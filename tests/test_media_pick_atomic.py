# -*- coding: utf-8 -*-
"""media.pick_media 的 hardlink 原子发布与并发不覆盖回归。"""

import errno
import importlib
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load_media():
    name = "_kedou_media_pick_atomic_tests"
    package = ModuleType(name)
    package.__path__ = [str(ROOT / "kedou_bridge")]
    with patch.dict(sys.modules, {
        name: package, "aiohttp": None, "server": None,
        "nodes": None, "folder_paths": None, "torch": None,
    }):
        return importlib.import_module(name + ".media")


class MediaPickAtomicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = load_media()

    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="kedou_media_pick_")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.in_dir = root / "input"
        self.out_dir = root / "output"
        self.in_dir.mkdir()
        self.out_dir.mkdir()
        self.src = self.out_dir / "shot.png"
        self.src.write_bytes(b"complete source image")
        dirs_patch = patch.object(self.media, "_media_dirs",
                                  lambda: (str(self.in_dir), str(self.out_dir)))
        dirs_patch.start()
        self.addCleanup(dirs_patch.stop)

    def assert_no_temp_files(self):
        self.assertEqual(list(self.in_dir.glob(".kedou-media-*")), [])

    def test_output_file_is_published_with_complete_content(self):
        result = self.media.pick_media("shot.png", "", "output")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["filename"], "shot.png")
        self.assertTrue(result["copied"])
        self.assertEqual((self.in_dir / "shot.png").read_bytes(), self.src.read_bytes())
        self.assert_no_temp_files()

    def test_existing_different_target_is_preserved_and_new_name_selected(self):
        target = self.in_dir / "shot.png"
        target.write_bytes(b"do not overwrite")
        result = self.media.pick_media("shot.png", "", "output")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["filename"], "shot_库1.png")
        self.assertEqual(target.read_bytes(), b"do not overwrite")
        self.assertEqual((self.in_dir / result["filename"]).read_bytes(), self.src.read_bytes())
        self.assert_no_temp_files()

    def test_target_created_after_check_is_never_overwritten(self):
        real_link = os.link
        raced = False

        def link_with_one_race(source, destination):
            nonlocal raced
            if not raced:
                raced = True
                Path(destination).write_bytes(b"concurrent winner")
            return real_link(source, destination)

        with patch.object(self.media.os, "link", side_effect=link_with_one_race):
            result = self.media.pick_media("shot.png", "", "output")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["filename"], "shot_库1.png")
        self.assertEqual((self.in_dir / "shot.png").read_bytes(), b"concurrent winner")
        self.assertEqual((self.in_dir / result["filename"]).read_bytes(), self.src.read_bytes())
        self.assert_no_temp_files()

    def test_identical_existing_target_keeps_legacy_reuse_behavior(self):
        (self.in_dir / "shot.png").write_bytes(self.src.read_bytes())
        result = self.media.pick_media("shot.png", "", "output")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["filename"], "shot.png")
        self.assertFalse(result["copied"])
        self.assertEqual(list(self.in_dir.iterdir()), [self.in_dir / "shot.png"])

    def test_unsupported_hardlink_returns_clear_error_without_fallback(self):
        with patch.object(self.media.os, "link", side_effect=OSError(errno.EPERM, "not supported")):
            result = self.media.pick_media("shot.png", "", "output")
        self.assertFalse(result["ok"], result)
        self.assertIn("不支持硬链接", result["error"])
        self.assertFalse((self.in_dir / "shot.png").exists())
        self.assert_no_temp_files()

    def test_copy_failure_cleans_temp_and_leaves_no_target(self):
        with patch("shutil.copyfile", side_effect=OSError("injected copy failure")):
            result = self.media.pick_media("shot.png", "", "output")
        self.assertFalse(result["ok"], result)
        self.assertIn("复制到输入目录失败", result["error"])
        self.assertFalse((self.in_dir / "shot.png").exists())
        self.assert_no_temp_files()

    def test_read_only_source_does_not_leave_temp_file(self):
        os.chmod(self.src, 0o444)
        try:
            result = self.media.pick_media("shot.png", "", "output")
        finally:
            os.chmod(self.src, 0o644)
        self.assertTrue(result["ok"], result)
        self.assertEqual((self.in_dir / "shot.png").read_bytes(), self.src.read_bytes())
        self.assert_no_temp_files()

    def test_input_file_is_returned_without_copy(self):
        source = self.in_dir / "already.png"
        source.write_bytes(b"input")
        result = self.media.pick_media("already.png", "", "input")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["filename"], "already.png")
        self.assertFalse(result["copied"])
        self.assert_no_temp_files()


if __name__ == "__main__":
    unittest.main(verbosity=2)

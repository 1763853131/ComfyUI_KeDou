# -*- coding: utf-8 -*-
"""媒体库删除 media.delete_media 的自测（不依赖 ComfyUI 进程）。

用法：<comfyui>/python_embeded/python.exe tests/test_media_delete.py

覆盖：
  1. input / output 两个 tab 都删得掉，且落进回收站对应子目录（不真删）
  2. 子目录结构在回收站里保留；扩展名保留（捞回来不用猜格式）
  3. 缺文件 / 非媒体类型 / 目录 / 越界路径 → ok=False，且不动任何文件
  4. 同一秒删两个同名：时间戳后缀 -1 递增，不互相覆盖
  5. 删完媒体清单扫不到（回收站在 input/output 之外）
"""

import importlib
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load_bridge():
    pkg = ModuleType("_kedou_del_test")
    pkg.__path__ = [str(ROOT / "kedou_bridge")]
    with patch.dict(sys.modules, {pkg.__name__: pkg, "aiohttp": None, "server": None,
                                  "nodes": None, "folder_paths": None, "torch": None}):
        media = importlib.import_module(pkg.__name__ + ".media")
        paths = importlib.import_module(pkg.__name__ + ".paths")
    return media, paths


class MediaDeleteTest(unittest.TestCase):

    def setUp(self):
        self.media, self.paths = load_bridge()
        self._tmp = TemporaryDirectory(prefix="kedou_del_")
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.in_dir = root / "input"
        self.out_dir = root / "output"
        self.trash = root / "user" / "default" / "kedou_trash"
        self.in_dir.mkdir(parents=True)
        self.out_dir.mkdir(parents=True)
        for p in (self.in_dir / "a.png", self.out_dir / "b.png",
                  self.in_dir / "sub" / "c.jpg", self.in_dir / "note.txt"):
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"\x89PNG\r\n\x1a\nfake")
        self._patches = [
            patch.object(self.media, "_media_dirs", lambda: (str(self.in_dir), str(self.out_dir))),
            patch.object(self.paths, "TRASH_DIR", str(self.trash)),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

    def test_delete_input_moves_to_trash(self):
        r = self.media.delete_media("a.png", "", "input")
        self.assertTrue(r["ok"], r)
        self.assertFalse((self.in_dir / "a.png").exists())
        moved = list((self.trash / "media" / "input").glob("a.*.png"))
        self.assertEqual(len(moved), 1)
        self.assertEqual(moved[0].read_bytes(), b"\x89PNG\r\n\x1a\nfake")
        self.assertEqual(r["tab"], "input")
        self.assertTrue(r["trashed"])

    def test_delete_output_uses_output_trash(self):
        r = self.media.delete_media("b.png", "", "output")
        self.assertTrue(r["ok"], r)
        self.assertFalse((self.out_dir / "b.png").exists())
        self.assertEqual(len(list((self.trash / "media" / "output").glob("b.*.png"))), 1)
        self.assertFalse((self.trash / "media" / "input").exists())

    def test_subfolder_preserved_in_trash(self):
        r = self.media.delete_media("c.jpg", "sub", "input")
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(list((self.trash / "media" / "input" / "sub").glob("c.*.jpg"))), 1)

    def test_missing_file_fails_without_side_effects(self):
        r = self.media.delete_media("nope.png", "", "input")
        self.assertFalse(r["ok"])
        self.assertFalse(self.trash.exists())

    def test_non_media_type_refused(self):
        r = self.media.delete_media("note.txt", "", "input")
        self.assertFalse(r["ok"])
        self.assertTrue((self.in_dir / "note.txt").exists())

    def test_directory_refused(self):
        r = self.media.delete_media("sub", "", "input")
        self.assertFalse(r["ok"])
        self.assertTrue((self.in_dir / "sub" / "c.jpg").exists())

    def test_cannot_escape_media_dirs(self):
        secret = Path(self._tmp.name) / "secret.png"
        secret.write_bytes(b"secret")
        # basename 口径：../secret.png 只会落到 input/secret.png（不存在）→ 失败
        r = self.media.delete_media("../secret.png", "", "input")
        self.assertFalse(r["ok"])
        self.assertTrue(secret.exists())
        r2 = self.media.delete_media("a.png", "../../", "input")
        self.assertFalse(r2["ok"])
        self.assertTrue((self.in_dir / "a.png").exists())
        self.assertTrue(secret.exists())

    def test_same_second_collision_gets_suffix(self):
        with patch.object(self.media.time, "strftime", lambda fmt: "20261111-000000"):
            r1 = self.media.delete_media("a.png", "", "input")
            (self.in_dir / "a.png").write_bytes(b"second")
            r2 = self.media.delete_media("a.png", "", "input")
        self.assertTrue(r1["ok"] and r2["ok"], (r1, r2))
        names = sorted(p.name for p in (self.trash / "media" / "input").glob("a.*"))
        self.assertEqual(names, ["a.20261111-000000-1.png", "a.20261111-000000.png"])

    def test_deleted_file_leaves_media_listing(self):
        before = {i["name"] for i in self.media.list_media("image", "all")}
        self.assertIn("a.png", before)
        self.assertTrue(self.media.delete_media("a.png", "", "input")["ok"])
        after = {i["name"] for i in self.media.list_media("image", "all")}
        self.assertNotIn("a.png", after)


if __name__ == "__main__":
    unittest.main(verbosity=2)
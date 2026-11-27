# -*- coding: utf-8 -*-
"""image_sets 损坏 JSON 留档、拒绝覆写与恢复流程回归。"""

import importlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load_image_sets():
    name = "_kedou_image_sets_integrity_tests"
    package = ModuleType(name)
    package.__path__ = [str(ROOT / "kedou_bridge")]
    with patch.dict(sys.modules, {
        name: package, "aiohttp": None, "server": None,
        "nodes": None, "folder_paths": None, "torch": None,
    }):
        return importlib.import_module(name + ".image_sets")


class ImageSetsIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sets = load_image_sets()

    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="kedou_image_sets_")
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / "vault"
        self.store_dir = self.vault / ".kedou"
        self.store_dir.mkdir(parents=True)
        self.store = self.store_dir / "image_sets.json"
        pv = ModuleType("kedou_prompt_vault")
        pv.vault_dir = lambda: str(self.vault)
        pv.STORE_DIR = ".kedou"
        pv_patch = patch.dict(sys.modules, {"kedou_prompt_vault": pv})
        pv_patch.start()
        self.addCleanup(pv_patch.stop)

    def test_failed_legacy_migration_reads_and_writes_old_location(self):
        legacy = Path(self.tmp.name) / "legacy.json"
        legacy.write_text('{"v":1,"items":[{"id":"old","name":"old","images":["a.png"]}]}', encoding="utf-8")
        with patch.object(self.sets, "_legacy_path", return_value=str(legacy)), \
                patch.object(self.sets.shutil, "move", side_effect=OSError("injected move")):
            listed = self.sets.list_sets()
            self.assertTrue(listed["ok"], listed)
            self.assertEqual(listed["items"][0]["name"], "old")
            saved = self.sets.save_set("new", ["b.png"])
            self.assertTrue(saved["ok"], saved)
        self.assertFalse(self.store.exists())
        self.assertEqual({item["name"] for item in json.loads(legacy.read_text(encoding="utf-8"))["items"]},
                         {"old", "new"})

    def test_cap_always_keeps_the_item_being_saved(self):
        with patch.object(self.sets, "_now", return_value="2026-01-01 00:00:00"):
            for index in range(101):
                self.assertTrue(self.sets.save_set("p%03d" % index, ["a.png"])["ok"])
        names = {item["name"] for item in self.sets.list_sets()["items"]}
        self.assertEqual(len(names), 100)
        self.assertIn("p100", names)
        self.assertNotIn("p000", names)

    def test_corrupt_store_is_archived_and_all_public_writes_refuse(self):
        saved = self.sets.save_set("原排列", ["a.png"])
        self.assertTrue(saved["ok"], saved)
        set_id = saved["item"]["id"]
        self.store.write_text("{broken json", encoding="utf-8")

        listed = self.sets.list_sets()
        self.assertFalse(listed["ok"], listed)
        self.assertEqual(listed["items"], [])
        self.assertIn("损坏", listed["error"])
        self.assertFalse(self.store.exists())
        bad_files = list(self.store_dir.glob("image_sets.json.bad-*"))
        self.assertEqual(len(bad_files), 1)
        self.assertEqual(bad_files[0].read_text(encoding="utf-8"), "{broken json")

        results = [
            self.sets.save_set("新排列", ["b.png"]),
            self.sets.rename_set(set_id, "改名"),
            self.sets.delete_set(set_id),
            self.sets.load_set(set_id),
        ]
        for result in results:
            self.assertFalse(result["ok"], result)
            self.assertIn("损坏", result["error"])
        self.assertFalse(self.store.exists())       # 损坏留档仍在，不能当空库继续写

    def test_moving_bad_archive_allows_fresh_store(self):
        self.store.write_text("not json", encoding="utf-8")
        self.assertFalse(self.sets.list_sets()["ok"])
        bad = next(self.store_dir.glob("image_sets.json.bad-*"))
        bad.replace(self.store_dir / "recovered.json")
        listed = self.sets.list_sets()
        self.assertTrue(listed["ok"], listed)
        self.assertEqual(listed["items"], [])
        saved = self.sets.save_set("恢复后新建", ["a.png"])
        self.assertTrue(saved["ok"], saved)
        self.assertTrue(self.store.is_file())

    def test_repairing_original_path_allows_reading_again(self):
        saved = self.sets.save_set("可恢复排列", ["a.png"])
        valid = self.store.read_bytes()
        self.store.write_text("broken", encoding="utf-8")
        self.assertFalse(self.sets.list_sets()["ok"])
        self.store.write_bytes(valid)
        listed = self.sets.list_sets()
        self.assertTrue(listed["ok"], listed)
        self.assertEqual(listed["items"][0]["id"], saved["item"]["id"])

    def test_archive_failure_still_refuses_to_overwrite_original(self):
        valid = json.dumps({"v": 1, "items": []}, ensure_ascii=False)
        self.store.write_text("broken", encoding="utf-8")
        with patch.object(self.sets.os, "replace", side_effect=PermissionError("injected")):
            listed = self.sets.list_sets()
            saved = self.sets.save_set("不能写入", ["a.png"])
        self.assertFalse(listed["ok"], listed)
        self.assertFalse(saved["ok"], saved)
        self.assertEqual(self.store.read_text(encoding="utf-8"), "broken")
        self.store.write_text(valid, encoding="utf-8")
        self.assertTrue(self.sets.list_sets()["ok"])

    def test_invalid_schema_is_treated_as_corruption(self):
        self.store.write_text(json.dumps({"v": 1, "items": "not-a-list"}), encoding="utf-8")
        listed = self.sets.list_sets()
        self.assertFalse(listed["ok"], listed)
        self.assertFalse(self.store.exists())
        self.assertEqual(len(list(self.store_dir.glob("image_sets.json.bad-*"))), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)

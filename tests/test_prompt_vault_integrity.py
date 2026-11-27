# -*- coding: utf-8 -*-
"""prompt_vault 的并发读改写、失败状态与每日备份回归。"""

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load_prompt_vault():
    name = "_kedou_prompt_vault_integrity_tests"
    package_dir = ROOT / "prompt_vault"
    spec = importlib.util.spec_from_file_location(
        name, package_dir / "__init__.py", submodule_search_locations=[str(package_dir)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class PromptVaultIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pv = load_prompt_vault()

    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="kedou_prompt_integrity_")
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / "vault"
        self.vault.mkdir()                         # 已存在，避免播种示例干扰断言
        env_patch = patch.dict(os.environ, {self.pv.ENV_KEY: str(self.vault)}, clear=False)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        self.pv._reset_state()
        self.pv._state["backups"].clear()
        self.pv._cache.clear()

    def create_prompt(self, name="测试词条", positive="一段足够长的唯一提示词正文", **extra):
        body = {"name": name, "positive": positive}
        body.update(extra)
        result = self.pv.save_prompt(body)
        self.assertTrue(result["ok"], result)
        return result["item"]

    def test_concurrent_edits_to_different_fields_both_survive(self):
        item = self.create_prompt()
        pid = item["id"]
        barrier = threading.Barrier(2)
        real_write = self.pv._atomic_write

        def slow_write(*args, **kwargs):
            # 没锁时两个线程都会在旧快照上停顿，稳定放大丢字段竞态。
            time.sleep(0.05)
            return real_write(*args, **kwargs)

        def edit(field, value):
            barrier.wait(timeout=2)
            return self.pv.save_prompt({"id": pid, field: value})

        with patch.object(self.pv, "_atomic_write", side_effect=slow_write):
            with ThreadPoolExecutor(max_workers=2) as pool:
                negative = pool.submit(edit, "negative", "保留负面字段")
                description = pool.submit(edit, "description", "保留描述字段")
                self.assertTrue(negative.result(timeout=5)["ok"])
                self.assertTrue(description.result(timeout=5)["ok"])

        self.pv._cache.clear()
        path, stored = self.pv._find_path(str(self.vault), pid)
        self.assertIsNotNone(path)
        self.assertEqual(stored["negative"], "保留负面字段")
        self.assertEqual(stored["description"], "保留描述字段")

    def test_category_rewrite_and_field_edit_are_serialized(self):
        item = self.create_prompt(category="old")
        pid = item["id"]
        barrier = threading.Barrier(2)
        real_write = self.pv._atomic_write

        def slow_write(*args, **kwargs):
            time.sleep(0.03)
            return real_write(*args, **kwargs)

        def rename():
            barrier.wait(timeout=2)
            return self.pv.rename_category("prompts", "old", "new")

        def edit():
            barrier.wait(timeout=2)
            return self.pv.save_prompt({"id": pid, "negative": "并发编辑保留"})

        with patch.object(self.pv, "_atomic_write", side_effect=slow_write):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = [pool.submit(rename), pool.submit(edit)]
                self.assertTrue(all(f.result(timeout=5)["ok"] for f in results))
        self.pv._cache.clear()
        _path, stored = self.pv._find_path(str(self.vault), pid)
        self.assertEqual(stored["category"], "new")
        self.assertEqual(stored["negative"], "并发编辑保留")

    def test_failed_history_migration_retries_on_next_access(self):
        old = self.vault / self.pv.HISTORY_DIR / "old.md"
        entry = {"id": "p.old", "name": "old", "type": "历史",
                 "positive": "old history text", "negative": "", "use_for": ["文生图"],
                 "uses": 1, "created": "2026-01-01", "updated": "2026-01-01"}
        self.pv._atomic_write(str(old), self.pv._serialize(entry))
        with patch.object(self.pv, "_write_history", side_effect=OSError("injected")):
            self.pv.vault_dir()
        self.assertFalse((self.vault / self.pv.STORE_DIR / self.pv.HISTORY_FILE).exists())
        self.pv.vault_dir()
        self.assertTrue((self.vault / self.pv.STORE_DIR / self.pv.HISTORY_FILE).exists())
        self.assertFalse(old.exists())

    def test_category_rename_failure_rolls_back_all_entries(self):
        self.create_prompt(name="A", positive="positive A long enough", category="old")
        self.create_prompt(name="B", positive="positive B long enough", category="old")
        real_write = self.pv._atomic_write
        calls = {"n": 0}

        def fail_second(path, content):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError("injected second write")
            return real_write(path, content)

        with patch.object(self.pv, "_atomic_write", side_effect=fail_second):
            with self.assertRaises(OSError):
                self.pv.rename_category("prompts", "old", "new")
        self.pv._cache.clear()
        categories = [self.pv._parse_entry(str(path), path.relative_to(self.vault).as_posix())["category"]
                      for path in self.vault.rglob("*.md")]
        self.assertEqual(categories, ["old", "old"])
        self.assertEqual(self.pv.list_categories("prompts")["categories"], [])

    def test_prompt_rename_failure_removes_new_duplicate(self):
        item = self.create_prompt(name="Before", positive="rename duplicate positive")
        real_remove = self.pv.os.remove

        def fail_old(path):
            if Path(path).name == "Before.md":
                raise OSError("injected remove")
            return real_remove(path)

        with patch.object(self.pv.os, "remove", side_effect=fail_old):
            result = self.pv.save_prompt({"id": item["id"], "name": "After"})
        self.assertFalse(result["ok"])
        matches = []
        for path in self.vault.rglob("*.md"):
            parsed = self.pv._parse_entry(str(path), path.relative_to(self.vault).as_posix())
            if parsed["id"] == item["id"]:
                matches.append(path.name)
        self.assertEqual(matches, ["Before.md"])

    def test_concurrent_use_increments_are_not_lost(self):
        pid = self.create_prompt()["id"]
        real_write = self.pv._atomic_write

        def slow_write(*args, **kwargs):
            time.sleep(0.01)
            return real_write(*args, **kwargs)

        with patch.object(self.pv, "_atomic_write", side_effect=slow_write):
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _n: self.pv.bump_use(pid), range(12)))
        self.assertTrue(all(r["ok"] for r in results), results)
        self.pv._cache.clear()
        _path, stored = self.pv._find_path(str(self.vault), pid)
        self.assertEqual(stored["uses"], 12)

    def test_failed_dedup_save_does_not_mutate_cached_state(self):
        item = self.create_prompt(usage=["文生图"])
        pid = item["id"]
        path, _old = self.pv._find_path(str(self.vault), pid)
        before = Path(path).read_bytes()
        with patch.object(self.pv, "_atomic_write", side_effect=OSError("injected write failure")):
            with self.assertRaises(OSError):
                self.pv.save_prompt({"name": item["name"], "positive": item["positive"],
                                     "usage": ["图生图"]})
        self.assertEqual(Path(path).read_bytes(), before)
        _path, cached = self.pv._find_path(str(self.vault), pid)
        self.assertEqual(cached["use_for"], ["文生图"])

    def test_failed_field_save_leaves_file_and_cache_unchanged(self):
        pid = self.create_prompt()["id"]
        path, _old = self.pv._find_path(str(self.vault), pid)
        before = Path(path).read_bytes()
        with patch.object(self.pv, "_atomic_write", side_effect=OSError("injected write failure")):
            with self.assertRaises(OSError):
                self.pv.save_prompt({"id": pid, "negative": "不应半途生效"})
        self.assertEqual(Path(path).read_bytes(), before)
        _path, cached = self.pv._find_path(str(self.vault), pid)
        self.assertEqual(cached["negative"], "")

    def test_history_fallbacks_do_not_deadlock_prompt_lock(self):
        history = self.pv.save_history("一段用于验证历史兜底不会死锁的提示词")
        self.assertTrue(history["ok"], history)
        hid = history["item"]["id"]
        bumped = self.pv.bump_use(hid)
        self.assertTrue(bumped["ok"], bumped)
        self.assertEqual(bumped["uses"], 2)
        self.assertTrue(self.pv.delete_prompt(hid)["ok"])

    def test_failed_backup_is_not_marked_and_retries_with_entries(self):
        (self.vault / "note.md").write_text("# Note\n内容\n", encoding="utf-8")
        store = self.vault / self.pv.STORE_DIR
        store.mkdir()
        (store / self.pv.HISTORY_FILE).write_text(
            json.dumps({"version": 1, "items": []}), encoding="utf-8")
        today = time.strftime("%Y-%m-%d")
        key = (str(self.vault), today)
        backup_dir = Path(self.pv._backup_dir(str(self.vault)))

        with patch.object(self.pv.zipfile.ZipFile, "write", side_effect=OSError("injected zip failure")):
            self.pv._backup_daily(str(self.vault))
        self.assertNotIn(key, self.pv._state["backups"])
        self.assertFalse((backup_dir / ("prompts_%s.zip" % today)).exists())
        self.assertEqual(list(backup_dir.glob("*.tmp")), [])

        self.pv._backup_daily(str(self.vault))
        self.assertIn(key, self.pv._state["backups"])
        dest = backup_dir / ("prompts_%s.zip" % today)
        with zipfile.ZipFile(dest, "r") as z:
            self.assertIsNone(z.testzip())
            self.assertIn("note.md", z.namelist())
            self.assertIn(self.pv.STORE_DIR + "/" + self.pv.HISTORY_FILE, z.namelist())

    def test_daily_backup_contains_image_and_av_sets(self):
        store = self.vault / self.pv.STORE_DIR
        store.mkdir()
        (store / "image_sets.json").write_text('{"v":1,"items":[]}', encoding="utf-8")
        (store / "av_sets.json").write_text('{"v":1,"items":[]}', encoding="utf-8")
        self.pv._backup_daily(str(self.vault))
        archive = next(Path(self.pv._backup_dir(str(self.vault))).glob("*.zip"))
        with zipfile.ZipFile(archive) as z:
            self.assertIn(self.pv.STORE_DIR + "/image_sets.json", z.namelist())
            self.assertIn(self.pv.STORE_DIR + "/av_sets.json", z.namelist())

    def test_failed_atomic_replace_cleans_temp_and_retries(self):
        (self.vault / "note.md").write_text("note", encoding="utf-8")
        today = time.strftime("%Y-%m-%d")
        key = (str(self.vault), today)
        backup_dir = Path(self.pv._backup_dir(str(self.vault)))
        with patch.object(self.pv.os, "replace", side_effect=OSError("injected replace failure")):
            self.pv._backup_daily(str(self.vault))
        self.assertNotIn(key, self.pv._state["backups"])
        self.assertEqual(list(backup_dir.glob("*.tmp")), [])
        self.pv._backup_daily(str(self.vault))
        self.assertTrue((backup_dir / ("prompts_%s.zip" % today)).is_file())

    def test_old_unreadable_backup_is_rebuilt(self):
        (self.vault / "note.md").write_text("note", encoding="utf-8")
        today = time.strftime("%Y-%m-%d")
        backup_dir = Path(self.pv._backup_dir(str(self.vault)))
        backup_dir.mkdir()
        dest = backup_dir / ("prompts_%s.zip" % today)
        dest.write_bytes(b"not a zip")
        self.pv._backup_daily(str(self.vault))
        with zipfile.ZipFile(dest, "r") as z:
            self.assertIn("note.md", z.namelist())

    def test_old_incomplete_backup_is_rebuilt_not_treated_as_done(self):
        (self.vault / "note.md").write_text("note", encoding="utf-8")
        today = time.strftime("%Y-%m-%d")
        backup_dir = Path(self.pv._backup_dir(str(self.vault)))
        backup_dir.mkdir()
        dest = backup_dir / ("prompts_%s.zip" % today)
        with zipfile.ZipFile(dest, "w"):
            pass                                    # 旧 bug 会留下的“成功”空 ZIP
        self.pv._backup_daily(str(self.vault))
        with zipfile.ZipFile(dest, "r") as z:
            self.assertIn("note.md", z.namelist())


if __name__ == "__main__":
    unittest.main(verbosity=2)

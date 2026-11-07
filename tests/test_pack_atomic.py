# -*- coding: utf-8 -*-
"""Recoverable archive-write failures; not cross-file power-loss atomicity."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
import importlib
import json
import os
from pathlib import Path
import sys
import threading
from tempfile import TemporaryDirectory
from types import ModuleType
import unittest
from unittest.mock import patch


class TextNode:
    RETURN_TYPES = ("TEST_TEXT",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"text": ("STRING", {"default": ""})}}


class SaveTextNode:
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "text": ("TEST_TEXT",),
            "prefix": ("STRING", {"default": "output"}),
        }}


def workflow(value):
    return {
        "id": "atomic-graph",
        "nodes": [
            {"id": 1, "type": "AtomicText", "inputs": [],
             "widgets_values": [value], "widgets_values_named": {"text": value}},
            {"id": 2, "type": "AtomicSaveText",
             "inputs": [{"name": "text", "type": "TEST_TEXT", "link": 1}],
             "widgets_values": [value], "widgets_values_named": {"prefix": value}},
        ],
        "links": [[1, 1, 0, 2, 0, "TEST_TEXT"]],
        "extra": {"linearMode": True, "linearData": {
            "inputs": [["atomic-graph:1:text", "Text"]], "outputs": ["2"],
        }},
    }


def kapp(value):
    # Explicit expected API graph: do not derive expectations from the converter.
    return {
        "kedou_app": 1, "name": "archive", "desc": "",
        "graph": {
            "1": {"class_type": "AtomicText", "inputs": {"text": value},
                  "_meta": {"title": "AtomicText"}},
            "2": {"class_type": "AtomicSaveText",
                  "inputs": {"prefix": value, "text": ["1", 0]},
                  "_meta": {"title": "AtomicSaveText"}},
        },
        "params": [{"node": "1", "input": "text", "label": "Text",
                    "widget": "text", "default": value}],
        "outputs": ["2"], "source": "kedou_apps/archive.json",
    }


class PackAtomicTests(unittest.TestCase):
    ENTRIES = ("save_kapp", "pack_app", "kapp_from_linear")
    maxDiff = 1600

    @classmethod
    def setUpClass(cls):
        stack = ExitStack()
        cls.addClassCleanup(stack.close)
        # A private package avoids importing unrelated runtime-only dependencies.
        name = "_kedou_pack_atomic_tests"
        package = ModuleType(name)
        package.__path__ = [str(Path(__file__).resolve().parents[1] / "kedou_bridge")]
        stack.enter_context(patch.dict(sys.modules, {
            name: package, "aiohttp": None, "server": None,
            "nodes": None, "folder_paths": None, "torch": None,
        }))
        cls.pack = importlib.import_module(name + ".pack")
        cls.paths = importlib.import_module(name + ".paths")
        compat = importlib.import_module(name + ".compat")
        stack.enter_context(patch.object(compat, "NODE_MAP", {
            "AtomicText": TextNode, "AtomicSaveText": SaveTextNode,
        }))

    @staticmethod
    def _write_json(path, data):
        # Noncanonical whitespace makes a restore-by-reserializing fail the byte check.
        text = json.dumps(data, ensure_ascii=False, indent=4).replace("\n", "\r\n")
        path.write_bytes((text + "\r\n\r\n").encode("utf-8"))

    @contextmanager
    def _sandbox(self, entry, existing=False):
        with TemporaryDirectory(prefix="kedou_pack_atomic_") as tmp, ExitStack() as stack:
            self.root = Path(tmp).resolve()
            user = self.root / "user" / "default"
            self.workflows = user / "workflows"
            self.apps = user / "kedou_apps"
            trash = user / "kedou_trash"
            for directory in (self.workflows, self.apps, trash):
                directory.mkdir(parents=True)
            stack.enter_context(patch.multiple(
                self.paths, COMFY_ROOT=str(self.root), WORKFLOW_DIR=str(self.workflows),
                APPS_DIR=str(self.apps), TRASH_DIR=str(trash),
                _user_default_dir=lambda: str(user),
            ))
            self.ui = workflow("new text")
            self.payload = kapp("new text")
            self.workflow_path = self.apps / "archive.json"
            self.package_path = self.apps / "archive.kapp.json"
            self.source_path = self.workflows / "source.json"
            if entry == "pack_app":
                self._write_json(self.source_path, self.ui)
            if existing:
                self._write_json(self.workflow_path, workflow("old text"))
                self._write_json(self.package_path, kapp("old text"))
            yield

    def _snapshot(self):
        return {p.relative_to(self.root).as_posix(): p.read_bytes()
                for p in self.root.rglob("*") if p.is_file()}

    def _invoke(self, entry):
        if entry == "save_kapp":
            return self.pack.save_kapp("archive", "", self.payload, workflow=self.ui)
        if entry == "pack_app":
            return self.pack.pack_app(self.source_path.name, self.payload["params"],
                                      name="archive")
        return self.pack.kapp_from_linear("archive", self.ui, source="obsolete.json")

    def _assert_rejected(self, result, error_fragment):
        self.assertIs(result.get("ok"), False, result)
        self.assertIn(error_fragment, result.get("error", ""), result)

    def _assert_saved(self, result, name="archive"):
        self.assertIs(result.get("ok"), True, result)
        self.assertEqual(result["file"], self.package_path.relative_to(self.root).as_posix())
        stored_ui = json.loads(self.workflow_path.read_bytes())
        stored = json.loads(self.package_path.read_bytes())
        self.assertEqual(stored_ui, self.ui)
        self.assertEqual(stored["graph"], self.payload["graph"])
        self.assertEqual(stored["name"], name)
        self.assertEqual(stored["outputs"], ["2"])
        self.assertEqual(len(stored["params"]), 1)
        param = stored["params"][0]
        self.assertEqual((param["node"], param["input"], param["default"]),
                         ("1", "text", stored_ui["nodes"][0]["widgets_values_named"]["text"]))
        self.assertEqual(stored["source"], "kedou_apps/archive.json")
        resolved = self.pack.load_workflow_file(stored["source"])
        self.assertIs(resolved.get("ok"), True, resolved)
        self.assertEqual(resolved["workflow"], self.ui)
        self.assertEqual(result["param_count"], 1)
        self.assertEqual(result["node_count"], 2)

    def test_validation_failure_keeps_archive_unchanged(self):
        for entry in self.ENTRIES:
            for existing in (False, True):
                with self.subTest(entry=entry, existing=existing), self._sandbox(entry, existing):
                    # Reach the post-build validation, not the early node-reference check.
                    self.payload["params"][0]["input"] = "missing_input"
                    self.ui["extra"]["linearData"]["inputs"][0][0] = "atomic-graph:1:missing_input"
                    before = self._snapshot()
                    result = self._invoke(entry)
                    self._assert_rejected(result, "missing_input")
                    self.assertEqual(self._snapshot(), before)

    def test_success_commits_matching_workflow_and_package(self):
        for entry in self.ENTRIES:
            for existing in (False, True):
                with self.subTest(entry=entry, existing=existing), self._sandbox(entry, existing):
                    source_before = self.source_path.read_bytes() if entry == "pack_app" else None
                    result = self._invoke(entry)
                    self._assert_saved(result)
                    expected_files = {self.workflow_path, self.package_path}
                    if source_before is not None:
                        self.assertEqual(self.source_path.read_bytes(), source_before)
                        expected_files.add(self.source_path)
                    self.assertEqual({p for p in self.root.rglob("*") if p.is_file()}, expected_files)

    def test_package_replace_failure_restores_archive(self):
        for entry in self.ENTRIES:
            for existing in (False, True):
                with self.subTest(entry=entry, existing=existing), self._sandbox(entry, existing):
                    before = self._snapshot()
                    real_replace = os.replace
                    at_package_commit = []

                    def fail_package(src, dst, *args, **kwargs):
                        # Fail the final destination without blocking staging or rollback.
                        if Path(dst).resolve() == self.package_path:
                            at_package_commit.append(self.workflow_path.read_bytes())
                            raise OSError("injected package replace failure")
                        return real_replace(src, dst, *args, **kwargs)

                    with patch.object(os, "replace", side_effect=fail_package):
                        result = self._invoke(entry)
                    self._assert_rejected(result, "injected package replace failure")
                    self.assertTrue(at_package_commit, "final package replacement was not attempted")
                    for raw in at_package_commit:
                        self.assertEqual(json.loads(raw), self.ui, "workflow must commit before package")
                    self.assertEqual(self._snapshot(), before)

    def test_linear_missing_output_leaves_archive_unchanged(self):
        for existing in (False, True):
            with self.subTest(existing=existing), self._sandbox("kapp_from_linear", existing):
                # Valid graph and parameter; only the post-build output check rejects it.
                self.ui["extra"]["linearData"]["outputs"] = ["999"]
                before = self._snapshot()
                result = self._invoke("kapp_from_linear")
                self._assert_rejected(result, "999")
                self.assertIn("输出节点", result["error"])
                self.assertEqual(self._snapshot(), before)

    def test_save_parameter_only_preserves_workflow(self):
        with self._sandbox("save_kapp", existing=True):
            before = self._snapshot()
            payload = json.loads(self.package_path.read_bytes())
            payload["params"][0]["default"] = "parameter-only edit"
            result = self.pack.save_kapp("archive", "", payload,
                                         target="kedou_apps/archive.kapp.json")
            self.assertIs(result.get("ok"), True, result)
            self.assertIs(result.get("edited"), True)
            self.assertEqual(json.loads(self.package_path.read_bytes()), payload)
            after = self._snapshot()
            package_key = self.package_path.relative_to(self.root).as_posix()
            self.assertNotEqual(after.pop(package_key), before.pop(package_key))
            self.assertEqual(after, before)

    def test_save_renamed_target_keeps_filenames(self):
        with self._sandbox("save_kapp", existing=True):
            self.payload["name"] = "Renamed display name"
            result = self.pack.save_kapp(self.payload["name"], "", self.payload,
                                         target="kedou_apps/archive.kapp.json", workflow=self.ui)
            self._assert_saved(result, name=self.payload["name"])
            self.assertEqual(result["target"], "kedou_apps/archive.kapp.json")
            self.assertIs(result.get("edited"), True)
            self.assertEqual(set(self.root.rglob("*.json")),
                             {self.workflow_path, self.package_path})

    def test_save_legacy_target_keeps_package_location(self):
        with self._sandbox("save_kapp"):
            legacy = self.workflows / "legacy"
            legacy.mkdir()
            self.package_path = legacy / "archive.kapp.json"
            old_workflow = legacy / "archive.json"
            self._write_json(self.package_path, kapp("old text"))
            self._write_json(old_workflow, workflow("legacy source"))
            old_bytes = old_workflow.read_bytes()
            self.payload["name"] = "Renamed legacy app"
            result = self.pack.save_kapp(self.payload["name"], "", self.payload,
                                         target="legacy/archive.kapp.json", workflow=self.ui)
            self._assert_saved(result, name=self.payload["name"])
            self.assertEqual(result["target"], "legacy/archive.kapp.json")
            self.assertIs(result.get("edited"), True)
            self.assertEqual(old_workflow.read_bytes(), old_bytes)
            self.assertEqual(set(self.root.rglob("*.json")),
                             {self.workflow_path, self.package_path, old_workflow})

    def test_json_serialization_failure_keeps_archive_unchanged(self):
        for entry in self.ENTRIES:
            for existing in (False, True):
                with self.subTest(entry=entry, existing=existing), self._sandbox(entry, existing):
                    before = self._snapshot()
                    real_dump = json.dump

                    def fail_package_dump(data, stream, *args, **kwargs):
                        if isinstance(data, dict) and data.get("kedou_app") == 1:
                            # Simulate a partially serialized package, not a validation failure.
                            stream.write('{"kedou_app":')
                            raise TypeError("injected JSON serialization failure")
                        return real_dump(data, stream, *args, **kwargs)

                    with patch.object(json, "dump", side_effect=fail_package_dump):
                        result = self._invoke(entry)
                    self._assert_rejected(result, "injected JSON serialization failure")
                    self.assertEqual(self._snapshot(), before)

    def test_workflow_replace_failure_keeps_package_unchanged(self):
        for entry in self.ENTRIES:
            for existing in (False, True):
                with self.subTest(entry=entry, existing=existing), self._sandbox(entry, existing):
                    before = self._snapshot()
                    real_replace = os.replace
                    destinations = []

                    def fail_workflow(src, dst, *args, **kwargs):
                        destination = Path(dst).resolve()
                        destinations.append(destination)
                        if destination == self.workflow_path:
                            raise OSError("injected workflow replace failure")
                        return real_replace(src, dst, *args, **kwargs)

                    with patch.object(os, "replace", side_effect=fail_workflow):
                        result = self._invoke(entry)
                    self._assert_rejected(result, "injected workflow replace failure")
                    self.assertIn(self.workflow_path, destinations)
                    self.assertNotIn(self.package_path, destinations)
                    self.assertEqual(self._snapshot(), before)

    def test_blocked_rollback_retains_original_backup(self):
        for entry in self.ENTRIES:
            with self.subTest(entry=entry), self._sandbox(entry, existing=True):
                old_workflow = self.workflow_path.read_bytes()
                old_package = self.package_path.read_bytes()
                real_replace = os.replace

                def fail_commit_and_rollback(src, dst):
                    if Path(dst).resolve() == self.package_path or str(src).endswith(".bak"):
                        raise PermissionError("injected commit and rollback failure")
                    return real_replace(src, dst)

                with patch.object(os, "replace", side_effect=fail_commit_and_rollback):
                    result = self._invoke(entry)
                self._assert_rejected(result, "回滚失败")
                backups = list(self.apps.glob(".kedou-pack-*.bak"))
                self.assertEqual(len(backups), 1)
                self.assertEqual(backups[0].read_bytes(), old_workflow)
                self.assertIn(str(backups[0]), result["error"])
                self.assertEqual(self.package_path.read_bytes(), old_package)
                self.assertEqual(list(self.root.rglob("*.tmp")), [])

    def test_delete_waits_for_both_files_to_commit(self):
        for entry in self.ENTRIES:
            with self.subTest(entry=entry), self._sandbox(entry, existing=True):
                workflow_committed = threading.Event()
                delete_waiting = threading.Event()
                resume = threading.Event()
                write_lock = threading.Lock()
                real_replace = os.replace

                class ObservedLock:
                    def __enter__(self):
                        if write_lock.locked():
                            delete_waiting.set()
                        write_lock.acquire()

                    def __exit__(self, *exc):
                        write_lock.release()

                def pause_after_workflow(src, dst):
                    real_replace(src, dst)
                    if Path(dst).resolve() == self.workflow_path:
                        workflow_committed.set()
                        if not resume.wait(15):
                            raise RuntimeError("timed out waiting to commit package")

                with patch.object(self.pack, "_PACK_WRITE_LOCK", ObservedLock(), create=True), \
                        patch.object(os, "replace", side_effect=pause_after_workflow), \
                        ThreadPoolExecutor(max_workers=2) as pool:
                    save_future = pool.submit(self._invoke, entry)
                    try:
                        self.assertTrue(workflow_committed.wait(5))
                        delete_future = pool.submit(
                            self.pack.delete_kapp, "kedou_apps/archive.kapp.json")
                        self.assertTrue(delete_waiting.wait(5), "delete did not acquire the write lock")
                        self.assertFalse(delete_future.done())
                    finally:
                        resume.set()
                    saved = save_future.result(timeout=10)
                    deleted = delete_future.result(timeout=10)
                self.assertIs(saved.get("ok"), True, saved)
                self.assertIs(deleted.get("ok"), True, deleted)
                self.assertFalse(self.workflow_path.exists())
                self.assertFalse(self.package_path.exists())
                trashed_package = self.root / deleted["trash"]
                self.assertEqual(json.loads(trashed_package.read_bytes())["graph"], self.payload["graph"])
                trashed_workflows = list(Path(self.paths.TRASH_DIR).glob("archive.json.*"))
                self.assertEqual(len(trashed_workflows), 1)
                self.assertEqual(json.loads(trashed_workflows[0].read_bytes()), self.ui)


if __name__ == "__main__":
    unittest.main()

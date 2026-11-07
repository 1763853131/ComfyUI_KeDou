# -*- coding: utf-8 -*-
"""Offline group-switch integration tests; only the standard library is needed."""

from contextlib import ExitStack
import copy
import importlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType
import unittest
from unittest.mock import patch


class ImageSource:
    RETURN_TYPES = ("IMAGE", "MASK")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"value": ("STRING", {"default": "original"})}}


class ImageEffect:
    RETURN_TYPES = ("IMAGE",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",), "strength": ("FLOAT", {"default": 0.5}),
        }}


class ImageSink:
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",), "prefix": ("STRING", {"default": "output"}),
        }}


class ImageMux:
    RETURN_TYPES = ("IMAGE", "IMAGE")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "optional": {
            "left": ("IMAGE",), "right": ("IMAGE",), "spare": ("IMAGE",),
        }}


def chain_kapp():
    # Handwritten API graph and socket metadata, not output from a converter.
    return {
        "kedou_app": 1, "name": "switches", "desc": "",
        "graph": {
            "1": {"class_type": "GroupSource", "inputs": {"value": "original"}},
            "2": {"class_type": "GroupEffect",
                  "inputs": {"image": ["1", 0], "strength": 0.5}},
            "3": {"class_type": "GroupSink",
                  "inputs": {"image": ["2", 0], "prefix": "output"}},
        },
        "params": [{"node": "2", "input": "strength", "label": "Strength",
                    "widget": "number", "default": 0.5, "node_type": "GroupEffect"}],
        "outputs": ["3"],
        "groups": [{"id": "effect", "label": "Effect", "default": True,
                    "mode": "bypass", "nodes": ["2"]}],
        "group_nodes": {
            "1": {"inputs": [], "outputs": ["IMAGE", "MASK"]},
            "2": {"inputs": [{"name": "image", "type": "IMAGE"}], "outputs": ["IMAGE"]},
            "3": {"inputs": [{"name": "image", "type": "IMAGE"}], "outputs": []},
        },
    }


def mux_kapp():
    return {
        "kedou_app": 1, "name": "switches", "desc": "", "params": [], "outputs": ["4"],
        "graph": {
            "1": {"class_type": "GroupSource", "inputs": {"value": "left"}},
            "2": {"class_type": "GroupSource", "inputs": {"value": "right"}},
            "3": {"class_type": "GroupMux",
                  "inputs": {"left": ["1", 0], "right": ["2", 0]}},
            "4": {"class_type": "GroupSink",
                  "inputs": {"image": ["3", 0], "prefix": "output"}},
        },
        "groups": [{"id": "mux", "label": "Mux", "default": False,
                    "mode": "bypass", "nodes": ["3"]}],
        "group_nodes": {
            "1": {"inputs": [], "outputs": ["IMAGE", "MASK"]},
            "2": {"inputs": [], "outputs": ["IMAGE", "MASK"]},
            "3": {"inputs": [{"name": "left", "type": "IMAGE"},
                             {"name": "right", "type": "IMAGE"}],
                  "outputs": ["IMAGE", "IMAGE"]},
            "4": {"inputs": [{"name": "image", "type": "IMAGE"}], "outputs": []},
        },
    }


# Expected graphs are explicit, independent of groups.rewrite/disabled_nodes.
CHAIN_ON = {
    "1": {"class_type": "GroupSource", "inputs": {"value": "original"}},
    "2": {"class_type": "GroupEffect", "inputs": {"image": ["1", 0], "strength": 0.5}},
    "3": {"class_type": "GroupSink", "inputs": {"image": ["2", 0], "prefix": "output"}},
}
CHAIN_BYPASSED = {
    "1": {"class_type": "GroupSource", "inputs": {"value": "original"}},
    "3": {"class_type": "GroupSink", "inputs": {"image": ["1", 0], "prefix": "output"}},
}
CHAIN_MUTED = {
    "1": {"class_type": "GroupSource", "inputs": {"value": "original"}},
    "3": {"class_type": "GroupSink", "inputs": {"prefix": "output"}},
}


class GroupSwitchTests(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        stack = ExitStack()
        cls.addClassCleanup(stack.close)
        # Same private-package technique as test_pack_atomic.py: neither plugin
        # __init__.py runs, and runtime/GPU dependencies cannot be imported.
        name = "_kedou_group_switch_tests"
        package = ModuleType(name)
        package.__path__ = [str(Path(__file__).resolve().parents[1] / "kedou_bridge")]
        stack.enter_context(patch.object(sys, "dont_write_bytecode", True))
        stack.enter_context(patch.dict(sys.modules, {
            name: package, "aiohttp": None, "server": None,
            "nodes": None, "folder_paths": None, "torch": None,
        }))
        cls.apps = importlib.import_module(name + ".apps")
        cls.pack = importlib.import_module(name + ".pack")
        cls.paths = importlib.import_module(name + ".paths")
        compat = importlib.import_module(name + ".compat")
        stack.enter_context(patch.object(compat, "NODE_MAP", {
            "GroupSource": ImageSource, "GroupEffect": ImageEffect,
            "GroupSink": ImageSink, "GroupMux": ImageMux,
        }))

    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.root = Path(stack.enter_context(TemporaryDirectory(prefix="kedou_groups_"))).resolve()
        user = self.root / "user" / "default"
        self.workflows = user / "workflows"
        self.archive = user / "kedou_apps"
        self.state_dir = user / "kedou_app_state"
        trash = user / "kedou_trash"
        for directory in (self.workflows, self.archive, trash):
            directory.mkdir(parents=True)
        stack.enter_context(patch.multiple(
            self.paths, COMFY_ROOT=str(self.root), WORKFLOW_DIR=str(self.workflows),
            APPS_DIR=str(self.archive), TRASH_DIR=str(trash),
            _user_default_dir=lambda: str(user),
        ))
        self.package_path = self.archive / "switches.kapp.json"
        self.workflow_path = self.archive / "switches.json"
        self.read_only = True
        self._install(chain_kapp())

    def tearDown(self):
        if self.read_only:
            self.assertEqual(self.package_path.read_bytes(), self.original_bytes,
                             "reading, running or updating values must not rewrite the kapp")

    @staticmethod
    def _write_json(path, data):
        # Byte equality must detect a rewrite, even if JSON contents are equal.
        text = json.dumps(data, ensure_ascii=False, indent=4).replace("\n", "\r\n")
        path.write_bytes((text + "\r\n\r\n").encode("utf-8"))

    def _install(self, data):
        self._write_json(self.package_path, data)
        self.original_bytes = self.package_path.read_bytes()

    def _snapshot(self):
        return {p.relative_to(self.root).as_posix(): p.read_bytes()
                for p in self.root.rglob("*") if p.is_file()}

    def _build(self, values=None):
        return self.apps.build_graph("switches", values, object_info={})

    def _spec(self):
        return self.apps.build_kapp_spec(str(self.package_path), object_info={})

    def _update(self, values):
        return self.apps.update_values("switches", values, object_info={})

    def _assert_graph(self, result, expected, disabled=()):
        self.assertIs(result.get("ok"), True, result)
        self.assertEqual(result["graph"], expected)
        self.assertEqual(result["node_count"], len(expected))
        self.assertCountEqual(result["disabled_nodes"], disabled)
        self.assertEqual(result["failed"], [])
        self.assertEqual(result["unknown_types"], {})

    def _assert_state(self, result, values):
        self.assertIs(result.get("ok"), True, result)
        self.assertEqual(result["persisted"], "sidecar")
        state_path = (self.root / result["state"]).resolve()
        self.assertEqual(state_path.parent, self.state_dir)
        self.assertEqual(list(self.state_dir.glob("*.json")), [state_path])
        stored = json.loads(state_path.read_bytes())
        self.assertEqual(stored["values"], values)
        self.assertEqual(stored["kedou_state"], 1)
        self.assertEqual(stored["app"], self.package_path.relative_to(self.root).as_posix())
        return state_path

    def test_spec_exposes_generic_boolean_toggles_before_parameters(self):
        payload = chain_kapp()
        payload["groups"].append({"id": "silent", "label": "Silent", "default": False,
                                  "mode": "mute", "nodes": ["2"]})
        self._install(payload)
        before = self._snapshot()
        spec = self._spec()
        self.assertEqual(spec["params"][:2], [
            {"node": "__group__", "input": "effect", "label": "Effect",
             "widget": "toggle", "kind": "bool", "spec": {"type": "BOOLEAN"},
             "default": True, "node_type": "", "node_title": "分组开关"},
            {"node": "__group__", "input": "silent", "label": "Silent",
             "widget": "toggle", "kind": "bool", "spec": {"type": "BOOLEAN"},
             "default": False, "node_type": "", "node_title": "分组开关"},
        ])
        self.assertEqual([p["node"] + ":" + p["input"] for p in spec["params"]],
                         ["__group__:effect", "__group__:silent", "2:strength"])
        self.assertEqual(spec["param_count"], 3)
        self.assertEqual(spec["node_count"], 3)
        self.assertEqual(self._snapshot(), before)

    def test_enabled_or_default_true_keeps_the_complete_graph(self):
        for mode in ("bypass", "mute"):
            for values in (None, {}, {"__group__:effect": True}):
                with self.subTest(mode=mode, values=values):
                    payload = chain_kapp()
                    payload["groups"][0]["mode"] = mode
                    self._install(payload)
                    before = self._snapshot()
                    result = self._build(values)
                    self._assert_graph(result, CHAIN_ON)
                    self.assertEqual(result["applied"], list(values or {}))
                    self.assertEqual(self._snapshot(), before)

    def test_bypass_off_reconnects_then_on_restores_original_link(self):
        result = self._build({"__group__:effect": False})
        self._assert_graph(result, CHAIN_BYPASSED, ["2"])
        self.assertEqual(result["applied"], ["__group__:effect"])
        self._assert_graph(self._build({"__group__:effect": True}), CHAIN_ON)
        self._assert_graph(self._build(), CHAIN_ON)

    def test_mute_off_removes_only_the_disabled_node_and_its_link(self):
        payload = chain_kapp()
        payload["groups"][0]["mode"] = "mute"
        self._install(payload)
        self._assert_graph(self._build({"__group__:effect": False}), CHAIN_MUTED, ["2"])
        self._assert_graph(self._build({"__group__:effect": True}), CHAIN_ON)

    def test_default_false_applies_without_a_request_switch(self):
        for mode, expected in (("bypass", CHAIN_BYPASSED), ("mute", CHAIN_MUTED)):
            with self.subTest(mode=mode):
                payload = chain_kapp()
                payload["groups"][0].update(default=False, mode=mode)
                self._install(payload)
                self.assertIs(self._spec()["params"][0]["default"], False)
                self._assert_graph(self._build(), expected, ["2"])
                self._assert_graph(self._build({"__group__:effect": True}), CHAIN_ON)

    def test_sidecar_false_overrides_default_and_request_true_overrides_sidecar(self):
        saved = self._update({"__group__:effect": False})
        self.assertEqual(saved["changed"], ["__group__:effect"])
        self.assertEqual(saved["failed"], [])
        self._assert_state(saved, {"__group__:effect": False})
        before = self._snapshot()
        self.assertIs(self._spec()["params"][0]["default"], False)
        self._assert_graph(self._build(), CHAIN_BYPASSED, ["2"])
        self._assert_graph(self._build({"__group__:effect": True}), CHAIN_ON)
        self._assert_graph(self._build(), CHAIN_BYPASSED, ["2"])
        self.assertEqual(self._snapshot(), before, "request overrides must not persist")

    def test_sidecar_true_overrides_default_false_and_request_false_wins(self):
        payload = chain_kapp()
        payload["groups"][0]["default"] = False
        self._install(payload)
        self._assert_state(self._update({"__group__:effect": True}), {"__group__:effect": True})
        before = self._snapshot()
        self.assertIs(self._spec()["params"][0]["default"], True)
        self._assert_graph(self._build(), CHAIN_ON)
        self._assert_graph(self._build({"__group__:effect": False}), CHAIN_BYPASSED, ["2"])
        self.assertEqual(self._snapshot(), before)

    def test_sidecar_merges_switch_and_parameter_updates_without_losing_values(self):
        self._assert_state(self._update({"2:strength": 0.8}), {"2:strength": 0.8})
        self._assert_state(self._update({"__group__:effect": False}),
                           {"2:strength": 0.8, "__group__:effect": False})
        result = self._build()
        self._assert_graph(result, CHAIN_BYPASSED, ["2"])
        self.assertEqual(result["applied"], ["__group__:effect"])
        self.assertEqual(result["skipped"], [{"key": "2:strength", "why": "节点所在分组已关闭"}])
        self._assert_state(self._update({"__group__:effect": True}),
                           {"2:strength": 0.8, "__group__:effect": True})
        expected = {
            "1": {"class_type": "GroupSource", "inputs": {"value": "original"}},
            "2": {"class_type": "GroupEffect", "inputs": {"image": ["1", 0], "strength": 0.8}},
            "3": {"class_type": "GroupSink", "inputs": {"image": ["2", 0], "prefix": "output"}},
        }
        self._assert_graph(self._build(), expected)
        self.assertEqual(self._spec()["params"][1]["default"], 0.8)

    def test_two_serial_bypass_groups_resolve_to_original_source(self):
        payload = chain_kapp()
        payload["graph"]["4"] = {"class_type": "GroupEffect",
                                   "inputs": {"image": ["2", 0], "strength": 0.25}}
        payload["graph"]["3"]["inputs"]["image"] = ["4", 0]
        payload["group_nodes"]["4"] = {
            "inputs": [{"name": "image", "type": "IMAGE"}], "outputs": ["IMAGE"],
        }
        payload["groups"].append({"id": "second", "label": "Second", "default": True,
                                  "mode": "bypass", "nodes": ["4"]})
        self._install(payload)
        self._assert_graph(self._build({"__group__:effect": False, "__group__:second": False}),
                           CHAIN_BYPASSED, ["2", "4"])
        self._assert_graph(self._build({"__group__:effect": False}), {
            "1": {"class_type": "GroupSource", "inputs": {"value": "original"}},
            "4": {"class_type": "GroupEffect", "inputs": {"image": ["1", 0], "strength": 0.25}},
            "3": {"class_type": "GroupSink", "inputs": {"image": ["4", 0], "prefix": "output"}},
        }, ["2"])

    def test_overlap_mute_wins_regardless_of_group_order(self):
        for reverse in (False, True):
            payload = chain_kapp()
            payload["groups"].append({"id": "silent", "label": "Silent", "default": True,
                                      "mode": "mute", "nodes": ["2"]})
            if reverse:
                payload["groups"].reverse()
            self._install(payload)
            for bypass, mute, expected, disabled in (
                (True, True, CHAIN_ON, []),
                (False, True, CHAIN_BYPASSED, ["2"]),
                (True, False, CHAIN_MUTED, ["2"]),
                (False, False, CHAIN_MUTED, ["2"]),
            ):
                with self.subTest(reverse=reverse, bypass=bypass, mute=mute):
                    self._assert_graph(self._build({"__group__:effect": bypass,
                                                    "__group__:silent": mute}), expected, disabled)

    def test_mute_does_not_cascade_delete_downstream_nodes(self):
        payload = chain_kapp()
        payload["groups"][0]["mode"] = "mute"
        payload["graph"]["4"] = {"class_type": "GroupEffect",
                                   "inputs": {"image": ["2", 0], "strength": 0.25}}
        payload["graph"]["3"]["inputs"]["image"] = ["4", 0]
        payload["group_nodes"]["4"] = {
            "inputs": [{"name": "image", "type": "IMAGE"}], "outputs": ["IMAGE"],
        }
        self._install(payload)
        self._assert_graph(self._build({"__group__:effect": False}), {
            "1": {"class_type": "GroupSource", "inputs": {"value": "original"}},
            "4": {"class_type": "GroupEffect", "inputs": {"strength": 0.25}},
            "3": {"class_type": "GroupSink", "inputs": {"image": ["4", 0], "prefix": "output"}},
        }, ["2"])

    def test_multitype_socket_fallback_uses_compatible_input_not_first_input(self):
        for input_type, output_type, target_type in (
            ("IMAGE", "IMAGE", "IMAGE"),
            (" MASK, IMAGE ", "IMAGE", "IMAGE"),
            ("IMAGE", "MASK, IMAGE", "IMAGE, MASK"),
            ("*", "IMAGE", "IMAGE"),
        ):
            with self.subTest(input_type=input_type, output_type=output_type, target=target_type):
                payload = mux_kapp()
                payload["graph"]["3"]["inputs"]["left"] = ["1", 1]
                ports = payload["group_nodes"]["3"]
                ports["inputs"][0]["type"] = "MASK"
                ports["inputs"][1]["type"] = input_type
                ports["outputs"][0] = output_type
                payload["group_nodes"]["4"]["inputs"][0]["type"] = target_type
                # For a union target, MASK is also compatible: make left AUDIO
                # so this case actually exercises fallback rather than same-slot.
                if target_type == "IMAGE, MASK":
                    ports["inputs"][0]["type"] = "AUDIO"
                    payload["group_nodes"]["1"]["outputs"][1] = "AUDIO"
                self._install(payload)
                self._assert_graph(self._build(), {
                    "1": {"class_type": "GroupSource", "inputs": {"value": "left"}},
                    "2": {"class_type": "GroupSource", "inputs": {"value": "right"}},
                    "4": {"class_type": "GroupSink", "inputs": {"image": ["2", 0], "prefix": "output"}},
                }, ["3"])

    def test_same_slot_has_priority_over_earlier_exact_type_match(self):
        payload = mux_kapp()
        payload["graph"]["4"]["inputs"]["image"] = ["3", 1]
        # A compatible union at the same slot beats an earlier exact IMAGE.
        payload["group_nodes"]["3"]["inputs"][1]["type"] = "IMAGE, MASK"
        self._install(payload)
        self._assert_graph(self._build(), {
            "1": {"class_type": "GroupSource", "inputs": {"value": "left"}},
            "2": {"class_type": "GroupSource", "inputs": {"value": "right"}},
            "4": {"class_type": "GroupSink", "inputs": {"image": ["2", 0], "prefix": "output"}},
        }, ["3"])

    def test_no_compatible_socket_removes_link_instead_of_guessing(self):
        payload = mux_kapp()
        payload["graph"]["3"]["inputs"] = {"left": ["1", 1], "right": ["2", 1]}
        for port in payload["group_nodes"]["3"]["inputs"]:
            port["type"] = "MASK"
        self._install(payload)
        self._assert_graph(self._build(), {
            "1": {"class_type": "GroupSource", "inputs": {"value": "left"}},
            "2": {"class_type": "GroupSource", "inputs": {"value": "right"}},
            "4": {"class_type": "GroupSink", "inputs": {"prefix": "output"}},
        }, ["3"])

    def test_matching_unconnected_socket_never_falls_back_to_another_connected_socket(self):
        for matching_slot in (0, 1):
            for unconnected in ("missing", "literal"):
                with self.subTest(matching_slot=matching_slot, unconnected=unconnected):
                    payload = mux_kapp()
                    inputs = payload["graph"]["3"]["inputs"]
                    ports = payload["group_nodes"]["3"]["inputs"]
                    if matching_slot == 1:
                        inputs["left"] = ["1", 1]
                        ports[0]["type"] = "MASK"
                        ports.append({"name": "spare", "type": "IMAGE"})
                        inputs["spare"] = ["1", 0]
                    chosen = ("left", "right")[matching_slot]
                    if unconnected == "missing":
                        del inputs[chosen]
                    else:
                        inputs[chosen] = "not a link"
                    self._install(payload)
                    self._assert_graph(self._build(), {
                        "1": {"class_type": "GroupSource", "inputs": {"value": "left"}},
                        "2": {"class_type": "GroupSource", "inputs": {"value": "right"}},
                        "4": {"class_type": "GroupSink", "inputs": {"prefix": "output"}},
                    }, ["3"])

    def test_unknown_switch_is_rejected_by_build_and_update_without_persistence(self):
        self._assert_state(self._update({"__group__:effect": True}), {"__group__:effect": True})
        for invoke in (self._build, self._update):
            with self.subTest(entry=invoke.__name__):
                before = self._snapshot()
                result = invoke({"__group__:unknown": False})
                self.assertIs(result.get("ok"), False, result)
                self.assertEqual(result["failed"], [{"key": "__group__:unknown", "why": "未知分组"}])
                self.assertEqual(self._snapshot(), before)

    def test_non_bool_switches_are_rejected_including_zero_and_one(self):
        self._assert_state(self._update({"__group__:effect": True}), {"__group__:effect": True})
        for value in (0, 1, 0.0, 1.0, "false", "true", None, [], {}):
            for invoke in (self._build, self._update):
                with self.subTest(value=value, entry=invoke.__name__):
                    before = self._snapshot()
                    result = invoke({"__group__:effect": value})
                    self.assertIs(result.get("ok"), False, result)
                    self.assertEqual(result["failed"], [
                        {"key": "__group__:effect", "why": "分组开关必须是 bool"},
                    ])
                    self.assertEqual(self._snapshot(), before)

    def test_bypass_cycles_report_explicit_errors_without_a_graph(self):
        for upstream, markers in (("2", ("2[0]",)), ("1", ("1[0]", "2[0]"))):
            with self.subTest(upstream=upstream):
                payload = chain_kapp()
                payload["graph"]["1"] = {"class_type": "GroupEffect",
                                           "inputs": {"image": ["2", 0], "strength": 0.25}}
                payload["group_nodes"]["1"] = {
                    "inputs": [{"name": "image", "type": "IMAGE"}], "outputs": ["IMAGE"],
                }
                payload["graph"]["2"]["inputs"]["image"] = [upstream, 0]
                payload["groups"][0]["nodes"] = ["1", "2"]
                self._install(payload)
                before = self._snapshot()
                result = self._build({"__group__:effect": False})
                self.assertIs(result.get("ok"), False, result)
                self.assertIn("bypass", result.get("error", ""))
                self.assertIn("环", result["error"])
                for marker in markers:
                    self.assertIn(marker, result["error"])
                self.assertNotIn("graph", result)
                self.assertEqual(self._snapshot(), before)

    def test_disabling_every_node_returns_error_not_an_empty_successful_graph(self):
        for mode in ("bypass", "mute"):
            with self.subTest(mode=mode):
                payload = chain_kapp()
                payload["groups"] = [
                    {"id": "first", "label": "First", "default": False,
                     "mode": mode, "nodes": ["1", "2"]},
                    {"id": "last", "label": "Last", "default": False,
                     "mode": mode, "nodes": ["3"]},
                ]
                self._install(payload)
                result = self._build()
                self.assertIs(result.get("ok"), False, result)
                self.assertIn("没有可执行节点", result.get("error", ""))
                self.assertNotIn("graph", result)

    def test_subgraph_string_id_parameter_injection_and_state_round_trip(self):
        payload = chain_kapp()
        payload["graph"]["10:2"] = payload["graph"].pop("2")
        payload["graph"]["3"]["inputs"]["image"] = ["10:2", 0]
        payload["group_nodes"]["10:2"] = payload["group_nodes"].pop("2")
        payload["groups"][0]["nodes"] = ["10:2"]
        payload["params"][0]["node"] = "10:2"
        self._install(payload)
        expected = {
            "1": {"class_type": "GroupSource", "inputs": {"value": "original"}},
            "10:2": {"class_type": "GroupEffect", "inputs": {"image": ["1", 0], "strength": 0.9}},
            "3": {"class_type": "GroupSink", "inputs": {"image": ["10:2", 0], "prefix": "output"}},
        }
        direct = self._build({"10:2:strength": 0.9})
        self._assert_graph(direct, expected)
        self.assertEqual(direct["applied"], ["10:2:strength"])
        self.assertFalse(self.state_dir.exists())
        saved = self._update({"10:2:strength": 0.9, "__group__:effect": False})
        self._assert_state(saved, {"10:2:strength": 0.9, "__group__:effect": False})
        self.assertCountEqual(saved["changed"], ["10:2:strength", "__group__:effect"])
        self.assertEqual(self._spec()["params"][1]["node"], "10:2")
        self.assertEqual(self._spec()["params"][1]["default"], 0.9)
        disabled = self._build()
        self._assert_graph(disabled, CHAIN_BYPASSED, ["10:2"])
        self.assertEqual(disabled["skipped"], [
            {"key": "10:2:strength", "why": "节点所在分组已关闭"},
        ])
        before = self._snapshot()
        self._assert_graph(self._build({"__group__:effect": True}), expected)
        requested = copy.deepcopy(expected)
        requested["10:2"]["inputs"]["strength"] = 0.3
        self._assert_graph(self._build({"__group__:effect": True, "10:2:strength": 0.3}), requested)
        self.assertEqual(self._snapshot(), before)
        self._assert_state(self._update({"__group__:effect": True}),
                           {"10:2:strength": 0.9, "__group__:effect": True})
        self._assert_graph(self._build(), expected)

    def test_save_round_trip_preserves_groups_and_ports_for_all_api_nodes(self):
        self.read_only = False  # This test explicitly exercises archive writes.
        payload = chain_kapp()
        payload["groups"][0]["default"] = False
        before_payload = copy.deepcopy(payload)
        result = self.pack.save_kapp("switches", "", payload,
                                     target="kedou_apps/switches.kapp.json")
        self.assertIs(result.get("ok"), True, result)
        stored = json.loads(self.package_path.read_bytes())
        self.assertEqual(stored, before_payload)
        self.assertEqual(payload, before_payload)
        self.assertEqual(set(stored["group_nodes"]), {"1", "2", "3"})
        self.assertEqual(result["param_count"], 2)
        self.assertEqual(result["warnings"], [])
        self.assertIs(self._spec()["params"][0]["default"], False)
        self._assert_graph(self._build(), CHAIN_BYPASSED, ["2"])
        original = self.package_path.read_bytes()
        self._assert_state(self._update({"__group__:effect": True}), {"__group__:effect": True})
        self._assert_graph(self._build(), CHAIN_ON)
        self.assertEqual(self.package_path.read_bytes(), original)

    def test_save_rejects_malformed_groups_and_ports_without_touching_original_files(self):
        self._write_json(self.workflow_path, {"nodes": [{"id": 1}], "extra": {"note": "original"}})
        self._assert_state(self._update({"__group__:effect": True}), {"__group__:effect": True})
        base = chain_kapp()
        delete = object()
        cases = [
            ("groups object", ("groups",), {}, "groups"),
            ("groups null", ("groups",), None, "groups"),
            ("non-object entry", ("groups", 0), "effect", "条目"),
            ("missing id", ("groups", 0, "id"), delete, "id"),
            ("blank id", ("groups", 0, "id"), " ", "id"),
            ("numeric id", ("groups", 0, "id"), 2, "id"),
            ("colon id", ("groups", 0, "id"), "a:b", "id"),
            ("duplicate id", ("groups",), [base["groups"][0], base["groups"][0]], "重复"),
            ("missing label", ("groups", 0, "label"), delete, "label"),
            ("blank label", ("groups", 0, "label"), " ", "label"),
            ("non-string label", ("groups", 0, "label"), False, "label"),
            ("missing default", ("groups", 0, "default"), delete, "bool"),
            ("integer default", ("groups", 0, "default"), 1, "bool"),
            ("string default", ("groups", 0, "default"), "false", "bool"),
            ("missing mode", ("groups", 0, "mode"), delete, "mode"),
            ("unsupported mode", ("groups", 0, "mode"), "delete", "mode"),
            ("missing nodes", ("groups", 0, "nodes"), delete, "nodes"),
            ("empty nodes", ("groups", 0, "nodes"), [], "nodes"),
            ("non-list nodes", ("groups", 0, "nodes"), "2", "nodes"),
            ("numeric node", ("groups", 0, "nodes"), [2], "字符串 ID"),
            ("blank node", ("groups", 0, "nodes"), [" "], "字符串 ID"),
            ("unknown node", ("groups", 0, "nodes"), ["999"], "999"),
            ("duplicate node", ("groups", 0, "nodes"), ["2", "2"], "重复"),
            ("missing metadata", ("group_nodes",), delete, "group_nodes"),
            ("non-object metadata", ("group_nodes",), [], "group_nodes"),
            ("missing controlled node ports", ("group_nodes", "2"), delete, "2"),
            ("missing uncontrolled source ports", ("group_nodes", "1"), delete, "1"),
            ("missing uncontrolled target ports", ("group_nodes", "3"), delete, "3"),
            ("unknown metadata node", ("group_nodes", "999"), {"inputs": [], "outputs": []}, "999"),
            ("non-object ports", ("group_nodes", "2"), [], "inputs"),
            ("missing inputs", ("group_nodes", "2", "inputs"), delete, "inputs"),
            ("non-list inputs", ("group_nodes", "2", "inputs"), {}, "inputs"),
            ("missing outputs", ("group_nodes", "2", "outputs"), delete, "outputs"),
            ("non-list outputs", ("group_nodes", "2", "outputs"), "IMAGE", "outputs"),
            ("non-string output type", ("group_nodes", "2", "outputs"), [1], "outputs"),
            ("non-object input", ("group_nodes", "2", "inputs", 0), "image", "socket"),
            ("missing input name", ("group_nodes", "2", "inputs", 0, "name"), delete, "name"),
            ("blank input name", ("group_nodes", "2", "inputs", 0, "name"), " ", "name"),
            ("duplicate input name", ("group_nodes", "2", "inputs"),
             [{"name": "image", "type": "IMAGE"}, {"name": "image", "type": "MASK"}], "name"),
            ("missing input type", ("group_nodes", "2", "inputs", 0, "type"), delete, "type"),
            ("non-string input type", ("group_nodes", "2", "inputs", 0, "type"), [], "type"),
            ("reserved graph id", ("graph", "__group__"),
             {"class_type": "GroupSource", "inputs": {"value": "reserved"}}, "保留 ID"),
        ]
        for label, path, value, error in cases:
            with self.subTest(case=label):
                payload = copy.deepcopy(base)
                target = payload
                for key in path[:-1]:
                    target = target[key]
                if value is delete:
                    del target[path[-1]]
                else:
                    target[path[-1]] = copy.deepcopy(value)
                before = self._snapshot()
                result = self.pack.save_kapp(
                    "switches", "", payload, target="kedou_apps/switches.kapp.json",
                    workflow={"nodes": [{"id": 99}], "extra": {"note": "must not be saved"}},
                )
                self.assertIs(result.get("ok"), False, result)
                self.assertIn(error, result.get("error", ""))
                self.assertEqual(self._snapshot(), before, label)

    def test_missing_required_input_remains_warning_for_legacy_and_grouped_packages(self):
        self.read_only = False
        self._write_json(self.workflow_path, {"nodes": [{"id": 1}], "extra": {"note": "keep"}})
        original_workflow = self.workflow_path.read_bytes()
        for grouped in (False, True):
            with self.subTest(grouped=grouped):
                payload = chain_kapp()
                del payload["graph"]["2"]["inputs"]["image"]
                if not grouped:
                    del payload["groups"]
                    del payload["group_nodes"]
                before_payload = copy.deepcopy(payload)
                result = self.pack.save_kapp("switches", "", payload,
                                             target="kedou_apps/switches.kapp.json")
                self.assertIs(result.get("ok"), True, result)
                self.assertEqual(len(result["warnings"]), 1)
                self.assertIn("节点 2", result["warnings"][0])
                self.assertIn("缺输入 image", result["warnings"][0])
                self.assertEqual(json.loads(self.package_path.read_bytes()), before_payload)
                self.assertEqual(self.workflow_path.read_bytes(), original_workflow)
                self.assertEqual(payload, before_payload)
                self.assertEqual(set(p for p in self.root.rglob("*") if p.is_file()),
                                 {self.workflow_path, self.package_path})


if __name__ == "__main__":
    unittest.main()

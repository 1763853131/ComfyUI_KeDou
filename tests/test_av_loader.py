# -*- coding: utf-8 -*-
"""KedouAVLoader 状态、32 槽输出、缓存签名、批次、内存和链接裁剪回归。"""

import copy
import importlib
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import call, patch
import wave


ROOT = Path(__file__).resolve().parents[1]
VIDEO_EXTS = (".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".ogv")


def load_nodes():
    name = "_kedou_av_loader_tests"
    package = ModuleType(name)
    package.__path__ = [str(ROOT / "kedou_bridge")]
    server = ModuleType("server")
    server.PromptServer = type("PromptServer", (), {"instance": None})
    nodes = ModuleType("nodes")
    nodes.NODE_CLASS_MAPPINGS = {}
    with patch.dict(sys.modules, {name: package, "server": server, "nodes": nodes,
                                  "folder_paths": None, "torch": None}):
        return importlib.import_module(name + ".nodes")


def item(filename, tab="input", extract=False, trim_start=0, trim_end=None):
    return {"id": "%s|%s" % (tab, filename), "filename": filename, "tab": tab,
            "kind": "video" if os.path.splitext(filename)[1].lower() in VIDEO_EXTS else "audio",
            "extract_audio": extract, "trim_start": trim_start, "trim_end": trim_end}


def state(videos=None, audios=None, mode="video", **kw):
    out = {"v": 2, "kind": "av", "videos": [] if videos is None else videos,
           "audios": [] if audios is None else audios, "picked_videos": [], "picked_audios": [],
           "select": False, "batch": False, "cursor": 0, "output_mode": mode,
           "frame_options": {"start_frame": 0, "max_frames": 16,
                             "frame_step": 1, "max_side": 512}}
    out.update(kw)
    return out


class FakeWaveform:
    def __init__(self, nbytes=0):
        self.nbytes = nbytes
        self.dim = None

    def unsqueeze(self, dim):
        self.dim = dim
        return self


class FakeFrames:
    def __init__(self, nbytes, label="frames"):
        self.nbytes = nbytes
        self.label = label


class FakeContainer:
    def __init__(self, streams, duration=None, frames=None):
        self.streams = streams
        self.duration = duration
        self.frames = frames or []
        self.seek_calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def seek(self, offset, **kwargs):
        self.seek_calls.append((offset, kwargs))

    def decode(self, _stream):
        return iter(self.frames)


def fake_av_module(*streams, duration=None, frames=None):
    module = ModuleType("av")
    module.time_base = 1000000
    module.error = SimpleNamespace(FFmpegError=RuntimeError)
    module.open = lambda *_args, **_kw: FakeContainer(list(streams), duration, frames)
    return module


def fake_audio_stream(duration=1, rate=8000, channels=2):
    return SimpleNamespace(type="audio", duration=duration, time_base=1,
                           channels=channels,
                           codec_context=SimpleNamespace(sample_rate=rate))


class FakeVideoFrame:
    def __init__(self, array, rotation=0, time=None):
        self.array = array
        self.height, self.width = array.shape[:2]
        self.rotation = rotation
        self.time = time
        self.conversions = 0

    def to_ndarray(self, format=None):
        self.conversions += 1
        return self.array


class AVLoaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.nodes = load_nodes()

    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="kedou_av_loader_")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.input = root / "input"
        self.output = root / "output"
        self.input.mkdir()
        self.output.mkdir()
        for filename in ("clip.mp4", "second.mp4", "third.webm"):
            (self.input / filename).write_bytes(("video fixture: " + filename).encode())
        for filename in ("voice.wav", "music.mp3"):
            (self.input / filename).write_bytes(("audio fixture: " + filename).encode())
        (self.output / "clip.mp4").write_bytes(b"output video fixture")
        dirs = patch.object(self.nodes.media, "_media_dirs",
                            lambda: (str(self.input), str(self.output)))
        dirs.start()
        self.addCleanup(dirs.stop)

    def audio_module(self, waveform=None, rate=44100):
        module = ModuleType("comfy_extras.nodes_audio")
        waveform = waveform or FakeWaveform(1)
        module.load = lambda _path: (waveform, rate)
        return module, waveform

    def video_module(self):
        module = ModuleType("comfy_api.latest")
        module.InputImpl = SimpleNamespace(VideoFromFile=lambda path: ("video", path))
        return module

    def test_defaults_and_normalized_internal_fields(self):
        parsed = self.nodes.av_state.parse_av_state(state([item("clip.mp4")], [item("voice.wav")]))
        self.assertEqual(parsed["videos"][0]["id"], "input|clip.mp4")
        self.assertEqual(parsed["videos"][0]["trim_start"], 0)
        self.assertIsNone(parsed["videos"][0]["trim_end"])
        self.assertEqual(parsed["audios"][0]["trim_start"], 0)
        self.assertIsNone(parsed["audios"][0]["trim_end"])
        old_video = item("clip.mp4")
        old_video.pop("trim_start")
        old_video.pop("trim_end")
        old_parsed = self.nodes.av_state.parse_av_state(state([old_video]))
        self.assertEqual(old_parsed["videos"][0]["trim_start"], 0)
        self.assertIsNone(old_parsed["videos"][0]["trim_end"])
        self.assertEqual(parsed["effective_videos"], parsed["videos"])
        self.assertEqual(parsed["effective_audios"], parsed["audios"])
        self.assertEqual(parsed["current_pair"], {"video": parsed["videos"][0],
                                                  "audio": parsed["audios"][0]})
        self.assertEqual(parsed["pair_count"], 1)
        self.assertEqual(parsed["frame_options"], self.nodes.av_state.DEFAULT_FRAME_OPTIONS)
        self.assertFalse(parsed["select"])
        self.assertFalse(parsed["batch"])
        self.assertFalse(parsed["video_audio"])
        self.assertEqual(self.nodes.av_state.AV_SLOTS, 8)
        self.assertEqual(self.nodes.av_state.AV_ITEM_LIMIT, 500)
        self.assertEqual(self.nodes.av_state.AV_OUTPUT_SLOTS, 32)
        with self.assertRaisesRegex(ValueError, "v=2"):
            self.nodes.av_state.parse_av_state({"v": 1})
        with self.assertRaisesRegex(ValueError, "JSON"):
            self.nodes.av_state.parse_av_state("{")

    def test_legacy_top_level_and_pairs_migration(self):
        legacy = {"v": 2, "kind": "av", "video": item("clip.mp4"), "audio": item("voice.wav"),
                  "output_mode": "video", "frame_options": self.nodes.av_state.DEFAULT_FRAME_OPTIONS,
                  "batch": False, "cursor": 0, "pairs": []}
        parsed = self.nodes.av_state.parse_av_state(legacy)
        self.assertEqual([entry["filename"] for entry in parsed["videos"]], ["clip.mp4"])
        self.assertEqual([entry["filename"] for entry in parsed["audios"]], ["voice.wav"])

        first = {"video": item("clip.mp4"), "audio": item("voice.wav")}
        second = {"video": item("second.mp4"), "audio": item("music.mp3")}
        legacy["pairs"] = [first, second]
        parsed = self.nodes.av_state.parse_av_state(legacy)
        self.assertEqual(parsed["pair_count"], 1)   # 旧普通模式忽略面板残留的 pairs
        self.assertEqual(parsed["current_pair"]["video"]["filename"], "clip.mp4")
        legacy.update(batch=True, cursor=1, pairs=[first, second, first])
        parsed = self.nodes.av_state.parse_av_state(legacy)
        self.assertEqual([entry["filename"] for entry in parsed["videos"]],
                         ["clip.mp4", "second.mp4"])
        self.assertEqual([entry["filename"] for entry in parsed["audios"]],
                         ["voice.wav", "music.mp3"])
        self.assertEqual(parsed["current_pair"]["video"]["filename"], "second.mp4")
        self.assertEqual(parsed["current_pair"]["audio"]["filename"], "music.mp3")
        self.assertEqual(parsed["pair_count"], 1)       # 批次节点只露出一组

    def test_legacy_batch_keeps_original_pair_alignment(self):
        legacy = {"v": 2, "kind": "av", "output_mode": "video",
                  "frame_options": self.nodes.av_state.DEFAULT_FRAME_OPTIONS,
                  "batch": True, "cursor": 1, "pairs": [
                      {"video": item("clip.mp4"), "audio": item("voice.wav")},
                      {"video": item("clip.mp4"), "audio": item("music.mp3")},
                  ]}
        parsed = self.nodes.av_state.parse_av_state(legacy)
        self.assertEqual(parsed["current_pair"]["video"]["filename"], "clip.mp4")
        self.assertEqual(parsed["current_pair"]["audio"]["filename"], "music.mp3")
        self.assertEqual(parsed["pair_count"], 1)
        migrated = dict(legacy, videos=parsed["videos"], audios=parsed["audios"], legacy_pairs=True)
        reparsed = self.nodes.av_state.parse_av_state(migrated)
        self.assertEqual(reparsed["current_pair"]["video"]["filename"], "clip.mp4")
        self.assertEqual(reparsed["current_pair"]["audio"]["filename"], "music.mp3")

    def test_legacy_picked_filename_and_id_compatibility(self):
        legacy = {"v": 2, "kind": "av", "video": item("clip.mp4"), "audio": item("voice.wav"),
                  "output_mode": "video", "frame_options": self.nodes.av_state.DEFAULT_FRAME_OPTIONS,
                  "select": True, "picked": ["voice.wav", "input|clip.mp4"]}
        parsed = self.nodes.av_state.parse_av_state(legacy)
        self.assertEqual(parsed["picked_videos"], ["input|clip.mp4"])
        self.assertEqual(parsed["picked_audios"], ["input|voice.wav"])
        self.assertEqual(parsed["effective_videos"], parsed["videos"])
        self.assertEqual(parsed["effective_audios"], parsed["audios"])

    def test_slot_rules_and_safe_paths(self):
        invalid = (
            state([item("voice.wav")]),
            state([item("clip.mp4")], [item("clip.mp4")]),
            state([item("../clip.mp4")]),
            state([item("/clip.mp4")]),
            state([item("C:/clip.mp4")]),
            state([item("clip.txt")]),
            state([item("clip.mp4", "other")]),
            state(videos="clip.mp4"),
            state(audios={}),
            dict(state([item("clip.mp4")]), videos=None),
            state(select=1),
            state(video_audio=1),
            state(),
        )
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.nodes.av_state.parse_av_state(raw)
        parsed = self.nodes.av_state.parse_av_state(
            state([item("clip.mp4")], [item("clip.mp4", extract=True)]))
        self.assertEqual(parsed["audios"][0]["kind"], "video")
        self.assertTrue(parsed["audios"][0]["extract_audio"])

    def test_trim_defaults_validation_and_public_errors(self):
        invalid = (
            item("clip.mp4", trim_start=-0.1),
            item("clip.mp4", trim_start=True),
            item("clip.mp4", trim_start="1"),
            item("clip.mp4", trim_start=float("nan")),
            item("clip.mp4", trim_start=float("inf")),
            item("clip.mp4", trim_start=10 ** 400),
            item("clip.mp4", trim_start=None),
            item("clip.mp4", trim_end=-1),
            item("clip.mp4", trim_end=True),
            item("clip.mp4", trim_end=float("nan")),
            item("clip.mp4", trim_end=0),
            item("clip.mp4", trim_start=2, trim_end=2),
            item("clip.mp4", trim_start=2, trim_end=1),
        )
        for entry in invalid:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                self.nodes.av_state.parse_av_state(state([entry]))
        with self.assertRaisesRegex(ValueError, "trim_end"):
            self.nodes.av_state.parse_av_state(state(audios=[item("voice.wav", trim_end=-1)]))
        parsed = self.nodes.av_state.parse_av_state(state(
            [item("clip.mp4", trim_start=1.25, trim_end=4.5)],
            [item("voice.wav", trim_start=0.5, trim_end=None)]))
        self.assertEqual(parsed["videos"][0]["trim_start"], 1.25)
        self.assertEqual(parsed["videos"][0]["trim_end"], 4.5)
        self.assertEqual(parsed["audios"][0]["trim_start"], 0.5)
        self.assertIsNone(parsed["audios"][0]["trim_end"])
        self.assertIn("trim_end 必须大于 trim_start",
                      self.nodes.av_state.public_error("trim_end must be greater than trim_start"))
        self.assertIn("trim_start 必须是", self.nodes.av_state.public_error(
            "trim_start must be a finite number >= 0"))
        self.assertIn("trim_end 必须大于", self.nodes.KedouAVLoader.VALIDATE_INPUTS(
            json.dumps(state([item("clip.mp4", trim_start=2, trim_end=1)]))))
        self.assertIn("segment_id 只能包含", self.nodes.av_state.public_error(
            "segment_id must contain 1-64 letters, digits, underscores or hyphens"))

    def test_empty_and_frames_without_video_are_rejected(self):
        self.assertIn("至少选择一个视频或音频",
                      self.nodes.KedouAVLoader.VALIDATE_INPUTS(json.dumps(state())))
        self.assertIn("视频帧模式需要选择视频", self.nodes.KedouAVLoader.VALIDATE_INPUTS(
            json.dumps(state(audios=[item("voice.wav")], mode="frames"))))

    def test_partial_missing_media_keeps_slots_and_only_all_missing_is_rejected(self):
        (self.input / "ok.mp4").write_bytes(b"video fixture")
        raw = state([item("missing.mp4"), item("ok.mp4")])
        self.assertTrue(self.nodes.KedouAVLoader.VALIDATE_INPUTS(json.dumps(raw)))
        with patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}):
            out = self.nodes.KedouAVLoader()._load(raw)
        self.assertIsNone(out[0])
        self.assertEqual(out[1], ("video", str(self.input / "ok.mp4")))
        self.assertIn("找不到文件", self.nodes.KedouAVLoader.VALIDATE_INPUTS(
            json.dumps(state([item("missing.mp4")]))))

    def test_lists_deduplicate_and_cap_at_500_in_order(self):
        videos = [item("v%d.mp4" % index) for index in range(501)]
        videos.insert(3, item("v1.mp4"))
        parsed = self.nodes.av_state.parse_av_state(state(videos))
        self.assertEqual(len(parsed["videos"]), 500)
        self.assertEqual([entry["filename"] for entry in parsed["videos"]],
                         ["v%d.mp4" % index for index in range(500)])
        parsed = self.nodes.av_state.parse_av_state(state(
            audios=[item("voice.wav"), None, item("voice.wav"),
                    item("clip.mp4", extract=True), item("clip.mp4", extract=True)]))
        self.assertEqual([entry["id"] for entry in parsed["audios"]],
                         ["input|voice.wav", "input|clip.mp4"])

    def test_output_layout_four_mode_switch_combinations_and_batch(self):
        raw = state([item("clip.mp4"), item("second.mp4")],
                    [item("voice.wav"), item("music.mp3")])
        expected = {
            ("video", False): ["video_1", "video_2", "audio_1", "audio_2"],
            ("video", True): ["video_1", "video_audio_1", "video_2", "video_audio_2",
                              "audio_1", "audio_2"],
            ("frames", False): ["frames_1", "frames_2", "audio_1", "audio_2"],
            ("frames", True): ["frames_1", "video_audio_1", "frames_2", "video_audio_2",
                               "audio_1", "audio_2"],
        }
        for (mode, video_audio), keys in expected.items():
            with self.subTest(mode=mode, video_audio=video_audio):
                parsed = self.nodes.av_state.parse_av_state(
                    dict(raw, output_mode=mode, video_audio=video_audio))
                self.assertEqual(self.nodes.av_state.output_layout(parsed), keys)
        batch_expected = {
            ("video", False): ["video_1", "audio_1"],
            ("video", True): ["video_1", "video_audio_1", "audio_1"],
            ("frames", False): ["frames_1", "audio_1"],
            ("frames", True): ["frames_1", "video_audio_1", "audio_1"],
        }
        for (mode, video_audio), keys in batch_expected.items():
            with self.subTest(batch=True, mode=mode, video_audio=video_audio):
                parsed = self.nodes.av_state.parse_av_state(
                    dict(raw, output_mode=mode, video_audio=video_audio,
                         batch=True, cursor=1))
                self.assertEqual(self.nodes.av_state.output_layout(parsed), keys)
        audio_only = self.nodes.av_state.parse_av_state(state(
            audios=[item("voice.wav"), item("music.mp3")]))
        self.assertEqual(self.nodes.av_state.output_layout(audio_only), ["audio_1", "audio_2"])
        video_only_raw = state([item("clip.mp4"), item("second.mp4")])
        video_only_expected = {
            ("video", False): ["video_1", "video_2", "audio_1"],
            ("video", True): ["video_1", "video_audio_1", "video_2", "video_audio_2", "audio_1"],
            ("frames", False): ["frames_1", "frames_2", "audio_1"],
            ("frames", True): ["frames_1", "video_audio_1", "frames_2", "video_audio_2", "audio_1"],
        }
        for (mode, video_audio), keys in video_only_expected.items():
            with self.subTest(video_only=True, mode=mode, video_audio=video_audio):
                parsed = self.nodes.av_state.parse_av_state(
                    dict(video_only_raw, output_mode=mode, video_audio=video_audio))
                self.assertEqual(self.nodes.av_state.output_layout(parsed), keys)
        ordered = self.nodes.av_state.parse_av_state(state(
            [item("clip.mp4"), item("second.mp4")],
            port_order=["video_1", "audio_1", "video_2"]))
        self.assertEqual(self.nodes.av_state.output_layout(ordered),
                         ["video_1", "audio_1", "video_2"])

        empty = {"batch": False, "effective_videos": [], "effective_audios": [],
                 "output_mode": "video", "video_audio": True}
        self.assertEqual(self.nodes.av_state.output_layout(empty), [])
        empty_batch = dict(empty, batch=True, current_pair={"video": None, "audio": None})
        self.assertEqual(self.nodes.av_state.output_layout(empty_batch), [])

    def test_500_item_batch_keeps_full_queue_while_normal_layout_caps_at_eight(self):
        videos = [item("v%d.mp4" % index) for index in range(500)]
        audios = [item("a%d.wav" % index) for index in range(500)]
        batch = self.nodes.av_state.parse_av_state(state(videos, audios, batch=True, cursor=499))
        self.assertEqual(len(batch["videos"]), 500)
        self.assertEqual(len(batch["audios"]), 500)
        self.assertEqual(batch["pair_count"], 1)
        self.assertEqual(batch["current_pair"]["video"]["filename"], "v499.mp4")
        self.assertEqual(batch["current_pair"]["audio"]["filename"], "a499.wav")
        self.assertEqual(self.nodes.av_state.output_layout(batch), ["video_1", "audio_1"])
        normal = self.nodes.av_state.parse_av_state(state(videos, audios))
        self.assertEqual(normal["pair_count"], 8)
        layout = self.nodes.av_state.output_layout(normal)
        self.assertEqual(layout, (["video_%d" % index for index in range(1, 9)]
                                  + ["audio_%d" % index for index in range(1, 9)]))
        self.assertEqual(len(layout), 16)
        loader = self.nodes.KedouAVLoader()
        with patch.object(self.nodes, "_av_input_path", side_effect=lambda entry: entry["filename"]), \
                patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}):
            out = loader._load(state(videos, batch=True, cursor=499))
        self.assertEqual(len(out), 32)
        self.assertEqual(out[0], ("video", "v499.mp4"))
        self.assertTrue(all(value is None for value in out[1:]))

    def test_segment_ids_are_stable_deduplicated_and_legacy_picks_are_unambiguous(self):
        first = dict(item("clip.mp4"), segment_id="cut_a", trim_start=0, trim_end=1)
        duplicate = dict(item("clip.mp4"), segment_id="cut_a", trim_start=2, trim_end=3)
        second = dict(item("clip.mp4"), segment_id="cut_b", trim_start=3, trim_end=4)
        parsed = self.nodes.av_state.parse_av_state(state([first, duplicate, second]))
        self.assertEqual([entry["id"] for entry in parsed["videos"]], [
            "input|clip.mp4#cut_a", "input|clip.mp4#cut_b"])
        self.assertEqual([entry["source_id"] for entry in parsed["videos"]], [
            "input|clip.mp4", "input|clip.mp4"])
        self.assertEqual(parsed["videos"][0]["trim_end"], 1)  # 同 id 重复项保留第一项

        changed = dict(first, trim_start=0.5, trim_end=1.5)
        changed_parsed = self.nodes.av_state.parse_av_state(state([changed]))
        self.assertEqual(changed_parsed["videos"][0]["id"], "input|clip.mp4#cut_a")
        ordinary = self.nodes.av_state.parse_av_state(state([item("clip.mp4")]))["videos"][0]
        self.assertEqual(ordinary["id"], "input|clip.mp4")
        self.assertEqual(ordinary["source_id"], "input|clip.mp4")
        self.assertNotIn("segment_id", ordinary)

        unique = self.nodes.av_state.parse_av_state(state(
            [first], select=True, picked_videos=["input|clip.mp4", "clip.mp4",
                                                 "input|clip.mp4#cut_a"]))
        self.assertEqual(unique["picked_videos"], ["input|clip.mp4#cut_a"])
        self.assertEqual(unique["effective_videos"], unique["videos"])

        ambiguous = self.nodes.av_state.parse_av_state(state(
            [first, second], [item("voice.wav")], select=True,
            picked_videos=["input|clip.mp4", {"source_id": "input|clip.mp4"}],
            picked_audios=["input|voice.wav"]))
        self.assertEqual(ambiguous["picked_videos"], ["input|clip.mp4"])
        self.assertEqual(ambiguous["effective_videos"], [])

        for invalid in ("", "a/b", "a#b", "a" * 65, 1, None):
            with self.subTest(segment_id=invalid), self.assertRaisesRegex(ValueError, "segment_id"):
                self.nodes.av_state.parse_av_state(state(
                    [dict(item("clip.mp4"), segment_id=invalid)]))

    def test_select_orders_each_list_independently_without_implicit_select_all(self):
        raw = state([item("clip.mp4"), item("second.mp4"), item("third.webm")],
                    [item("voice.wav"), item("music.mp3")], select=True,
                    picked_videos=["input|third.webm", "input|clip.mp4", "input|third.webm"],
                    picked_audios=["input|music.mp3"])
        parsed = self.nodes.av_state.parse_av_state(raw)
        self.assertEqual([entry["filename"] for entry in parsed["effective_videos"]],
                         ["third.webm", "clip.mp4"])
        self.assertEqual([entry["filename"] for entry in parsed["effective_audios"]], ["music.mp3"])
        self.assertEqual(parsed["pair_count"], 2)
        self.assertEqual([entry["filename"] for entry in parsed["videos"]],
                         ["clip.mp4", "second.mp4", "third.webm"])

        raw["picked_videos"] = ["input|missing.mp4"]
        raw["picked_audios"] = ["input|missing.wav"]
        with self.assertRaisesRegex(ValueError, "at least one video or audio"):
            self.nodes.av_state.parse_av_state(raw)
        raw["picked_audios"] = ["input|music.mp3"]
        parsed = self.nodes.av_state.parse_av_state(raw)
        self.assertEqual(parsed["effective_videos"], [])
        self.assertEqual([entry["filename"] for entry in parsed["effective_audios"]], ["music.mp3"])

    def test_frame_parameter_validation_and_current_video_requirement(self):
        for key, value in (("max_frames", 129), ("frame_step", 61), ("max_side", 2049),
                           ("start_frame", 100001), ("max_frames", 0), ("frame_step", 0),
                           ("start_frame", -1), ("max_frames", 1.5), ("max_frames", True)):
            opts = dict(self.nodes.av_state.DEFAULT_FRAME_OPTIONS, **{key: value})
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.nodes.av_state.parse_av_state(
                    state([item("clip.mp4")], mode="frames", frame_options=opts))
        original = dict(self.nodes.av_state.DEFAULT_FRAME_OPTIONS, max_side=0)
        self.assertEqual(self.nodes.av_state.parse_av_state(
            state([item("clip.mp4")], mode="frames", frame_options=original))["frame_options"]["max_side"], 0)
        with self.assertRaisesRegex(ValueError, "frames mode requires"):
            self.nodes.av_state.parse_av_state(state(audios=[item("voice.wav")], mode="frames"))
        with self.assertRaisesRegex(ValueError, "frames mode requires"):
            self.nodes.av_state.parse_av_state(state(
                [item("clip.mp4")], [item("voice.wav"), item("music.mp3")],
                mode="frames", batch=True, cursor=1))
        parsed = self.nodes.av_state.parse_av_state(state(
            [item("clip.mp4")], [item("voice.wav"), item("music.mp3")], mode="frames"))
        self.assertEqual(parsed["pair_count"], 2)      # 第 2 组音频-only 在普通模式合法

    def test_normal_multi_group_outputs_always_return_32_items(self):
        loader = self.nodes.KedouAVLoader()
        audio_module, _waveform = self.audio_module()
        with patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}), \
                patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                patch.object(self.nodes, "_load_audio", side_effect=lambda path, memory_limit=None, **_kw: {
                    "waveform": FakeWaveform(1), "sample_rate": 44100, "path": path}):
            out = loader._load(state([item("clip.mp4"), item("second.mp4")], [item("voice.wav")]))
        self.assertIsInstance(out, tuple)
        self.assertEqual(len(out), 32)
        self.assertEqual(out[0], ("video", str(self.input / "clip.mp4")))
        self.assertEqual(out[1], ("video", str(self.input / "second.mp4")))
        self.assertEqual(out[2]["path"], str(self.input / "voice.wav"))
        self.assertTrue(all(value is None for value in out[3:]))

    def test_normal_output_caps_at_eight_groups(self):
        loader = self.nodes.KedouAVLoader()
        videos = []
        audios = []
        for index in range(10):
            video_filename = "group_%d.mp4" % index
            audio_filename = "group_%d.wav" % index
            (self.input / video_filename).write_bytes(b"video fixture")
            (self.input / audio_filename).write_bytes(b"audio fixture")
            videos.append(item(video_filename))
            audios.append(item(audio_filename))
        for video_audio in (False, True):
            with self.subTest(video_audio=video_audio), \
                    patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}), \
                    patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                    patch.object(self.nodes, "_load_audio", side_effect=lambda path, memory_limit=None, **_kw: {
                        "waveform": FakeWaveform(1), "sample_rate": 8000, "path": path}):
                out = loader._load(state(videos, audios, video_audio=video_audio))
            self.assertEqual(len(out), 32)
            expected = []
            for index in range(8):
                expected.append(("video", str(self.input / videos[index]["filename"])))
                if video_audio:
                    expected.append(str(self.input / videos[index]["filename"]))
            expected.extend(str(self.input / entry["filename"]) for entry in audios[:8])
            actual = [value["path"] if isinstance(value, dict) else value
                      for value in out[:len(expected)]]
            self.assertEqual(actual, expected)
            self.assertTrue(all(value is None for value in out[len(expected):]))

    def test_normal_audio_only_groups_return_audio_first_and_32_items(self):
        loader = self.nodes.KedouAVLoader()
        with patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                patch.object(self.nodes, "_load_audio", side_effect=lambda path, memory_limit=None, **_kw: {
                    "waveform": FakeWaveform(1), "sample_rate": 8000, "path": path}):
            out = loader._load(state(audios=[item("voice.wav"), item("music.mp3")]))
        self.assertEqual(len(out), 32)
        self.assertEqual(out[0]["path"], str(self.input / "voice.wav"))
        self.assertEqual(out[1]["path"], str(self.input / "music.mp3"))
        self.assertTrue(all(value is None for value in out[2:]))

    def test_select_output_order_matches_picked_order(self):
        loader = self.nodes.KedouAVLoader()
        raw = state([item("clip.mp4"), item("second.mp4")], select=True,
                    picked_videos=["input|second.mp4", "input|clip.mp4"])
        with patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}):
            out = loader._load(raw)
        self.assertEqual(out[0], ("video", str(self.input / "second.mp4")))
        self.assertEqual(out[1], ("video", str(self.input / "clip.mp4")))
        self.assertIsNone(out[2])
        self.assertEqual(sum(value is not None for value in out), 2)

    def test_each_pair_passes_its_own_trim_to_audio_frames_and_video(self):
        loader = self.nodes.KedouAVLoader()
        videos = [item("clip.mp4", trim_start=1, trim_end=2),
                  item("second.mp4", trim_start=3, trim_end=4)]
        audios = [item("voice.wav", trim_start=0.5, trim_end=1.5),
                  item("music.mp3", trim_start=2, trim_end=None)]

        def trimmed(path, trim_start=0, trim_end=None):
            return {"ok": True, "path": "%s|%s-%s" % (path, trim_start, trim_end),
                    "copied": trim_start > 0}

        with patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}), \
                patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                patch.object(self.nodes, "_load_audio", side_effect=lambda path, **_kw: {
                    "waveform": FakeWaveform(1), "sample_rate": 8000, "path": path}) as decode_audio, \
                patch.object(self.nodes.media, "trimmed_video", side_effect=trimmed) as trim_video:
            out = loader._load(state(videos, audios))
        self.assertEqual(out[0], ("video", str(self.input / "clip.mp4") + "|1.0-2.0"))
        self.assertEqual(out[1], ("video", str(self.input / "second.mp4") + "|3.0-4.0"))
        self.assertEqual(out[2]["path"], str(self.input / "voice.wav"))
        self.assertEqual(out[3]["path"], str(self.input / "music.mp3"))
        self.assertEqual(decode_audio.call_args_list, [
            call(str(self.input / "voice.wav"), memory_limit=self.nodes.AV_MEMORY_LIMIT,
                 trim_start=0.5, trim_end=1.5),
            call(str(self.input / "music.mp3"), memory_limit=self.nodes.AV_MEMORY_LIMIT - 1,
                 trim_start=2.0, trim_end=None),
        ])
        self.assertEqual(trim_video.call_args_list, [
            call(str(self.input / "clip.mp4"), trim_start=1.0, trim_end=2.0),
            call(str(self.input / "second.mp4"), trim_start=3.0, trim_end=4.0),
        ])

        raw = state(videos, audios, mode="frames", batch=True, cursor=1)
        with patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                patch.object(self.nodes, "_load_audio", return_value={
                    "waveform": FakeWaveform(1), "sample_rate": 8000, "path": str(self.input / "music.mp3")}) as decode_audio, \
                patch.object(self.nodes, "_video_frames", return_value=FakeFrames(1)) as decode_frames:
            out = loader._load(raw)
        self.assertEqual(out[0].label, "frames")
        self.assertEqual(out[1]["path"], str(self.input / "music.mp3"))
        decode_audio.assert_called_once_with(str(self.input / "music.mp3"),
                                             memory_limit=self.nodes.AV_MEMORY_LIMIT,
                                             trim_start=2.0, trim_end=None)
        decode_frames.assert_called_once_with(str(self.input / "second.mp4"), raw["frame_options"],
                                              memory_limit=self.nodes.AV_MEMORY_LIMIT - 1,
                                              trim_start=3.0, trim_end=4.0)

    def test_video_trim_failure_is_reported_to_node_user(self):
        loader = self.nodes.KedouAVLoader()
        with patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}), \
                patch.object(self.nodes.media, "trimmed_video", return_value={
                    "ok": False, "error": "无法裁剪视频（边界按关键帧近似）"}), \
                self.assertRaisesRegex(ValueError, "无法裁剪视频"):
            loader.load(state([item("clip.mp4", trim_start=1, trim_end=2)]))

    def test_batch_cursor_outputs_only_current_group_to_first_slots(self):
        loader = self.nodes.KedouAVLoader()
        raw = state([item("clip.mp4"), item("second.mp4")],
                    [item("voice.wav"), item("music.mp3")], batch=True, cursor=1)
        with patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}), \
                patch.object(self.nodes, "_audio_memory_estimate", return_value=1) as estimate, \
                patch.object(self.nodes, "_load_audio", side_effect=lambda path, memory_limit=None, **_kw: {
                    "waveform": FakeWaveform(1), "sample_rate": 8000, "path": path}) as decode:
            out = loader._load(raw)
        self.assertEqual(len(out), 32)
        self.assertEqual(out[0], ("video", str(self.input / "second.mp4")))
        self.assertEqual(out[1]["path"], str(self.input / "music.mp3"))
        self.assertTrue(all(value is None for value in out[2:]))
        estimate.assert_called_once()
        decode.assert_called_once()

    def test_batch_allows_current_group_missing_one_side(self):
        loader = self.nodes.KedouAVLoader()
        raw = state([item("clip.mp4")], [item("voice.wav"), item("music.mp3")],
                    batch=True, cursor=1)
        with patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                patch.object(self.nodes, "_load_audio", side_effect=lambda path, memory_limit=None, **_kw: {
                    "waveform": FakeWaveform(1), "sample_rate": 8000, "path": path}):
            out = loader._load(raw)
        self.assertEqual(out[0]["path"], str(self.input / "music.mp3"))
        self.assertTrue(all(value is None for value in out[1:]))
        raw = state([item("clip.mp4"), item("second.mp4")], [item("voice.wav")],
                    batch=True, cursor=1)
        with patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}):
            out = loader._load(raw)
        self.assertEqual(out[0], ("video", str(self.input / "second.mp4")))
        self.assertTrue(all(value is None for value in out[1:]))

    def test_batch_cursor_validation_uses_longest_effective_list(self):
        raw = state([item("clip.mp4")], [item("voice.wav"), item("music.mp3")],
                    batch=True, cursor=1)
        parsed = self.nodes.av_state.parse_av_state(raw)
        self.assertEqual(parsed["current_pair"], {"video": None, "audio": parsed["audios"][1]})
        with self.assertRaisesRegex(ValueError, "cursor is outside"):
            self.nodes.av_state.parse_av_state(dict(raw, cursor=2))
        selected = state([item("clip.mp4"), item("second.mp4")],
                         [item("voice.wav"), item("music.mp3")], select=True,
                         picked_videos=["input|second.mp4"], picked_audios=["input|music.mp3"],
                         batch=True, cursor=1)
        with self.assertRaisesRegex(ValueError, "cursor is outside"):
            self.nodes.av_state.parse_av_state(selected)

    def test_frames_mode_outputs_frames_and_independent_audio(self):
        loader = self.nodes.KedouAVLoader()
        opts = dict(self.nodes.av_state.DEFAULT_FRAME_OPTIONS, start_frame=2, frame_step=3)
        raw = state([item("clip.mp4"), item("second.mp4")], [item("voice.wav")],
                    mode="frames", frame_options=opts)
        with patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                patch.object(self.nodes, "_load_audio", side_effect=lambda path, memory_limit=None, **_kw: {
                    "waveform": FakeWaveform(1), "sample_rate": 8000}), \
                patch.object(self.nodes, "_video_frames", side_effect=[
                    FakeFrames(10, "first"), FakeFrames(20, "second")]) as decode:
            out = loader._load(raw)
        self.assertEqual(out[0].label, "first")
        self.assertEqual(out[1].label, "second")
        self.assertIsNotNone(out[2])
        self.assertTrue(all(value is None for value in out[3:]))
        self.assertEqual(decode.call_args_list, [
            call(str(self.input / "clip.mp4"), opts, memory_limit=self.nodes.AV_MEMORY_LIMIT - 1,
                 trim_start=0.0, trim_end=None),
            call(str(self.input / "second.mp4"), opts,
                 memory_limit=self.nodes.AV_MEMORY_LIMIT - 11, trim_start=0.0, trim_end=None),
        ])

    def test_frames_mode_allows_later_audio_only_group(self):
        loader = self.nodes.KedouAVLoader()
        raw = state([item("clip.mp4")], [item("voice.wav"), item("music.mp3")], mode="frames")
        with patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                patch.object(self.nodes, "_load_audio", side_effect=lambda path, memory_limit=None, **_kw: {
                    "waveform": FakeWaveform(1), "sample_rate": 8000}), \
                patch.object(self.nodes, "_video_frames", return_value=FakeFrames(10)) as decode:
            out = loader._load(raw)
        self.assertEqual(out[0].label, "frames")
        self.assertIsNotNone(out[1])
        self.assertIsNotNone(out[2])
        self.assertTrue(all(value is None for value in out[3:]))
        decode.assert_called_once()

    def test_public_error_wrapper_is_preserved(self):
        loader = self.nodes.KedouAVLoader()
        with self.assertRaisesRegex(ValueError, "media_state 不是有效的 JSON"):
            loader.load("{")
        with self.assertRaisesRegex(ValueError, "not valid JSON"):
            loader._load("{")

    def test_video_audio_extraction_uses_official_loader(self):
        audio_module, waveform = self.audio_module(rate=22050)
        with patch.dict(sys.modules, {"comfy_extras.nodes_audio": audio_module,
                                      "av": fake_av_module(fake_audio_stream())}):
            result = self.nodes._load_audio(str(self.input / "clip.mp4"))
        self.assertEqual(result, {"waveform": waveform, "sample_rate": 22050})
        self.assertEqual(waveform.dim, 0)

    def test_audio_trim_slices_exact_samples_and_checks_sliced_bytes(self):
        import torch

        source = torch.arange(32, dtype=torch.float32).reshape(2, 16)
        audio_module = ModuleType("comfy_extras.nodes_audio")
        audio_module.load = lambda _path: (source, 8)
        path = str(self.input / "voice.wav")
        cases = ((0.25, 0.75, 2, 6), (0.5, None, 4, 16), (0, 0.25, 0, 2))
        for start, end, first, last in cases:
            with self.subTest(start=start, end=end), patch.dict(
                    sys.modules, {"comfy_extras.nodes_audio": audio_module}), \
                    patch.object(self.nodes, "_audio_memory_estimate", return_value=1) as estimate:
                result = self.nodes._load_audio(path, memory_limit=1024,
                                                trim_start=start, trim_end=end)
            self.assertEqual(tuple(result["waveform"].shape), (1, 2, last - first))
            self.assertTrue(torch.equal(result["waveform"][0], source[:, first:last]))
            self.assertEqual(result["sample_rate"], 8)
            estimate.assert_called_once_with(path, 1024)  # 峰值预算仍按原文件全解码
        with patch.dict(sys.modules, {"comfy_extras.nodes_audio": audio_module}), \
                patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                self.assertRaisesRegex(ValueError, "estimated audio memory"):
            self.nodes._load_audio(path, memory_limit=31, trim_start=0.25, trim_end=0.75)
        with patch.object(self.nodes, "_audio_memory_estimate") as estimate, \
                self.assertRaisesRegex(ValueError, "trim_end"):
            self.nodes._load_audio(path, trim_start=1, trim_end=1)
        estimate.assert_not_called()
        with patch.dict(sys.modules, {"comfy_extras.nodes_audio": audio_module}), \
                patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                self.assertRaisesRegex(ValueError, "no audio samples"):
            self.nodes._load_audio(path, trim_start=3)

    def test_audio_memory_guard_runs_before_official_decode(self):
        audio_module = ModuleType("comfy_extras.nodes_audio")
        official = audio_module.load = unittest.mock.Mock(return_value=(FakeWaveform(64000), 8000))
        with patch.dict(sys.modules, {"comfy_extras.nodes_audio": audio_module,
                                      "av": fake_av_module(fake_audio_stream())}), \
                patch.object(self.nodes, "AV_MEMORY_LIMIT", 191999), \
                self.assertRaisesRegex(ValueError, "estimated audio memory"):
            self.nodes._load_audio(str(self.input / "voice.wav"))
        official.assert_not_called()
        with patch.dict(sys.modules, {"comfy_extras.nodes_audio": audio_module,
                                      "av": fake_av_module(fake_audio_stream())}), \
                patch.object(self.nodes, "AV_MEMORY_LIMIT", 192000):
            self.assertEqual(self.nodes._load_audio(str(self.input / "voice.wav"))["sample_rate"], 8000)
        official.assert_called_once()
        with patch.dict(sys.modules, {"comfy_extras.nodes_audio": audio_module,
                                      "av": fake_av_module(fake_audio_stream())}), \
                self.assertRaisesRegex(ValueError, "estimated audio memory"):
            self.nodes._load_audio(str(self.input / "voice.wav"), memory_limit=100)

    def test_audio_actual_waveform_is_checked_against_remaining_budget(self):
        audio_module, _waveform = self.audio_module(FakeWaveform(101))
        with patch.dict(sys.modules, {"comfy_extras.nodes_audio": audio_module}), \
                patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                self.assertRaisesRegex(ValueError, "estimated audio memory"):
            self.nodes._load_audio(str(self.input / "voice.wav"), memory_limit=100)

    def test_audio_memory_guard_uses_container_duration_and_rejects_unknown(self):
        audio_module, _waveform = self.audio_module(rate=8000)
        fallback = fake_av_module(fake_audio_stream(duration=None), duration=1000000)
        with patch.dict(sys.modules, {"comfy_extras.nodes_audio": audio_module, "av": fallback}):
            self.nodes._load_audio(str(self.input / "voice.wav"))
        unknown = fake_av_module(fake_audio_stream(duration=None))
        with patch.dict(sys.modules, {"comfy_extras.nodes_audio": audio_module, "av": unknown}), \
                self.assertRaisesRegex(ValueError, "cannot determine audio duration"):
            self.nodes._load_audio(str(self.input / "voice.wav"))

    def test_normal_multi_group_audio_estimates_share_one_budget(self):
        loader = self.nodes.KedouAVLoader()
        estimates = {str(self.input / "voice.wav"): 60, str(self.input / "music.mp3"): 40}
        estimate_limits = []
        decode_limits = []

        def estimate(path, memory_limit=None):
            estimate_limits.append(memory_limit)
            value = estimates[path]
            if value > memory_limit:
                raise ValueError("Kedou AV Loader: estimated audio memory exceeds budget")
            return value

        def decode(path, memory_limit=None, **_kw):
            decode_limits.append(memory_limit)
            return {"waveform": FakeWaveform(estimates[path]), "sample_rate": 8000}

        with patch.object(self.nodes, "AV_MEMORY_LIMIT", 100), \
                patch.object(self.nodes, "_audio_memory_estimate", side_effect=estimate), \
                patch.object(self.nodes, "_load_audio", side_effect=decode):
            out = loader._load(state(audios=[item("voice.wav"), item("music.mp3")]))
        self.assertIsNotNone(out[0])
        self.assertIsNotNone(out[1])
        self.assertEqual(estimate_limits, [100, 40])
        self.assertEqual(decode_limits, [100, 40])

        estimates[str(self.input / "music.mp3")] = 50
        with patch.object(self.nodes, "AV_MEMORY_LIMIT", 100), \
                patch.object(self.nodes, "_audio_memory_estimate", side_effect=estimate), \
                patch.object(self.nodes, "_load_audio") as decode, \
                self.assertRaisesRegex(ValueError, "estimated audio memory"):
            loader._load(state(audios=[item("voice.wav"), item("music.mp3")]))
        decode.assert_not_called()                # 预检总估算失败，不先解码第 1 组

    def test_batch_audio_memory_checks_only_current_group(self):
        loader = self.nodes.KedouAVLoader()
        raw = state(audios=[item("voice.wav"), item("music.mp3")], batch=True, cursor=1)
        with patch.object(self.nodes, "AV_MEMORY_LIMIT", 100), \
                patch.object(self.nodes, "_audio_memory_estimate", return_value=100) as estimate, \
                patch.object(self.nodes, "_load_audio", side_effect=lambda path, memory_limit=None, **_kw: {
                    "waveform": FakeWaveform(100), "sample_rate": 8000}) as decode:
            out = loader._load(raw)
        self.assertIsNotNone(out[0])
        estimate.assert_called_once_with(str(self.input / "music.mp3"), 100)
        decode.assert_called_once_with(str(self.input / "music.mp3"), memory_limit=100,
                                       trim_start=0, trim_end=None)

    def test_video_audio_uses_video_trim_and_shares_audio_port_order(self):
        loader = self.nodes.KedouAVLoader()
        raw = state([item("clip.mp4", trim_start=1, trim_end=2)],
                    [item("voice.wav", trim_start=0.5, trim_end=1.5)], video_audio=True)
        with patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}), \
                patch.object(self.nodes.media, "trimmed_video", side_effect=lambda path, trim_start=0, trim_end=None: {
                    "ok": True, "path": "%s|%s-%s" % (path, trim_start, trim_end)}), \
                patch.object(self.nodes, "_audio_memory_estimate", return_value=1) as estimate, \
                patch.object(self.nodes, "_load_audio", side_effect=lambda path, **_kw: {
                    "waveform": FakeWaveform(1), "sample_rate": 8000, "path": path}) as decode:
            out = loader._load(raw)
        self.assertEqual(len(out), 32)
        self.assertEqual(out[0], ("video", str(self.input / "clip.mp4") + "|1.0-2.0"))
        self.assertEqual(out[1]["path"], str(self.input / "clip.mp4"))
        self.assertEqual(out[2]["path"], str(self.input / "voice.wav"))
        self.assertIsNone(out[3])
        self.assertEqual(estimate.call_args_list, [
            call(str(self.input / "clip.mp4"), self.nodes.AV_MEMORY_LIMIT),
            call(str(self.input / "voice.wav"), self.nodes.AV_MEMORY_LIMIT - 1),
        ])
        self.assertEqual(decode.call_args_list, [
            call(str(self.input / "clip.mp4"), memory_limit=self.nodes.AV_MEMORY_LIMIT,
                 trim_start=1.0, trim_end=2.0),
            call(str(self.input / "voice.wav"), memory_limit=self.nodes.AV_MEMORY_LIMIT - 1,
                 trim_start=0.5, trim_end=1.5),
        ])

    def test_video_without_audio_stream_emits_none_and_other_errors_propagate(self):
        loader = self.nodes.KedouAVLoader()
        raw = state([item("clip.mp4")], [item("voice.wav")], video_audio=True)
        video_path = str(self.input / "clip.mp4")
        audio_path = str(self.input / "voice.wav")

        def estimate(path, _memory_limit=None):
            if path == video_path:
                raise ValueError("Kedou AV Loader: no audio stream found: %s" % path)
            return 1

        with patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}), \
                patch.object(self.nodes, "_audio_memory_estimate", side_effect=estimate), \
                patch.object(self.nodes, "_load_audio", return_value={
                    "waveform": FakeWaveform(1), "sample_rate": 8000, "path": audio_path}) as decode:
            out = loader._load(raw)
        self.assertIsNone(out[1])
        self.assertEqual(out[2]["path"], audio_path)
        decode.assert_called_once_with(audio_path, memory_limit=self.nodes.AV_MEMORY_LIMIT,
                                       trim_start=0, trim_end=None)

        def decode_with_missing(path, **_kw):
            if path == video_path:
                raise ValueError("Kedou AV Loader: no audio stream found: %s" % path)
            return {"waveform": FakeWaveform(1), "sample_rate": 8000, "path": path}

        with patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}), \
                patch.object(self.nodes, "_audio_memory_estimate", return_value=1), \
                patch.object(self.nodes, "_load_audio", side_effect=decode_with_missing):
            out = loader._load(raw)
        self.assertIsNone(out[1])
        self.assertEqual(out[2]["path"], audio_path)

        with patch.dict(sys.modules, {"comfy_api.latest": self.video_module()}), \
                patch.object(self.nodes, "_audio_memory_estimate", side_effect=ValueError("cannot decode audio")), \
                patch.object(self.nodes, "_load_audio") as decode, \
                self.assertRaisesRegex(ValueError, "cannot decode audio"):
            loader._load(raw)
        decode.assert_not_called()

    def test_embedded_and_standalone_audio_share_estimate_and_actual_storage_budget(self):
        loader = self.nodes.KedouAVLoader()
        raw = state([item("clip.mp4")], [item("voice.wav")], mode="frames", video_audio=True)
        video_path = str(self.input / "clip.mp4")
        audio_path = str(self.input / "voice.wav")
        estimates = {video_path: 60, audio_path: 40}
        actual = {video_path: 55, audio_path: 35}
        estimate_limits = []
        decode_limits = []

        def estimate(path, memory_limit=None):
            estimate_limits.append(memory_limit)
            if estimates[path] > memory_limit:
                raise ValueError("Kedou AV Loader: estimated audio memory exceeds budget")
            return estimates[path]

        def decode(path, memory_limit=None, **_kw):
            decode_limits.append(memory_limit)
            return {"waveform": FakeWaveform(actual[path]), "sample_rate": 8000, "path": path}

        with patch.object(self.nodes, "AV_MEMORY_LIMIT", 100), \
                patch.object(self.nodes, "_audio_memory_estimate", side_effect=estimate), \
                patch.object(self.nodes, "_load_audio", side_effect=decode), \
                patch.object(self.nodes, "_video_frames", return_value=FakeFrames(10)) as frames:
            out = loader._load(raw)
        self.assertEqual(out[0].nbytes, 10)
        self.assertEqual(out[1]["path"], video_path)
        self.assertEqual(out[2]["path"], audio_path)
        self.assertEqual(estimate_limits, [100, 40])
        self.assertEqual(decode_limits, [100, 45])
        frames.assert_called_once_with(video_path, raw["frame_options"], memory_limit=10,
                                       trim_start=0, trim_end=None)

        estimates[audio_path] = 50
        with patch.object(self.nodes, "AV_MEMORY_LIMIT", 100), \
                patch.object(self.nodes, "_audio_memory_estimate", side_effect=estimate), \
                patch.object(self.nodes, "_load_audio") as decode, \
                self.assertRaisesRegex(ValueError, "estimated audio memory"):
            loader._load(raw)
        decode.assert_not_called()

    def test_normal_multi_group_frame_bytes_share_one_budget(self):
        loader = self.nodes.KedouAVLoader()
        raw = state([item("clip.mp4"), item("second.mp4")], mode="frames")
        limits = []

        def decode(path, _opts, memory_limit=None, **_kw):
            limits.append(memory_limit)
            return FakeFrames(60 if path.endswith("clip.mp4") else 40)

        with patch.object(self.nodes, "AV_MEMORY_LIMIT", 100), \
                patch.object(self.nodes, "_video_frames", side_effect=decode):
            out = loader._load(raw)
        self.assertEqual(out[0].nbytes + out[1].nbytes, 100)
        self.assertEqual(limits, [100, 40])

        def overflow(_path, _opts, memory_limit=None, **_kw):
            return FakeFrames(60 if memory_limit == 100 else 50)

        with patch.object(self.nodes, "AV_MEMORY_LIMIT", 100), \
                patch.object(self.nodes, "_video_frames", side_effect=overflow), \
                self.assertRaisesRegex(ValueError, "estimated frame memory"):
            loader._load(raw)

    def test_batch_frames_decode_only_current_group(self):
        loader = self.nodes.KedouAVLoader()
        raw = state([item("clip.mp4"), item("second.mp4")], mode="frames", batch=True, cursor=1)
        with patch.object(self.nodes, "_video_frames", return_value=FakeFrames(10)) as decode:
            out = loader._load(raw)
        self.assertEqual(out[0].label, "frames")
        self.assertTrue(all(value is None for index, value in enumerate(out) if index != 0))
        decode.assert_called_once_with(str(self.input / "second.mp4"), raw["frame_options"],
                                       memory_limit=self.nodes.AV_MEMORY_LIMIT,
                                       trim_start=0, trim_end=None)

    def test_video_frames_trim_window_seek_and_frame_options(self):
        import numpy as np

        stream = SimpleNamespace(type="video", width=2, height=2, time_base=0.001)
        frames = [FakeVideoFrame(np.full((2, 2, 3), index * 40, dtype=np.uint8), time=index * 0.5)
                  for index in range(6)]
        container = FakeContainer([stream], frames=frames)
        module = ModuleType("av")
        module.time_base = 1000000
        module.error = SimpleNamespace(FFmpegError=RuntimeError)
        module.open = lambda *_args, **_kw: container
        opts = dict(self.nodes.av_state.DEFAULT_FRAME_OPTIONS,
                    start_frame=0, frame_step=2, max_frames=2, max_side=0)
        with patch.dict(sys.modules, {"av": module}):
            result = self.nodes._video_frames(str(self.input / "clip.mp4"), opts,
                                              trim_start=0.75, trim_end=2.25)
        self.assertEqual(tuple(result.shape), (2, 2, 2, 3))
        np.testing.assert_allclose(result.numpy()[0], np.full((2, 2, 3), 80 / 255.0))
        np.testing.assert_allclose(result.numpy()[1], np.full((2, 2, 3), 160 / 255.0))
        self.assertEqual(container.seek_calls,
                         [(750, {"stream": stream, "backward": True, "any_frame": False})])

        end_container = FakeContainer([stream], frames=frames[:4])
        module.open = lambda *_args, **_kw: end_container
        with patch.dict(sys.modules, {"av": module}):
            result = self.nodes._video_frames(str(self.input / "clip.mp4"), opts, trim_end=1.5)
        self.assertEqual(tuple(result.shape), (2, 2, 2, 3))
        self.assertEqual(end_container.seek_calls, [])

    def test_video_rotation_is_clockwise_after_pil_conversion(self):
        import numpy as np
        import torch

        source = np.array([[[255, 0, 0], [0, 255, 0]],
                           [[0, 0, 255], [255, 255, 255]]], dtype=np.uint8)
        opts = dict(self.nodes.av_state.DEFAULT_FRAME_OPTIONS, max_frames=1, max_side=0)
        for rotation in (90, 180, 270):
            frame = FakeVideoFrame(source, rotation)
            stream = SimpleNamespace(type="video", width=2, height=2)
            with self.subTest(rotation=rotation), patch.dict(sys.modules, {
                    "av": fake_av_module(stream, frames=[frame])}):
                result = self.nodes._video_frames(str(self.input / "clip.mp4"), opts)
            expected = np.rot90(source, k=-(rotation // 90)).astype(np.float32) / 255.0
            np.testing.assert_allclose(result.numpy(), expected[None], atol=1e-6)
            self.assertEqual(result.dtype, torch.float32)
            self.assertEqual(frame.conversions, 1)

    def test_video_source_and_output_budget_plus_start_limit(self):
        import numpy as np

        frame = FakeVideoFrame(np.zeros((2, 4, 3), dtype=np.uint8))
        stream = SimpleNamespace(type="video", width=4, height=2)
        fake_av = fake_av_module(stream, frames=[frame])
        opts = dict(self.nodes.av_state.DEFAULT_FRAME_OPTIONS, max_frames=1, max_side=0)
        with patch.dict(sys.modules, {"av": fake_av}), \
                self.assertRaisesRegex(ValueError, "one decoded frame"):
            self.nodes._video_frames(str(self.input / "clip.mp4"), opts, memory_limit=119)
        self.assertEqual(frame.conversions, 0)
        with patch.dict(sys.modules, {"av": fake_av}), \
                self.assertRaisesRegex(ValueError, "estimated frame memory"):
            self.nodes._video_frames(str(self.input / "clip.mp4"), opts, memory_limit=215)
        with patch("av.open") as opener, self.assertRaisesRegex(ValueError, "start_frame exceeds"):
            self.nodes._video_frames(str(self.input / "clip.mp4"),
                                     dict(opts, start_frame=100001))
        opener.assert_not_called()

    def test_frame_stack_peak_is_included_in_memory_budget(self):
        import numpy as np

        frames = [FakeVideoFrame(np.zeros((10, 10, 3), dtype=np.uint8)) for _ in range(10)]
        stream = SimpleNamespace(type="video", width=10, height=10)
        opts = dict(self.nodes.av_state.DEFAULT_FRAME_OPTIONS, max_frames=10, max_side=0)
        with patch.dict(sys.modules, {"av": fake_av_module(stream, frames=frames)}), \
                self.assertRaisesRegex(ValueError, "estimated frame memory"):
            self.nodes._video_frames(str(self.input / "clip.mp4"), opts, memory_limit=20000)

    def test_exact_tab_resolution_then_fallback(self):
        self.assertEqual(self.nodes._av_input_path(item("clip.mp4", "output")),
                         str(self.output / "clip.mp4"))
        (self.output / "clip.mp4").unlink()
        self.assertEqual(self.nodes._av_input_path(item("clip.mp4", "output")),
                         str(self.input / "clip.mp4"))
        with self.assertRaisesRegex(ValueError, "not found"):
            self.nodes._av_input_path(item("missing.mp4"))

    def test_cache_signature_tracks_lists_selection_options_and_files(self):
        cls = self.nodes.KedouAVLoader
        raw = state([item("clip.mp4"), item("second.mp4")], [item("voice.wav")])
        base = cls.IS_CHANGED(json.dumps(raw))
        self.assertEqual(base, cls.IS_CHANGED(json.dumps(raw)))
        changed = copy.deepcopy(raw)
        changed["frame_options"]["max_frames"] = 8
        self.assertNotEqual(base, cls.IS_CHANGED(json.dumps(changed)))
        changed = copy.deepcopy(raw)
        changed["output_mode"] = "frames"
        self.assertNotEqual(base, cls.IS_CHANGED(json.dumps(changed)))
        changed = copy.deepcopy(raw)
        changed["video_audio"] = True
        self.assertNotEqual(base, cls.IS_CHANGED(json.dumps(changed)))
        changed = copy.deepcopy(raw)
        changed["audios"][0]["extract_audio"] = True
        self.assertNotEqual(base, cls.IS_CHANGED(json.dumps(changed)))
        changed = copy.deepcopy(raw)
        changed["videos"][0]["trim_start"] = 1.5
        self.assertNotEqual(base, cls.IS_CHANGED(json.dumps(changed)))
        changed = copy.deepcopy(raw)
        changed["audios"][0]["trim_end"] = 2.5
        self.assertNotEqual(base, cls.IS_CHANGED(json.dumps(changed)))
        changed = copy.deepcopy(raw)
        changed["videos"].reverse()
        self.assertNotEqual(base, cls.IS_CHANGED(json.dumps(changed)))
        changed = copy.deepcopy(raw)
        changed["select"] = True
        self.assertNotEqual(base, cls.IS_CHANGED(json.dumps(changed)))
        selected = copy.deepcopy(raw)
        selected.update(select=True, picked_videos=["input|clip.mp4", "input|second.mp4"])
        selected_base = cls.IS_CHANGED(json.dumps(selected))
        selected["picked_videos"].reverse()
        self.assertNotEqual(selected_base, cls.IS_CHANGED(json.dumps(selected)))
        selected["picked_videos"] = ["input|missing.mp4"]
        self.assertNotEqual(selected_base, cls.IS_CHANGED(json.dumps(selected)))
        batch = copy.deepcopy(raw)
        batch.update(batch=True, cursor=0)
        self.assertNotEqual(cls.IS_CHANGED(json.dumps(batch)),
                            cls.IS_CHANGED(json.dumps(dict(batch, cursor=1))))
        st = (self.input / "clip.mp4").stat()
        os.utime(str(self.input / "clip.mp4"), ns=(st.st_atime_ns, st.st_mtime_ns + 1000000))
        self.assertNotEqual(base, cls.IS_CHANGED(json.dumps(raw)))
        st = (self.input / "voice.wav").stat()
        os.utime(str(self.input / "voice.wav"), ns=(st.st_atime_ns, st.st_mtime_ns + 1000000))
        self.assertNotEqual(base, cls.IS_CHANGED(json.dumps(raw)))

    def test_validate_inputs_allows_partial_missing_and_rejects_all_missing(self):
        cls = self.nodes.KedouAVLoader
        self.assertIs(cls.VALIDATE_INPUTS(json.dumps(state([item("clip.mp4")]))), True)
        self.assertIs(cls.VALIDATE_INPUTS(json.dumps(state(audios=[item("voice.wav")]))), True)
        self.assertIn("找不到文件", cls.VALIDATE_INPUTS(json.dumps(state([item("missing.mp4")]))))
        selected = state([item("clip.mp4"), item("missing.mp4")], select=True,
                         picked_videos=["input|clip.mp4"])
        self.assertIs(cls.VALIDATE_INPUTS(json.dumps(selected)), True)
        batch = state([item("clip.mp4"), item("missing.mp4")], batch=True, cursor=0)
        self.assertIs(cls.VALIDATE_INPUTS(json.dumps(batch)), True)
        self.assertIn("找不到文件", cls.VALIDATE_INPUTS(json.dumps(
            state([item("missing.mp4")], batch=True, cursor=0))))
        self.assertIn("视频帧模式", cls.VALIDATE_INPUTS(
            json.dumps(state(audios=[item("voice.wav")], mode="frames"))))
        self.assertIs(cls.VALIDATE_INPUTS(json.dumps(state(
            [item("clip.mp4")], [item("voice.wav"), item("music.mp3")], mode="frames"))), True)
        many = state([item("v%d.mp4" % index) for index in range(500)], batch=True, cursor=0)
        with patch.object(self.nodes, "_av_input_path", return_value="exists") as resolve:
            self.assertIs(cls.VALIDATE_INPUTS(json.dumps(many)), True)
        self.assertEqual(resolve.call_count, 500)

    def test_av_link_pruning_normal_groups_modes_and_batch(self):
        raw = state([item("clip.mp4"), item("second.mp4")],
                    [item("voice.wav"), item("music.mp3"), item("third.webm", extract=True)])
        batch = dict(raw, batch=True, cursor=1)

        def graph_for(media_state):
            return {
                "1": {"class_type": "KedouAVLoader", "inputs": {"media_state": json.dumps(media_state)}},
                "2": {"inputs": {"slot_%d" % index: ["1", index] for index in range(24)}},
            }

        cases = (
            (raw, 5),
            (dict(raw, output_mode="frames"), 5),
            (dict(raw, video_audio=True), 7),
            (batch, 2),
            (dict(batch, video_audio=True), 3),
        )
        for media_state, visible_count in cases:
            with self.subTest(media_state=media_state):
                graph = graph_for(media_state)
                self.assertEqual(self.nodes._prune_stale_loader_links(graph), 24 - visible_count)
                self.assertEqual(set(graph["2"]["inputs"]),
                                 {"slot_%d" % index for index in range(visible_count)})

    def test_av_link_pruning_drops_placeholder_and_growth_ports(self):
        raw = state([item("clip.mp4")],
                    port_order=["video_1", "video_2", "audio_1"])
        parsed = self.nodes.av_state.parse_av_state(raw)
        self.assertEqual(self.nodes.av_state.executable_layout(parsed), ["video_1"])
        graph = {
            "1": {"class_type": "KedouAVLoader", "inputs": {"media_state": json.dumps(raw)}},
            "2": {"inputs": {"slot_%d" % index: ["1", index] for index in range(3)}},
        }
        self.assertEqual(self.nodes._prune_stale_loader_links(graph), 2)
        self.assertEqual(graph["2"]["inputs"], {"slot_0": ["1", 0]})

        audio_only = state(audios=[item("voice.wav")],
                           port_order=["video_1", "audio_1"])
        graph = {
            "1": {"class_type": "KedouAVLoader", "inputs": {"media_state": json.dumps(audio_only)}},
            "2": {"inputs": {"slot_0": ["1", 0], "slot_1": ["1", 1]}},
        }
        self.assertEqual(self.nodes._prune_stale_loader_links(graph), 1)
        self.assertEqual(graph["2"]["inputs"], {"slot_1": ["1", 1]})

    def test_av_link_pruning_migrates_old_three_output_states(self):
        legacy = {"v": 2, "kind": "av", "video": item("clip.mp4"), "audio": item("voice.wav"),
                  "output_mode": "frames", "frame_options": self.nodes.av_state.DEFAULT_FRAME_OPTIONS,
                  "batch": False, "cursor": 0, "pairs": []}
        graph = {
            "1": {"class_type": "KedouAVLoader", "inputs": {"media_state": json.dumps(legacy)}},
            "2": {"inputs": {"slot_%d" % index: ["1", index] for index in range(4)}},
        }
        self.assertEqual(self.nodes._prune_stale_loader_links(graph), 2)
        self.assertEqual(graph["2"]["inputs"], {"slot_0": ["1", 0], "slot_1": ["1", 1]})
        legacy.update(batch=True, cursor=1, output_mode="video", pairs=[
            {"video": item("clip.mp4"), "audio": item("voice.wav")},
            {"video": None, "audio": item("music.mp3")},
        ])
        graph["1"]["inputs"]["media_state"] = json.dumps(legacy)
        graph["2"]["inputs"] = {"slot_%d" % index: ["1", index] for index in range(4)}
        self.assertEqual(self.nodes._prune_stale_loader_links(graph), 3)
        self.assertEqual(graph["2"]["inputs"], {"slot_0": ["1", 0]})
        graph["1"]["inputs"]["media_state"] = "{}"
        before = copy.deepcopy(graph)
        self.assertEqual(self.nodes._prune_stale_loader_links(graph), 0)
        self.assertEqual(graph, before)

    def test_node_mappings_static_contract_and_description(self):
        cls = self.nodes.KedouAVLoader
        self.assertEqual(self.nodes.AV_SLOTS, 8)
        self.assertIs(self.nodes.NODE_CLASS_MAPPINGS["KedouAVLoader"], cls)
        self.assertEqual(cls.RETURN_TYPES, ("*",) * 32)
        self.assertEqual(cls.RETURN_NAMES, tuple("output_%d" % index for index in range(1, 33)))
        self.assertEqual(cls.INPUT_TYPES()["required"]["media_state"][0], "STRING")
        self.assertIn("KedouImageLoader", self.nodes.NODE_CLASS_MAPPINGS)
        self.assertIn("KedouPromptBox", self.nodes.NODE_CLASS_MAPPINGS)
        description = cls.DESCRIPTION.lower()
        for keyword in ("multi-select", "select", "batch", "8", "500", "32", "2gb",
                        "video_audio", "trim_start", "trim_end", "keyframe", "re-encoding"):
            self.assertIn(keyword, description)

    def test_real_pyav_audio_decode_and_sample_trim(self):
        try:
            import av
            import numpy as np
            import torch
            from comfy_extras.nodes_audio import load as official_load
        except ImportError:
            self.skipTest("av/numpy/torch/ComfyUI audio loader unavailable")
        path = self.input / "trim-tone.wav"
        samples = (np.arange(4000, dtype=np.int32) % 2000 - 1000).astype("<i2")
        with wave.open(str(path), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(8000)
            out.writeframes(samples.tobytes())
        full, rate = official_load(str(path))
        result = self.nodes._load_audio(str(path), trim_start=0.125, trim_end=0.375)
        self.assertEqual(rate, 8000)
        self.assertEqual(tuple(result["waveform"].shape), (1, 1, 2000))
        self.assertTrue(torch.equal(result["waveform"][0], full[:, 1000:3000]))

    def test_real_pyav_frame_decode_and_memory_guard(self):
        try:
            import av
            import numpy as np
            import torch
        except ImportError:
            self.skipTest("av/numpy/torch unavailable")
        path = self.input / "short.mp4"
        try:
            with av.open(str(path), "w") as container:
                stream = container.add_stream("libx264", rate=8)
                stream.width, stream.height, stream.pix_fmt = 64, 48, "yuv420p"
                for index in range(8):
                    arr = np.full((48, 64, 3), index * 25, dtype=np.uint8)
                    frame = av.VideoFrame.from_ndarray(arr, format="rgb24")
                    for packet in stream.encode(frame):
                        container.mux(packet)
                for packet in stream.encode():
                    container.mux(packet)
        except Exception as exc:
            self.skipTest("cannot encode H.264 fixture: %s" % exc)
        opts = dict(self.nodes.av_state.DEFAULT_FRAME_OPTIONS,
                    start_frame=2, frame_step=2, max_frames=3, max_side=32)
        frames = self.nodes._video_frames(str(path), opts)
        self.assertEqual(tuple(frames.shape), (3, 24, 32, 3))
        self.assertEqual(frames.dtype, torch.float32)
        self.assertTrue(bool(torch.all((frames >= 0) & (frames <= 1))))
        with self.assertRaisesRegex(ValueError, "no frames"):
            self.nodes._video_frames(str(path), dict(opts, start_frame=99))
        with patch.object(self.nodes, "AV_MEMORY_LIMIT", 1024), \
                self.assertRaisesRegex(ValueError, "2GB memory guard"):
            self.nodes._video_frames(str(path), opts)


if __name__ == "__main__":
    unittest.main(verbosity=2)

# -*- coding: utf-8 -*-
"""长视频分段协议、后台任务、缓存、镜头检测与安全导出回归。"""

import errno
import gc
import hashlib
import importlib
import importlib.util
import io
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import weakref
import zipfile
from contextlib import ExitStack

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import numpy as np


ROOT = Path(__file__).resolve().parents[1]


def load_bridge(module, package_name):
    package = ModuleType(package_name)
    package.__path__ = [str(ROOT / "kedou_bridge")]
    server = ModuleType("server")
    server.PromptServer = type("PromptServer", (), {"instance": None})
    nodes = ModuleType("nodes")
    nodes.NODE_CLASS_MAPPINGS = {}
    with patch.dict(sys.modules, {package_name: package, "server": server, "nodes": nodes,
                                  "folder_paths": None, "torch": None}):
        return importlib.import_module(package_name + "." + module)


SEGMENTS = load_bridge("segments", "_kedou_video_segments_tests")
ROUTES = load_bridge("routes", "_kedou_video_segments_routes_tests")


def tearDownModule():
    SEGMENTS._executor.shutdown(wait=True)
    ROUTES.segments._executor.shutdown(wait=True)
    ROUTES._thumb_pool.shutdown(wait=True)


class FakeFrame:
    def __init__(self, value, pts, time_base=0.1, hook=None):
        self.source = np.full((54, 96), value, dtype=np.uint8)
        self.pts = pts
        self.time_base = time_base
        self.hook = hook

    def reformat(self, width, height, format):
        self.reformat_size = (width, height, format)
        return self

    def to_ndarray(self, format=None):
        if self.hook is not None:
            self.hook()
        return self.source


class FakeShotContainer:
    def __init__(self, frames, rate=5):
        self.frames = frames
        self.closed = False
        self.streams = [SimpleNamespace(type="video", average_rate=rate, time_base=0.1)]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True
        return False

    def decode(self, _stream):
        return iter(self.frames)


def fake_av(frames, rate=5):
    module = ModuleType("av")
    module.time_base = 1000000
    container = FakeShotContainer(frames, rate)
    module.open = lambda *_args, **_kwargs: container
    return module, container


class FakeRGBFrame:
    def __init__(self, value, pts, time_base=0.001, hook=None):
        self.source = np.full((27, 48, 3), value, dtype=np.uint8)
        self.pts = pts
        self.time_base = time_base
        self.hook = hook

    def reformat(self, width, height, format):
        self.reformat_size = (width, height, format)
        return self

    def to_ndarray(self, format=None):
        if self.hook is not None:
            self.hook()
        return self.source


class FakeTransNetModel:
    def __init__(self, values, hook=None):
        self.values = list(values)
        self.windows = []
        self.next_window = 0
        self.hook = hook
        self.device = "cpu"
        self.destroyed = threading.Event()

    def predict_raw(self, batch):
        self.windows.append(batch.data[0].copy())
        single = np.zeros((1, 100, 1), dtype=np.float32)
        for index, value in enumerate(self.values):
            if self.next_window <= index < self.next_window + 50:
                single[0, 25 + index - self.next_window, 0] = value
        many_hot = single * 0.5
        self.next_window += 50
        if self.hook is not None:
            self.hook()
        return single, many_hot

    def __del__(self):
        self.destroyed.set()


class FakeTensor:
    def __init__(self, data):
        self.data = data
        self.device = None

    def to(self, device):
        self.device = device
        return self


class FakeInferenceMode:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def fake_torch():
    module = ModuleType("torch")
    module.from_numpy = lambda value: FakeTensor(value)
    module.inference_mode = FakeInferenceMode
    module.cuda = SimpleNamespace(is_available=lambda: True, empty_cache=Mock())
    return module


def weight_wheel(weight):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(SEGMENTS._TRANSNET_WEIGHT_MEMBER, weight)
        archive.writestr("transnetv2_pytorch/ignore.txt", "must not be extracted")
    return output.getvalue()


class SegmentBackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="kedou_video_segments_")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.input = root / "input"
        self.output = root / "output"
        self.input.mkdir()
        self.output.mkdir()
        self.cache = root / "cache"
        self.source = self.input / "clip.mp4"
        self.source.write_bytes(b"fake video source")
        with SEGMENTS._jobs_lock:
            SEGMENTS._jobs.clear()
        patches = [
            patch.object(SEGMENTS.media, "_media_dirs", lambda: (str(self.input), str(self.output))),
            patch.object(SEGMENTS, "CACHE_DIR", str(self.cache)),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def body(self, mode="duration", params=None, **overrides):
        out = {"name": "clip.mp4", "subfolder": "", "tab": "input", "mode": mode,
               "params": {} if params is None else params}
        out.update(overrides)
        return out

    def wait_job(self, job_id, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = SEGMENTS.get_job(job_id)
            if job is not None and job["status"] in ("done", "error", "cancelled"):
                return job
            time.sleep(0.01)
        self.fail("任务等待超时：%s" % job_id)

    def test_parameter_validation_defaults_and_paths(self):
        source, mode, params = SEGMENTS.validate_analyze_request(self.body())
        self.assertEqual(source["name"], "clip.mp4")
        self.assertEqual(mode, "duration")
        self.assertEqual(params, {"segment_seconds": 15.0, "remainder": "keep"})
        _source, _mode, shot = SEGMENTS.validate_analyze_request(self.body("shot"))
        self.assertEqual(shot, {"engine": "fast", "threshold": 0.22,
                                "min_scene_len": 1.0, "adaptive": 2.5})
        _source, _mode, ai = SEGMENTS.validate_analyze_request(
            self.body("shot", {"engine": "transnet"}))
        self.assertEqual(ai, {"engine": "transnet", "threshold": 0.5,
                              "min_scene_len": 1.0, "adaptive": 2.5})
        _source, _mode, omni = SEGMENTS.validate_analyze_request(
            self.body("shot", {"engine": "omnishotcut"}))
        self.assertEqual(omni, {"engine": "omnishotcut", "threshold": 0.5,
                                "min_scene_len": 1.0, "adaptive": 2.5})
        _source, _mode, legacy = SEGMENTS.validate_analyze_request(
            self.body(params={"seconds": 20, "tail": "merge"}))
        self.assertEqual(legacy, {"segment_seconds": 20.0, "remainder": "merge"})
        _source, _mode, legacy_shot = SEGMENTS.validate_analyze_request(
            self.body("shot", {"threshold": 0.3, "min_seconds": 2}))
        self.assertEqual(legacy_shot, {"engine": "fast", "threshold": 0.3,
                                       "min_scene_len": 2.0, "adaptive": 2.5})
        for engine, threshold in (("fast", 0.05), ("fast", 0.8),
                                  ("transnet", 0.01), ("transnet", 0.99),
                                  ("omnishotcut", 0.01), ("omnishotcut", 0.99)):
            with self.subTest(engine=engine, threshold=threshold):
                _source, _mode, accepted = SEGMENTS.validate_analyze_request(
                    self.body("shot", {"engine": engine, "threshold": threshold}))
                self.assertEqual(accepted["threshold"], threshold)

        invalid = [
            self.body(mode="other"),
            self.body(params=[]),
            self.body(params={"segment_seconds": 0.49}),
            self.body(params={"segment_seconds": 600.1}),
            self.body(params={"segment_seconds": True}),
            self.body(params={"segment_seconds": float("nan")}),
            self.body(params={"remainder": "last"}),
            self.body(params={"unknown": 1}),
            self.body("shot", {"threshold": 0.04}),
            self.body("shot", {"threshold": 0.81}),
            self.body("shot", {"engine": "other"}),
            self.body("shot", {"engine": None}),
            self.body("shot", {"engine": "transnet", "threshold": 0.009}),
            self.body("shot", {"engine": "transnet", "threshold": 0.991}),
            self.body("shot", {"engine": "omnishotcut", "threshold": 0.009}),
            self.body("shot", {"engine": "omnishotcut", "threshold": 0.991}),
            self.body("shot", {"engine": "transnet", "unknown": 1}),
            self.body("shot", {"min_scene_len": 0.19}),
            self.body("shot", {"min_scene_len": 30.1}),
            self.body("shot", {"adaptive": 0.9}),
            self.body("shot", {"adaptive": 6.1}),
            self.body("shot", {"adaptive": float("inf")}),
            self.body(name="../clip.mp4"),
            self.body(name="dir/clip.mp4"),
            self.body(name="clip.wav"),
            self.body(subfolder="../escape"),
            self.body(subfolder="C:/escape"),
            self.body(tab="all"),
        ]
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                SEGMENTS.validate_analyze_request(raw)

    def test_duration_remainders_coverage_and_limit(self):
        expected = [
            {"start": 0.0, "end": 15.0},
            {"start": 15.0, "end": 30.0},
            {"start": 30.0, "end": 32.0},
        ]
        self.assertEqual(SEGMENTS.duration_segments(32, 15, "keep"), expected)
        self.assertEqual(SEGMENTS.duration_segments(32, 15, "merge"), [
            {"start": 0.0, "end": 15.0}, {"start": 15.0, "end": 32.0}])
        self.assertEqual(SEGMENTS.duration_segments(32, 15, "drop"), expected[:2])
        self.assertEqual(SEGMENTS.duration_segments(8, 15, "merge"),
                         [{"start": 0.0, "end": 8.0}])
        self.assertEqual(SEGMENTS.duration_segments(8, 15, "drop"), [])
        self.assertEqual(SEGMENTS.duration_segments(30, 15, "keep")[-1]["end"], 30.0)
        with self.assertRaisesRegex(ValueError, "500"):
            SEGMENTS.duration_segments(250.5, 0.5, "keep")
        self.assertEqual(len(SEGMENTS.duration_segments(250.25, 0.5, "merge")), 500)
        self.assertEqual(len(SEGMENTS.duration_segments(250.25, 0.5, "drop")), 500)

    def test_analysis_cache_and_fingerprint(self):
        stat = self.source.stat()
        base = SEGMENTS._cache_key(str(self.source), stat, "duration",
                                   {"segment_seconds": 15.0, "remainder": "keep"})
        self.assertEqual(len(base), 64)
        variants = [
            SEGMENTS._cache_key(str(self.source), stat, "duration",
                               {"segment_seconds": 16.0, "remainder": "keep"}),
            SEGMENTS._cache_key(str(self.source), stat, "duration",
                               {"segment_seconds": 15.0, "remainder": "drop"}),
            SEGMENTS._cache_key(str(self.source), stat, "shot",
                               {"engine": "fast", "threshold": 0.22,
                                "min_scene_len": 1.0, "adaptive": 2.5}),
            SEGMENTS._cache_key(str(self.source), stat, "shot",
                               {"engine": "transnet", "threshold": 0.5,
                                "min_scene_len": 1.0, "adaptive": 2.5}),
            SEGMENTS._cache_key(str(self.source), stat, "shot",
                               {"engine": "omnishotcut", "threshold": 0.5,
                                "min_scene_len": 1.0, "adaptive": 2.5}),
            SEGMENTS._cache_key(str(self.source), SimpleNamespace(st_mtime_ns=stat.st_mtime_ns + 1,
                                                                   st_size=stat.st_size),
                               "duration", {"segment_seconds": 15.0, "remainder": "keep"}),
            SEGMENTS._cache_key(str(self.source), SimpleNamespace(st_mtime_ns=stat.st_mtime_ns,
                                                                   st_size=stat.st_size + 1),
                               "duration", {"segment_seconds": 15.0, "remainder": "keep"}),
        ]
        self.assertEqual(len({base, *variants}), 8)

        with patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 32.0, "width": 96}):
            first_id = SEGMENTS.start_analyze(self.body(params={"segment_seconds": 15}))
            first = self.wait_job(first_id)
            self.assertEqual(first["status"], "done", first)
            self.assertEqual(first["result"]["duration"], 32.0)
            self.assertEqual(len(first["result"]["segments"]), 3)
            self.assertEqual(len(list(self.cache.glob("*.json"))), 1)

            second_id = SEGMENTS.start_analyze(self.body(params={"segment_seconds": 15}))
            second = self.wait_job(second_id)
            self.assertEqual(second["stage"], "命中分析缓存")
            self.assertEqual(second["result"], first["result"])
            self.assertEqual(len(list(self.cache.glob("*.json"))), 1)

            touched = self.source.stat()
            os.utime(str(self.source), ns=(touched.st_atime_ns, touched.st_mtime_ns + 1000000))
            third_id = SEGMENTS.start_analyze(self.body(params={"segment_seconds": 15}))
            self.assertEqual(self.wait_job(third_id)["status"], "done")
            self.assertEqual(len(list(self.cache.glob("*.json"))), 2)
            self.source.write_bytes(b"fake video source with another size")
            fourth_id = SEGMENTS.start_analyze(self.body(params={"segment_seconds": 15}))
            self.assertEqual(self.wait_job(fourth_id)["status"], "done")
            self.assertEqual(len(list(self.cache.glob("*.json"))), 3)
        self.assertFalse(list(self.cache.glob("*.tmp")))

        with patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 32.0, "width": 96}):
            drop_id = SEGMENTS.start_analyze(self.body(params={"segment_seconds": 15, "remainder": "drop"}))
            self.assertEqual(self.wait_job(drop_id)["status"], "done")
            cached_drop_id = SEGMENTS.start_analyze(self.body(params={"segment_seconds": 15, "remainder": "drop"}))
            self.assertEqual(self.wait_job(cached_drop_id)["stage"], "命中分析缓存")

    def test_cache_write_failure_still_returns_analysis_result(self):
        with patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 32.0, "width": 96}), \
                patch.object(SEGMENTS.paths, "_dump_json_atomic", side_effect=OSError("disk full")):
            job_id = SEGMENTS.start_analyze(self.body(params={"segment_seconds": 15}))
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "done", job)
        self.assertEqual(len(job["result"]["segments"]), 3)

    def test_shot_engine_dispatch_and_cache_isolation(self):
        stat = self.source.stat()
        for engine in ("fast", "transnet", "omnishotcut"):
            with self.subTest(engine=engine):
                _source, _mode, params = SEGMENTS.validate_analyze_request(
                    self.body("shot", {"engine": engine}))
                job = SEGMENTS._Job("direct-" + engine, None)
                job.status = "running"
                with patch.object(SEGMENTS, "_resolve_source", return_value=(str(self.source), "input", stat)), \
                        patch.object(SEGMENTS, "_duration", return_value=12.0), \
                        patch.object(SEGMENTS, "_load_cache", return_value=None), \
                        patch.object(SEGMENTS, "_write_cache"), \
                        patch.object(SEGMENTS, "_detect_shots", return_value=[{"start": 0.0, "end": 12.0}]) as fast, \
                        patch.object(SEGMENTS, "_detect_shots_model", return_value=[{"start": 0.0, "end": 12.0}]) as model, \
                        patch.object(SEGMENTS, "_detect_shots_omnishotcut", return_value=[{"start": 0.0, "end": 12.0}]) as omni:
                    result = SEGMENTS._analyze(job, _source, "shot", params)
                self.assertEqual(result["params"]["engine"], engine)
                if engine == "fast":
                    fast.assert_called_once()
                    model.assert_not_called()
                    omni.assert_not_called()
                elif engine == "transnet":
                    model.assert_called_once()
                    fast.assert_not_called()
                    omni.assert_not_called()
                else:
                    omni.assert_called_once()
                    model.assert_not_called()
                    fast.assert_not_called()

    def test_unknown_duration_is_rejected(self):
        with patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": None}):
            job_id = SEGMENTS.start_analyze(self.body())
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "error")
        self.assertIn("无法确定视频时长", job["error"])
        self.assertIsNone(job["result"])

    def test_drop_tail_shorter_than_one_segment_returns_clear_error(self):
        with patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 8.0, "width": 96}):
            job_id = SEGMENTS.start_analyze(self.body(params={"segment_seconds": 15, "remainder": "drop"}))
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "error")
        self.assertIn("分段结果为空", job["error"])
        self.assertFalse(self.cache.exists() and list(self.cache.glob("*.json")))

    def test_shot_cancel_is_checked_inside_decode_loop(self):
        started = threading.Event()
        release = threading.Event()

        def hook():
            started.set()
            if not release.wait(3):
                raise RuntimeError("测试帧未释放")

        frames = [FakeFrame(0, 0, hook=hook), FakeFrame(0, 10)]
        module, _container = fake_av(frames)
        with patch.dict(sys.modules, {"av": module}), \
                patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 2.0, "width": 96}):
            job_id = SEGMENTS.start_analyze(self.body("shot"))
            self.assertTrue(started.wait(2))
            cancelled = SEGMENTS.cancel_job(job_id)
            self.assertTrue(cancelled["cancelled"])
            release.set()
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "cancelled")
        self.assertTrue(job["cancelled"])
        self.assertIsNone(job["result"])
        self.assertFalse(self.cache.exists() and list(self.cache.glob("*.json")))

    def test_fake_av_hard_cuts_use_pts_and_adaptive_threshold(self):
        times = [0, .2, .4, .6, .8, 1.0, 1.25, 1.5, 1.75, 2.0,
                 2.2, 2.4, 2.6, 2.8, 2.9, 3.0, 3.2, 3.4, 3.6, 3.8, 4.0]
        frames = [FakeFrame(0 if index < 5 or index >= 15 else 255,
                            int(round(value * 10))) for index, value in enumerate(times)]
        module, container = fake_av(frames, rate=5)  # average_rate 与 PTS 故意不一致
        with patch.dict(sys.modules, {"av": module}), \
                patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 4.0, "width": 96}):
            job_id = SEGMENTS.start_analyze(self.body("shot", {
                "threshold": 0.22, "min_scene_len": 1.0, "adaptive": 2.5}))
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "done", job)
        self.assertEqual(container.streams[0].average_rate, 5)
        segments = job["result"]["segments"]
        self.assertEqual([(item["start"], item["end"]) for item in segments],
                         [(0.0, 1.0), (1.0, 3.0), (3.0, 4.0)])
        self.assertEqual(segments[0]["confidence"], 1.0)
        self.assertEqual(segments[1]["confidence"], 1.0)
        self.assertNotIn("confidence", segments[-1])
        self.assertEqual(job["progress"], 1.0)

    def test_short_scene_flash_is_isolated(self):
        frames = [FakeFrame(0, 0), FakeFrame(255, 10), FakeFrame(0, 12),
                  FakeFrame(255, 14), FakeFrame(255, 20)]
        module, _container = fake_av(frames, rate=10)
        with patch.dict(sys.modules, {"av": module}), \
                patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 2.0, "width": 96}):
            job_id = SEGMENTS.start_analyze(self.body("shot", {"min_scene_len": 1.0}))
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "done", job)
        self.assertEqual([(item["start"], item["end"]) for item in job["result"]["segments"]],
                         [(0.0, 1.0), (1.0, 2.0)])

    def test_export_never_overwrites_and_returns_input_items(self):
        existing = self.input / "clip_seg001.mp4"
        existing.write_bytes(b"keep me")
        trim_dir = Path(self.tmp.name) / "trim"
        trim_dir.mkdir()

        def trimmed(_path, trim_start=0, trim_end=None):
            target = trim_dir / ("trim-%s-%s.mp4" % (trim_start, trim_end))
            target.write_bytes(("segment %s-%s" % (trim_start, trim_end)).encode())
            return {"ok": True, "path": str(target), "copied": True}

        with patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 10.0, "width": 96}), \
                patch.object(SEGMENTS.media, "trimmed_video", side_effect=trimmed):
            job_id = SEGMENTS.start_export({
                "name": "clip.mp4", "subfolder": "", "tab": "input", "mode": "copy",
                "segments": [{"start": 0, "end": 1}, {"start": 1, "end": 2}],
            })
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "done", job)
        self.assertEqual(existing.read_bytes(), b"keep me")
        self.assertEqual((self.input / "clip_seg001_库1.mp4").read_bytes(), b"segment 0.0-1.0")
        self.assertEqual((self.input / "clip_seg002.mp4").read_bytes(), b"segment 1.0-2.0")
        self.assertEqual(job["result"]["items"], [
            {"name": "clip_seg001_库1.mp4", "filename": "clip_seg001_库1.mp4", "subfolder": "",
             "tab": "input", "kind": "video", "start": 0.0, "end": 1.0},
            {"name": "clip_seg002.mp4", "filename": "clip_seg002.mp4", "subfolder": "",
             "tab": "input", "kind": "video", "start": 1.0, "end": 2.0},
        ])
        self.assertFalse(list(self.input.glob(".kedou-segment-*")))

    def test_export_validation_rejects_reencode_overlap_and_out_of_bounds(self):
        with self.assertRaisesRegex(ValueError, "copy"):
            SEGMENTS.start_export({"name": "clip.mp4", "mode": "reencode", "segments": [{"start": 0, "end": 1}]})
        invalid = [
            [{"start": True, "end": 1}],
            [{"start": float("nan"), "end": 1}],
            [{"start": 0, "end": float("inf")}],
            [{"start": 1, "end": 1}],
            [{"start": -1, "end": 1}],
            [{"start": 0, "end": 11}],
            [{"start": 2, "end": 3}, {"start": 1, "end": 2}],
            [{"start": 0, "end": 2}, {"start": 1, "end": 3}],
        ]
        for segments in invalid:
            with self.subTest(segments=segments), self.assertRaises(ValueError):
                SEGMENTS.validate_export_segments(segments, duration=10)
        with self.assertRaisesRegex(ValueError, "500"):
            SEGMENTS.validate_export_segments([{"start": 0, "end": 1}] * 501)

        with patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 10.0, "width": 96}):
            job_id = SEGMENTS.start_export({
                "name": "clip.mp4", "subfolder": "", "tab": "input", "mode": "copy",
                "segments": [{"start": 9, "end": 11}],
            })
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "error")
        self.assertIn("超出视频时长", job["error"])
        self.assertFalse((self.input / "clip_seg001.mp4").exists())

    def test_export_cancel_is_checked_before_publish(self):
        started = threading.Event()
        release = threading.Event()

        def trimmed(_path, trim_start=0, trim_end=None):
            started.set()
            if not release.wait(3):
                raise RuntimeError("测试导出未释放")
            return {"ok": True, "path": str(self.source), "copied": True}

        with patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 10.0, "width": 96}), \
                patch.object(SEGMENTS.media, "trimmed_video", side_effect=trimmed):
            job_id = SEGMENTS.start_export({
                "name": "clip.mp4", "subfolder": "", "tab": "input", "mode": "copy",
                "segments": [{"start": 0, "end": 1}],
            })
            self.assertTrue(started.wait(2))
            self.assertTrue(SEGMENTS.cancel_job(job_id)["cancelled"])
            release.set()
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "cancelled")
        self.assertFalse((self.input / "clip_seg001.mp4").exists())
        self.assertFalse(list(self.input.glob(".kedou-segment-*")))

    def test_export_cancel_removes_already_published_segments(self):
        second_started = threading.Event()
        release = threading.Event()
        calls = {"n": 0}

        def trimmed(_path, trim_start=0, trim_end=None):
            calls["n"] += 1
            if calls["n"] == 2:
                second_started.set()
                if not release.wait(3):
                    raise RuntimeError("测试导出未释放")
            return {"ok": True, "path": str(self.source), "copied": True}

        with patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 10.0, "width": 96}), \
                patch.object(SEGMENTS.media, "trimmed_video", side_effect=trimmed):
            job_id = SEGMENTS.start_export({
                "name": "clip.mp4", "subfolder": "", "tab": "input", "mode": "copy",
                "segments": [{"start": 0, "end": 1}, {"start": 1, "end": 2}],
            })
            self.assertTrue(second_started.wait(2))
            self.assertTrue((self.input / "clip_seg001.mp4").exists())
            self.assertTrue(SEGMENTS.cancel_job(job_id)["cancelled"])
            release.set()
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "cancelled")
        deadline = time.time() + 2
        while (self.input / "clip_seg001.mp4").exists() and time.time() < deadline:
            time.sleep(0.02)
        self.assertFalse((self.input / "clip_seg001.mp4").exists())
        self.assertFalse((self.input / "clip_seg002.mp4").exists())

    def test_export_publish_failure_cleans_temporary_file(self):
        with patch.object(SEGMENTS.media, "_av_metadata", return_value={"duration": 10.0, "width": 96}), \
                patch.object(SEGMENTS.media, "trimmed_video", return_value={
                    "ok": True, "path": str(self.source), "copied": True}), \
                patch.object(SEGMENTS.os, "link", side_effect=OSError(errno.EIO, "disk failure")):
            job_id = SEGMENTS.start_export({
                "name": "clip.mp4", "subfolder": "", "tab": "input", "mode": "copy",
                "segments": [{"start": 0, "end": 1}],
            })
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "error")
        self.assertIn("未覆盖目标", job["error"])
        self.assertFalse(list(self.input.glob(".kedou-segment-*")))
        self.assertFalse((self.input / "clip_seg001.mp4").exists())

    def test_job_store_is_capped_and_missing_jobs_are_absent(self):
        self.assertIsNone(SEGMENTS.get_job("missing"))
        self.assertIsNone(SEGMENTS.cancel_job("missing"))
        with SEGMENTS._jobs_lock:
            for index in range(SEGMENTS.JOB_LIMIT):
                job = SEGMENTS._Job(str(index), lambda _job: None)
                job.status = "running"
                SEGMENTS._jobs[str(index)] = job
            with self.assertRaises(SEGMENTS.QueueFull):
                SEGMENTS._submit(lambda _job: None)
            self.assertEqual(len(SEGMENTS._jobs), SEGMENTS.JOB_LIMIT)
            SEGMENTS._jobs.clear()


class TransNetWeightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="kedou_transnet_weights_")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.segments_dir = self.root / "kedou_segments"
        patcher = patch.object(SEGMENTS, "SEGMENTS_DIR", str(self.segments_dir))
        patcher.start()
        self.addCleanup(patcher.stop)
        folder_patcher = patch.dict(sys.modules, {"folder_paths": None})
        folder_patcher.start()
        self.addCleanup(folder_patcher.stop)
        self.job = SEGMENTS._Job("weights", None)
        self.job.status = "running"
        self.destination = (self.segments_dir / "models" / "transnetv2"
                            / SEGMENTS._TRANSNET_WEIGHT_NAME)

    def patch_hashes(self, stack, wheel, weight, wheel_hash=None, weight_hash=None, size=None):
        stack.enter_context(patch.object(
            SEGMENTS, "_TRANSNET_WHEEL_SHA256",
            wheel_hash or hashlib.sha256(wheel).hexdigest()))
        stack.enter_context(patch.object(
            SEGMENTS, "_TRANSNET_WEIGHT_SHA256",
            weight_hash or hashlib.sha256(weight).hexdigest()))
        stack.enter_context(patch.object(
            SEGMENTS, "_TRANSNET_WEIGHT_SIZE", len(weight) if size is None else size))

    def test_comfy_model_folder_registration_and_lookup_priority(self):
        model_root = self.root / "comfy" / "models"
        default_folder = model_root / "transnetv2"
        extra_folder = self.root / "extra_models" / "transnetv2"
        default_folder.mkdir(parents=True)
        extra_folder.mkdir(parents=True)
        weight = b"model folder weight fixture"
        model_weight = default_folder / SEGMENTS._TRANSNET_WEIGHT_NAME
        model_weight.write_bytes(weight)
        self.destination.parent.mkdir(parents=True)
        self.destination.write_bytes(b"corrupt user cache")

        fake = ModuleType("folder_paths")
        fake.models_dir = str(model_root)
        fake.add_model_folder_path = unittest.mock.Mock()
        fake.get_folder_paths = unittest.mock.Mock(return_value=[str(default_folder), str(extra_folder)])
        with patch.dict(sys.modules, {"folder_paths": fake}), \
                patch.object(SEGMENTS, "_TRANSNET_WEIGHT_SIZE", len(weight)), \
                patch.object(SEGMENTS, "_TRANSNET_WEIGHT_SHA256", hashlib.sha256(weight).hexdigest()), \
                patch.object(SEGMENTS, "_download_to_file") as downloader:
            folders = SEGMENTS._transnet_model_folders()
            result = SEGMENTS._ensure_transnet_weights(self.job)
        self.assertEqual(folders, [str(default_folder), str(extra_folder)])
        fake.add_model_folder_path.assert_called_once_with("transnetv2", str(default_folder))
        self.assertEqual(result, str(model_weight))
        self.assertEqual(self.destination.read_bytes(), b"corrupt user cache")
        downloader.assert_not_called()

    def test_download_verifies_both_hashes_and_atomically_publishes_only_weight(self):
        self.assertEqual(SEGMENTS._TRANSNET_WHEEL_SHA256,
                         "9f8e72085526aaa95383d219b6750b1fa45b865fd10d840cafa12ef78ab3bf27")
        self.assertEqual(SEGMENTS._TRANSNET_WEIGHT_SIZE, 30506391)
        self.assertEqual(SEGMENTS._TRANSNET_WEIGHT_SHA256,
                         "a313d0b3bebfa9a71914b375bfdf918a30b5c3b1e6be51972d35dd8078b442de")
        weight = b"verified official-weight fixture"
        wheel = weight_wheel(weight)
        self.destination.parent.mkdir(parents=True)
        self.destination.write_bytes(b"corrupt old weight")
        published = []
        real_replace = os.replace

        def download(_url, path, _job):
            Path(path).write_bytes(wheel)

        def replace(source, destination):
            published.append((Path(source), Path(destination), Path(destination).exists()))
            real_replace(source, destination)

        with ExitStack() as stack:
            self.patch_hashes(stack, wheel, weight)
            stack.enter_context(patch.object(SEGMENTS, "_download_to_file", side_effect=download))
            stack.enter_context(patch.object(SEGMENTS.os, "replace", side_effect=replace))
            result = SEGMENTS._ensure_transnet_weights(self.job)
        self.assertEqual(result, str(self.destination))
        self.assertEqual(self.destination.read_bytes(), weight)
        self.assertEqual(len(published), 1)
        source, destination, existed = published[0]
        self.assertEqual(destination, self.destination)
        self.assertFalse(existed)
        self.assertEqual(source.parent, destination.parent)
        self.assertTrue(source.name.startswith(".transnet-weights-"))
        self.assertEqual(self.job.stage, "正在下载AI模型权重")
        self.assertEqual([path.name for path in self.destination.parent.iterdir()],
                         [SEGMENTS._TRANSNET_WEIGHT_NAME])

        with ExitStack() as stack:
            self.patch_hashes(stack, wheel, weight)
            downloader = stack.enter_context(patch.object(SEGMENTS, "_download_to_file"))
            self.assertEqual(SEGMENTS._ensure_transnet_weights(self.job), str(self.destination))
            downloader.assert_not_called()

    def test_corrupt_wheel_weight_and_size_are_rejected_and_cleaned(self):
        weight = b"weight fixture"
        wheel = weight_wheel(weight)
        cases = [
            {"wheel_hash": "0" * 64},
            {"weight_hash": "0" * 64},
            {"size": len(weight) + 1},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                with ExitStack() as stack:
                    self.patch_hashes(stack, wheel, weight, **overrides)
                    stack.enter_context(patch.object(
                        SEGMENTS, "_download_to_file",
                        side_effect=lambda _url, path, _job: Path(path).write_bytes(wheel)))
                    with self.assertRaisesRegex(ValueError, "AI模型权重校验失败"):
                        SEGMENTS._ensure_transnet_weights(self.job)
                self.assertFalse(self.destination.exists())
                self.assertEqual(list(self.destination.parent.glob(".transnet-*")), [])

    def test_download_failure_and_cancellation_are_chinese_and_clean(self):
        with patch.object(SEGMENTS, "_download_to_file", side_effect=OSError("network down")):
            with self.assertRaisesRegex(ValueError, "下载AI模型权重失败：network down"):
                SEGMENTS._ensure_transnet_weights(self.job)
        self.assertEqual(list(self.destination.parent.glob(".transnet-*")), [])

        def cancelled_download(_url, path, job):
            Path(path).write_bytes(b"partial wheel")
            job.cancel_event.set()

        with patch.object(SEGMENTS, "_download_to_file", side_effect=cancelled_download):
            with self.assertRaises(SEGMENTS._Cancelled):
                SEGMENTS._ensure_transnet_weights(self.job)
        self.assertFalse(self.destination.exists())
        self.assertEqual(list(self.destination.parent.glob(".transnet-*")), [])

    def test_concurrent_callers_download_once_under_lock(self):
        weight = b"concurrent weight fixture"
        wheel = weight_wheel(weight)
        started = threading.Event()
        release = threading.Event()
        second_started = threading.Event()
        calls = []
        calls_lock = threading.Lock()
        results = []
        errors = []

        def download(_url, path, _job):
            with calls_lock:
                calls.append(path)
            started.set()
            if not release.wait(3):
                raise RuntimeError("test download was not released")
            Path(path).write_bytes(wheel)

        def run():
            try:
                results.append(SEGMENTS._ensure_transnet_weights(self.job))
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        with ExitStack() as stack:
            self.patch_hashes(stack, wheel, weight)
            stack.enter_context(patch.object(SEGMENTS, "_download_to_file", side_effect=download))
            first = threading.Thread(target=run)
            first.start()
            self.assertTrue(started.wait(2))

            def second():
                second_started.set()
                run()

            waiter = threading.Thread(target=second)
            waiter.start()
            self.assertTrue(second_started.wait(2))
            release.set()
            first.join(3)
            waiter.join(3)
        self.assertFalse(first.is_alive() or waiter.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(calls), 1)
        self.assertEqual(results, [str(self.destination), str(self.destination)])


class TransNetDetectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="kedou_transnet_detect_")
        self.addCleanup(self.tmp.cleanup)
        self.source = str(Path(self.tmp.name) / "clip.mp4")
        patcher = patch.object(SEGMENTS, "SEGMENTS_DIR", str(Path(self.tmp.name) / "segments"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def detect(self, frames, model, duration, min_scene_len=1.0, threshold=0.5):
        job = SEGMENTS._Job("ai-detect", None)
        job.status = "running"
        params = {"engine": "transnet", "threshold": threshold,
                  "min_scene_len": min_scene_len, "adaptive": 2.5}
        torch_module = fake_torch()
        av_module, container = fake_av(frames, rate=1)
        stages = []
        update = SEGMENTS._update_job

        def record(instance, progress=None, stage=None):
            if stage is not None:
                stages.append(stage)
            update(instance, progress=progress, stage=stage)

        windows = None
        destroyed = model.destroyed
        with patch.dict(sys.modules, {"av": av_module, "torch": torch_module}), \
                patch.object(SEGMENTS, "_ensure_transnet_weights", return_value="verified.pth"), \
                patch.object(SEGMENTS, "_create_transnet_model", return_value=model), \
                patch.object(SEGMENTS, "_update_job", side_effect=record):
            result = SEGMENTS._detect_shots_model(self.source, duration, params, job)
            windows = [window.copy() for window in model.windows]
        gc.collect()  # Release Mock's temporary reference to the fake model.
        return {"segments": result, "windows": windows, "stages": stages,
                "job": job, "container": container, "destroyed": destroyed,
                "empty_cache": torch_module.cuda.empty_cache}

    def test_streaming_windows_padding_vfr_pts_and_finally_release(self):
        times = [round(5.0 + index * 0.2 + (index % 3) * 0.01, 3) for index in range(130)]
        frames = [FakeRGBFrame(index, int(round(value * 1000))) for index, value in enumerate(times)]
        values = [0.1] * len(frames)
        values[60], values[110] = 0.9, 0.8
        duration = times[-1] - times[0] + 1.0
        outcome = self.detect(frames, FakeTransNetModel(values), duration)
        self.assertEqual([(item["start"], item["end"]) for item in outcome["segments"]],
                         [(0.0, times[60] - times[0]), (times[60] - times[0], times[110] - times[0]),
                          (times[110] - times[0], duration)])
        self.assertAlmostEqual(outcome["segments"][0]["confidence"], 0.9)
        self.assertAlmostEqual(outcome["segments"][1]["confidence"], 0.8)
        self.assertNotIn("confidence", outcome["segments"][-1])
        self.assertEqual(len(outcome["windows"]), 3)
        first, second, third = outcome["windows"]
        np.testing.assert_array_equal(first[:25], np.repeat(frames[0].source[None], 25, axis=0))
        np.testing.assert_array_equal(first[25:], np.stack([frame.source for frame in frames[:75]]))
        np.testing.assert_array_equal(second, np.stack([frame.source for frame in frames[25:125]]))
        np.testing.assert_array_equal(third[:55], np.stack([frame.source for frame in frames[75:]]))
        np.testing.assert_array_equal(third[55:], np.repeat(frames[-1].source[None], 45, axis=0))
        self.assertTrue(all(frame.reformat_size == (48, 27, "rgb24") for frame in frames))
        self.assertIn("正在加载AI检测模型", outcome["stages"])
        self.assertIn("正在AI检测镜头", outcome["stages"])
        self.assertTrue(outcome["container"].closed)
        self.assertTrue(outcome["destroyed"].wait(1))
        outcome["empty_cache"].assert_called_once_with()
        self.assertGreaterEqual(outcome["job"].progress, 0.8)

    def test_short_scene_isolation_and_strict_probability_threshold(self):
        times = [index * 0.1 for index in range(40)]
        frames = [FakeRGBFrame(index, int(value * 1000)) for index, value in enumerate(times)]
        values = [0.1] * 40
        values[10], values[12], values[20] = 0.9, 0.8, 0.5
        outcome = self.detect(frames, FakeTransNetModel(values), 4.0, min_scene_len=1.0)
        self.assertEqual([(item["start"], item["end"]) for item in outcome["segments"]],
                         [(0.0, 1.0), (1.0, 4.0)])
        values[20] = 0.5001
        outcome = self.detect(frames, FakeTransNetModel(values), 4.0, min_scene_len=1.0)
        self.assertEqual([(item["start"], item["end"]) for item in outcome["segments"]],
                         [(0.0, 1.0), (1.0, 2.0), (2.0, 4.0)])

    def test_cancel_during_inference_still_releases_model(self):
        frames = [FakeRGBFrame(index, index * 100) for index in range(100)]
        torch_module = fake_torch()
        av_module, _container = fake_av(frames, rate=10)
        job = SEGMENTS._Job("ai-cancel", None)
        job.status = "running"

        def invoke():
            model = FakeTransNetModel([0.1] * 100)
            reference = weakref.ref(model)
            model.hook = job.cancel_event.set
            with patch.dict(sys.modules, {"av": av_module, "torch": torch_module}), \
                    patch.object(SEGMENTS, "_ensure_transnet_weights", return_value="verified.pth"), \
                    patch.object(SEGMENTS, "_create_transnet_model", side_effect=lambda _path: model):
                with self.assertRaises(SEGMENTS._Cancelled):
                    SEGMENTS._detect_shots_model(
                        self.source, 10.0,
                        {"engine": "transnet", "threshold": 0.5,
                         "min_scene_len": 1.0, "adaptive": 2.5}, job)
            return reference

        reference = invoke()
        gc.collect()
        self.assertIsNone(reference())
        torch_module.cuda.empty_cache.assert_called_once_with()

    def test_model_loading_failure_still_empties_cuda_cache(self):
        torch_module = fake_torch()
        job = SEGMENTS._Job("ai-load-failure", None)
        job.status = "running"
        with patch.dict(sys.modules, {"torch": torch_module}), \
                patch.object(SEGMENTS, "_ensure_transnet_weights", return_value="verified.pth"), \
                patch.object(SEGMENTS, "_create_transnet_model", side_effect=RuntimeError("bad weights")):
            with self.assertRaisesRegex(ValueError, "AI镜头检测失败：bad weights"):
                SEGMENTS._detect_shots_model(
                    self.source, 10.0,
                    {"engine": "transnet", "threshold": 0.5,
                     "min_scene_len": 1.0, "adaptive": 2.5}, job)
        torch_module.cuda.empty_cache.assert_called_once_with()


class TransNetVendorTests(unittest.TestCase):
    def test_forward_sigmoid_heads_device_and_weight_roundtrip_without_download(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch unavailable")
        spec = importlib.util.spec_from_file_location(
            "_kedou_transnet_vendor_tests", ROOT / "kedou_bridge" / "vendor" / "transnetv2.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        options = {"F": 1, "L": 1, "S": 1, "D": 4,
                   "use_frame_similarity": False, "use_color_histograms": False}
        model = module.TransNetV2(device="cpu", weights_path=None, **options)
        inputs = torch.randint(0, 256, (1, 4, 27, 48, 3), dtype=torch.uint8)
        with torch.inference_mode():
            logits, extra = model(inputs)
            single, many_hot = model.predict_raw(inputs)
        self.assertEqual(tuple(logits.shape), (1, 4, 1))
        self.assertEqual(tuple(extra["many_hot"].shape), (1, 4, 1))
        self.assertEqual(tuple(single.shape), (1, 4, 1))
        self.assertEqual(tuple(many_hot.shape), (1, 4, 1))
        self.assertTrue(bool(torch.all((single >= 0) & (single <= 1))))
        self.assertTrue(bool(torch.all((many_hot >= 0) & (many_hot <= 1))))
        feature_model = module.TransNetV2(
            F=1, L=1, S=1, D=4, device="cpu", weights_path=None,
            use_frame_similarity=True, use_color_histograms=True)
        with torch.inference_mode():
            feature_single, feature_many = feature_model.predict_raw(inputs)
        self.assertEqual(tuple(feature_single.shape), (1, 4, 1))
        self.assertEqual(tuple(feature_many.shape), (1, 4, 1))
        with patch.object(torch.cuda, "is_available", return_value=True):
            self.assertEqual(module.TransNetV2._detect_best_device(), "cuda")
        with patch.object(torch.cuda, "is_available", return_value=False):
            self.assertEqual(module.TransNetV2._detect_best_device(), "cpu")

        with TemporaryDirectory(prefix="kedou_transnet_vendor_") as directory:
            path = Path(directory) / "weights.pth"
            torch.save(model.state_dict(), str(path))
            loaded = module.TransNetV2(device="cpu", weights_path=str(path), **options)
        self.assertEqual(set(model.state_dict()), set(loaded.state_dict()))
        self.assertTrue(all(torch.equal(value, loaded.state_dict()[name])
                            for name, value in model.state_dict().items()))


class OmniShotCutWeightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="kedou_omnishotcut_weights_")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.segments_dir = self.root / "kedou_segments"
        patcher = patch.object(SEGMENTS, "SEGMENTS_DIR", str(self.segments_dir))
        patcher.start()
        self.addCleanup(patcher.stop)
        folder_patcher = patch.dict(sys.modules, {"folder_paths": None})
        folder_patcher.start()
        self.addCleanup(folder_patcher.stop)
        self.job = SEGMENTS._Job("omni-weights", None)
        self.job.status = "running"
        self.destination = (self.segments_dir / "models" / "omnishotcut"
                            / SEGMENTS.OMNISHOTCUT_WEIGHT_NAME)

    def patch_weight(self, stack, weight, digest=None, size=None):
        stack.enter_context(patch.object(SEGMENTS, "OMNISHOTCUT_WEIGHT_SIZE",
                                         len(weight) if size is None else size))
        stack.enter_context(patch.object(SEGMENTS, "OMNISHOTCUT_WEIGHT_SHA256",
                                         digest or hashlib.sha256(weight).hexdigest()))

    def test_registered_model_folder_priority_and_unknown_files_are_ignored(self):
        default = self.root / "comfy" / "models" / "omnishotcut"
        extra = self.root / "extra" / "omnishotcut"
        default.mkdir(parents=True)
        extra.mkdir(parents=True)
        weight = b"official fixture"
        model_weight = default / SEGMENTS.OMNISHOTCUT_WEIGHT_NAME
        model_weight.write_bytes(weight)
        unknown = default / "unknown.pth"
        unknown.write_bytes(b"keep me")
        self.destination.parent.mkdir(parents=True)
        self.destination.write_bytes(b"corrupt user cache")
        fake = ModuleType("folder_paths")
        fake.models_dir = str(default.parent)
        fake.add_model_folder_path = unittest.mock.Mock()
        fake.get_folder_paths = unittest.mock.Mock(return_value=[str(default), str(extra)])
        with patch.dict(sys.modules, {"folder_paths": fake}), \
                patch.object(SEGMENTS, "_OMNISHOTCUT_REGISTERED_FOLDERS", set()), \
                patch.object(SEGMENTS, "OMNISHOTCUT_WEIGHT_SIZE", len(weight)), \
                patch.object(SEGMENTS, "OMNISHOTCUT_WEIGHT_SHA256", hashlib.sha256(weight).hexdigest()), \
                patch.object(SEGMENTS, "_download_omnishotcut_to_file") as downloader:
            folders = SEGMENTS._omnishotcut_model_folders()
            result = SEGMENTS._ensure_omnishotcut_weights(self.job)
        self.assertEqual(folders[0], str(default))
        self.assertIn(str(extra), folders)
        fake.add_model_folder_path.assert_called_once_with("omnishotcut", str(default))
        self.assertEqual(result, str(model_weight))
        self.assertEqual(unknown.read_bytes(), b"keep me")
        self.assertEqual(self.destination.read_bytes(), b"corrupt user cache")
        downloader.assert_not_called()

    def test_unknown_model_file_falls_back_to_valid_user_cache(self):
        folder = self.root / "models" / "omnishotcut"
        folder.mkdir(parents=True)
        (folder / SEGMENTS.OMNISHOTCUT_WEIGHT_NAME).write_bytes(b"unknown")
        self.destination.parent.mkdir(parents=True)
        self.destination.write_bytes(b"valid user cache")
        with patch.object(SEGMENTS, "_omnishotcut_model_folders", return_value=[str(folder)]), \
                patch.object(SEGMENTS, "OMNISHOTCUT_WEIGHT_SIZE", len(b"valid user cache")), \
                patch.object(SEGMENTS, "OMNISHOTCUT_WEIGHT_SHA256",
                             hashlib.sha256(b"valid user cache").hexdigest()), \
                patch.object(SEGMENTS, "_download_omnishotcut_to_file") as downloader:
            self.assertEqual(SEGMENTS._ensure_omnishotcut_weights(self.job), str(self.destination))
        downloader.assert_not_called()

    def test_download_checks_size_hash_and_atomic_publish(self):
        self.assertEqual(SEGMENTS.OMNISHOTCUT_WEIGHT_SIZE, 211261519)
        self.assertEqual(SEGMENTS.OMNISHOTCUT_WEIGHT_SHA256,
                         "5bafe33d8d0dde16c6e24fc63dfc580da9d5731804d6e51e1fc8de21d4600999")
        weight = b"verified omni fixture"
        self.destination.parent.mkdir(parents=True)
        self.destination.write_bytes(b"corrupt old weight")
        published = []
        real_replace = os.replace

        def download(url, path, _job):
            self.assertEqual(url, SEGMENTS.OMNISHOTCUT_WEIGHTS_URL)
            Path(path).write_bytes(weight)

        def replace(source, destination):
            published.append((Path(source), Path(destination), Path(destination).exists()))
            real_replace(source, destination)

        with ExitStack() as stack:
            self.patch_weight(stack, weight)
            stack.enter_context(patch.object(SEGMENTS, "_download_omnishotcut_to_file", side_effect=download))
            stack.enter_context(patch.object(SEGMENTS.os, "replace", side_effect=replace))
            result = SEGMENTS._ensure_omnishotcut_weights(self.job)
        self.assertEqual(result, str(self.destination))
        self.assertEqual(self.destination.read_bytes(), weight)
        self.assertEqual(len(published), 1)
        source, destination, existed = published[0]
        self.assertEqual(destination, self.destination)
        self.assertTrue(existed)  # Corrupt cache is replaced only after verification.
        self.assertEqual(source.parent, destination.parent)
        self.assertTrue(source.name.startswith(".omnishotcut-weights-"))
        self.assertEqual(self.job.stage, "正在下载OmniShotCut模型")
        self.assertEqual([p.name for p in self.destination.parent.iterdir()],
                         [SEGMENTS.OMNISHOTCUT_WEIGHT_NAME])

    def test_corrupt_size_hash_download_failure_and_cancel_clean_up(self):
        weight = b"omni fixture"
        cases = [{"digest": "0" * 64}, {"size": len(weight) + 1}]
        for overrides in cases:
            with self.subTest(overrides=overrides), ExitStack() as stack:
                self.patch_weight(stack, weight, **overrides)
                stack.enter_context(patch.object(
                    SEGMENTS, "_download_omnishotcut_to_file",
                    side_effect=lambda _url, path, _job: Path(path).write_bytes(weight)))
                with self.assertRaisesRegex(ValueError, "OmniShotCut模型权重校验失败"):
                    SEGMENTS._ensure_omnishotcut_weights(self.job)
            self.assertFalse(self.destination.exists())
            self.assertEqual(list(self.destination.parent.glob(".omnishotcut-*")), [])
        with patch.object(SEGMENTS, "_download_omnishotcut_to_file", side_effect=OSError("network down")):
            with self.assertRaisesRegex(ValueError, "下载OmniShotCut模型失败：network down"):
                SEGMENTS._ensure_omnishotcut_weights(self.job)
        self.assertEqual(list(self.destination.parent.glob(".omnishotcut-*")), [])

        def cancelled(_url, path, job):
            Path(path).write_bytes(b"partial")
            job.cancel_event.set()

        with patch.object(SEGMENTS, "_download_omnishotcut_to_file", side_effect=cancelled):
            with self.assertRaises(SEGMENTS._Cancelled):
                SEGMENTS._ensure_omnishotcut_weights(self.job)
        self.assertFalse(self.destination.exists())
        self.assertEqual(list(self.destination.parent.glob(".omnishotcut-*")), [])

    def test_stream_download_rejects_oversize_before_hash(self):
        payload = b"x" * 32
        response = io.BytesIO(payload)
        response.read = lambda _size=-1: b"x" * 32
        response.__enter__ = lambda: response
        response.__exit__ = lambda *_args: False
        with patch.object(SEGMENTS.urllib.request, "urlopen", return_value=response), \
                patch.object(SEGMENTS, "OMNISHOTCUT_WEIGHT_SIZE", 16), \
                patch.object(SEGMENTS, "_file_sha256") as digest:
            with self.assertRaisesRegex(ValueError, "大小不符合预期"):
                SEGMENTS._download_omnishotcut_to_file("https://example.invalid", str(self.root / "x"), self.job)
        digest.assert_not_called()


class FakeOmniFrame:
    def __init__(self, value, pts, time_base=0.001, hook=None):
        self.source = np.full((96, 128, 3), value, dtype=np.uint8)
        self.pts = pts
        self.time_base = time_base
        self.hook = hook

    def reformat(self, width, height, format):
        self.reformat_size = (width, height, format)
        return self

    def to_ndarray(self, format=None):
        if self.hook:
            self.hook()
        return self.source


class FakeOmniModel:
    def __init__(self):
        self.device = "cpu"
        self.destroyed = threading.Event()

    def __del__(self):
        self.destroyed.set()


def fake_omnishotcut(cancel=None, error=None):
    vendor = ModuleType("_kedou_video_segments_tests.vendor.omnishotcut")
    vendor.intra_int2string = {0: "General", 1: "Dissolve"}
    vendor.inter_int2string = {0: "New_Start", 1: "Hard_Cut", 3: "Transition"}
    calls = []

    def load_model(_path, device="auto"):
        if error:
            raise error
        return FakeOmniModel(), SimpleNamespace(max_process_window_length=100,
                                                process_width=128, process_height=96)

    def infer_windows(_model, _args, windows, **_kwargs):
        records = []
        total = 0
        for window, valid_len, start, valid_start, valid_end in windows:
            if cancel:
                cancel()
            records.append((window.copy(), valid_len, start, valid_start, valid_end))
            total = max(total, start + valid_len)
        cuts = [60, 110] if total > 110 else ([60] if total > 60 else [])
        points = [0] + cuts + [total]
        return {"ranges": [[a, b] for a, b in zip(points, points[1:])],
                "intra_labels": [0] * len(points[:-1]),
                "inter_labels": [0] + [1 if i == 0 else 3 for i in range(len(cuts))],
                "confidence": [0.9 if cuts else None] + [0.8] * max(0, len(cuts) - 1)
                               + ([None] if cuts else [])}

    vendor.load_model = load_model
    vendor.infer_windows = infer_windows
    return vendor, calls


def omnishotcut_modules(vendor):
    package = ModuleType(SEGMENTS.__package__)
    package.__path__ = [str(ROOT / "kedou_bridge")]
    parent = ModuleType(SEGMENTS.__package__ + ".vendor")
    parent.__path__ = []
    parent.omnishotcut = vendor
    return {SEGMENTS.__package__: package, SEGMENTS.__package__ + ".vendor": parent,
            SEGMENTS.__package__ + ".vendor.omnishotcut": vendor}


class OmniShotCutDetectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="kedou_omnishotcut_detect_")
        self.addCleanup(self.tmp.cleanup)
        self.source = str(Path(self.tmp.name) / "clip.mp4")

    def detect(self, frames, duration=30.0, minimum=0.2, vendor=None, error=None):
        job = SEGMENTS._Job("omni-detect", None)
        job.status = "running"
        torch_module = fake_torch()
        av_module, container = fake_av(frames, rate=7)
        vendor, records = vendor if isinstance(vendor, tuple) else (vendor, [])
        if vendor is None:
            vendor, records = fake_omnishotcut(error=error)
        original = vendor.infer_windows
        # Wrap the window iterator so the test can inspect actual streamed windows.
        def wrapped(_model, _args, windows, **kwargs):
            materialized = list(windows)  # At most two bounded 100-frame windows in this fixture.
            records.extend((window.copy(), valid, start, valid_start, valid_end)
                           for window, valid, start, valid_start, valid_end in materialized)
            kwargs["windows"] = iter(materialized)
            return original(_model, _args, **kwargs)

        vendor.infer_windows = wrapped
        params = {"engine": "omnishotcut", "threshold": 0.5,
                  "min_scene_len": minimum, "adaptive": 2.5}
        stages = []
        update = SEGMENTS._update_job

        def stage(instance, progress=None, stage=None):
            if stage:
                stages.append(stage)
            update(instance, progress=progress, stage=stage)

        modules = omnishotcut_modules(vendor)
        modules.update({"av": av_module, "torch": torch_module})
        with patch.dict(sys.modules, modules), \
                patch.object(SEGMENTS, "_ensure_omnishotcut_weights", return_value="verified.pth"), \
                patch.object(SEGMENTS, "_update_job", side_effect=stage):
            result = SEGMENTS._detect_shots_omnishotcut(self.source, duration, params, job)
        return result, records, stages, container, torch_module.cuda.empty_cache

    def test_streamed_official_windows_pts_confidence_and_finally(self):
        times = [round(10 + i * 0.2 + (i % 4) * 0.01, 4) for i in range(130)]
        frames = [FakeOmniFrame(i, int(round(t * 1000))) for i, t in enumerate(times)]
        vendor, _ = fake_omnishotcut()
        segments, records, stages, container, empty_cache = self.detect(
            frames, duration=times[-1] - times[0] + 1, vendor=vendor)
        self.assertEqual([(s["start"], s["end"]) for s in segments], [
            (0.0, times[60] - times[0]), (times[60] - times[0], times[110] - times[0]),
            (times[110] - times[0], times[-1] - times[0] + 1)])
        self.assertEqual(segments[0]["confidence"], 0.9)
        self.assertEqual(segments[1]["confidence"], 0.8)
        self.assertEqual(segments[0]["transition"], "New_Start")
        self.assertEqual(segments[1]["transition"], "Hard_Cut")
        self.assertEqual(segments[2]["transition"], "Transition")
        self.assertEqual(len(records), 2)
        first, second = records
        self.assertEqual((first[1], first[2], first[3], first[4]), (100, 0, 0, 95))
        self.assertEqual((second[1], second[2], second[3], second[4]), (40, 90, 95, 130))
        np.testing.assert_array_equal(first[0][:100], np.stack([f.source for f in frames[:100]]))
        np.testing.assert_array_equal(second[0][:40], np.stack([f.source for f in frames[90:]]))
        self.assertTrue(np.all(second[0][40:] == 0))
        self.assertTrue(all(f.reformat_size == (128, 96, "rgb24") for f in frames))
        self.assertIn("正在加载高精度模型", stages)
        self.assertIn("正在高精度检测镜头", stages)
        self.assertTrue(container.closed)
        empty_cache.assert_called_once_with()

    def test_exact_window_length_is_one_final_window(self):
        frames = [FakeOmniFrame(i, i * 100) for i in range(100)]
        _segments, records, _stages, _container, _cache = self.detect(frames, duration=10)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0][1:], (100, 0, 0, 100))

    def test_cancel_and_oom_release_resources(self):
        job = SEGMENTS._Job("cancel", None)
        job.status = "running"
        torch_module = fake_torch()
        av_module, _container = fake_av([FakeOmniFrame(i, i * 100) for i in range(130)], rate=10)
        vendor, _records = fake_omnishotcut(cancel=job.cancel_event.set)
        modules = omnishotcut_modules(vendor)
        modules.update({"av": av_module, "torch": torch_module})
        with patch.dict(sys.modules, modules), \
                patch.object(SEGMENTS, "_ensure_omnishotcut_weights", return_value="verified.pth"):
            with self.assertRaises(SEGMENTS._Cancelled):
                SEGMENTS._detect_shots_omnishotcut(self.source, 30, {
                    "engine": "omnishotcut", "threshold": 0.5,
                    "min_scene_len": 0.2, "adaptive": 2.5}, job)
        torch_module.cuda.empty_cache.assert_called_once_with()

        vendor, _records = fake_omnishotcut()
        oom_model = FakeOmniModel()
        oom_model.device = "cuda"
        vendor.load_model = lambda *_args, **_kwargs: (oom_model, SimpleNamespace(
            max_process_window_length=100, process_width=128, process_height=96))
        vendor.infer_windows = lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("CUDA out of memory"))
        modules = omnishotcut_modules(vendor)
        oom_av, _container = fake_av([FakeOmniFrame(0, 0)], rate=10)
        modules.update({"av": oom_av, "torch": torch_module})
        with patch.dict(sys.modules, modules), \
                patch.object(SEGMENTS, "_ensure_omnishotcut_weights", return_value="verified.pth"):
            with self.assertRaisesRegex(ValueError, "CUDA 显存不足"):
                SEGMENTS._detect_shots_omnishotcut(self.source, 30, {
                    "engine": "omnishotcut", "threshold": 0.5,
                    "min_scene_len": 0.2, "adaptive": 2.5}, SEGMENTS._Job("oom", None))


class OmniShotCutVendorTests(unittest.TestCase):
    def load_engine(self, torch_module=None):
        package_name = "_kedou_omnishotcut_vendor_tests"
        package = ModuleType(package_name)
        package.__path__ = [str(ROOT / "kedou_bridge" / "vendor" / "omnishotcut")]
        architecture = ModuleType(package_name + ".architecture")
        architecture.__path__ = []
        model = ModuleType(package_name + ".architecture.model")
        model.build_model = Mock()
        torch_module = torch_module or ModuleType("torch")
        if not hasattr(torch_module, "cuda"):
            torch_module.cuda = SimpleNamespace(is_available=lambda: False)
        modules = {package_name: package, package_name + ".architecture": architecture,
                   package_name + ".architecture.model": model, "torch": torch_module}
        with patch.dict(sys.modules, modules):
            labels = importlib.import_module(package_name + ".labels")
            engine = importlib.import_module(package_name + ".engine")
        return engine, labels, torch_module

    def test_official_split_decode_collect_and_assemble_parity(self):
        engine, _labels, _torch = self.load_engine()
        video = np.arange(130 * 2 * 3 * 3, dtype=np.uint8).reshape(130, 2, 3, 3)
        windows = engine.split_videos(video, 100, 10)
        self.assertEqual([(w[2], w[3], w[4], w[5]) for w in windows],
                         [(0, 0, 95, 100), (90, 95, 130, 40)])
        np.testing.assert_array_equal(windows[1][0][:40], video[90:])
        self.assertTrue(np.all(windows[1][0][40:] == 0))
        segments = engine.decode_window_segments([0, 1, 2], [0, 1, 3], [30, 60, 100], 100)
        self.assertEqual(segments, [(0, 30, 0, 0), (30, 60, 1, 1), (60, 100, 2, 3)])
        cuts = engine.collect_cuts_from_window(segments, 90, 95, 130)
        self.assertEqual(cuts, [{"pos": 120, "intra_label": 1, "inter_label": 1}])
        ranges, intra, inter = engine.assemble_ranges([
            {"pos": 120, "intra_label": 1, "inter_label": 1},
            {"pos": 121, "intra_label": 2, "inter_label": 3},
            {"pos": 180, "intra_label": 2, "inter_label": 3}], 200, duplicate_tolerance=1)
        self.assertEqual(ranges, [[0, 120], [120, 180], [180, 200]])
        self.assertEqual(intra, [0, 1, 2])
        self.assertEqual(inter, [0, 1, 3])

    def test_streaming_inference_uses_range_end_probability(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch unavailable")
        engine, _labels, _torch = self.load_engine(torch)

        class Model:
            def eval(self):
                return self

            def __call__(self, batch):
                self.batch = batch
                intra = torch.full((1, 3, 9), -10.0)
                inter = torch.full((1, 3, 6), -10.0)
                ranges = torch.full((1, 3, 102), -10.0)
                intra[0, 0, 0], intra[0, 1, 1], intra[0, 2, 1] = 10, 10, 10
                inter[0, 0, 0], inter[0, 1, 1], inter[0, 2, 3] = 10, 10, 10
                ranges[0, 0, 30], ranges[0, 1, 60], ranges[0, 2, 100] = 10, 10, 10
                return {"intra_clip_logits": intra, "inter_clip_logits": inter,
                        "pred_shot_logits": ranges}

        model = Model()
        args = SimpleNamespace(max_process_window_length=100, process_height=2, process_width=3)
        windows = [(np.zeros((100, 2, 3, 3), dtype=np.uint8), 100, 0, 0, 95),
                   (np.zeros((100, 2, 3, 3), dtype=np.uint8), 40, 90, 95, 130)]
        result = engine.infer_windows(model, args, iter(windows), device="cpu")
        self.assertEqual(result["ranges"], [[0, 30], [30, 60], [60, 120], [120, 130]])
        self.assertEqual(result["intra_labels"], [0, 1, 1, 1])
        self.assertEqual(result["inter_labels"], [0, 1, 3, 1])
        self.assertAlmostEqual(result["confidence"][0], 0.99999988, places=6)
        self.assertAlmostEqual(result["confidence"][1], 0.99999988, places=6)
        self.assertAlmostEqual(result["confidence"][2], 0.99999988, places=6)
        self.assertIsNone(result["confidence"][3])
        expected = (torch.zeros(1, 100, 3, 2, 3) - torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        expected /= torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)
        self.assertTrue(torch.allclose(model.batch, expected))

    def test_load_model_verifies_hash_before_weights_only_false(self):
        engine, _labels, torch_module = self.load_engine()
        torch_module.load = Mock(return_value={"args": SimpleNamespace(), "model": {}})
        model = Mock()
        engine.build_model = Mock(return_value=model)
        with TemporaryDirectory(prefix="kedou_omni_load_") as directory:
            path = Path(directory) / engine.CHECKPOINT_FILENAME
            path.write_bytes(b"fixture")
            with patch.object(engine, "CHECKPOINT_SIZE", 7), \
                    patch.object(engine, "CHECKPOINT_SHA256", "0" * 64):
                with self.assertRaisesRegex(ValueError, "SHA-256"):
                    engine.load_model(str(path), device="cpu")
            torch_module.load.assert_not_called()
            with patch.object(engine, "CHECKPOINT_SIZE", 7), \
                    patch.object(engine, "CHECKPOINT_SHA256", hashlib.sha256(b"fixture").hexdigest()):
                loaded, _args = engine.load_model(str(path), device="cpu")
            self.assertIs(loaded, model)
            torch_module.load.assert_called_once_with(str(path), map_location="cpu", weights_only=False)
            model.eval.assert_called_once_with()


class SegmentRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.app = web.Application()
        server_patch = patch.object(ROUTES.compat.PromptServer, "instance", SimpleNamespace(app=self.app))
        server_patch.start()
        self.addCleanup(server_patch.stop)
        table = web.RouteTableDef()
        ROUTES.register(table)
        self.app.add_routes(table)

    async def asyncSetUp(self):
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_four_route_protocol_and_chinese_errors(self):
        sample = {"id": "job-1", "status": "running", "progress": 0.25, "stage": "正在解码",
                  "result": None, "error": None, "cancelled": False}
        with patch.object(ROUTES.segments, "start_analyze", return_value="job-1"), \
                patch.object(ROUTES.segments, "start_export", return_value="job-2"), \
                patch.object(ROUTES.segments, "get_job", return_value=sample), \
                patch.object(ROUTES.segments, "cancel_job", return_value=sample):
            response = await self.client.post("/ps/video/segments/analyze", json={
                "name": "clip.mp4", "subfolder": "", "tab": "input", "mode": "duration", "params": {}})
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"ok": True, "job_id": "job-1"})

            response = await self.client.get("/ps/video/segments/jobs/job-1")
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"ok": True, "job": sample})

            response = await self.client.post("/ps/video/segments/jobs/job-1/cancel", json={})
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"ok": True, "job": sample})

            response = await self.client.post("/ps/video/segments/export", json={
                "name": "clip.mp4", "subfolder": "", "tab": "input", "mode": "copy",
                "segments": [{"start": 0, "end": 1}]})
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"ok": True, "job_id": "job-2"})

        with patch.object(ROUTES.segments, "get_job", return_value=None):
            response = await self.client.get("/ps/video/segments/jobs/missing")
            self.assertEqual(response.status, 404)
            self.assertEqual(await response.json(), {"ok": False, "error": "分段任务不存在"})
        with patch.object(ROUTES.segments, "start_analyze", side_effect=ValueError("mode 必须是 duration 或 shot")):
            response = await self.client.post("/ps/video/segments/analyze", json={"mode": "bad"})
            self.assertEqual(response.status, 400)
            self.assertEqual((await response.json())["error"], "mode 必须是 duration 或 shot")
        response = await self.client.post("/ps/video/segments/analyze", data="{",
                                          headers={"Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        self.assertIn("JSON", (await response.json())["error"])


if __name__ == "__main__":
    unittest.main()

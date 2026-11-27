# -*- coding: utf-8 -*-
"""媒体流式上传、安全校验、元数据、首帧/波形预览与 AV 应用协议。"""

import asyncio
import importlib
import io
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
import wave

from aiohttp import FormData, web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def load_routes():
    name = "_kedou_media_av_tests"
    package = ModuleType(name)
    package.__path__ = [str(ROOT / "kedou_bridge")]
    server = ModuleType("server")
    server.PromptServer = type("PromptServer", (), {"instance": None})
    nodes = ModuleType("nodes")
    nodes.NODE_CLASS_MAPPINGS = {}
    with patch.dict(sys.modules, {name: package, "server": server, "nodes": nodes,
                                  "folder_paths": None, "torch": None}):
        module = importlib.import_module(name + ".routes")
        module.common = importlib.import_module(name + ".common")
        return module


class FakeAudioFrame:
    def __init__(self, samples, after_decode=None):
        import numpy as np

        self.samples = np.asarray(samples, dtype=np.float32)
        self.after_decode = after_decode
        self.conversions = 0

    def to_ndarray(self):
        self.conversions += 1
        if self.after_decode is not None:
            self.after_decode()
        return self.samples


class FakeAudioContainer:
    def __init__(self, frames, stream_duration, container_duration):
        self.frames = frames
        self.duration = container_duration
        self.streams = [SimpleNamespace(
            type="audio", duration=stream_duration, time_base=1, channels=1,
            codec_context=SimpleNamespace(sample_rate=8000))]
        self.decode_calls = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def decode(self, _stream):
        self.decode_calls += 1
        return iter(self.frames)


def fake_audio_av(chunks, expected_samples, stream_duration=True, container_duration=None,
                  after_decode=None):
    frames = [FakeAudioFrame(chunk, after_decode) for chunk in chunks]
    duration = expected_samples / 8000.0 if stream_duration else None
    container = FakeAudioContainer(frames, duration, container_duration)
    module = ModuleType("av")
    module.time_base = 1000000
    module.open = lambda *_args, **_kw: container
    return module, container


class FakeThumbFrame:
    def __init__(self, source, rotation=0):
        import numpy as np

        self.source = np.asarray(source, dtype=np.uint8)
        self.height, self.width = self.source.shape[:2]
        self.rotation = rotation
        self.reformats = []
        self.events = []

    def reformat(self, width, height, format):
        self.events.append("reformat")
        self.reformats.append((width, height, format))
        self.width, self.height = width, height
        return self

    def to_ndarray(self):
        import numpy as np

        self.events.append("to_ndarray")
        if self.source.shape[:2] != (self.height, self.width):
            return np.full((self.height, self.width, 3), self.source[0, 0], dtype=np.uint8)
        return self.source


class FakeVideoContainer:
    def __init__(self, frame, width, height, rotation=0):
        self.frame = frame
        self.streams = [SimpleNamespace(
            type="video", width=width, height=height, rotation=rotation,
            duration=None, time_base=None, average_rate=6, frames=6,
            codec_context=SimpleNamespace(name="h264"))]
        self.duration = 1000000
        self.decode_calls = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def decode(self, _stream):
        self.decode_calls += 1
        return iter([self.frame])


def fake_video_av(frame, width, height, rotation=0):
    container = FakeVideoContainer(frame, width, height, rotation)
    module = ModuleType("av")
    module.time_base = 1000000
    module.open = lambda *_args, **_kw: container
    return module, container


class FakeTrimPacket:
    def __init__(self, pts, time_base=0.001, dts=None):
        self.pts = pts
        self.dts = pts if dts is None else dts
        self.time_base = time_base
        self.stream = None


class FakeTrimSource:
    def __init__(self, stream, packets, audio_stream=None, audio_packets=None, origin=None):
        self.streams = [stream] + ([audio_stream] if audio_stream is not None else [])
        if origin is not None:
            stream.start_time = int(origin / float(stream.time_base))
        self.packets = list(packets) + list(audio_packets or [])
        for packet in self.packets:
            packet.source_stream = self.streams[0] if packet in packets else self.streams[1]
            packet.stream = packet.source_stream
        self.format = SimpleNamespace(name="mp4")
        self.seek_calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def seek(self, offset, **kwargs):
        self.seek_calls.append((offset, kwargs))

    def demux(self, _stream=None):
        for packet in self.packets:
            packet.stream = packet.source_stream
        return iter(self.packets)


class FakeTrimOutput:
    def __init__(self, path):
        self.path = path
        self.packets = []
        self.template = None
        self.templates = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        Path(self.path).write_bytes(b"trimmed fixture")
        return False

    def add_stream_from_template(self, template):
        if self.template is None:
            self.template = template
        self.templates.append(template)
        return SimpleNamespace(type=template.type)

    def mux(self, packet):
        self.packets.append(packet)


def fake_trim_av(packets, audio_packets=None, origin=None):
    stream = SimpleNamespace(index=0, type="video", time_base=0.001, average_rate=10,
                             codec_context=SimpleNamespace(name="h264", has_b_frames=2))
    audio_stream = None
    if audio_packets is not None:
        audio_stream = SimpleNamespace(index=1, type="audio", time_base=0.001, average_rate=10,
                                       codec_context=SimpleNamespace(name="aac", has_b_frames=0))
    source = FakeTrimSource(stream, packets, audio_stream, audio_packets, origin)
    outputs = []
    open_calls = []

    def opener(path, mode="r", **_kwargs):
        open_calls.append((path, mode))
        if mode == "r":
            return source
        output = FakeTrimOutput(path)
        outputs.append(output)
        return output

    module = ModuleType("av")
    module.time_base = 1000000
    module.error = SimpleNamespace(FFmpegError=RuntimeError)
    module.open = opener
    return module, SimpleNamespace(source=source, outputs=outputs, open_calls=open_calls, opener=opener)


class MediaUploadInfoTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.routes = load_routes()
        cls.addClassCleanup(cls.routes._thumb_pool.shutdown, wait=True)

    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="kedou_media_av_")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.input = root / "input"
        self.output = root / "output"
        self.input.mkdir()
        self.output.mkdir()
        self.thumbs = root / "thumbs"
        self.waveforms = root / "waveforms"
        self.trims = root / "trims"
        Image.new("RGB", (20, 12), "red").save(self.input / "photo.png")
        patches = [
            patch.object(self.routes.media, "_media_dirs",
                         lambda: (str(self.input), str(self.output))),
            patch.object(self.routes.media, "THUMB_DIR", str(self.thumbs)),
            patch.object(self.routes.media, "WAVEFORM_DIR", str(self.waveforms)),
            patch.object(self.routes.media, "TRIM_DIR", str(self.trims)),
            patch.object(self.routes, "_thumb_pruned", True),
            patch.object(self.routes, "_waveform_pruned", True),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        self.app = web.Application()
        server_patch = patch.object(self.routes.compat.PromptServer, "instance",
                                    SimpleNamespace(app=self.app))
        server_patch.start()
        self.addCleanup(server_patch.stop)
        table = web.RouteTableDef()
        self.routes.register(table)
        self.app.add_routes(table)

    async def asyncSetUp(self):
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def upload(self, content, filename, mime, kind="image", subfolder=""):
        form = FormData()
        form.add_field("file", content, filename=filename, content_type=mime)
        return await self.client.post("/ps/media/upload?type=%s&subfolder=%s" % (kind, subfolder),
                                      data=form)

    def make_video(self):
        try:
            import av
            import numpy as np
        except ImportError:
            self.skipTest("av/numpy unavailable")
        path = self.input / "tiny.mp4"
        try:
            with av.open(str(path), "w") as container:
                stream = container.add_stream("libx264", rate=6)
                stream.width, stream.height, stream.pix_fmt = 64, 48, "yuv420p"
                for i in range(6):
                    arr = np.full((48, 64, 3), 40 + i * 30, dtype=np.uint8)
                    for packet in stream.encode(av.VideoFrame.from_ndarray(arr, format="rgb24")):
                        container.mux(packet)
                for packet in stream.encode():
                    container.mux(packet)
        except Exception as exc:
            self.skipTest("cannot encode video fixture: %s" % exc)
        return path

    def make_av_video(self):
        try:
            import av
            import numpy as np
        except ImportError:
            self.skipTest("av/numpy unavailable")
        path = self.input / "tiny-av.mp4"
        try:
            with av.open(str(path), "w") as container:
                video = container.add_stream("libx264", rate=8)
                video.width, video.height, video.pix_fmt = 64, 48, "yuv420p"
                audio = container.add_stream("aac", rate=8000)
                for i in range(8):
                    arr = np.full((48, 64, 3), 30 + i * 20, dtype=np.uint8)
                    frame = av.VideoFrame.from_ndarray(arr, format="rgb24")
                    for packet in video.encode(frame):
                        container.mux(packet)
                    samples = (np.sin(np.arange(1000) * 0.05) * 0.2).astype(np.float32).reshape(1, -1)
                    aframe = av.AudioFrame.from_ndarray(samples, format="fltp", layout="mono")
                    aframe.sample_rate = 8000
                    aframe.pts = i * 1000
                    for packet in audio.encode(aframe):
                        container.mux(packet)
                for packet in video.encode():
                    container.mux(packet)
                for packet in audio.encode():
                    container.mux(packet)
        except Exception as exc:
            self.skipTest("cannot encode A/V fixture: %s" % exc)
        return path

    def make_audio(self):
        path = self.input / "tone.wav"
        with wave.open(str(path), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(8000)
            out.writeframes(b"".join(int(12000 * ((i % 80) / 80 - 0.5)).to_bytes(2, "little", signed=True)
                                     for i in range(4000)))
        return path

    def test_fitted_thumbnail_pads_to_requested_box(self):
        dst = self.routes.media._make_thumb(
            str(self.input / "photo.png"), str(self.thumbs / "fit"), 96, "1x1")
        with Image.open(dst) as im:
            self.assertEqual(im.size, (96, 96))

    async def test_streaming_image_upload_and_metadata(self):
        png = (self.input / "photo.png").read_bytes()
        response = await self.upload(png, "photo.png", "image/png", subfolder="batch")
        self.assertEqual(response.status, 200, await response.text())
        data = await response.json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["subfolder"], "batch")
        self.assertEqual((self.input / "batch" / "photo.png").read_bytes(), png)
        self.assertEqual(list((self.input / "batch").glob(".kedou-upload-*")), [])
        info = await (await self.client.get(
            "/ps/media/info?filename=photo.png&subfolder=batch&type=input")).json()
        self.assertEqual((info["width"], info["height"]), (20, 12))
        self.assertEqual(info["kind"], "image")

    async def test_upload_sanitizes_name_and_never_overwrites(self):
        png = (self.input / "photo.png").read_bytes()
        first = await (await self.upload(png, "../../outside.png", "image/png")).json()
        second = await (await self.upload(png, "../../outside.png", "image/png")).json()
        self.assertTrue(first["ok"], first)
        self.assertTrue(second["ok"], second)
        self.assertEqual(first["filename"], "outside.png")
        self.assertEqual(second["filename"], "outside_1.png")
        self.assertFalse((Path(self.tmp.name) / "outside.png").exists())
        self.assertFalse(any(p.name.startswith(".kedou-upload-") for p in self.input.iterdir()))

    async def test_upload_rejects_traversal_extension_spoof_and_oversize(self):
        png = (self.input / "photo.png").read_bytes()
        for kwargs in ({"subfolder": "../escape", "filename": "photo.png"},
                       {"filename": "bad.txt"}, {"filename": "CON .png"},
                       {"filename": "bad?.png"},
                       {"filename": "bad.png", "content": b"not an image"},
                       {"filename": "big.png", "content": png + b"x" * 100}):
            with self.subTest(kwargs=kwargs), patch.dict(
                    self.routes.media.MEDIA_UPLOAD_LIMITS, {"image": len(png)}):
                response = await self.upload(kwargs.get("content", png), kwargs["filename"],
                                             "image/png", subfolder=kwargs.get("subfolder", ""))
                self.assertEqual(response.status, 400, await response.text())
                self.assertFalse((await response.json())["ok"])
        self.assertFalse((self.input / "bad.txt").exists())
        self.assertFalse((self.input / "bad.png").exists())

    async def test_upload_checks_directory_before_and_after_makedirs(self):
        request = SimpleNamespace(content_length=0, headers={}, content=None)
        media = self.routes.media
        with patch.object(media.paths, "_under", return_value=False) as under, \
                patch.object(media.os, "makedirs") as makedirs:
            result = await media.upload_media(request, "image", "linked")
        self.assertFalse(result["ok"])
        self.assertIn("越界", result["error"])
        makedirs.assert_not_called()
        under.assert_called_once()

        with patch.object(media.paths, "_under", side_effect=[True, False]) as under, \
                patch.object(media.os, "makedirs") as makedirs:
            result = await media.upload_media(request, "image", "linked")
        self.assertFalse(result["ok"])
        self.assertEqual(under.call_count, 2, (result, under.call_args_list))
        makedirs.assert_called_once()

    async def test_upload_counts_non_file_fields_toward_request_limit(self):
        class Entry:
            def __init__(self, name, chunks, filename=None):
                self.name = name
                self.chunks = list(chunks)
                self.filename = filename

            async def read_chunk(self):
                return self.chunks.pop(0) if self.chunks else b""

        class Reader:
            def __init__(self, entries):
                self.entries = iter(entries)

            async def next(self):
                return next(self.entries, None)

        png = (self.input / "photo.png").read_bytes()
        entries = [Entry("file", [png], "photo.png"),
                   Entry("note", [b"x" * 600000]), Entry("meta", [b"y" * 600000])]
        request = SimpleNamespace(content_length=0, headers={}, content=None)
        with patch.dict(self.routes.media.MEDIA_UPLOAD_LIMITS, {"image": len(png)}), \
                patch("aiohttp.MultipartReader", return_value=Reader(entries)), \
                patch.object(self.routes.media, "_validate_upload") as validate:
            result = await self.routes.media.upload_media(request, "image")
        self.assertFalse(result["ok"])
        self.assertIn("请求超过", result["error"])
        validate.assert_not_called()
        self.assertFalse((self.input / "photo_1.png").exists())
        self.assertFalse(list(self.input.glob(".kedou-upload-*")))

    async def test_upload_extra_fields_within_overhead_are_accepted(self):
        png = (self.input / "photo.png").read_bytes()
        form = FormData()
        form.add_field("file", png, filename="with-note.png", content_type="image/png")
        form.add_field("note", "media library upload")
        response = await self.client.post("/ps/media/upload?type=image", data=form)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())["size"], len(png))

    async def test_upload_concurrency_limit_returns_429_without_waiting(self):
        slots = threading.BoundedSemaphore(1)
        slots.acquire()
        try:
            with patch.object(self.routes.media, "_upload_slots", slots):
                response = await self.upload((self.input / "photo.png").read_bytes(),
                                             "busy.png", "image/png")
            self.assertEqual(response.status, 429)
            self.assertEqual((await response.json())["status"], 429)
            self.assertFalse((self.input / "busy.png").exists())
        finally:
            slots.release()

    async def test_upload_validation_unexpected_exception_is_400_and_cancellation_propagates(self):
        png = (self.input / "photo.png").read_bytes()
        with patch.object(self.routes.media, "_validate_upload", side_effect=RuntimeError("bad codec")):
            response = await self.upload(png, "invalid.png", "image/png")
        self.assertEqual(response.status, 400, await response.text())
        self.assertIn("bad codec", (await response.json())["error"])
        self.assertFalse((self.input / "invalid.png").exists())
        self.assertFalse(list(self.input.glob(".kedou-upload-*")))

        class Entry:
            async def read_chunk(self):
                return b""

        class Reader:
            async def next(self):
                return None

        entry = Entry()
        entry.name = "file"
        entry.filename = "cancelled.png"
        entry.read_chunk = unittest.mock.AsyncMock(side_effect=[png, b""])
        reader = Reader()
        reader.next = unittest.mock.AsyncMock(side_effect=[entry, None])
        request = SimpleNamespace(content_length=0, headers={}, content=None)
        with patch("aiohttp.MultipartReader", return_value=reader), \
                patch.object(self.routes.media.asyncio, "to_thread",
                             side_effect=asyncio.CancelledError), \
                self.assertRaises(asyncio.CancelledError):
            await self.routes.media.upload_media(request, "image", "cancelled")
        self.assertFalse(list((self.input / "cancelled").glob(".kedou-upload-*")))

    async def test_video_upload_metadata_thumbnail_and_cache(self):
        path = self.make_video()
        raw = path.read_bytes()
        response = await self.upload(raw, "tiny.mp4", "video/mp4", kind="video")
        self.assertEqual(response.status, 200, await response.text())
        info = await (await self.client.get(
            "/ps/media/info?filename=tiny.mp4&type=input")).json()
        self.assertTrue(info["ok"], info)
        self.assertEqual((info["width"], info["height"]), (64, 48))
        self.assertEqual(info["frame_count"], 6)
        self.assertAlmostEqual(info["fps"], 6.0)
        thumb = await self.client.get("/ps/thumb?filename=tiny.mp4&type=input&w=64&mode=raw")
        self.assertEqual(thumb.status, 200)
        self.assertIn(thumb.headers["Content-Type"], ("image/jpeg", "image/png"))
        with Image.open(__import__("io").BytesIO(await thumb.read())) as im:
            self.assertEqual(im.size, (64, 48))
        cached = set(self.thumbs.iterdir())
        self.assertEqual((await self.client.get(
            "/ps/thumb?filename=tiny.mp4&type=input&w=64&mode=raw")).status, 200)
        self.assertEqual(set(self.thumbs.iterdir()), cached)

    async def test_audio_upload_metadata_waveform_and_cache(self):
        path = self.make_audio()
        response = await self.upload(path.read_bytes(), "tone.wav", "audio/wav", kind="audio")
        self.assertEqual(response.status, 200, await response.text())
        info = await (await self.client.get(
            "/ps/media/info?filename=tone.wav&type=input")).json()
        self.assertEqual(info["sample_rate"], 8000)
        self.assertEqual(info["channels"], 1)
        self.assertAlmostEqual(info["duration"], 0.5)
        waveform = await self.client.get("/ps/waveform?filename=tone.wav&type=input&w=256")
        self.assertEqual(waveform.status, 200)
        self.assertEqual(waveform.headers["Content-Type"], "image/png")
        with Image.open(__import__("io").BytesIO(await waveform.read())) as im:
            self.assertEqual(im.size, (256, 64))
        cached = set(self.waveforms.iterdir())
        self.assertEqual((await self.client.get(
            "/ps/waveform?filename=tone.wav&type=input&w=256")).status, 200)
        self.assertEqual(set(self.waveforms.iterdir()), cached)
        self.assertEqual((await self.client.get(
            "/ps/waveform?filename=photo.png&type=input")).status, 404)

    def test_trimmed_video_no_trim_and_invalid_parameters(self):
        media = self.routes.media
        source = str(self.input / "missing.mp4")
        self.assertEqual(media.trimmed_video(source),
                         {"ok": True, "path": source, "copied": False})
        self.assertFalse(self.trims.exists())
        for start, end in ((-1, None), (True, None), (float("nan"), None),
                           (0, -1), (1, 1), (2, 1), (0, "2")):
            with self.subTest(start=start, end=end):
                result = media.trimmed_video(source, trim_start=start, trim_end=end)
                self.assertFalse(result["ok"])
                self.assertIn("trim_", result["error"])
                self.assertFalse(self.trims.exists())

    def test_trimmed_video_fake_packet_filter_cache_and_fingerprint(self):
        media = self.routes.media
        source = self.input / "packets.mp4"
        source.write_bytes(b"source")
        packets = [FakeTrimPacket(pts) for pts in (0, 100, 199, 200, 300, 499, 500, 600)]
        module, fake = fake_trim_av(packets)
        with patch.dict(sys.modules, {"av": module}):
            first = media.trimmed_video(str(source), trim_start=0.2, trim_end=0.5)
            self.assertTrue(first["ok"], first)
            self.assertTrue(first["copied"])
            self.assertEqual([packet.pts for packet in fake.outputs[-1].packets], [0, 100, 199, 200, 300, 499, 500, 600])
            self.assertIs(fake.outputs[-1].template, fake.source.streams[0])
            self.assertEqual(fake.source.seek_calls[0],
                             (200, {"stream": fake.source.streams[0],
                                    "backward": True, "any_frame": False}))
            calls = len(fake.open_calls)
            with patch.object(module, "open", side_effect=AssertionError("cache miss")):
                cached = media.trimmed_video(str(source), trim_start=0.2, trim_end=0.5)
            self.assertTrue(cached["ok"], cached)
            self.assertFalse(cached["copied"])
            self.assertEqual(cached["path"], first["path"])
            self.assertEqual(cached["cache_key"], first["cache_key"])
            self.assertEqual(len(fake.open_calls), calls)

            stat = source.stat()
            os.utime(str(source), ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
            touched = media.trimmed_video(str(source), trim_start=0.2, trim_end=0.5)
            source.write_bytes(b"source with a different size")
            resized = media.trimmed_video(str(source), trim_start=0.2, trim_end=0.5)
            later_start = media.trimmed_video(str(source), trim_start=0.25, trim_end=0.5)
            later_end = media.trimmed_video(str(source), trim_start=0.25, trim_end=0.6)
        for result in (touched, resized, later_start, later_end):
            self.assertTrue(result["ok"], result)
            self.assertTrue(result["copied"])
        keys = {first["cache_key"], touched["cache_key"], resized["cache_key"],
                later_start["cache_key"], later_end["cache_key"]}
        self.assertEqual(len(keys), 5)
        self.assertEqual([packet.pts for packet in fake.outputs[-1].packets], [0, 100, 199, 200, 300, 499, 500, 600])
        self.assertFalse(list(self.trims.glob(".kedou-trim-*")))

    def test_broken_image_info_returns_failure_contract(self):
        (self.input / "broken.png").write_bytes(b"not an image")
        result = self.routes.media.media_info("broken.png", "", "input")
        self.assertFalse(result["ok"])
        self.assertIn("图片尺寸", result["error"])

    def test_trim_cache_cleanup_keeps_recent_and_protected_files(self):
        media = self.routes.media
        self.trims.mkdir()
        old = self.trims / "kedou-old.mp4"
        recent = self.trims / "kedou-recent.mp4"
        protected = self.trims / "kedou-protected.mp4"
        for path in (old, recent, protected):
            path.write_bytes(b"cache")
        old_time = time.time() - media.TRIM_CACHE_TTL - 10
        os.utime(old, (old_time, old_time))
        os.utime(protected, (old_time, old_time))
        media._prune_trim_cache(str(protected))
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(protected.exists())

    def test_trimmed_video_preserves_audio_stream_and_preroll(self):
        media = self.routes.media
        source = self.input / "av.mp4"
        source.write_bytes(b"source")
        module, fake = fake_trim_av(
            [FakeTrimPacket(pts) for pts in (0, 199, 200, 300, 499)],
            [FakeTrimPacket(pts) for pts in (0, 199, 200, 300, 499)])
        with patch.dict(sys.modules, {"av": module}):
            result = media.trimmed_video(str(source), trim_start=0.2, trim_end=0.5)
        self.assertTrue(result["ok"], result)
        packets = fake.outputs[-1].packets
        self.assertEqual([p.pts for p in packets if p.stream.type == "video"], [0, 199, 200, 300, 499])
        self.assertEqual([p.pts for p in packets if p.stream.type == "audio"], [0, 199, 200, 300, 499])

    def test_trimmed_video_nonzero_origin_and_bframe_dts_stop(self):
        media = self.routes.media
        source = self.input / "origin.mp4"
        source.write_bytes(b"source")
        packets = [
            FakeTrimPacket(10000), FakeTrimPacket(10200),
            FakeTrimPacket(10450, dts=10300), FakeTrimPacket(10300, dts=10400),
            FakeTrimPacket(10499, dts=10500), FakeTrimPacket(10400, dts=11000),
        ]
        module, fake = fake_trim_av(packets, origin=10)
        fake.source.start_time = 0
        with patch.dict(sys.modules, {"av": module}):
            result = media.trimmed_video(str(source), trim_start=0.2, trim_end=0.5)
        self.assertTrue(result["ok"], result)
        self.assertEqual([p.pts for p in fake.outputs[-1].packets], [10000, 10200, 10450, 10300, 10499])
        self.assertEqual(fake.source.seek_calls[0][0], 10200)

    def test_trimmed_video_real_av_copy_keeps_decodable_audio(self):
        try:
            import av
        except ImportError:
            self.skipTest("av unavailable")
        source = self.make_av_video()
        for start, end in ((0.2, 0.5), (0.0, 0.1)):
            with self.subTest(start=start, end=end):
                result = self.routes.media.trimmed_video(str(source), trim_start=start, trim_end=end)
                self.assertTrue(result["ok"], result)
                with av.open(result["path"], mode="r") as container:
                    self.assertEqual(len(container.streams.audio), 1)
                with av.open(result["path"], mode="r") as container:
                    self.assertGreater(sum(1 for _ in container.decode(container.streams.video[0])), 0)
                with av.open(result["path"], mode="r") as container:
                    self.assertGreater(sum(1 for _ in container.decode(container.streams.audio[0])), 0)

    def test_trimmed_video_empty_window_fails_without_publishing_cache(self):
        source = self.input / "empty-window.mp4"
        source.write_bytes(b"source")
        module, _fake = fake_trim_av([FakeTrimPacket(3000)])
        with patch.dict(sys.modules, {"av": module}):
            result = self.routes.media.trimmed_video(str(source), trim_start=2, trim_end=3)
        self.assertFalse(result["ok"])
        self.assertIn("没有可复制的视频包", result["error"])
        self.assertIn("关键帧近似", result["error"])
        self.assertEqual(list(self.trims.iterdir()), [])

    def test_trimmed_video_real_pyav_stream_copy_and_cache(self):
        try:
            import av
        except ImportError:
            self.skipTest("av unavailable")
        source = self.make_video()
        media = self.routes.media
        result = media.trimmed_video(str(source), trim_start=0.2, trim_end=0.5)
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["copied"])
        self.assertEqual(Path(result["path"]).parent, self.trims)
        self.assertEqual(Path(result["path"]).suffix, ".mp4")
        with av.open(result["path"], mode="r") as container:
            stream = container.streams.video[0]
            self.assertEqual(stream.codec_context.name, "h264")
            timestamps = [float(packet.pts * packet.time_base)
                          for packet in container.demux(stream) if packet.pts is not None]
        self.assertTrue(timestamps)
        self.assertTrue(any(0.2 <= value < 0.5 for value in timestamps), timestamps)
        self.assertLess(max(timestamps), 1.0)  # B 帧解码后卷允许略微越过请求终点
        self.assertLessEqual(timestamps[0], 0.2 + 1e-6)  # 保留起点前关键帧预卷
        with av.open(result["path"], mode="r") as check:
            decoded = next(check.decode(check.streams.video[0]))
            self.assertGreater(decoded.width, 0)
            self.assertGreater(decoded.height, 0)
        unavailable = ModuleType("av")
        unavailable.open = lambda *_args, **_kw: (_ for _ in ()).throw(
            AssertionError("cache miss"))
        with patch.dict(sys.modules, {"av": unavailable}):
            cached = media.trimmed_video(str(source), trim_start=0.2, trim_end=0.5)
        self.assertTrue(cached["ok"], cached)
        self.assertFalse(cached["copied"])
        self.assertEqual(cached["path"], result["path"])

    def waveform_amplitudes(self, path):
        """从 PNG 的实际波形列读归一化幅值，避免只断言图片尺寸。"""
        with Image.open(path) as im:
            im = im.convert("RGB")
            mid = im.height // 2
            max_amp = mid - 2
            values = []
            for x in range(im.width):
                count = sum(1 for y in range(im.height)
                            if im.getpixel((x, y)) == (86, 190, 255))
                values.append(max(0, (count - 1) // 2) / float(max_amp) if count else 0.0)
            return values

    def test_waveform_int16_full_scale_negative_does_not_overflow(self):
        import numpy as np

        path = self.input / "fullscale.wav"
        samples = np.array([-32768, -16384, 0, 16384], dtype="<i2")
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            wav.writeframes(samples.tobytes())
        dst = self.routes.media._make_waveform(str(path), str(self.waveforms / "fullscale"), width=128)
        self.assertEqual(self.waveform_amplitudes(dst)[0], 1.0)

    def test_waveform_short_audio_uses_global_columns_and_peak_amplitudes(self):
        import numpy as np

        samples = np.array([-0.125, -0.25, -0.5, -1.0,
                            0.75, 0.625, 0.375, 0.1875], dtype=np.float32)
        fake_av, _container = fake_audio_av([samples[:4], samples[4:]], expected_samples=8,
                                            container_duration=1000000)  # 流时长必须优先于容器时长
        base = str(self.waveforms / "short")
        with patch.dict(sys.modules, {"av": fake_av}):
            dst = self.routes.media._make_waveform("fake.wav", base, width=128)
        peaks = self.waveform_amplitudes(dst)
        cols = [0, 16, 32, 48, 64, 80, 96, 112]
        for col, expected in zip(cols, np.abs(samples)):
            rendered = int(float(expected) * 30) / 30.0
            self.assertAlmostEqual(peaks[col], rendered, places=5)
        self.assertTrue(all(value == 0 for i, value in enumerate(peaks) if i not in cols))

    def test_waveform_multiframe_maximum_at_aggregates_repeated_columns(self):
        import numpy as np

        first = np.resize(np.array([0.2, 0.4, 0.6, 0.8], dtype=np.float32), 1000)
        second = np.resize(np.array([0.9, 0.3, 0.7, 0.1], dtype=np.float32), 1000)
        samples = np.concatenate([first, second])
        expected = np.zeros(128, dtype=np.float32)
        for index, value in enumerate(samples):
            col = index * 128 // len(samples)          # 独立按全局区间计算期望峰值
            expected[col] = max(expected[col], abs(value))
        fake_av, _container = fake_audio_av([first, second], expected_samples=len(samples))
        base = str(self.waveforms / "multi")
        with patch.dict(sys.modules, {"av": fake_av}):
            dst = self.routes.media._make_waveform("fake.wav", base, width=128)
        peaks = self.waveform_amplitudes(dst)
        for col, value in enumerate(expected):
            rendered = int(float(value / expected.max()) * 30) / 30.0
            self.assertAlmostEqual(peaks[col], rendered, places=5)
        self.assertAlmostEqual(peaks[0], int((0.8 / 0.9) * 30) / 30.0, places=5)
        self.assertEqual(peaks[127], 1.0)              # 第二帧必须落在全局后半段

    def test_waveform_duration_fallback_and_missing_duration_error(self):
        import numpy as np

        samples = np.array([0.2, 0.4, 0.6, 0.8], dtype=np.float32)
        fake_av, _container = fake_audio_av([samples], expected_samples=4,
                                            stream_duration=False, container_duration=500)
        base = str(self.waveforms / "fallback")
        with patch.dict(sys.modules, {"av": fake_av}):
            dst = self.routes.media._make_waveform("fake.wav", base, width=128)
        peaks = self.waveform_amplitudes(dst)
        for col, expected in zip((0, 32, 64, 96), samples):
            rendered = int(float(expected / 0.8) * 30) / 30.0
            self.assertAlmostEqual(peaks[col], rendered, places=5)

        fake_av, container = fake_audio_av([samples], expected_samples=4,
                                           stream_duration=False)
        with patch.dict(sys.modules, {"av": fake_av}), \
                self.assertRaisesRegex(ValueError, "缺少 stream/container duration"):
            self.routes.media._make_waveform("fake.wav", str(self.waveforms / "missing"), width=128)
        self.assertEqual(container.decode_calls, 0)
        self.assertFalse((self.waveforms / "missing.png").exists())

    def test_waveform_cancellation_stops_before_next_frame_and_publishes_nothing(self):
        import numpy as np

        cancel = threading.Event()
        fake_av, container = fake_audio_av(
            [np.ones(4, dtype=np.float32), np.ones(4, dtype=np.float32)],
            expected_samples=8, after_decode=cancel.set)
        base = str(self.waveforms / "cancelled")
        with patch.dict(sys.modules, {"av": fake_av}), \
                self.assertRaisesRegex(RuntimeError, "已取消"):
            self.routes.media._make_waveform("fake.wav", base, width=128, cancel=cancel)
        self.assertEqual(container.frames[0].conversions, 1)
        self.assertEqual(container.frames[1].conversions, 0)
        self.assertFalse(Path(base + ".png").exists())

    def test_waveform_timeout_stops_before_frame_conversion(self):
        import numpy as np

        fake_av, container = fake_audio_av([np.ones(4, dtype=np.float32)], expected_samples=4)
        base = str(self.waveforms / "timeout")
        with patch.dict(sys.modules, {"av": fake_av}), \
                patch.object(self.routes.media.time, "monotonic", side_effect=[0.0, 2.0]), \
                self.assertRaisesRegex(TimeoutError, "超时"):
            self.routes.media._make_waveform("fake.wav", base, width=128, timeout=1)
        self.assertEqual(container.frames[0].conversions, 0)
        self.assertFalse(Path(base + ".png").exists())

    def test_video_thumbnail_rotation_and_metadata_display_dimensions(self):
        import numpy as np

        source = np.array([[[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]],
                           [[0, 255, 255], [255, 0, 255], [255, 255, 0], [0, 0, 0]]],
                          dtype=np.uint8)
        for rotation in (90, 180, 270):
            frame = FakeThumbFrame(source, rotation)
            fake_av, _container = fake_video_av(frame, 4, 2, rotation)
            with self.subTest(rotation=rotation), patch.dict(sys.modules, {"av": fake_av}), \
                    patch.object(self.routes.media, "_save_thumb_image",
                                 side_effect=lambda im, *_args: im):
                im = self.routes.media._make_video_thumb("fake.mp4", str(self.thumbs / "rot"),
                                                         64, mode="raw")
                self.assertEqual(im.size, (2, 4) if rotation in (90, 270) else (4, 2))
                np.testing.assert_array_equal(np.asarray(im),
                                              np.rot90(source, k=-(rotation // 90)))
                info = self.routes.media._av_metadata("fake.mp4")
                self.assertEqual((info["width"], info["height"]),
                                 (2, 4) if rotation in (90, 270) else (4, 2))
                im.close()

    def test_video_thumbnail_reformats_before_array_and_guards_source_budget(self):
        import numpy as np

        source = np.full((480, 640, 3), 100, dtype=np.uint8)
        frame = FakeThumbFrame(source, 90)
        fake_av, container = fake_video_av(frame, 640, 480, 90)
        with patch.dict(sys.modules, {"av": fake_av}), \
                patch.object(self.routes.media, "_save_thumb_image",
                             side_effect=lambda im, *_args: im):
            im = self.routes.media._make_video_thumb("fake.mp4", str(self.thumbs / "resized"),
                                                     64, mode="raw")
        self.assertEqual(frame.reformats, [(64, 48, "rgb24")])
        self.assertEqual(frame.events, ["reformat", "to_ndarray"])
        self.assertEqual(im.size, (48, 64))
        self.assertEqual(np.asarray(im).shape, (64, 48, 3))
        im.close()

        frame = FakeThumbFrame(np.zeros((2, 4, 3), dtype=np.uint8))
        fake_av, container = fake_video_av(frame, 4, 2)
        with patch.dict(sys.modules, {"av": fake_av}), \
                patch.object(self.routes.media, "AV_MEMORY_LIMIT", 100), \
                self.assertRaisesRegex(ValueError, "源帧超过"):
            self.routes.media._make_video_thumb("fake.mp4", str(self.thumbs / "huge"), 64)
        self.assertEqual(container.decode_calls, 0)
        self.assertEqual(frame.events, [])

    async def test_video_upload_rejects_audio_only_content(self):
        audio = self.make_audio()
        response = await self.upload(audio.read_bytes(), "fake.mp4", "video/mp4", kind="video")
        self.assertEqual(response.status, 400, await response.text())
        self.assertFalse((self.input / "fake.mp4").exists())

    async def test_output_fallback_and_pick_without_copy(self):
        path = self.make_video()
        target = self.output / "exports" / path.name
        target.parent.mkdir()
        os.replace(str(path), str(target))
        info = await (await self.client.get(
            "/ps/media/info?filename=tiny.mp4&subfolder=exports&type=input")).json()
        self.assertEqual(info["tab"], "output")
        result = await (await self.client.post("/ps/media/pick", json={
            "name": "tiny.mp4", "subfolder": "exports", "tab": "output",
            "copy_output": False})).json()
        self.assertTrue(result["ok"])
        self.assertFalse(result["copied"])
        self.assertEqual(result["filename"], "exports/tiny.mp4")
        self.assertFalse((self.input / "tiny.mp4").exists())
        self.assertEqual((await self.client.post("/ps/media/pick", json={
            "name": "tiny.mp4", "tab": "output", "copy_output": "false"})).status, 400)

    async def test_version_advertises_av_loader(self):
        data = await (await self.client.get("/ps/version")).json()
        self.assertIs(data["features"]["av_loader"], True)
        self.assertIs(data["features"]["video_segments"], True)

    def test_av_app_protocol_and_pack_widget(self):
        common = self.routes.common
        pack = self.routes.pack
        self.assertEqual(common.DOM_HANDLES["KedouAVLoader"]["media_state"], "kedou_av")
        self.assertEqual(common._kind_of({"type": "KedouAVLoader"}, "media_state", ""), "av")
        self.assertEqual(common._panel_widget("KedouAVLoader", "kedou_av"), "media_state")
        self.assertEqual(pack._suggest_widget({}, "KedouAVLoader", "media_state"), "kedou_av")
        self.assertIn("kedou_av", self.routes.apps._KAPP_WIDGETS)
        item = self.routes.apps._kapp_param_item({
            "node": "1", "input": "media_state", "widget": "kedou_av",
            "node_type": "KedouAVLoader", "default": {"v": 2, "kind": "av"},
        }, {})
        self.assertEqual(item["kind"], "av")
        self.assertEqual(item["widget"], "kedou_av")
        self.assertEqual(pack._suggest_widget({}, "KedouImageLoader", "media_state"), "kedou_media")
        app_path = self.input / "av.app.json"
        app_path.write_text(json.dumps({
            "nodes": [{"id": 1, "type": "KedouAVLoader", "widgets_values": [""],
                       "inputs": [{"name": "media_state", "widget": {"name": "media_state"}}]}],
            "extra": {"linearMode": True, "linearData": {
                "inputs": [["graph:1:kedou_av", "音视频"]], "outputs": ["1"]}},
        }), encoding="utf-8")
        spec = self.routes.apps.build_spec(str(app_path), object_info={})
        self.assertEqual(spec["params"][0]["kind"], "av")
        self.assertEqual(spec["params"][0]["input"], "media_state")
        self.assertIn("音视频", spec["desc"])

    def test_official_app_accepts_av_dom_handle_with_named_media_state_only(self):
        pack = self.routes.pack
        media_state = {"v": 2, "kind": "av", "video": None, "audio": None,
                       "output_mode": "video", "frame_options": {
                           "start_frame": 0, "max_frames": 16, "frame_step": 1, "max_side": 512}}
        node = {"id": 1, "type": "KedouAVLoader",
                "widgets_values_named": {"media_state": media_state},
                "inputs": [{"name": "media_state", "widget": {"name": "media_state"}}]}
        self.assertEqual(pack._app_node_widgets(node), ["media_state", "kedou_av"])
        workflow = {"id": "av-graph", "nodes": [node]}
        with patch.object(pack.paths, "WORKFLOW_DIR", str(self.input)):
            result = pack.save_official_app(
                "av-handle", workflow, [{"node": 1, "input": "media_state", "label": "音视频"}], [1])
        self.assertTrue(result["ok"], result)
        saved = json.loads((self.input / "av-handle.app.json").read_text(encoding="utf-8"))
        ref = saved["extra"]["linearData"]["inputs"][0][0]
        self.assertTrue(ref.endswith(":1:kedou_av"), ref)
        self.assertEqual(saved["nodes"][0]["widgets_values_named"], {"media_state": media_state})


if __name__ == "__main__":
    unittest.main(verbosity=2)

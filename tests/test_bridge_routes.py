# -*- coding: utf-8 -*-
"""路由层 CORS/免令牌直连与缩略图有界队列回归（真实 aiohttp 测试服务器）。"""

import asyncio
import importlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[1]


def load_routes():
    name = "_kedou_bridge_routes_tests"
    package = ModuleType(name)
    package.__path__ = [str(ROOT / "kedou_bridge")]
    server = ModuleType("server")
    server.PromptServer = type("PromptServer", (), {"instance": None})
    nodes = ModuleType("nodes")
    nodes.NODE_CLASS_MAPPINGS = {}
    with patch.dict(sys.modules, {
        name: package, "server": server, "nodes": nodes,
        "folder_paths": None, "torch": None,
    }):
        return importlib.import_module(name + ".routes")


class BridgeRoutesTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.routes = load_routes()
        cls.addClassCleanup(cls.routes._thumb_pool.shutdown, wait=True)

    def setUp(self):
        self.tmp = TemporaryDirectory(prefix="kedou_routes_")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.src = root / "source.png"
        self.src.write_bytes(b"fake source")
        self.thumbs = root / "thumbs"
        self.thumbs.mkdir()
        patches = [
            patch.object(self.routes.media, "_media_file",
                          lambda name, *_args: str(self.src) if name == "source.png" else None),
            patch.object(self.routes.media, "THUMB_DIR", str(self.thumbs)),
            patch.object(self.routes, "_thumb_pruned", True),
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

    async def read(self, response):
        body = await response.read()
        return response.status, dict(response.headers), body

    async def test_version_metadata_has_no_plugin_auth_contract(self):
        status, _headers, body = await self.read(await self.client.get("/ps/version"))
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertNotIn("write_token", data["features"])
        self.assertNotIn("write_auth", data)

    async def test_writes_need_no_token_and_cors_preflight_works(self):
        for headers in ({}, {"Origin": "null"}, {"X-Kedou-Token": "ignored"}):
            status, response_headers, _body = await self.read(await self.client.post(
                "/ps/media/pick", json={}, headers=headers))
            self.assertEqual(status, 400)               # 无令牌也进入正常参数/文件校验
            self.assertEqual(response_headers.get("Access-Control-Allow-Origin"), "*")
        status, headers, _body = await self.read(await self.client.options(
            "/ps/media/pick", headers={
                "Origin": "null",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            }))
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
        self.assertIn("POST", headers.get("Access-Control-Allow-Methods", ""))

    async def test_app_graph_rejects_bad_json_and_non_object_values(self):
        with patch.object(self.routes.apps, "build_graph", return_value={"ok": True}) as build:
            status, _headers, _body = await self.read(await self.client.post(
                "/ps/apps/demo/graph", data="{bad", headers={"Content-Type": "application/json"}))
            self.assertEqual(status, 400)
            status, _headers, _body = await self.read(await self.client.post(
                "/ps/apps/demo/graph", json="not an object"))
            self.assertEqual(status, 400)
            status, _headers, _body = await self.read(await self.client.post(
                "/ps/apps/demo/graph", json={"values": "bad"}))
            self.assertEqual(status, 400)
            build.assert_not_called()
            status, _headers, _body = await self.read(await self.client.post(
                "/ps/apps/demo/graph", json={"values": {}}))
            self.assertEqual(status, 200)
            build.assert_called_once_with("demo", {})

    async def test_thumbnail_queue_limit_returns_429_and_releases_on_success(self):
        slots = threading.BoundedSemaphore(1)
        started = threading.Event()
        release = threading.Event()

        def make_thumb(_src, base, _w, _fit, _mode):
            started.set()
            if not release.wait(timeout=3):
                raise OSError("test worker timed out")
            dst = base + ".jpg"
            Path(dst).write_bytes(b"thumb")
            return dst

        with patch.object(self.routes, "_thumb_slots", slots), \
                patch.object(self.routes.media, "_make_thumb", side_effect=make_thumb):
            first_task = asyncio.create_task(self.client.get("/ps/thumb?filename=source.png"))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                status, headers, _body = await self.read(
                    await asyncio.wait_for(self.client.get("/ps/thumb?filename=source.png"), 2))
                self.assertEqual(status, 429)
                self.assertEqual(headers.get("Retry-After"), "1")
            finally:
                release.set()
            self.assertEqual((await self.read(await first_task))[0], 200)

            for cached in self.thumbs.iterdir():
                cached.unlink()
            status, _headers, _body = await self.read(
                await self.client.get("/ps/thumb?filename=source.png"))
            self.assertEqual(status, 200)               # 成功路径也已释放名额

    async def test_thumbnail_queue_releases_after_worker_failure(self):
        slots = threading.BoundedSemaphore(1)
        calls = {"n": 0}

        def make_thumb(_src, base, _w, _fit, _mode):
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError("injected thumbnail failure")
            dst = base + ".jpg"
            Path(dst).write_bytes(b"thumb")
            return dst

        with patch.object(self.routes, "_thumb_slots", slots), \
                patch.object(self.routes.media, "_make_thumb", side_effect=make_thumb):
            self.assertEqual((await self.read(
                await self.client.get("/ps/thumb?filename=source.png")))[0], 404)
            self.assertEqual((await self.read(
                await self.client.get("/ps/thumb?filename=source.png")))[0], 200)

    async def test_thumbnail_slot_is_held_until_worker_finishes_after_double_cancel(self):
        slots = threading.BoundedSemaphore(1)
        started = threading.Event()
        release = threading.Event()

        def make_thumb(_src, base, _w, _fit, _mode):
            started.set()
            if not release.wait(timeout=3):
                raise OSError("test worker timed out")
            dst = base + ".jpg"
            Path(dst).write_bytes(b"thumb")
            return dst

        with patch.object(self.routes, "_thumb_slots", slots), \
                patch.object(self.routes.media, "_make_thumb", side_effect=make_thumb):
            task = asyncio.create_task(self.client.get("/ps/thumb?filename=source.png"))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                task.cancel()
                await asyncio.sleep(0)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                self.assertEqual(slots._value, 0)   # worker 仍阻塞时不能提前释放
            finally:
                release.set()
            for _ in range(100):
                if slots._value == 1:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(slots._value, 1)

    async def test_waveform_cancel_sets_event_and_holds_slot_until_worker_exits(self):
        slots = threading.BoundedSemaphore(1)
        started = threading.Event()
        cancel_seen = threading.Event()
        release_worker = threading.Event()
        finished = threading.Event()
        audio = self.src.with_suffix(".wav")
        audio.write_bytes(b"fake audio")
        seen = {}

        def make_waveform(_src, _base, _width, cancel, timeout):
            seen["timeout"] = timeout
            started.set()
            if not cancel.wait(timeout=3):
                raise OSError("test worker did not receive cancellation")
            cancel_seen.set()
            if not release_worker.wait(timeout=3):
                raise OSError("test worker release timed out")
            finished.set()
            raise RuntimeError("cancelled after cooperative stop")

        with patch.object(self.routes, "_thumb_slots", slots), \
                patch.object(self.routes, "_waveform_pruned", True), \
                patch.object(self.routes.media, "WAVEFORM_DIR", str(self.thumbs)), \
                patch.object(self.routes.media, "_resolve_media_file",
                             return_value=(str(audio), "input")), \
                patch.object(self.routes.media, "_make_waveform", side_effect=make_waveform):
            task = asyncio.create_task(self.client.get("/ps/waveform?filename=source.wav&w=256"))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertTrue(await asyncio.to_thread(cancel_seen.wait, 2))
                self.assertEqual(slots._value, 0)       # 请求已取消，worker 仍运行时不能释放
                self.assertEqual(seen["timeout"], self.routes._WAVEFORM_TIMEOUT)
            finally:
                release_worker.set()
            self.assertTrue(await asyncio.to_thread(finished.wait, 2))
            for _ in range(100):
                if slots._value == 1:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(slots._value, 1)
            self.assertFalse(list(self.thumbs.glob("*.png")))

    def test_pool_and_inflight_limit_preserve_one_80_tile_screen(self):
        self.assertEqual(self.routes._thumb_pool._max_workers, 4)
        self.assertEqual(self.routes._THUMB_MAX_INFLIGHT, 80)


if __name__ == "__main__":
    unittest.main(verbosity=2)

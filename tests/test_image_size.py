# -*- coding: utf-8 -*-
"""原图尺寸接口 media.image_size 的自测（不依赖 ComfyUI 进程，只要有 Pillow）。

用法：python tests/test_image_size.py
      <comfyui>/python_embeded/python.exe tests/test_image_size.py

覆盖：
  1. 各格式的真实像素宽高（PNG / JPEG / WebP / GIF / BMP）
  2. EXIF 方向：竖拍手机图存的是横向像素 + 方向标记，必须换算成看得见的宽高
  3. input 找不到自动试 output；两边同名时按请求的目录优先
  4. 不存在 / 不是图片 / 越界路径 / 坏文件 → ok=False，不抛异常
  5. 缓存：同一张图只读一次文件头；同名覆盖后必须读到新尺寸
  6. bucket_size 的不动点性质（前端 kdBucketSize 要和它逐字一致）
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

try:
    from PIL import Image
except ImportError:                                     # pragma: no cover
    print("需要 Pillow：请用 ComfyUI 的 python_embeded 跑这个测试")
    raise


def load_bridge():
    """把 kedou_bridge 当成一个独立包加载，ComfyUI 那几个依赖全部挡掉。"""
    pkg = ModuleType("_kedou_size_test")
    pkg.__path__ = [str(ROOT / "kedou_bridge")]
    with patch.dict(sys.modules, {pkg.__name__: pkg, "aiohttp": None, "server": None,
                                  "nodes": None, "folder_paths": None, "torch": None}):
        media = importlib.import_module(pkg.__name__ + ".media")
        nodes = importlib.import_module(pkg.__name__ + ".nodes")
    return media, nodes


def write_image(path, size, fmt=None, orientation=None, color=(90, 140, 200)):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.new("RGB", size, color)
    kwargs = {}
    if orientation is not None:
        exif = Image.Exif()
        exif[274] = orientation
        kwargs["exif"] = exif
    im.save(path, format=fmt, **kwargs)
    return path


class ImageSizeTest(unittest.TestCase):

    def setUp(self):
        self.media, self.nodes = load_bridge()
        self.tmp = TemporaryDirectory(prefix="kedou_imgsize_")
        self.addCleanup(self.tmp.cleanup)
        self.in_dir = Path(self.tmp.name) / "input"
        self.out_dir = Path(self.tmp.name) / "output"
        self.in_dir.mkdir()
        self.out_dir.mkdir()
        patcher = patch.object(self.media, "_media_dirs",
                               lambda: (str(self.in_dir), str(self.out_dir)))
        patcher.start()
        self.addCleanup(patcher.stop)
        # 缩略图目录也要挪进临时目录：_make_thumb 的临时文件写在 THUMB_DIR 里，
        # 跨盘 os.replace 会直接 WinError 17（而且会往仓库外扔垃圾目录）
        thumbs = Path(self.tmp.name) / "thumbs"
        thumbs.mkdir()
        tp = patch.object(self.media, "THUMB_DIR", str(thumbs))
        tp.start()
        self.addCleanup(tp.stop)
        self.media._SIZE_CACHE.clear()

    def size(self, name, sub="", tab="input"):
        return self.media.image_size(name, sub, tab)

    # ---------------------------------------------------------------- 正常读尺寸
    def test_formats(self):
        cases = [("wide.png", (1600, 900), "PNG"), ("photo.jpg", (900, 1600), "JPEG"),
                 ("pic.webp", (240, 160), "WEBP"), ("anim.gif", (64, 48), "GIF"),
                 ("old.bmp", (32, 20), "BMP")]
        for name, size, fmt in cases:
            write_image(self.in_dir / name, size)
            got = self.size(name)
            self.assertTrue(got["ok"], name)
            self.assertEqual((got["width"], got["height"]), size, name)
            self.assertEqual(got["format"], fmt, name)
            self.assertEqual(got["tab"], "input", name)
            self.assertEqual(got["bytes"], os.path.getsize(self.in_dir / name), name)

    def test_subfolder(self):
        write_image(self.in_dir / "shoot" / "day1" / "a.png", (800, 600))
        got = self.size("a.png", "shoot/day1")
        self.assertTrue(got["ok"])
        self.assertEqual((got["width"], got["height"]), (800, 600))

    def test_exif_orientation(self):
        # 5/6/7/8 都是转了 90 或 270 度：看得见的宽高要互换；1/2/3/4 不互换
        for orient, expect in ((1, (1600, 900)), (3, (1600, 900)), (6, (900, 1600)),
                               (8, (900, 1600)), (5, (900, 1600))):
            name = "o%d.jpg" % orient
            write_image(self.in_dir / name, (1600, 900), orientation=orient)
            got = self.size(name)
            self.assertTrue(got["ok"], name)
            self.assertEqual((got["width"], got["height"]), expect, "EXIF %d" % orient)

    def test_exif_matches_thumbnail(self):
        """显示的宽高必须和缩略图一致 —— 缩略图走 exif_transpose，两边不一致就是打脸。"""
        write_image(self.in_dir / "rot.jpg", (1600, 900), orientation=6)
        got = self.size("rot.jpg")
        base = str(Path(self.tmp.name) / "thumb")
        dst = self.media._make_thumb(str(self.in_dir / "rot.jpg"), base, 512, "", "raw")
        with Image.open(dst) as im:
            tw, th = im.size
        self.assertEqual(got["width"] / got["height"], tw / th)
        self.assertLess(tw, th)                          # 缩略图确实是竖的（高 > 宽）

    # ---------------------------------------------------------------- 目录回退
    def test_output_fallback(self):
        write_image(self.out_dir / "gen.png", (1024, 1536))
        got = self.size("gen.png", "", "input")          # 面板先按 input 问
        self.assertTrue(got["ok"])
        self.assertEqual((got["width"], got["height"]), (1024, 1536))
        self.assertEqual(got["tab"], "output")           # 回包要告诉前端真正命中的目录

    def test_requested_tab_wins(self):
        write_image(self.in_dir / "both.png", (300, 200))
        write_image(self.out_dir / "both.png", (500, 400))
        self.assertEqual(self.size("both.png", "", "input")["width"], 300)
        self.assertEqual(self.size("both.png", "", "output")["width"], 500)

    # ---------------------------------------------------------------- 拒绝
    def test_missing(self):
        self.assertFalse(self.size("nope.png")["ok"])

    def test_not_an_image(self):
        (self.in_dir / "note.txt").write_text("hello", encoding="utf-8")
        self.assertFalse(self.size("note.txt")["ok"])

    def test_cannot_escape_media_dirs(self):
        # 媒体目录**外面**放一张图，任何写法都不该读到它
        secret = write_image(Path(self.tmp.name) / "secret.png", (999, 777))
        write_image(self.in_dir / "a.png", (10, 10))
        for name, sub in (("../secret.png", ""), ("secret.png", ".."), ("secret.png", "../"),
                          ("../../secret.png", ""), (str(secret), ""), ("C:secret.png", ""),
                          ("a.png", "../../")):
            got = self.size(name, sub)
            self.assertFalse(got["ok"], "%r %r -> %r" % (name, sub, got))
        # basename 会把 "../a.png" 归一成 "a.png"：读到的必须是媒体目录里那张，不是外面的
        got = self.size("../a.png")
        self.assertTrue(got["ok"])
        self.assertEqual((got["width"], got["height"]), (10, 10))

    def test_broken_file(self):
        (self.in_dir / "broken.png").write_bytes(b"\x89PNG\r\n\x1a\nnot really a png")
        got = self.size("broken.png")
        self.assertFalse(got["ok"])
        self.assertIn("error", got)

    # ---------------------------------------------------------------- 缓存
    def test_cache_reads_once(self):
        path = write_image(self.in_dir / "cached.png", (640, 480))
        self.assertEqual(self.size("cached.png")["width"], 640)
        with patch.object(Image, "open", side_effect=AssertionError("不该再读一次文件头")):
            got = self.size("cached.png")
        self.assertTrue(got["ok"])
        self.assertEqual((got["width"], got["height"]), (640, 480))
        self.assertTrue(path.exists())

    def test_cache_invalidated_on_overwrite(self):
        path = self.in_dir / "same.png"
        write_image(path, (640, 480))
        self.assertEqual(self.size("same.png")["width"], 640)
        write_image(path, (1280, 720))
        st = path.stat()
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))   # 保证指纹变了
        got = self.size("same.png")
        self.assertEqual((got["width"], got["height"]), (1280, 720))

    def test_cache_bounded(self):
        with patch.object(self.media, "_SIZE_CACHE_MAX", 8):
            for i in range(30):
                write_image(self.in_dir / ("f%d.png" % i), (32 + i, 32))
                self.assertTrue(self.size("f%d.png" % i)["ok"])
            self.assertLessEqual(len(self.media._SIZE_CACHE), 8)
            # 丢的是最早写进来的那条，最新的还在
            self.assertTrue(self.size("f29.png")["ok"])

    # ---------------------------------------------------------------- 分辨率桶
    def test_bucket_is_fixed_point(self):
        for w, h in ((1600, 900), (900, 1600), (1089, 4096), (3024, 4032), (100, 100)):
            for res in (512, 1024, 1328, 2048):
                bw, bh = self.nodes.bucket_size(w, h, res)
                self.assertEqual((bw % 32, bh % 32), (0, 0))
                self.assertGreaterEqual(min(bw, bh), 32)
                again = self.nodes.bucket_size(bw, bh, res)
                self.assertEqual(again, (bw, bh), "%dx%d @%d 不是不动点" % (w, h, res))

    def test_bucket_original_untouched(self):
        self.assertEqual(self.nodes.bucket_size(1600, 900, 0), (1600, 900))

    def test_bucket_half_rounding(self):
        """1089×4096 @1024 正好落在 .5：Python 取偶得 512，JS 若用 Math.round 会得 544。"""
        self.assertEqual(self.nodes.bucket_size(1089, 4096, 1024), (512, 2016))


if __name__ == "__main__":
    unittest.main(verbosity=2)
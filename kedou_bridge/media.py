# -*- coding: utf-8 -*-
"""媒体库清单、媒体选取（复制到 input）与真缩略图缓存。"""

import os
import tempfile
import time

from . import paths


# ---------------------------------------------------------------- 媒体库（共享协议）
# 目的：让「媒体选择器」在启动器 / PS 插件 / ComfyUI 内的节点上共用同一份数据与协议。
# 只提供清单与预览地址；上传走 ComfyUI 原生 /upload/image，不重复造轮子。
MEDIA_EXTS = {
    "image": (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"),
    "video": (".mp4", ".mov", ".webm", ".avi", ".mkv"),
    "audio": (".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"),
}
MEDIA_CAP = 400          # 单次最多返回多少条（上千条对选择器没意义还占带宽）
# 遍历时的收集上限，防目录爆炸；**排序完成后**再按 MEDIA_CAP 截断。
# 2026-09-28 修：以前是用 MEDIA_CAP 在循环里就 break，等于「先收满 400 再排序」，
# 排序只在碰巧遍历到的那 400 个里生效 —— 「最新在前」是假的（实测返回里混着去年的图）。
MEDIA_SCAN_CAP = 5000


def _media_dirs():
    """输入/输出目录：优先 ComfyUI 的 folder_paths（尊重它的路径配置），取不到再按根目录兜底。"""
    try:
        from folder_paths import get_input_directory, get_output_directory  # noqa: PLC0415
        return get_input_directory(), get_output_directory()
    except Exception:                                   # noqa: BLE001
        return os.path.join(paths.COMFY_ROOT, "input"), os.path.join(paths.COMFY_ROOT, "output")


def list_media(mtype="image", tab="all", q="", cap=MEDIA_CAP):
    """媒体清单：{name,subfolder,kind,tab,size,mtime,url}；tab = all|input|output。"""
    import urllib.parse as _up
    in_dir, out_dir = _media_dirs()
    exts = MEDIA_EXTS.get(str(mtype or "image"), MEDIA_EXTS["image"])
    items = []
    for tab_name, base in (("input", in_dir), ("output", out_dir)):
        if tab not in ("all", tab_name):
            continue
        if not os.path.isdir(base):
            continue
        for r, _dirs, files in os.walk(base):
            for fn in files:
                if fn.startswith(".") or not fn.lower().endswith(exts):
                    continue
                if q and str(q).lower() not in fn.lower():
                    continue
                try:
                    st = os.stat(os.path.join(r, fn))
                except Exception:                       # noqa: BLE001
                    continue
                sub = os.path.relpath(r, base).replace("\\", "/")
                if sub == ".":
                    sub = ""
                items.append({
                    "name": fn, "subfolder": sub, "kind": str(mtype or "image"), "tab": tab_name,
                    "size": st.st_size, "mtime": int(st.st_mtime),
                    "url": "/view?filename=%s&subfolder=%s&type=%s" % (
                        _up.quote(fn), _up.quote(sub), tab_name),
                })
                if len(items) >= MEDIA_SCAN_CAP:
                    break
            if len(items) >= MEDIA_SCAN_CAP:
                break
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items[:cap]


def pick_media(name, sub="", tab="input") -> dict:
    """把「库里选中的一张」变成图像输入能直接用的文件名。

    input 里的原样返回；output 里的先复制进 input —— 官方 LoadImage 只认 input 目录，
    不复制的话面板选了输出图、跑起来必然报「文件不存在」。
    """
    src = _media_file(name, sub, "output" if tab == "output" else "input")
    if src is None:
        return {"ok": False, "error": "文件不存在，或不在输入/输出目录内"}
    in_dir, _out_dir = _media_dirs()
    if tab != "output":
        rel = os.path.relpath(src, in_dir).replace("\\", "/")
        return {"ok": True, "filename": rel, "copied": False}
    import filecmp                                          # noqa: PLC0415
    import shutil                                           # noqa: PLC0415
    os.makedirs(in_dir, exist_ok=True)
    stem, ext = os.path.splitext(os.path.basename(src))
    dst = os.path.join(in_dir, stem + ext)
    if os.path.isfile(dst) and filecmp.cmp(src, dst, shallow=False):
        return {"ok": True, "filename": stem + ext, "copied": False}   # 内容相同：不重复拷
    i = 1
    while os.path.exists(dst):
        dst = os.path.join(in_dir, "%s_库%d%s" % (stem, i, ext))
        i += 1
    if not paths._under(in_dir, dst):
        return {"ok": False, "error": "目标路径越界"}
    try:
        shutil.copy2(src, dst)
    except Exception as e:                                  # noqa: BLE001
        return {"ok": False, "error": "复制到输入目录失败：%s" % e}
    return {"ok": True, "filename": os.path.basename(dst), "copied": True}


# ---------------------------------------------------------------- 真缩略图
# ComfyUI 自带的 /view?preview= 只重编码、不缩尺寸（server.py 里那句 preview 分支没有
# 任何 resize），5120x8192 的图照样回 8.7MB，而且全图解码同步跑在 async 处理函数里，
# 一屏 80 格能把事件循环堵死。这里出真正的缩略图，并按 源文件指纹 落盘缓存：
# 一张图一辈子只解一次码，之后纯静态发文件。
THUMB_MAX_SIDE = 512
THUMB_QUALITY = 72
THUMB_KEEP_DAYS = 30
THUMB_DIR = os.path.join(os.path.dirname(paths.WORKFLOW_DIR), "kedou_thumbs")
_thumb_pruned = False


def _media_file(name, sub, tab):
    """(tab, subfolder, filename) -> 真实文件路径；落在媒体目录之外或不存在都返回 None。"""
    in_dir, out_dir = _media_dirs()
    root = in_dir if tab == "input" else out_dir
    base = os.path.basename(str(name or ""))
    if not base or not paths._safe_id(base):
        return None
    path = os.path.join(root, str(sub or ""), base)
    if not paths._under(root, path) or not os.path.isfile(path):
        return None
    return path


def _make_thumb(src, dst, w):
    """缩到 w 以内存成 webp。跑在 asyncio.to_thread 里，不碰事件循环。"""
    from PIL import Image, ImageOps                        # noqa: PLC0415
    os.makedirs(THUMB_DIR, exist_ok=True)
    with Image.open(src) as im:
        try:
            # JPEG 支持按 1/2、1/4、1/8 直接解，先把解码量砍掉一个数量级再谈缩放
            im.draft("RGB", (w * 2, w * 2))
        except Exception:                                   # noqa: BLE001
            pass                                            # 非 JPEG（PNG/webp）不支持，照常全解
        im = ImageOps.exif_transpose(im)                    # 手机图的 EXIF 方向，不转就躺倒
        im.thumbnail((w, w))
        # UXP 不显示灰度图（官方 known-issues 原文：images with grayscale will not be displayed），
        # 灰度文档/深度图选完在面板里就是一片空白 → 有 alpha 走 RGBA，没有走 RGB
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if ("A" in im.getbands() or "transparency" in im.info) else "RGB")
        fd, tmp = tempfile.mkstemp(dir=THUMB_DIR, suffix=".webp")
        os.close(fd)
        try:
            im.save(tmp, "WEBP", quality=THUMB_QUALITY, method=4)
            os.replace(tmp, dst)                            # 原子替换：并发请求不会读到半截文件
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass


def _thumb_prune_old():
    """清掉 THUMB_KEEP_DAYS 天没再命中的缓存（源图删了/换机了就靠这个收口）。"""
    try:
        cutoff = time.time() - THUMB_KEEP_DAYS * 86400
        for fn in os.listdir(THUMB_DIR):
            if not fn.endswith(".webp"):
                continue
            p = os.path.join(THUMB_DIR, fn)
            try:
                st = os.stat(p)
                if max(st.st_mtime, st.st_atime) < cutoff:
                    os.remove(p)
            except OSError:
                pass
    except OSError:
        pass

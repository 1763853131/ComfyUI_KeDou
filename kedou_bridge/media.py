# -*- coding: utf-8 -*-
"""媒体库清单、媒体选取（复制到 input）与真缩略图缓存。"""

import os
import re
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
THUMB_QUALITY = 82
THUMB_KEEP_DAYS = 30
THUMB_DIR = os.path.join(os.path.dirname(paths.WORKFLOW_DIR), "kedou_thumbs")
# PS 面板的 <img> 不走 Chromium 的解码器，走 Adobe 自己那套 —— 官方 known-issues 里连
# 「灰度图不渲染」都单独列一条，webp 这种浏览器全认的格式它一样画不出来（一片空白，
# 而且不报错，只在 DOM 里占个位）。所以缩略图只出面板一定认的格式：不透明走 JPEG，
# 带透明通道的走 PNG（128px 量级也就几十 KB，不值得为省这点字节赌解码器）。
THUMB_EXTS = (".jpg", ".png")
# 面板的缩略图格子是「盒子比例 = 位图比例 + 写死像素」的画法：UXP 会把 max-width 和
# max-height 各自钳位、不锁宽高比，只给 max-* 就一定被拽成格子的比例（2026-10-20 实测：
# 1.80 和 0.66 的两张图在 90×64 的格子里变成 1.56 和 1.13）。
# 所以这里按面板给的 fit=<宽x高> 出图：整图缩进盒子（contain，不裁边 —— 修图的人要靠
# 缩略图判断构图，把头或脚切掉等于把信息弄没），再用格子底色补边补成精确比例。
THUMB_PAD_RGB = (26, 26, 26)               # = styles.css 里缩略盒的 #1a1a1a
_thumb_pruned = False


def _thumb_box(fit, w):
    """fit="3x4" 这种比例串 -> (box_w, box_h)，长边不超过 w；比例不合法返回 None。"""
    m = re.fullmatch(r"([1-9]\d?)x([1-9]\d?)", str(fit or ""))
    if not m:
        return None
    fw, fh = int(m.group(1)), int(m.group(2))
    return (w, max(1, int(round(w * fh / float(fw))))) if fw >= fh \
        else (max(1, int(round(w * fw / float(fh)))), w)


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


def _make_thumb(src, base, w, fit="", mode=""):
    """缩到 w 以内并落盘，返回真实写出的路径（base + .jpg/.png）。

    base 不带扩展名：扩展名要看完图才知道有没有 alpha，调用方拿返回值发文件即可。
    fit="3x4" 时整图缩进这个比例的盒子里、再用底色补边补成精确比例（不裁边）。
    mode="raw" 时保持原比例、**不补边**（ComfyUI 面板要这个：格子里的 cover 裁切和
    悬浮层的 contain 完整都由前端 CSS 决定，后端把图补成方图反而会让 cover 失效）。
    跑在 asyncio.to_thread 里，不碰事件循环。
    """
    from PIL import Image, ImageOps                        # noqa: PLC0415
    os.makedirs(THUMB_DIR, exist_ok=True)
    with Image.open(src) as im:
        try:
            # JPEG 支持按 1/2、1/4、1/8 直接解，先把解码量砍掉一个数量级再谈缩放
            im.draft("RGB", (w * 2, w * 2))
        except Exception:                                   # noqa: BLE001
            pass                                            # 非 JPEG（PNG/webp）不支持，照常全解
        im = ImageOps.exif_transpose(im)                    # 手机图的 EXIF 方向，不转就躺倒
        # 先把模式收拾干净再缩：UXP 的解码器只认 Adobe 那套（官方 known-issues：灰度图不渲染），
        # 而且 Pillow 的 thumbnail/reduce 对 16 位、浮点这类模式直接 ValueError。
        # 有透明通道 → PNG 保住通道，没有 → JPEG。
        has_alpha = "A" in im.getbands() or "transparency" in im.info
        if has_alpha:
            fmt, ext = "PNG", ".png"
            if im.mode != "RGBA":
                im = im.convert("RGBA")
        else:
            fmt, ext = "JPEG", ".jpg"
            if im.mode != "RGB":
                im = im.convert("RGB")
        raw = mode == "raw"
        box = _thumb_box(fit, w) or (w, w)
        im.thumbnail((w, w) if raw else box)
        if not raw and im.size != box:                      # 补边：位图比例 == 盒子比例
            rgba = im.mode == "RGBA"
            canvas = Image.new(im.mode, box,
                               THUMB_PAD_RGB + ((255,) if rgba else ()))
            canvas.paste(im, ((box[0] - im.width) // 2, (box[1] - im.height) // 2),
                         im if rgba else None)
            im = canvas
        fd, tmp = tempfile.mkstemp(dir=THUMB_DIR, suffix=ext)
        os.close(fd)
        try:
            if fmt == "JPEG":
                im.save(tmp, fmt, quality=THUMB_QUALITY, optimize=True)
            else:
                im.save(tmp, fmt, optimize=True)
            dst = base + ext
            os.replace(tmp, dst)                            # 原子替换：并发请求不会读到半截文件
            return dst
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass


def _thumb_prune_old():
    """清掉 THUMB_KEEP_DAYS 天没再命中的缓存（源图删了/换机了就靠这个收口）。

    认 .webp：老版本在这里出的是 webp，UXP 画不出来，路由已经不再发它，
    留着就是永远命不中的死文件，一起按天数清掉。
    """
    try:
        cutoff = time.time() - THUMB_KEEP_DAYS * 86400
        for fn in os.listdir(THUMB_DIR):
            if not fn.lower().endswith(THUMB_EXTS + (".jpeg", ".webp")):
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

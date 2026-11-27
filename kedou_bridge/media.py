# -*- coding: utf-8 -*-
"""媒体库清单、媒体选取（复制到 input）、真缩略图与视频时长裁剪缓存。"""

import asyncio
import hashlib
import math
import os
import re
import tempfile
import threading
import time

from . import av_state, paths


# ---------------------------------------------------------------- 媒体库（共享协议）
# 目的：让「媒体选择器」在启动器 / PS 插件 / ComfyUI 内的节点上共用同一份数据与协议。
# 清单与预览走桥接；上传由 /ps/media/upload 统一处理，ComfyUI 原生 /upload/image 只用于旧图片流程。
MEDIA_EXTS = {
    "image": (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"),
    "video": (".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".ogv"),
    "audio": (".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"),
}
MEDIA_UPLOAD_LIMITS = {"image": 32 * 1024 ** 2, "video": 2 * 1024 ** 3,
                       "audio": 2 * 1024 ** 3}
UPLOAD_CONCURRENCY = 4
_upload_slots = threading.BoundedSemaphore(UPLOAD_CONCURRENCY)
AV_MEMORY_LIMIT = 2 * 1024 ** 3
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


def pick_media(name, sub="", tab="input", copy_output=True) -> dict:
    """选取媒体。copy_output=False 时 output 原样引用，不复制（AV 加载器自行回退定位）。"""
    src = _media_file(name, sub, "output" if tab == "output" else "input")
    if src is None:
        return {"ok": False, "error": "文件不存在，或不在输入/输出目录内"}
    in_dir, _out_dir = _media_dirs()
    if tab != "output":
        rel = os.path.relpath(src, in_dir).replace("\\", "/")
        return {"ok": True, "filename": rel, "subfolder": os.path.dirname(rel),
                "copied": False}
    if not copy_output:
        rel = os.path.relpath(src, _out_dir).replace("\\", "/")
        return {"ok": True, "filename": rel, "subfolder": os.path.dirname(rel),
                "copied": False}
    import errno                                           # noqa: PLC0415
    import filecmp                                          # noqa: PLC0415
    import shutil                                           # noqa: PLC0415
    os.makedirs(in_dir, exist_ok=True)
    stem, ext = os.path.splitext(os.path.basename(src))
    original = os.path.join(in_dir, stem + ext)
    # 保留原有的“内容相同直接复用”行为；真正发布新文件时则绝不覆盖已有目标。
    if os.path.isfile(original):
        try:
            if filecmp.cmp(src, original, shallow=False):
                return {"ok": True, "filename": stem + ext, "copied": False}
        except OSError:
            pass                                            # 并发删掉/换走时继续选新名字
    fd, tmp = tempfile.mkstemp(dir=in_dir, prefix=".kedou-media-", suffix=".tmp")
    os.close(fd)
    try:
        # 先在同目录写完整副本，再用 hardlink 原子发布；不支持时明确失败，不回退覆盖写。
        # 只复制内容，不把源文件的只读属性带到临时文件；否则 Windows 发布后可能删不掉 tmp。
        shutil.copyfile(src, tmp)
        i = 0
        while True:
            dst = original if i == 0 else os.path.join(in_dir, "%s_库%d%s" % (stem, i, ext))
            i += 1
            if not paths._under(in_dir, dst):
                return {"ok": False, "error": "目标路径越界"}
            if os.path.lexists(dst):
                continue                                    # 含检查后刚被并发创建的目标
            try:
                os.link(tmp, dst)
            except FileExistsError:
                continue                                    # os.link 不会覆盖，竞争目标继续改名
            except OSError as e:
                unsupported = (e.errno in (errno.EPERM, errno.EXDEV,
                                           getattr(errno, "EOPNOTSUPP", errno.ENOTSUP),
                                           errno.ENOSYS) or getattr(e, "winerror", None) == 1)
                if unsupported:
                    return {"ok": False, "error": "当前平台/文件系统不支持硬链接，无法安全发布到输入目录：%s" % e}
                return {"ok": False, "error": "硬链接发布到输入目录失败（未覆盖目标）：%s" % e}
            return {"ok": True, "filename": os.path.basename(dst), "copied": True}
    except OSError as e:
        return {"ok": False, "error": "复制到输入目录失败：%s" % e}
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def delete_media(name, sub="", tab="input") -> dict:
    """POST /ps/media/delete —— 媒体库右键删除：移到回收站，不真删。

    与 pack.delete_kapp 一个口径：落到 user/default/kedou_trash/media/<tab>/<sub>/，
    文件名带时间戳（保留扩展名，捞回来不用猜格式），同一秒删两个同名也不互相覆盖。
    回收站不在 input/output 里，媒体清单、ComfyUI 自己的列表都扫不到它。

    只认媒体目录内的文件：_media_file 已做 basename + 越界检查；目录不删；
    扩展名不在媒体清单口径里的也不删（别拿一个误传的路径动到别的东西）。
    """
    import shutil                                           # noqa: PLC0415
    used = "input" if tab is None else str(tab)
    if used not in ("input", "output"):
        return {"ok": False, "error": "tab 必须是 input 或 output"}
    src = _media_file(name, sub, used)
    if src is None:
        return {"ok": False, "error": "文件不存在，或不在输入/输出目录内"}
    if not os.path.isfile(src):
        return {"ok": False, "error": "不是文件：%s" % name}
    ext = os.path.splitext(src)[1].lower()
    if ext not in set(sum(MEDIA_EXTS.values(), ())):
        return {"ok": False, "error": "不是媒体库认得的类型：%s" % ext}
    stem = os.path.splitext(os.path.basename(src))[0]
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dst_dir = os.path.join(paths.TRASH_DIR, "media", used, str(sub or ""))
    try:
        os.makedirs(dst_dir, exist_ok=True)
    except Exception as e:                                  # noqa: BLE001
        return {"ok": False, "error": "回收站目录不可写：%s" % e}
    dst = os.path.join(dst_dir, "%s.%s%s" % (stem, stamp, ext))
    n = 1
    while os.path.exists(dst):                              # 同一秒删两个同名
        dst = os.path.join(dst_dir, "%s.%s-%d%s" % (stem, stamp, n, ext))
        n += 1
    if not paths._under(paths.TRASH_DIR, dst):
        return {"ok": False, "error": "目标路径越界"}
    try:
        shutil.move(src, dst)
    except Exception as e:                                  # noqa: BLE001
        return {"ok": False, "error": "移到回收站失败：%s" % e}
    return {"ok": True, "name": os.path.basename(src), "tab": used,
            "trashed": paths._rel(dst)}


# ---------------------------------------------------------------- 上传与元数据
_INFO_CACHE = {}
_INFO_CACHE_MAX = 512


def _av_metadata(path):
    """PyAV 流信息；不解码完整媒体。"""
    import av
    with av.open(path, mode="r") as container:
        video = next((s for s in container.streams if s.type == "video"), None)
        audio = next((s for s in container.streams if s.type == "audio"), None)
        if video is None and audio is None:
            raise ValueError("文件没有可识别的视频或音频流")
        info = {"duration": None, "width": None, "height": None, "fps": None,
                "frame_count": None, "sample_rate": None, "channels": None,
                "video_codec": None, "audio_codec": None, "has_audio": audio is not None}
        stream = video or audio
        if stream.duration is not None and stream.time_base:
            info["duration"] = float(stream.duration * stream.time_base)
        elif container.duration is not None and av.time_base:
            info["duration"] = float(container.duration / av.time_base)
        if video is not None:
            width, height = int(video.width), int(video.height)
            rotation = int(getattr(video, "rotation", 0) or 0) % 360
            if rotation in (90, 270):
                width, height = height, width
            info.update(width=width, height=height,
                        video_codec=video.codec_context.name)
            rate = video.average_rate
            if rate:
                info["fps"] = float(rate)
            if video.frames and video.frames > 0:
                info["frame_count"] = int(video.frames)
        if audio is not None:
            info.update(sample_rate=int(audio.codec_context.sample_rate),
                        channels=int(audio.channels), audio_codec=audio.codec_context.name)
        return info


# ---------------------------------------------------------------- 视频时长裁剪缓存
# 只做容器级 stream copy：不重编码，seek 落到起点之前的关键帧，保留该预卷及
# [trim_start, trim_end) 内的 packet，并按 DTS 多留少量解码后卷。预卷/后卷保证片段可解码，
# 但边界是近似的。
# 视频与音频流都保留；失败时返回中文错误且绝不发布半截缓存。
TRIM_DIR = os.path.join(os.path.dirname(paths.WORKFLOW_DIR), "kedou_trim")
TRIM_CACHE_TTL = 7 * 24 * 60 * 60
TRIM_CACHE_MAX_BYTES = 16 * 1024 ** 3
TRIM_CACHE_MIN_AGE = 60 * 60
_trim_locks = tuple(threading.Lock() for _ in range(16))
_trim_cleanup_lock = threading.Lock()


def media_time_origin(container, video_stream, av):
    """把用户相对秒数换算到视频流绝对时间轴；流起点缺失时才回退容器起点。"""
    start = getattr(video_stream, "start_time", None)
    time_base = getattr(video_stream, "time_base", None)
    if start is not None and time_base:
        return float(start * time_base)
    if getattr(container, "start_time", None) is not None and av.time_base:
        return float(container.start_time / av.time_base)
    return 0.0


def _trim_cache_key(path, trim_start, trim_end, stat):
    """源绝对路径 + mtime_ns + size + 起止秒数 -> 稳定缓存文件名摘要。"""
    source = os.path.normcase(os.path.abspath(os.fspath(path)))
    digest = hashlib.sha256()
    end = "null" if trim_end is None else format(trim_end, ".17g")
    for value in ("trim-v3", source, str(stat.st_mtime_ns), str(stat.st_size),
                  format(trim_start, ".17g"), end):
        raw = value.encode("utf-8")
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)
    return digest.hexdigest()[:32]


def _prune_trim_cache(protect=None):
    """清理过期裁剪缓存；容量不足时只删至少一小时未动的文件，避开活跃任务。"""
    with _trim_cleanup_lock:
        try:
            names = os.listdir(TRIM_DIR)
        except OSError:
            return
        now = time.time()
        entries = []
        for name in names:
            if not name.startswith("kedou-"):
                continue
            path = os.path.join(TRIM_DIR, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if not os.path.isfile(path) or os.path.abspath(path) == os.path.abspath(protect or ""):
                continue
            entries.append((st.st_mtime, st.st_size, path))
        total = sum(size for _mtime, size, _path in entries)
        for mtime, size, path in sorted(entries):
            if now - mtime < TRIM_CACHE_TTL:
                continue
            try:
                os.remove(path)
            except OSError:
                continue
            total -= size
        if total <= TRIM_CACHE_MAX_BYTES:
            return
        for mtime, size, path in sorted(entries):
            if total <= TRIM_CACHE_MAX_BYTES:
                break
            if now - mtime < TRIM_CACHE_MIN_AGE:
                continue
            try:
                os.remove(path)
            except OSError:
                continue
            total -= size


def trimmed_video(path, trim_start=0, trim_end=None) -> dict:
    """返回 {ok,path,copied,cache_key?}；无裁剪时原样返回源路径。

    有裁剪时仅复制视频/音频流到 user/default/kedou_trim，不重编码；seek 使用向前关键帧，
    保留预卷及终点前的 packet，并按 DTS 保留少量解码后卷，所以边界为关键帧近似。同目录临时文件写完并关闭后才
    原子 replace；进程内并发由锁串行化。无法裁剪时返回中文错误，不发布缓存文件。
    """
    try:
        trim_start, trim_end = av_state._trim_seconds(trim_start, trim_end)
    except ValueError as exc:
        return {"ok": False, "error": av_state.public_error(str(exc))}
    if trim_start == 0 and trim_end is None:
        return {"ok": True, "path": path, "copied": False}

    tmp = None
    try:
        source = os.path.abspath(os.fspath(path))
        stat = os.stat(source)
        cache_key = _trim_cache_key(source, trim_start, trim_end, stat)
        ext = os.path.splitext(source)[1]
        cache_ext = ext or ".video"
        cache_path = os.path.join(TRIM_DIR, "kedou-%s%s" % (cache_key, cache_ext))
        with _trim_locks[int(cache_key[:2], 16) % len(_trim_locks)]:
            if os.path.isfile(cache_path):
                _prune_trim_cache(cache_path)
                return {"ok": True, "path": cache_path, "copied": False,
                        "cache_key": cache_key}
            os.makedirs(TRIM_DIR, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=TRIM_DIR, prefix=".kedou-trim-", suffix=cache_ext)
            os.close(fd)
            import av

            copied_packets = 0
            copied_window = 0
            copied_audio = 0
            has_audio = False
            with av.open(source, mode="r") as container:
                video_stream = next((s for s in container.streams if s.type == "video"), None)
                if video_stream is None:
                    raise ValueError("文件没有视频流，无法裁剪")
                streams = [s for s in container.streams if s.type in ("video", "audio")]
                has_audio = any(s.type == "audio" for s in streams)
                time_base = getattr(video_stream, "time_base", None)
                origin = media_time_origin(container, video_stream, av)
                source_start = origin + trim_start
                source_end = origin + trim_end if trim_end is not None else None
                if source_start > 0:
                    if not time_base:
                        raise ValueError("视频流缺少时间基，无法定位裁剪起点")
                    container.seek(math.floor(source_start / float(time_base) + 1e-9),
                                   stream=video_stream, backward=True, any_frame=False)
                format_name = getattr(getattr(container, "format", None), "name", None)
                if not format_name:
                    raise ValueError("无法识别源视频格式，无法同格式裁剪")
                # PyAV 的 format.name 可能是 "mov,mp4,m4a,..." 组合名，不能直接回传给
                # av.open；有源扩展名时让 PyAV 按同扩展名推断，无扩展名才取首个格式别名。
                output_options = {} if ext else {"format": format_name.split(",", 1)[0]}
                with av.open(tmp, mode="w", **output_options) as output:
                    if not hasattr(output, "add_stream_from_template"):
                        raise ValueError("当前 PyAV 不支持复制媒体流模板，无法裁剪")
                    output_streams = {s.index: output.add_stream_from_template(s) for s in streams}
                    reorder_margin = {}
                    for s in streams:
                        rate = float(getattr(s, "average_rate", 0) or 0)
                        has_b = int(getattr(getattr(s, "codec_context", None), "has_b_frames", 0) or 0)
                        reorder_margin[s.index] = max(0.05, (has_b * 2 + 1) / rate) if rate > 0 else 1.0
                    ended = set()
                    # 必须单次 demux：逐流 demux 共用输入游标，第二次调用会从 EOF 开始。
                    for packet in container.demux():
                        source_stream = getattr(packet, "stream", None)
                        output_stream = output_streams.get(getattr(source_stream, "index", None))
                        if output_stream is None or packet.pts is None:
                            continue
                        stream_index = source_stream.index
                        if stream_index in ended:
                            continue
                        packet_time_base = getattr(packet, "time_base", None) or getattr(source_stream, "time_base", None)
                        if not packet_time_base:
                            raise ValueError("媒体包缺少时间基，无法按秒裁剪")
                        if source_end is not None and packet.dts is not None:
                            dts_time = float(packet.dts * packet_time_base)
                            if dts_time >= source_end + reorder_margin[stream_index]:
                                ended.add(stream_index)
                                continue
                            if len(ended) == len(streams):
                                break
                        timestamp = float(packet.pts * packet_time_base)
                        # 保留起点前预卷及 DTS 截止点内的解码后卷；B 帧可能引用 pts 超过终点的包，
                        # 提前按 pts 丢弃会导致短片段封包成功却解不出帧。
                        packet.stream = output_stream
                        output.mux(packet)
                        if timestamp >= source_start and (source_end is None or timestamp < source_end):
                            if source_stream.type == "video":
                                copied_window += 1
                            elif source_stream.type == "audio":
                                copied_audio += 1
            if not copied_window:
                raise ValueError("裁剪窗口内没有可复制的视频包（边界按关键帧近似）")
            if has_audio and not copied_audio:
                raise ValueError("裁剪窗口内没有可复制的音频包")
            os.replace(tmp, cache_path)
            tmp = None
            _prune_trim_cache(cache_path)
            return {"ok": True, "path": cache_path, "copied": True,
                    "cache_key": cache_key}
    except Exception as exc:                           # noqa: BLE001
        return {"ok": False, "error": "无法裁剪视频（不重编码，边界按关键帧近似）：%s" % exc}
    finally:
        if tmp is not None:
            try:
                os.remove(tmp)
            except OSError:
                pass


def media_info(name, sub="", tab="input") -> dict:
    """图片/视频/音频元数据，按源文件指纹缓存。"""
    src, used = _resolve_media_file(name, sub, tab)
    if not src:
        return {"ok": False, "error": "文件不存在，或不在输入/输出目录内"}
    ext = os.path.splitext(src)[1].lower()
    kind = next((k for k, exts in MEDIA_EXTS.items() if ext in exts), None)
    if not kind:
        return {"ok": False, "error": "不是支持的媒体文件"}
    try:
        st = os.stat(src)
    except OSError:
        return {"ok": False, "error": "文件读不到"}
    key = (st.st_mtime_ns, st.st_size)
    cached = _INFO_CACHE.get(src)
    if cached and cached[0] == key:
        info = cached[1]
    else:
        try:
            if kind == "image":
                in_dir, out_dir = _media_dirs()
                root = in_dir if used == "input" else out_dir
                rel = os.path.relpath(src, root).replace("\\", "/")
                info = image_size(os.path.basename(rel), os.path.dirname(rel), used)
                if info.get("ok") is False:
                    return dict(info, kind=kind, tab=used, filename=os.path.basename(src))
            else:
                info = _av_metadata(src)
        except Exception as exc:                           # noqa: BLE001
            return {"ok": False, "error": "媒体信息读取失败：%s" % exc}
        if len(_INFO_CACHE) >= _INFO_CACHE_MAX:
            _INFO_CACHE.pop(next(iter(_INFO_CACHE)), None)
        _INFO_CACHE[src] = (key, info)
    return dict(info, ok=True, kind=kind, tab=used, bytes=st.st_size,
                filename=os.path.basename(src))


def _validate_upload(path, kind):
    if kind == "image":
        from PIL import Image
        with Image.open(path) as im:
            im.verify()
        return
    import av
    with av.open(path, mode="r") as container:
        wanted = "video" if kind == "video" else "audio"
        if not any(s.type == wanted for s in container.streams):
            raise ValueError("文件内容与上传的媒体类型不符")


async def upload_media(request, kind="image", subfolder="") -> dict:
    """流式 multipart 上传：同目录临时文件、内容探测、硬链接原子发布，绝不覆盖。"""
    import errno
    from aiohttp import MultipartReader

    kind = str(kind or "image")
    if kind not in MEDIA_UPLOAD_LIMITS:
        return {"ok": False, "error": "媒体类型必须是 image/video/audio"}
    try:
        sub = _safe_subfolder(subfolder)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    try:
        length = int(request.content_length or 0)
    except (TypeError, ValueError):
        length = 0
    limit = MEDIA_UPLOAD_LIMITS[kind]
    request_limit = limit + 1024 ** 2
    if length > request_limit:
        return {"ok": False, "error": "上传请求超过大小限制"}
    if not _upload_slots.acquire(blocking=False):
        return {"ok": False, "status": 429, "error": "上传并发已满，请稍后重试"}
    tmp = None
    try:
        in_dir, _out_dir = _media_dirs()
        directory = os.path.join(in_dir, *sub.split("/")) if sub else in_dir
        # realpath 复核必须早于 makedirs：符号链接可能在创建目录时把写入引到媒体目录外。
        if not paths._under(in_dir, directory):
            raise ValueError("上传目录越界")
        os.makedirs(directory, exist_ok=True)
        if not paths._under(in_dir, directory):
            raise ValueError("上传目录越界")
        reader = MultipartReader(request.headers, request.content)
        filename = None
        total = 0
        request_total = 0
        while True:
            entry = await reader.next()
            if entry is None:
                break
            if entry.name == "file":
                if filename is not None:
                    raise ValueError("multipart 只能包含一个 file 字段")
                filename = _safe_upload_name(entry.filename, kind)
                fd, tmp = tempfile.mkstemp(dir=directory, prefix=".kedou-upload-", suffix=".tmp")
                with os.fdopen(fd, "wb") as out:
                    while True:
                        chunk = await entry.read_chunk()
                        if not chunk:
                            break
                        request_total += len(chunk)
                        if request_total > request_limit:
                            raise ValueError("上传请求超过大小限制")
                        total += len(chunk)
                        if total > limit:
                            raise ValueError("上传文件超过大小限制")
                        out.write(chunk)
                    out.flush()
                    os.fsync(out.fileno())
            else:
                # 其它字段也必须消费并计入请求总量，MultipartReader 才能推进到下一个 boundary。
                while True:
                    chunk = await entry.read_chunk()
                    if not chunk:
                        break
                    request_total += len(chunk)
                    if request_total > request_limit:
                        raise ValueError("上传请求超过大小限制")
        if filename is None:
            return {"ok": False, "error": "multipart 中缺少 file 字段"}
        if not total:
            raise ValueError("上传文件为空")
        try:
            await asyncio.to_thread(_validate_upload, tmp, kind)
        except asyncio.CancelledError:
            raise
        except Exception as exc:                       # noqa: BLE001
            # 探测库可能抛 DecodeError/RuntimeError 等非 ValueError；坏文件统一按 400 返回。
            raise ValueError("上传文件校验失败：%s" % exc) from exc
        stem, ext = os.path.splitext(filename)
        i = 0
        while True:
            target_name = filename if i == 0 else "%s_%d%s" % (stem, i, ext)
            target = os.path.join(directory, target_name)
            i += 1
            if not paths._under(in_dir, target):
                raise ValueError("上传目标越界")
            if os.path.lexists(target):
                continue
            try:
                os.link(tmp, target)
                break
            except FileExistsError:
                continue
            except OSError as exc:
                unsupported = (exc.errno in (errno.EPERM, errno.EXDEV,
                                             getattr(errno, "EOPNOTSUPP", errno.ENOTSUP),
                                             errno.ENOSYS) or getattr(exc, "winerror", None) == 1)
                if unsupported:
                    raise ValueError("当前文件系统不支持原子发布上传文件") from exc
                raise
        return {"ok": True, "name": filename, "filename": target_name,
                "subfolder": sub, "tab": "input", "kind": kind, "size": total,
                "copied": False}
    except (ValueError, OSError, AssertionError, ImportError) as exc:
        return {"ok": False, "error": str(exc)}
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass
        _upload_slots.release()


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


def _safe_subfolder(value) -> str:
    """上传子目录只接受规范相对路径；拒绝绝对路径、..、NUL 与盘符。"""
    name = str(value or "").strip().replace("\\", "/")
    if (name.startswith("/") or "\x00" in name
            or (len(name) >= 2 and name[1] == ":")):
        raise ValueError("子目录必须是相对路径")
    parts = [p for p in name.split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        raise ValueError("子目录不能包含 ..")
    return "/".join(parts)


def _safe_upload_name(value, kind: str) -> str:
    """上传文件名只保留安全基名；扩展名决定媒体类型并做白名单校验。"""
    import urllib.parse
    # aiohttp 会把 filename 里的 / 编码成 %2F；先解码再取 basename，绝不把编码串当文件名。
    name = os.path.basename(urllib.parse.unquote(str(value or "")).replace("\\", "/")).strip()
    if (not name or name.startswith(".") or name in (".", "..")
            or name.endswith((" ", ".")) or any(ord(c) < 32 for c in name)
            or any(c in name for c in '<>"|?*') or ":" in name):
        raise ValueError("不安全的文件名")
    stem, ext = os.path.splitext(name)
    reserved = {"CON", "PRN", "AUX", "NUL", *(("COM%d" % i) for i in range(1, 10)),
                *(("LPT%d" % i) for i in range(1, 10))}
    if not stem or stem.rstrip(" .").upper() in reserved or ext.lower() not in MEDIA_EXTS[kind]:
        raise ValueError("不支持的文件扩展名：%s" % (ext or "(none)"))
    return stem + ext.lower()


def _resolve_media_file(name, sub, tab):
    """按 tab 精确查找再回退另一目录，供缩略图/元数据接口共用。"""
    first, second = (("output", "input") if str(tab) == "output" else ("input", "output"))
    for candidate in (first, second):
        found = _media_file(name, sub, candidate)
        if found:
            return found, candidate
    return None, None


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


# ---------------------------------------------------------------- 原图尺寸
# 悬浮预览要回答「这张图多大」，但缩略图是缩过的、媒体清单里的 size 是字节数，
# 两处都拿不到像素宽高；让前端去读原图又意味着为看一个数字下载几 MB。
# 这里只读文件头（Pillow 的 Image.open 不解码像素），一次不到一毫秒，
# 再按源文件指纹在内存里缓存，鼠标反复扫过同一张图不会重复读盘。
_SIZE_CACHE = {}            # 路径 -> (mtime_ns, 字节数, (宽, 高), 格式)
_SIZE_CACHE_MAX = 512       # 满了丢最早写进来的那条（不是 LRU，够用且不用额外维护顺序）


def image_size(name, sub="", tab="input") -> dict:
    """原图像素尺寸：{ok,width,height,bytes,tab,format}；给的目录里找不到会自动试另一个。

    宽高按 EXIF 方向换算过（手机竖拍存的是横向像素 + 一个方向标记），与缩略图、
    与节点 _load_image 出来的张量一致 —— 否则面板写着 4032×3024、实际出图 3024×4032。
    自动试另一个目录是必要的：面板格子先按 input 取图、失败才退 output，
    鼠标可能在回退发生前就扫过去了，这时按 input 找必然扑空。
    不是图片 / 读不出来 / 越界，一律 ok=False（路由回 404）。
    """
    src = used = None
    for cand in (("output", "input") if str(tab) == "output" else ("input", "output")):
        src = _media_file(name, sub, cand)
        if src:
            used = cand
            break
    if not src:
        return {"ok": False, "error": "文件不存在，或不在输入/输出目录内"}
    if not src.lower().endswith(MEDIA_EXTS["image"]):
        return {"ok": False, "error": "不是图片文件"}
    try:
        st = os.stat(src)
    except OSError:
        return {"ok": False, "error": "文件读不到"}
    hit = _SIZE_CACHE.get(src)
    if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
        size, fmt = hit[2], hit[3]
    else:
        try:
            from PIL import Image                               # noqa: PLC0415
            with Image.open(src) as im:
                size, fmt = im.size, str(im.format or "")
                try:
                    orient = int(im.getexif().get(274, 1) or 1)   # 274 = Orientation
                except Exception:                               # noqa: BLE001
                    orient = 1                                  # 没有 EXIF：按存的宽高算
            if orient in (5, 6, 7, 8):                          # 转了 90/270 度：宽高互换
                size = (size[1], size[0])
        except Exception as e:                                  # noqa: BLE001
            return {"ok": False, "error": "图片尺寸读不出来：%s" % e}
        if len(_SIZE_CACHE) >= _SIZE_CACHE_MAX:
            _SIZE_CACHE.pop(next(iter(_SIZE_CACHE)), None)
        _SIZE_CACHE[src] = (st.st_mtime_ns, st.st_size, size, fmt)
    return {"ok": True, "width": int(size[0]), "height": int(size[1]),
            "bytes": st.st_size, "tab": used, "format": fmt}


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
        return _save_thumb_image(im, base, w, fit, mode)


def _save_thumb_image(im, base, w, fit="", mode=""):
    """把已解码的 RGB/RGBA 图缩放、补边并原子写入缩略图缓存。"""
    from PIL import Image                                    # noqa: PLC0415

    os.makedirs(THUMB_DIR, exist_ok=True)
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
    if not raw and im.size != box:
        rgba = im.mode == "RGBA"
        canvas = Image.new(im.mode, box, THUMB_PAD_RGB + ((255,) if rgba else ()))
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
        os.replace(tmp, dst)
        return dst
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _rotate_frame_image(im, rotation):
    """按 PyAV frame.rotation 的顺时针语义旋转已解码的 PIL 图。"""
    from PIL import Image                                  # noqa: PLC0415

    angle = int(rotation or 0) % 360
    transpose = getattr(Image, "Transpose", Image)
    if angle == 90:
        return im.transpose(transpose.ROTATE_270)       # PIL 的 ROTATE_90 是逆时针
    if angle == 180:
        return im.transpose(transpose.ROTATE_180)
    if angle == 270:
        return im.transpose(transpose.ROTATE_90)
    return im


def _source_frame_memory(width, height):
    """单个源帧的工作峰值：RGB ndarray + PIL 副本 + float32 临时副本。"""
    return int(width) * int(height) * 3 * (1 + 1 + 4)


def _video_thumb_size(width, height, w, fit, mode, rotation):
    """先算出 _save_thumb_image 最终contain/raw尺寸，供 reformat 直接缩小。"""
    if int(rotation or 0) % 360 in (90, 270):
        width, height = height, width
    box = (w, w) if mode == "raw" else (_thumb_box(fit, w) or (w, w))
    scale = min(1.0, box[0] / float(width), box[1] / float(height))
    return (max(1, min(box[0], int(round(width * scale)))),
            max(1, min(box[1], int(round(height * scale)))))


def _make_video_thumb(src, base, w, fit="", mode=""):
    """PyAV 顺序解码首帧；先按源帧预算拦截，再直接缩到目标尺寸。"""
    import av
    from PIL import Image

    with av.open(src, mode="r") as container:
        stream = next((s for s in container.streams if s.type == "video"), None)
        if stream is None:
            raise ValueError("没有视频流")
        if _source_frame_memory(stream.width, stream.height) > AV_MEMORY_LIMIT:
            raise ValueError("视频源帧超过 AV 内存保护限制")
        frame = next(container.decode(stream))
        if _source_frame_memory(frame.width, frame.height) > AV_MEMORY_LIMIT:
            raise ValueError("视频源帧超过 AV 内存保护限制")
        rotation = int(getattr(frame, "rotation", 0) or 0)
        out_w, out_h = _video_thumb_size(frame.width, frame.height, w, fit, mode, rotation)
        # 绝不要把完整大帧转成 numpy/PIL；让 PyAV 在 reformat 阶段直接缩到输出尺寸。
        # 90/270 的最终显示宽高已交换，reformat 仍要旋转前的宽高，随后再转 PIL。
        reformat_w, reformat_h = ((out_h, out_w) if rotation % 360 in (90, 270)
                                  else (out_w, out_h))
        frame = frame.reformat(width=reformat_w, height=reformat_h, format="rgb24")
        im = Image.fromarray(frame.to_ndarray())
        im = _rotate_frame_image(im, getattr(frame, "rotation", rotation))
    return _save_thumb_image(im, base, w, fit, mode)


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


# ---------------------------------------------------------------- 音频波形
WAVEFORM_DIR = os.path.join(os.path.dirname(paths.WORKFLOW_DIR), "kedou_waveforms")
WAVEFORM_WIDTH = 1024
WAVEFORM_KEEP_DAYS = 30


def _make_waveform(src, base, width=WAVEFORM_WIDTH, cancel=None, timeout=None):
    """PyAV 解码音频，按全局采样区间保留峰值；支持协作取消与解码超时。"""
    import av
    import numpy as np
    from PIL import Image, ImageDraw

    width = max(128, min(2048, int(width)))
    height = max(64, width // 4)
    peaks = np.zeros(width, dtype=np.float32)
    total = 0
    deadline = time.monotonic() + float(timeout) if timeout is not None else None
    with av.open(src, mode="r") as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError("没有音频流")
        channels = int(stream.channels)
        rate = int(stream.codec_context.sample_rate)
        expected = 0
        # AudioStream.frames 是音频帧/包数，不是采样数；必须先按 duration×sample_rate 换算。
        if stream.duration is not None and stream.time_base:
            expected = int(float(stream.duration * stream.time_base) * rate)
        if expected <= 0 and container.duration is not None and av.time_base:
            expected = int(float(container.duration / av.time_base) * rate)
        if expected <= 0:
            raise ValueError("无法确定音频采样数（缺少 stream/container duration）")
        for frame in container.decode(stream):
            if cancel is not None and cancel.is_set():
                raise RuntimeError("波形生成已取消")
            if deadline is not None and time.monotonic() > deadline:
                raise TimeoutError("波形生成超时")
            arr = np.abs(frame.to_ndarray().astype(np.float32, copy=False))
            if arr.ndim == 1:
                mono = arr
            elif arr.ndim == 2 and arr.shape[0] == channels:
                mono = np.max(arr, axis=0)
            elif arr.ndim == 2 and arr.shape[1] == channels:
                mono = np.max(arr, axis=1)
            else:
                mono = np.max(arr.reshape(-1, channels), axis=1)
            mono = np.asarray(mono, dtype=np.float32)
            count = len(mono)
            if not count:
                continue
            # 每帧都从全局 total 偏移映射；同列多样本必须用 maximum.at 聚合，不能当 reduceat 下标。
            cols = (total + np.arange(count, dtype=np.int64)) * width // expected
            valid = (cols >= 0) & (cols < width)
            np.maximum.at(peaks, cols[valid], mono[valid])
            total += count
    if not total:
        raise ValueError("音频没有可解码的采样")
    peak = float(peaks.max())
    if peak > 0:
        peaks /= peak
    image = Image.new("RGB", (width, height), (18, 18, 22))
    draw = ImageDraw.Draw(image)
    mid = height // 2
    draw.line((0, mid, width - 1, mid), fill=(65, 65, 75))
    for x, value in enumerate(peaks):
        amp = int(float(value) * (mid - 2))
        draw.line((x, mid - amp, x, mid + amp), fill=(86, 190, 255))
    os.makedirs(WAVEFORM_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=WAVEFORM_DIR, suffix=".png")
    os.close(fd)
    try:
        image.save(tmp, "PNG", optimize=True)
        dst = base + ".png"
        os.replace(tmp, dst)
        return dst
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _waveform_prune_old():
    try:
        cutoff = time.time() - WAVEFORM_KEEP_DAYS * 86400
        for fn in os.listdir(WAVEFORM_DIR):
            if not fn.lower().endswith(".png"):
                continue
            path = os.path.join(WAVEFORM_DIR, fn)
            try:
                st = os.stat(path)
                if max(st.st_mtime, st.st_atime) < cutoff:
                    os.remove(path)
            except OSError:
                pass
    except OSError:
        pass

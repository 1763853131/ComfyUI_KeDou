# -*- coding: utf-8 -*-
"""KedouAVLoader 的 media_state v2 解析（纯 Python，不依赖 ComfyUI / PyAV）。"""

import json
import math
import os
import re


VIDEO_EXTS = (".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".ogv")
AUDIO_EXTS = (".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus")
AV_SLOTS = 8
AV_ITEM_LIMIT = 500
AV_OUTPUT_SLOTS = 32
DEFAULT_FRAME_OPTIONS = {
    "start_frame": 0,
    "max_frames": 16,
    "frame_step": 1,
    "max_side": 512,
}
FRAME_LIMITS = {"start_frame": 100000, "max_frames": 128, "frame_step": 60, "max_side": 2048}


def _integer(value, name, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("Kedou AV Loader: %s must be an integer" % name)
    if value < minimum:
        raise ValueError("Kedou AV Loader: %s must be >= %d" % (name, minimum))
    return value


def _filename(value):
    name = str(value or "").strip().replace("\\", "/")
    if (not name or "\x00" in name or name.startswith("/")
            or os.path.isabs(name) or (len(name) >= 2 and name[1] == ":")):
        raise ValueError("Kedou AV Loader: media filename must be relative")
    parts = [p for p in name.split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts):
        raise ValueError("Kedou AV Loader: unsafe media filename")
    return "/".join(parts)


def _trim_seconds(trim_start=0, trim_end=None):
    """规范化秒数裁剪窗口；结束时间为空表示到媒体结尾。"""
    values = []
    for name, value, nullable in (("trim_start", trim_start, False),
                                  ("trim_end", trim_end, True)):
        if value is None and nullable:
            values.append(None)
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Kedou AV Loader: %s must be a finite number >= 0%s"
                             % (name, " or null" if nullable else ""))
        try:
            value = float(value)
        except OverflowError as exc:
            raise ValueError("Kedou AV Loader: %s must be a finite number >= 0%s"
                             % (name, " or null" if nullable else "")) from exc
        if not math.isfinite(value) or value < 0:
            raise ValueError("Kedou AV Loader: %s must be a finite number >= 0%s"
                             % (name, " or null" if nullable else ""))
        values.append(value)
    start, end = values
    if end is not None and end <= start:
        raise ValueError("Kedou AV Loader: trim_end must be greater than trim_start")
    return start, end


def _item(value, slot):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("Kedou AV Loader: %s item must be an object or null" % slot)
    filename = _filename(value.get("filename"))
    tab = str(value.get("tab") or "input")
    if tab not in ("input", "output"):
        raise ValueError("Kedou AV Loader: %s tab must be input or output" % slot)
    extract = value.get("extract_audio", False)
    if not isinstance(extract, bool):
        raise ValueError("Kedou AV Loader: extract_audio must be a boolean")
    ext = os.path.splitext(filename)[1].lower()
    if ext in VIDEO_EXTS:
        kind = "video"
    elif ext in AUDIO_EXTS:
        kind = "audio"
    else:
        raise ValueError("Kedou AV Loader: unsupported %s extension: %s" % (slot, ext or "(none)"))
    if slot == "video" and kind != "video":
        raise ValueError("Kedou AV Loader: video slot only accepts video files")
    if slot == "audio" and kind == "video" and not extract:
        raise ValueError("Kedou AV Loader: set extract_audio=true to use a video's audio track")
    trim_start, trim_end = _trim_seconds(value.get("trim_start", 0), value.get("trim_end"))
    source_id = "%s|%s" % (tab, filename)
    item = {"id": source_id, "source_id": source_id, "filename": filename, "tab": tab,
            "kind": kind, "extract_audio": extract,
            "trim_start": trim_start, "trim_end": trim_end}
    if "segment_id" in value:
        segment_id = value.get("segment_id")
        if not isinstance(segment_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", segment_id):
            raise ValueError("Kedou AV Loader: segment_id must contain 1-64 letters, digits, underscores or hyphens")
        item["segment_id"] = segment_id
        item["id"] = "%s#%s" % (source_id, segment_id)
    return item


def _items(value, slot):
    """规范化一条多选列表：保持顺序、按 id 去重、最多 AV_ITEM_LIMIT 项。"""
    if not isinstance(value, list):
        raise ValueError("Kedou AV Loader: %s must be a list" % slot)
    out = []
    seen = set()
    for raw in value:
        item = _item(raw, "video" if slot == "videos" else "audio")
        if item is None or item["id"] in seen:
            continue
        seen.add(item["id"])
        out.append(item)
        if len(out) >= AV_ITEM_LIMIT:
            break
    return out


def _legacy_lists(raw, use_pairs=False):
    """旧版顶层单槽 / pairs 状态迁移为两条独立列表。

    旧批次真正使用 pairs；旧普通模式使用顶层当前槽，不能因面板残留的 pairs
    意外把单组输出扩成多组。只有顶层完全为空时才用 pairs 兜底。
    """
    pairs = raw.get("pairs")
    pair_videos = []
    pair_audios = []
    if pairs is not None:
        if not isinstance(pairs, list):
            raise ValueError("Kedou AV Loader: pairs must be a list")
        seen_videos = set()
        seen_audios = set()
        for pair in pairs:
            if not isinstance(pair, dict):
                raise ValueError("Kedou AV Loader: pair must be an object")
            video = _item(pair.get("video"), "video")
            audio = _item(pair.get("audio"), "audio")
            if video is not None and video["id"] not in seen_videos:
                seen_videos.add(video["id"])
                pair_videos.append(video)
            if audio is not None and audio["id"] not in seen_audios:
                seen_audios.add(audio["id"])
                pair_audios.append(audio)
    video = _item(raw.get("video"), "video")
    audio = _item(raw.get("audio"), "audio")
    if (use_pairs and (pair_videos or pair_audios)) or (video is None and audio is None):
        return pair_videos[:AV_ITEM_LIMIT], pair_audios[:AV_ITEM_LIMIT]
    return ([video] if video is not None else [], [audio] if audio is not None else [])


def _selectors(value, name):
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("Kedou AV Loader: %s must be a list" % name)
    out = []
    seen = set()
    for entry in value:
        selector = None
        if isinstance(entry, str):
            selector = entry.strip().replace("\\", "/")
        elif isinstance(entry, dict):
            if entry.get("id") is not None:
                selector = str(entry.get("id")).strip().replace("\\", "/")
            elif entry.get("source_id") is not None:
                selector = str(entry.get("source_id")).strip().replace("\\", "/")
            elif entry.get("filename") is not None:
                filename = str(entry.get("filename")).strip().replace("\\", "/")
                tab = str(entry.get("tab") or "input")
                selector = "%s|%s" % (tab, filename)
        # 失效/过期选择项保留字符串形式供缓存签名使用；无效类型直接跳过。
        if selector and selector not in seen:
            seen.add(selector)
            out.append(selector)
    return out


def _legacy_selectors(raw, slot):
    picked = raw.get("picked")
    if isinstance(picked, dict):
        picked = picked.get(slot, picked.get("video" if slot == "videos" else "audio"))
    return _selectors(picked, "picked")


def _legacy_pair_at(raw, cursor):
    """旧批次必须保留 pairs[cursor] 的原始配对，不能展平后重新按 index 组合。"""
    pairs = raw.get("pairs")
    if not isinstance(pairs, list) or not pairs:
        raise ValueError("Kedou AV Loader: batch mode requires at least one pair")
    if len(pairs) > AV_ITEM_LIMIT:
        raise ValueError("Kedou AV Loader: pairs exceeds limit %d" % AV_ITEM_LIMIT)
    if cursor >= len(pairs):
        raise ValueError("Kedou AV Loader: cursor is outside pairs")
    pair = pairs[cursor]
    if not isinstance(pair, dict):
        raise ValueError("Kedou AV Loader: pair must be an object")
    video = _item(pair.get("video"), "video")
    audio = _item(pair.get("audio"), "audio")
    if video is None and audio is None:
        raise ValueError("Kedou AV Loader: at least one video or audio item is required")
    return {"video": video, "audio": audio}


def _canonical_picked(items, selectors, drop_unknown=False):
    """完整 id 优先；旧 base id/source_id 仅在唯一同源项时映射到 segment。"""
    by_id = {item["id"]: item for item in items}
    by_name = {}
    by_source = {}
    for item in items:
        by_name.setdefault(item["filename"], []).append(item)
        by_source.setdefault(item.get("source_id", item["id"]), []).append(item)
    out = []
    seen = set()
    for selector in selectors:
        picked = by_id.get(selector)
        if picked is None and "|" not in selector:
            matches = by_name.get(selector, [])
            if len(matches) == 1:
                picked = matches[0]
        if picked is None:
            matches = by_source.get(selector, [])
            if len(matches) == 1:
                picked = matches[0]
        if picked is None and drop_unknown:
            continue
        normalized = picked["id"] if picked is not None else selector
        if normalized not in seen:
            seen.add(normalized)
            out.append(normalized)
    return out


def _effective(items, picked, select):
    if not select:
        return list(items)
    by_id = {item["id"]: item for item in items}
    return [by_id[picked_id] for picked_id in picked if picked_id in by_id]


def parse_av_state(value) -> dict:
    """解析 v2 多选状态，并迁移旧版单槽 / pairs 状态。

    返回完整 videos/audios（保留面板排列）及内部使用的 effective_*；选择模式
    只过滤 effective 列表，不改写原列表。任何批次都按两组列表的最大长度排队。
    """
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("Kedou AV Loader: media_state is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("Kedou AV Loader: media_state must be an object")
    if value.get("v") != 2 or value.get("kind") != "av":
        raise ValueError("Kedou AV Loader: media_state must have v=2 and kind=av")

    mode = value.get("output_mode")
    if mode not in ("video", "frames"):
        raise ValueError("Kedou AV Loader: output_mode must be video or frames")
    port_order = []
    if "port_order" in value:
        raw_order = value["port_order"]
        if not isinstance(raw_order, list):
            raise ValueError("Kedou AV Loader: port_order must be a list")
        seen = set()
        for key in raw_order[:AV_OUTPUT_SLOTS]:
            if not isinstance(key, str) or not re.fullmatch(r"(video|frames|video_audio|audio)_\d+", key):
                raise ValueError("Kedou AV Loader: port_order contains an invalid output key")
            if key in seen:
                continue
            seen.add(key)
            port_order.append(key)
    raw_opts = value.get("frame_options")
    if not isinstance(raw_opts, dict):
        raise ValueError("Kedou AV Loader: frame_options must be an object")
    opts = {}
    for name, default in DEFAULT_FRAME_OPTIONS.items():
        opts[name] = _integer(raw_opts.get(name, default), "frame_options.%s" % name)
    for name, maximum in FRAME_LIMITS.items():
        if opts[name] > maximum:
            raise ValueError("Kedou AV Loader: frame_options.%s exceeds limit %d"
                             % (name, maximum))
    if not opts["max_frames"] or not opts["frame_step"]:
        raise ValueError("Kedou AV Loader: max_frames and frame_step must be positive")

    batch = value.get("batch", False)
    if not isinstance(batch, bool):
        raise ValueError("Kedou AV Loader: batch must be a boolean")
    video_audio = value.get("video_audio", False)
    if not isinstance(video_audio, bool):
        raise ValueError("Kedou AV Loader: video_audio must be a boolean")
    select = value.get("select", False)
    if not isinstance(select, bool):
        raise ValueError("Kedou AV Loader: select must be a boolean")
    cursor = _integer(value.get("cursor", 0), "cursor")

    if "videos" in value or "audios" in value:
        legacy_videos, legacy_audios = ([], []) if ("videos" in value and "audios" in value) \
            else _legacy_lists(value, batch)
        videos = _items(value.get("videos", legacy_videos), "videos")
        audios = _items(value.get("audios", legacy_audios), "audios")
    else:
        legacy_videos, legacy_audios = _legacy_lists(value, batch)
        videos = _items(legacy_videos, "videos")
        audios = _items(legacy_audios, "audios")

    if "picked_videos" in value:
        picked_videos = _canonical_picked(videos, _selectors(value.get("picked_videos"),
                                                             "picked_videos"))
    else:
        picked_videos = _canonical_picked(videos, _legacy_selectors(value, "videos"),
                                          drop_unknown=True)
    if "picked_audios" in value:
        picked_audios = _canonical_picked(audios, _selectors(value.get("picked_audios"),
                                                             "picked_audios"))
    else:
        picked_audios = _canonical_picked(audios, _legacy_selectors(value, "audios"),
                                          drop_unknown=True)
    effective_videos = _effective(videos, picked_videos, select)
    effective_audios = _effective(audios, picked_audios, select)
    legacy_pairs = value.get("legacy_pairs") is True or (
        "videos" not in value and "audios" not in value and batch and value.get("pairs") is not None)
    queue_length = len(value.get("pairs") or []) if legacy_pairs else max(len(effective_videos), len(effective_audios))
    if not queue_length:
        raise ValueError("Kedou AV Loader: at least one video or audio item is required")
    if batch and cursor >= queue_length:
        raise ValueError("Kedou AV Loader: cursor is outside videos/audios")

    current_index = cursor if batch else 0
    if legacy_pairs and batch:
        current = _legacy_pair_at(value, cursor)
    else:
        current = {
            "video": effective_videos[current_index] if current_index < len(effective_videos) else None,
            "audio": effective_audios[current_index] if current_index < len(effective_audios) else None,
        }
    if mode == "frames" and current["video"] is None:
        raise ValueError("Kedou AV Loader: frames mode requires a video item")
    return {
        "v": 2, "kind": "av", "videos": videos, "audios": audios,
        "picked_videos": picked_videos, "picked_audios": picked_audios,
        "select": select, "batch": batch, "cursor": cursor,
        "output_mode": mode, "frame_options": opts, "video_audio": video_audio,
        "port_order": port_order,
        "effective_videos": effective_videos, "effective_audios": effective_audios,
        "current_pair": current,
        "pair_count": 1 if batch else min(queue_length, AV_SLOTS),
    }


def output_layout(state) -> list[str]:
    """返回 AV 加载器的可见语义输出键顺序。

    普通模式只布局前 8 组；批次模式只布局 cursor 当前组。每个视频依次输出
    当前媒体模式端口及可选的视频自带音频端口，最后输出独立音频端口。
    """
    if state["batch"]:
        video_items = [state["current_pair"]["video"]] if state["current_pair"]["video"] is not None else []
        audio_items = [state["current_pair"]["audio"]] if state["current_pair"]["audio"] is not None else []
    else:
        video_items = state["effective_videos"][:AV_SLOTS]
        audio_items = state["effective_audios"][:AV_SLOTS]

    active = "video" if state["output_mode"] == "video" else "frames"
    port_order = state.get("port_order")
    if isinstance(port_order, list) and port_order:
        ordered = []
        for key in port_order:
            if key not in ordered:
                ordered.append(key)
        for key in executable_layout(state):
            if key not in ordered:
                ordered.append(key)
        return ordered[:AV_OUTPUT_SLOTS]
    visible = []
    for index, _item in enumerate(video_items, 1):
        visible.append("%s_%d" % (active, index))
        if state["video_audio"]:
            visible.append("video_audio_%d" % index)
    visible.extend("audio_%d" % index for index, _item in enumerate(audio_items, 1))
    if video_items and not audio_items:
        visible.append("audio_1")
    return visible


def executable_layout(state) -> list[str]:
    """返回当前媒体实际可能产生的输出键，不含供接线使用的占位/增长槽。"""
    if state["batch"]:
        video_items = [state["current_pair"]["video"]] if state["current_pair"]["video"] is not None else []
        audio_items = [state["current_pair"]["audio"]] if state["current_pair"]["audio"] is not None else []
    else:
        video_items = state["effective_videos"][:AV_SLOTS]
        audio_items = state["effective_audios"][:AV_SLOTS]
    active = "video" if state["output_mode"] == "video" else "frames"
    keys = []
    for index, _item in enumerate(video_items, 1):
        keys.append("%s_%d" % (active, index))
        if state["video_audio"]:
            keys.append("video_audio_%d" % index)
    keys.extend("audio_%d" % index for index, _item in enumerate(audio_items, 1))
    return keys


_PUBLIC_ERROR_REGEX = (
    (r"^media filename escapes the media folders, rejected: (.+)$", r"媒体文件名越出媒体目录，已拒绝：\1"),
    (r"^file not found in input / output: (.+)$", r"input / output 中找不到文件：\1"),
    (r"^(.+) must be an integer$", r"\1 必须是整数"),
    (r"^(.+) must be >= (\d+)$", r"\1 不能小于 \2"),
    (r"^trim_start must be a finite number >= 0$", "trim_start 必须是大于等于 0 的有限数字"),
    (r"^trim_end must be a finite number >= 0 or null$", "trim_end 必须是大于等于 0 的有限数字或 null"),
    (r"^trim_end must be greater than trim_start$", "trim_end 必须大于 trim_start"),
    (r"^segment_id must contain 1-64 letters, digits, underscores or hyphens$",
     "segment_id 只能包含 1-64 位字母、数字、下划线或连字符"),
    (r"^no audio samples in trim window$", "裁剪窗口内没有音频采样"),
    (r"^(video|audio) item must be an object or null$", r"\1 素材必须是对象或 null"),
    (r"^(video|audio) tab must be input or output$", r"\1 目录必须是 input 或 output"),
    (r"^unsupported (video|audio) extension: (.+)$", r"不支持的 \1 扩展名：\2"),
    (r"^(.+) exceeds limit (\d+)$", r"\1 超过上限 \2"),
    (r"^no audio stream found: (.+)$", r"文件没有音频流：\1"),
    (r"^estimated audio memory ([0-9.]+)GB exceeds the 2GB limit$", r"预计音频内存 \1GB，超过 2GB 上限"),
    (r"^cannot decode audio \((.*)\): (.*)$", r"音频解码失败（\1）：\2"),
    (r"^start_frame exceeds limit (\d+)$", r"start_frame 超过上限 \1"),
    (r"^no video stream found: (.+)$", r"文件没有视频流：\1"),
    (r"^estimated frame memory ([0-9.]+)GB exceeds the 2GB limit$", r"预计视频帧内存 \1GB，超过 2GB 上限"),
    (r"^cannot decode video \((.*)\): (.*)$", r"视频解码失败（\1）：\2"),
    (r"^no frames decoded at start_frame=(\d+) \(check frame parameters\)$", r"从第 \1 帧开始没有解出视频帧，请检查帧参数"),
)


_PUBLIC_ERROR_REPLACEMENTS = (
    ("media filename escapes the media folders, rejected: %s", "媒体文件名越出媒体目录，已拒绝：%s"),
    ("file not found in input / output: %s", "input / output 中找不到文件：%s"),
    ("%s must be an integer", "%s 必须是整数"),
    ("%s must be >= %d", "%s 不能小于 %d"),
    ("trim_start must be a finite number >= 0", "trim_start 必须是大于等于 0 的有限数字"),
    ("trim_end must be a finite number >= 0 or null", "trim_end 必须是大于等于 0 的有限数字或 null"),
    ("trim_end must be greater than trim_start", "trim_end 必须大于 trim_start"),
    ("no audio samples in trim window", "裁剪窗口内没有音频采样"),
    ("media filename must be relative", "媒体文件名必须是相对路径"),
    ("unsafe media filename", "媒体文件名不安全"),
    ("%s item must be an object or null", "%s 素材必须是对象或 null"),
    ("%s tab must be input or output", "%s 目录必须是 input 或 output"),
    ("extract_audio must be a boolean", "extract_audio 必须是布尔值"),
    ("unsupported %s extension: %s", "不支持的 %s 扩展名：%s"),
    ("video slot only accepts video files", "视频槽只接受视频文件"),
    ("set extract_audio=true to use a video's audio track", "使用视频音轨时必须设置 extract_audio=true"),
    ("segment_id must contain 1-64 letters, digits, underscores or hyphens", "segment_id 只能包含 1–64 位字母、数字、下划线或连字符"),
    ("videos must be a list", "视频列表必须是数组"),
    ("audios must be a list", "音频列表必须是数组"),
    ("picked_videos must be a list", "视频选择列表必须是数组"),
    ("picked_audios must be a list", "音频选择列表必须是数组"),
    ("picked must be a list", "旧版选择列表必须是数组"),
    ("pair must be an object", "旧版每组素材必须是对象"),
    ("at least one video or audio item is required", "至少选择一个视频或音频"),
    ("media_state is not valid JSON", "media_state 不是有效的 JSON"),
    ("media_state must be an object", "media_state 必须是对象"),
    ("media_state must have v=2 and kind=av", "media_state 必须包含 v=2 和 kind=av"),
    ("output_mode must be video or frames", "output_mode 必须是 video 或 frames"),
    ("frame_options must be an object", "frame_options 必须是对象"),
    ("%s exceeds limit %d", "%s 超过上限 %d"),
    ("max_frames and frame_step must be positive", "max_frames 和 frame_step 必须大于 0"),
    ("batch must be a boolean", "batch 必须是布尔值"),
    ("video_audio must be a boolean", "video_audio 必须是布尔值"),
    ("select must be a boolean", "select 必须是布尔值"),
    ("pairs must be a list", "旧版 pairs 必须是列表"),
    ("cursor is outside videos/audios", "cursor 超出视频/音频配对范围"),
    ("frames mode requires a video item", "视频帧模式需要选择视频"),
    ("PyAV is unavailable", "PyAV 不可用"),
    ("no audio stream found: %s", "文件没有音频流：%s"),
    ("cannot determine audio duration for memory guard", "无法确定音频时长，无法执行内存保护"),
    ("invalid audio sample rate or channel count", "音频采样率或声道数无效"),
    ("estimated audio memory %.2fGB exceeds the 2GB limit", "预计音频内存 %.2fGB，超过 2GB 上限"),
    ("cannot decode audio (%s): %s", "音频解码失败（%s）：%s"),
    ("ComfyUI audio loader is unavailable", "ComfyUI 音频加载器不可用"),
    ("start_frame exceeds limit %d", "start_frame 超过上限 %d"),
    ("no video stream found: %s", "文件没有视频流：%s"),
    ("video stream has no time base for trim seek", "视频流缺少时间基，无法定位裁剪起点"),
    ("cannot determine decoded frame time for trim", "无法确定解码帧时间，无法应用时长裁剪"),
    ("one decoded frame is too large for the 2GB memory guard", "单帧解码内存超过 2GB 上限"),
    ("estimated frame memory %.2fGB exceeds the 2GB limit", "预计视频帧内存 %.2fGB，超过 2GB 上限"),
    ("cannot decode video (%s): %s", "视频解码失败（%s）：%s"),
    ("no frames decoded at start_frame=%d (check frame parameters)", "从第 %d 帧开始没有解出视频帧，请检查帧参数"),
)


def public_error(message) -> str:
    """把内部稳定英文错误转成面板中文；未知错误保留原文，避免误译。"""
    text = str(message or "").replace("Kedou AV Loader: ", "")
    for pattern, target in _PUBLIC_ERROR_REGEX:
        text = re.sub(pattern, target, text)
    for source, target in _PUBLIC_ERROR_REPLACEMENTS:
        text = text.replace(source, target)
    return text

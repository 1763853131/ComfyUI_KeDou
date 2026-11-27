# -*- coding: utf-8 -*-
"""音视频排列预设：保存列表顺序、选择/批次状态和帧参数，不复制媒体文件。"""

import json
import os
import re
import sys
import threading
import time
import uuid

from . import av_state, media, paths

MAX_ITEMS = 100
_LOCK = threading.Lock()


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _store_path():
    pv = sys.modules.get("kedou_prompt_vault")
    vault = None
    if pv is not None:
        try:
            vault = pv.vault_dir()
        except Exception:
            vault = None
    if not vault:
        return os.path.join(os.path.dirname(paths.WORKFLOW_DIR), "kedou_av_sets.json")
    store_dir = getattr(pv, "STORE_DIR", ".kedou")
    return os.path.join(vault, store_dir, "av_sets.json")


def _read(path=None):
    path = path or _store_path()
    if not os.path.exists(path):
        return {"v": 1, "items": []}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if (not isinstance(data, dict) or not isinstance(data.get("items"), list)
                or any(not isinstance(item, dict) for item in data["items"])):
            raise ValueError("顶层必须是含 items 数组的对象，且每条排列必须是对象")
    except FileNotFoundError:
        return {"v": 1, "items": []}
    except (ValueError, OSError) as exc:
        return {"ok": False, "error": "音视频排列数据读取失败，已拒绝继续写：%s" % exc}
    return {"v": 1, "items": data["items"]}


def _write(items, path=None, keep_id=None):
    path = path or _store_path()
    if keep_id is not None:
        pinned = [item for item in items if str(item.get("id")) == str(keep_id)]
        others = [item for item in items if str(item.get("id")) != str(keep_id)]
        ordered = pinned + sorted(others, key=lambda item: str(item.get("updated") or ""), reverse=True)
    else:
        ordered = sorted(items, key=lambda item: str(item.get("updated") or ""), reverse=True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    paths._dump_json_atomic(path, {"v": 1, "items": ordered[:MAX_ITEMS]})


def list_sets():
    with _LOCK:
        path = _store_path()
        data = _read(path)
        if data.get("ok") is False:
            return {"ok": False, "error": data["error"], "items": []}
        items = data["items"]
    items = sorted(items, key=lambda item: str(item.get("updated") or ""), reverse=True)
    return {"ok": True, "items": items}


def save_set(name="", videos=None, audios=None, batch=False, select=False,
             picked_videos=None, picked_audios=None, output_mode="video",
             video_audio=False, frame_options=None, set_id=""):
    try:
        videos = av_state._items(videos, "videos")
        audios = av_state._items(audios, "audios")
        parsed = av_state.parse_av_state({
            "v": 2, "kind": "av", "videos": videos, "audios": audios,
            "picked_videos": [], "picked_audios": [], "select": False,
            "batch": bool(batch), "cursor": 0, "output_mode": output_mode,
            "video_audio": bool(video_audio), "frame_options": frame_options or {},
        })
    except (TypeError, ValueError) as exc:
        return {"ok": False, "error": av_state.public_error(str(exc))}
    if not videos and not audios:
        return {"ok": False, "error": "排列里还没有视频或音频"}
    if not isinstance(select, bool) or not isinstance(batch, bool):
        return {"ok": False, "error": "选择和批次状态必须是布尔值"}
    if picked_videos is None:
        picked_videos = []
    if picked_audios is None:
        picked_audios = []
    if not isinstance(picked_videos, list) or not isinstance(picked_audios, list):
        return {"ok": False, "error": "选择列表必须是数组"}
    video_ids = {item["id"] for item in videos}
    audio_ids = {item["id"] for item in audios}
    picked_videos = [item for item in (picked_videos or []) if item in video_ids]
    picked_audios = [item for item in (picked_audios or []) if item in audio_ids]
    name = re.sub(r"\s+", " ", str(name or "")).strip()[:60] or time.strftime("音视频排列 %Y-%m-%d %H:%M")
    with _LOCK:
        path = _store_path()
        data = _read(path)
        if data.get("ok") is False:
            return {"ok": False, "error": data["error"]}
        items = data["items"]
        target = next((item for item in items if str(item.get("id")) == str(set_id)), None) if set_id else None
        if target is None:
            target = next((item for item in items if str(item.get("name")) == name), None)
        now = _now()
        if target is None:
            target = {"id": uuid.uuid4().hex[:12], "created": now}
            items.append(target)
        target.update({
            "name": name, "kind": "av", "videos": videos, "audios": audios,
            "batch": batch, "select": select,
            "picked_videos": picked_videos, "picked_audios": picked_audios,
            "output_mode": parsed["output_mode"], "video_audio": parsed["video_audio"],
            "frame_options": parsed["frame_options"], "updated": now,
        })
        _write(items, path, keep_id=target.get("id"))
    return {"ok": True, "item": target}


def rename_set(set_id="", name=""):
    name = re.sub(r"\s+", " ", str(name or "")).strip()[:60]
    if not name:
        return {"ok": False, "error": "名字不能为空"}
    with _LOCK:
        path = _store_path()
        data = _read(path)
        if data.get("ok") is False:
            return {"ok": False, "error": data["error"]}
        target = next((item for item in data["items"] if str(item.get("id")) == str(set_id)), None)
        if target is None:
            return {"ok": False, "error": "排列不存在"}
        target["name"] = name
        target["updated"] = _now()
        _write(data["items"], path, keep_id=target.get("id"))
    return {"ok": True, "item": target}


def delete_set(set_id=""):
    with _LOCK:
        path = _store_path()
        data = _read(path)
        if data.get("ok") is False:
            return {"ok": False, "error": data["error"]}
        before = len(data["items"])
        data["items"] = [item for item in data["items"] if str(item.get("id")) != str(set_id)]
        if len(data["items"]) == before:
            return {"ok": False, "error": "排列不存在"}
        _write(data["items"], path)
    return {"ok": True}


def _find_media(item):
    filename = item["filename"]
    sub, name = os.path.split(filename)
    return media._resolve_media_file(name, sub, item["tab"])


def load_set(set_id=""):
    with _LOCK:
        path = _store_path()
        data = _read(path)
        if data.get("ok") is False:
            return {"ok": False, "error": data["error"]}
        item = next((entry for entry in data["items"] if str(entry.get("id")) == str(set_id)), None)
    if item is None:
        return {"ok": False, "error": "排列不存在"}
    try:
        videos = av_state._items(item.get("videos"), "videos")
        audios = av_state._items(item.get("audios"), "audios")
    except (TypeError, ValueError) as exc:
        return {"ok": False, "error": av_state.public_error(str(exc))}
    found_videos, found_audios, missing = [], [], []
    for entry in videos:
        if _find_media(entry):
            found_videos.append(entry)
        else:
            missing.append(entry["filename"])
    for entry in audios:
        if _find_media(entry):
            found_audios.append(entry)
        else:
            missing.append(entry["filename"])
    video_ids = {entry["id"] for entry in found_videos}
    audio_ids = {entry["id"] for entry in found_audios}
    picked_videos = item.get("picked_videos", [])
    picked_audios = item.get("picked_audios", [])
    if not isinstance(picked_videos, list) or not isinstance(picked_audios, list):
        return {"ok": False, "error": "排列里的选择列表无效"}
    return {
        "ok": True,
        "item": {
            "id": item.get("id"), "name": item.get("name"),
            "videos": found_videos, "audios": found_audios,
            "batch": bool(item.get("batch")), "select": bool(item.get("select")),
            "picked_videos": [entry for entry in picked_videos if entry in video_ids],
            "picked_audios": [entry for entry in picked_audios if entry in audio_ids],
            "output_mode": item.get("output_mode", "video"),
            "video_audio": bool(item.get("video_audio")),
            "frame_options": item.get("frame_options") or av_state.DEFAULT_FRAME_OPTIONS,
        },
        "missing": missing,
    }

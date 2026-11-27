# -*- coding: utf-8 -*-
"""桥接 sidecar 状态持久化。"""

import hashlib
import json
import os
import threading
import time

from . import paths


# ---------------------------------------------------------------- 桥接状态
BRIDGE_SCHEMA_VERSION = 1


def _bridge_state_dir() -> str:
    return os.path.join(paths._user_default_dir(), "kedou_app_state")


def _state_path(app_path: str) -> str:
    """应用文件 -> sidecar 状态文件（按相对路径 hash，避免同名应用互相覆盖）。"""
    rel = paths._rel(app_path)
    h = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]
    return os.path.join(_bridge_state_dir(), h + ".json")


_STATE_LOCK = threading.RLock()


def _read_app_state(app_path: str) -> dict:
    fp = _state_path(app_path)
    try:
        with open(fp, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:                           # noqa: BLE001
        print("[KeDou] 应用状态读取失败（按无状态继续）：%s（%s）" % (fp, e))
        return {}
    vals = data.get("values") if isinstance(data, dict) else None
    return vals if isinstance(vals, dict) else {}


def _load_app_state(app_path: str) -> dict:
    with _STATE_LOCK:
        return dict(_read_app_state(app_path))


def _save_app_state(app_path: str, updates: dict) -> str:
    """原子写入 sidecar；多个面板并发写时在进程内串行合并。"""
    if not isinstance(updates, dict) or not updates:
        return ""
    fp = _state_path(app_path)
    with _STATE_LOCK:
        cur = _read_app_state(app_path)
        cur.update({str(k): v for k, v in updates.items()})
        payload = {"kedou_state": 1, "app": paths._rel(app_path),
                   "updated": time.strftime("%Y-%m-%d %H:%M:%S"), "values": cur}
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        paths._dump_json_atomic(fp, payload)
    return fp

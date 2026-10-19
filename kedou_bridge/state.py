# -*- coding: utf-8 -*-
"""桥接 sidecar 状态与写接口鉴权（令牌 / 来源）。"""

import hashlib
import json
import os
import secrets
import tempfile
import threading
import time
import urllib.parse

from . import paths


# ---------------------------------------------------------------- 桥接状态 / 写接口令牌
BRIDGE_SCHEMA_VERSION = 1


def _bridge_state_dir() -> str:
    return os.path.join(paths._user_default_dir(), "kedou_app_state")


def _bridge_token_file() -> str:
    return os.path.join(paths._user_default_dir(), "kedou_bridge_token.txt")


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


_BRIDGE_TOKEN = None
_BRIDGE_TOKEN_LOCK = threading.Lock()


def _get_bridge_token(create: bool = False) -> str:
    """本机写接口令牌：env 优先，否则 user/default/kedou_bridge_token.txt。"""
    global _BRIDGE_TOKEN
    env = str(os.environ.get("KEDOU_BRIDGE_TOKEN") or "").strip()
    if env:
        return env
    with _BRIDGE_TOKEN_LOCK:
        if _BRIDGE_TOKEN:
            return _BRIDGE_TOKEN
        try:
            with open(_bridge_token_file(), "r", encoding="utf-8-sig") as f:
                tok = f.read().strip()
        except OSError:
            tok = ""
        if tok:
            _BRIDGE_TOKEN = tok
            return tok
        if not create:
            return ""
        tok = secrets.token_urlsafe(32)
        fp = _bridge_token_file()
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(fp), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
                f.write(tok + "\n")
            os.replace(tmp, fp)
            try:
                os.chmod(fp, 0o600)
            except OSError:
                pass
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        _BRIDGE_TOKEN = tok
        print("[KeDou] 已生成桥接写接口令牌：%s" % fp)
        return tok


def _origin_allowed(origin: str) -> bool:
    """本机来源放行；具体的外部网站来源默认拒绝写操作。

    放行：无 Origin（本机进程）、null（UXP/沙箱）、loopback 的 http(s)、
          以及 file/plugin/uxp/app 这类本地面板/Electron 来源。
    拒绝：具体域名的 http(s) 来源 —— 恶意网页的 Origin 长这样。
    """
    origin = str(origin or "").strip()
    if not origin or origin == "null":
        return True
    extra = str(os.environ.get("KEDOU_BRIDGE_ALLOWED_ORIGINS") or "")
    if extra and origin in {x.strip() for x in extra.split(",") if x.strip()}:
        return True
    try:
        u = urllib.parse.urlsplit(origin)
    except Exception:                                  # noqa: BLE001
        return False
    scheme = (u.scheme or "").lower()
    if scheme in ("file", "plugin", "uxp", "app"):
        return True
    host = (u.hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "::1")


def _write_allowed(request) -> bool:
    """写接口：有效 X-Kedou-Token，或来源为本机（严格模式只认令牌）。"""
    try:
        tok = str(request.headers.get("X-Kedou-Token") or "").strip()
        expected = _get_bridge_token(create=False)
        if tok and expected and secrets.compare_digest(tok, expected):
            return True
        require = str(os.environ.get("KEDOU_BRIDGE_REQUIRE_TOKEN") or "").lower()
        if require in ("1", "true", "yes", "on"):
            return False
        return _origin_allowed(request.headers.get("Origin"))
    except Exception:                                  # noqa: BLE001
        return False

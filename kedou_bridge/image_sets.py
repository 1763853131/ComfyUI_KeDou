# -*- coding: utf-8 -*-
"""图片排列预设：只存文件名/顺序/选择状态，不复制图片。

一条记录 = 一个「排列」：
  {"id": "...", "name": "...", "images": ["a.png", "sub/b.png"],
   "batch": false, "select": true, "picked": ["b.png", "a.png"],
   "created": "...", "updated": "..."}

图片本身仍在 input/output 里；加载时逐张检查，找不到的跳过并返回 missing，
前端会提示缺了哪几张，不会把整个排列悄悄改成另一套顺序。
"""

import json
import os
import shutil
import sys
import threading
import time
import uuid

from . import media, paths

# 跟「词库」放在一起：<vault>/.kedou/image_sets.json。
# 这样排列会跟着用户在面板里改过的库位置走，也能在词库面板里统一检索/管理。
# prompt_vault 由插件入口以 kedou_prompt_vault 的名字加载，这里运行时取，
# 避免导入顺序耦合，也保证改了库路径后下一次读写就落到新目录。
MAX_ITEMS = 100
MAX_IMAGES = 50
_LOCK = threading.Lock()


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _legacy_path():
    """旧版本位置（user/default/kedou_image_sets.json），只用于一次性迁移。"""
    return os.path.join(os.path.dirname(paths.WORKFLOW_DIR), "kedou_image_sets.json")


def _store_path():
    pv = sys.modules.get("kedou_prompt_vault")
    vault = None
    if pv is not None:
        try:
            vault = pv.vault_dir()
        except Exception:                               # noqa: BLE001
            vault = None
    if not vault:
        return _legacy_path()                           # 词库不可用时退回旧位置，至少不丢数据
    store_dir = getattr(pv, "STORE_DIR", ".kedou")
    return os.path.join(vault, store_dir, "image_sets.json")


def _migrate_legacy(target):
    """把旧位置的文件搬到词库里；失败时本次操作继续读写旧位置。调用方持有 _LOCK。"""
    legacy = _legacy_path()
    if os.path.abspath(legacy) == os.path.abspath(target):
        return target
    if not os.path.isfile(legacy) or os.path.exists(target):
        return target
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.move(legacy, target)
        print("[KeDou] 图片排列已迁入词库：%s" % target)
        return target
    except OSError as e:
        print("[KeDou] 图片排列迁移失败（继续用旧位置）：%s" % e)
        return legacy


def _bad_archives(path):
    """列出曾因损坏留档的 .bad-* 文件；原文件缺失时仍据此阻止静默新建。"""
    directory = os.path.dirname(path) or "."
    prefix = os.path.basename(path) + ".bad-"
    try:
        return [os.path.join(directory, fn) for fn in os.listdir(directory)
                if fn.startswith(prefix)]
    except OSError:
        return []


def _archive_corrupt(path):
    """尽量把损坏原文件改名留档；同秒多次损坏也不会互相覆盖。"""
    bad = path + ".bad-" + time.strftime("%Y%m%d-%H%M%S")
    n = 2
    while os.path.lexists(bad):
        bad = "%s.bad-%s-%d" % (path, time.strftime("%Y%m%d-%H%M%S"), n)
        n += 1
    try:
        os.replace(path, bad)
        return bad
    except OSError as e:
        print("[KeDou] 图片排列损坏文件留档失败：%s（%s）" % (path, e))
        return ""


def _corrupt_result(path, error, bad_path=None):
    if bad_path is None:
        bad_path = _archive_corrupt(path)
    if bad_path:
        message = ("图片排列数据已损坏，原内容已留档到 %s；"
                   "请修复后移回 %s，或先移走该 .bad 文件" % (bad_path, path))
    else:
        message = ("图片排列数据已损坏且无法留档：%s；"
                   "请先修复或移走 %s，再继续读写" % (error, path))
    return {"ok": False, "error": message, "bad_file": bad_path}


def _read(path=None):
    path = path or _migrate_legacy(_store_path())
    if not os.path.exists(path):
        bad = _bad_archives(path)
        if bad:
            return _corrupt_result(path, "原文件缺失，但损坏留档仍存在", sorted(bad)[-1])
        return {"v": 1, "items": []}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if (not isinstance(data, dict) or not isinstance(data.get("items"), list)
                or any(not isinstance(it, dict) for it in data["items"])):
            raise ValueError("顶层必须是含 items 数组的对象，且每条排列必须是对象")
    except FileNotFoundError:
        bad = _bad_archives(path)
        if bad:
            return _corrupt_result(path, "原文件缺失，但损坏留档仍存在", sorted(bad)[-1])
        return {"v": 1, "items": []}
    except ValueError as e:
        return _corrupt_result(path, e)
    except OSError as e:
        # 读不到不等于 JSON 损坏；不要随便挪走可能有效的文件，但同样拒绝继续写。
        return {"ok": False, "error": "图片排列数据读取失败，已拒绝继续写：%s" % e}
    return {"v": 1, "items": data["items"]}


def _write(items, path=None, keep_id=None):
    path = path or _migrate_legacy(_store_path())
    if keep_id is not None:
        pinned = [item for item in items if str(item.get("id")) == str(keep_id)]
        others = [item for item in items if str(item.get("id")) != str(keep_id)]
        ordered = pinned + sorted(others, key=lambda x: str(x.get("updated") or ""), reverse=True)
    else:
        ordered = sorted(items, key=lambda x: str(x.get("updated") or ""), reverse=True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    paths._dump_json_atomic(path, {"v": 1, "items": ordered[:MAX_ITEMS]})


def _clean_images(images):
    out, seen = [], set()
    for it in images if isinstance(images, list) else []:
        name = str(it or "").strip().replace("\\", "/")
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
        if len(out) >= MAX_IMAGES:
            break
    return out


def list_sets():
    with _LOCK:
        path = _migrate_legacy(_store_path())
        data = _read(path)
        if data.get("ok") is False:
            return {"ok": False, "error": data["error"], "items": []}
        items = data["items"]
    items = sorted(items, key=lambda x: str(x.get("updated") or ""), reverse=True)
    return {"ok": True, "items": items}


def save_set(name="", images=None, batch=False, select=False, picked=None, set_id=""):
    images = _clean_images(images)
    if not images:
        return {"ok": False, "error": "排列里还没有图片"}
    name = str(name or "").strip()[:60] or time.strftime("排列 %Y-%m-%d %H:%M")
    picked = [x for x in (picked if isinstance(picked, list) else []) if x in images]
    with _LOCK:
        path = _migrate_legacy(_store_path())
        data = _read(path)
        if data.get("ok") is False:
            return {"ok": False, "error": data["error"]}
        items = data["items"]
        target = None
        if set_id:
            target = next((x for x in items if str(x.get("id")) == str(set_id)), None)
        if target is None:
            # 同名视为覆盖：用户再存一次同名排列时不希望出现两条
            target = next((x for x in items if str(x.get("name")) == name), None)
        now = _now()
        if target is None:
            target = {"id": uuid.uuid4().hex[:12], "created": now}
            items.append(target)
        target.update({
            "name": name, "images": images, "batch": bool(batch),
            "select": bool(select), "picked": picked, "updated": now,
        })
        _write(items, path, keep_id=target.get("id"))
    return {"ok": True, "item": target}


def rename_set(set_id="", name=""):
    """只改显示名；图片/顺序不动。词库面板里就地重命名用。"""
    name = str(name or "").strip()[:60]
    if not name:
        return {"ok": False, "error": "名字不能为空"}
    with _LOCK:
        path = _migrate_legacy(_store_path())
        data = _read(path)
        if data.get("ok") is False:
            return {"ok": False, "error": data["error"]}
        target = next((x for x in data["items"] if str(x.get("id")) == str(set_id)), None)
        if target is None:
            return {"ok": False, "error": "排列不存在"}
        target["name"] = name
        target["updated"] = _now()
        _write(data["items"], path, keep_id=target.get("id"))
    return {"ok": True, "item": target}


def delete_set(set_id=""):
    with _LOCK:
        path = _migrate_legacy(_store_path())
        data = _read(path)
        if data.get("ok") is False:
            return {"ok": False, "error": data["error"]}
        before = len(data["items"])
        data["items"] = [x for x in data["items"] if str(x.get("id")) != str(set_id)]
        if len(data["items"]) == before:
            return {"ok": False, "error": "排列不存在"}
        _write(data["items"], path)
    return {"ok": True}


def _find_file(filename):
    """在 input/output 里找图；返回规范化 filename（原样）或 None。"""
    raw = str(filename or "").replace("\\", "/").strip()
    if not raw:
        return None
    if "/" in raw:
        sub, name = raw.rsplit("/", 1)
    else:
        sub, name = "", raw
    for tab in ("input", "output"):
        if media._media_file(name, sub, tab):
            return raw
    return None


def load_set(set_id=""):
    with _LOCK:
        path = _migrate_legacy(_store_path())
        data = _read(path)
        if data.get("ok") is False:
            return {"ok": False, "error": data["error"]}
        item = next((x for x in data["items"] if str(x.get("id")) == str(set_id)), None)
    if item is None:
        return {"ok": False, "error": "排列不存在"}
    found, missing = [], []
    for name in _clean_images(item.get("images")):
        if _find_file(name):
            found.append({"filename": name})
        else:
            missing.append(name)
    valid = {f["filename"] for f in found}
    return {
        "ok": True,
        "item": {
            "id": item.get("id"), "name": item.get("name"),
            "batch": bool(item.get("batch")), "select": bool(item.get("select")),
            "picked": [x for x in (item.get("picked") or []) if x in valid],
        },
        "found": found,
        "missing": missing,
    }

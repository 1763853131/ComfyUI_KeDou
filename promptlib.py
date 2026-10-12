# -*- coding: utf-8 -*-
"""蝌蚪提示词库（轻量版）—— 直接读写 Obsidian vault 磁盘文件，Obsidian 不是运行时依赖。

设计稿：docs/promptlib-design.md
- 存储：D:\\知识库\\提示词库（可用环境变量 KEDOU_PROMPT_VAULT 覆盖），一条一 .md，
  递归子目录；frontmatter 存稳定 id（文件名只是显示用，改标题不换 id）。
- 文件安全：atomic_save（tmp+os.replace）；每日 zip 备份留 7 份；删除移入 .trash。
- 去重：正文 SHA256；历史条目按 hash 去重、50 条封顶。
- 无第三方依赖（yaml 用便携版内置 PyYAML，缺失时退手写解析）。
"""
import hashlib
import os
import re
import shutil
import tempfile
import time
import zipfile

try:
    import yaml
except Exception:                                   # noqa: BLE001
    yaml = None

VAULT = os.environ.get("KEDOU_PROMPT_VAULT") or r"D:\知识库\提示词库"
BACKUP_DIR = os.path.join(os.path.dirname(VAULT), ".提示词库备份")
TRASH_DIR = os.path.join(VAULT, ".trash")
HISTORY_DIR = "00_History"
HISTORY_CAP = 50
BACKUP_KEEP = 7

_FM_RE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?", re.S)
_SECTION_RE = re.compile(r"^# ([A-Za-z_ ]+)\s*$", re.M)
_ID_RE = re.compile(r"^[0-9A-Za-z_.\-\u4e00-\u9fff]+$")
_BAD_FN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# 解析缓存：{路径: (mtime_ns, size, entry)} —— 文件没变不重复解析
_cache = {}
_backup_done = False


# ─────────────────────────── 解析 / 序列化 ───────────────────────────

def _split_fm(text):
    m = _FM_RE.match(text)
    if not m:
        return {}, text
    raw = m.group(1)
    body = text[m.end():]
    if yaml is not None:
        try:
            meta = yaml.safe_load(raw)
            return (meta if isinstance(meta, dict) else {}), body
        except Exception:                           # noqa: BLE001
            return None, body                       # None = yaml 解析失败
    # 手写兜底（仅 key: value / 单行列表）
    meta = {}
    key = None
    for line in raw.splitlines():
        if re.match(r"^\s*-\s+", line) and key:
            meta.setdefault(key, []).append(line.split("-", 1)[1].strip())
        elif ":" in line:
            key, val = line.split(":", 1)
            key, val = key.strip(), val.strip()
            if val.startswith("[") and val.endswith("]"):
                meta[key] = [x.strip() for x in val[1:-1].split(",") if x.strip()]
            elif val:
                meta[key] = val
            else:
                meta[key] = []
    return meta, body


def _sections(body):
    """按 '# Positive' 等一级标题切段（沿用 vault 既有约定）。"""
    marks = list(_SECTION_RE.finditer(body))
    res = {}
    if not marks:
        res["_pre"] = body.strip()
        return res
    head = body[: marks[0].start()].strip()
    if head:
        res["_pre"] = head
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(body)
        res[m.group(1).strip().lower()] = body[m.end():end].strip()
    return res


def _parse_entry(path, rel):
    try:
        st = os.stat(path)
        hit = _cache.get(path)
        if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
            return hit[2]
        text = open(path, encoding="utf-8-sig").read()
        meta, body = _split_fm(text)
        if meta is None:
            print("[kedou词库] frontmatter 解析失败，跳过：%s" % rel)
            return None
        secs = _sections(body)
        positive = secs.get("positive") or (secs.get("_pre", "") if "negative" not in secs else "")
        def _strlist(v):
            if isinstance(v, list):
                return [str(x) for x in v]
            return [str(v)] if v else []

        entry = {
            "id": str(meta.get("id") or os.path.splitext(os.path.basename(path))[0]),
            "name": str(meta.get("name") or os.path.splitext(os.path.basename(path))[0]),
            "type": str(meta.get("type") or "精选"),
            "category": str(meta.get("category") or ""),
            "dir": rel.split("/")[0] if "/" in rel else "",
            "models": _strlist(meta.get("models")),
            "tags": _strlist(meta.get("tags")),
            "priority": int(meta.get("priority") or 0),
            "pinned": bool(meta.get("pinned")),
            "enabled": meta.get("enabled", True) is not False,
            "uses": int(meta.get("uses") or 0),
            "created": str(meta.get("created") or ""),
            "updated": str(meta.get("updated") or ""),
            "positive": positive,
            "negative": secs.get("negative", ""),
            "description": secs.get("description", ""),
            "note": secs.get("use", ""),
            "avoid": secs.get("avoid", ""),
            "related": secs.get("related", ""),
            "file": rel,
            "hash": hashlib.sha256(positive.encode("utf-8")).hexdigest()[:16],
        }
        _cache[path] = (st.st_mtime_ns, st.st_size, entry)
        return entry
    except OSError:
        return None


def _serialize(entry):
    fm = ["id: %s" % entry["id"], "type: %s" % entry["type"]]
    if entry.get("category"):
        fm.append("category: %s" % entry["category"])
    fm.append("name: %s" % entry["name"])
    for k in ("models", "tags"):
        v = entry.get(k) or []
        fm.append("%s:" % k)
        fm.extend("  - %s" % x for x in v)
    fm.append("priority: %d" % int(entry.get("priority") or 0))
    fm.append("pinned: %s" % ("true" if entry.get("pinned") else "false"))
    fm.append("enabled: %s" % ("true" if entry.get("enabled", True) else "false"))
    fm.append("uses: %d" % int(entry.get("uses") or 0))
    if entry.get("created"):
        fm.append("created: %s" % entry["created"])
    fm.append("updated: %s" % (entry.get("updated") or time.strftime("%Y-%m-%d")))
    body = "# Positive\n%s\n" % (entry.get("positive") or "").strip()
    for head, key in (("# Negative", "negative"), ("# Description", "description"),
                      ("# Use", "note"), ("# Avoid", "avoid"), ("# Related", "related")):
        seg = (entry.get(key) or "").strip()
        if seg:
            body += "\n%s\n%s\n" % (head, seg)
    return "---\n" + "\n".join(fm) + "\n---\n\n" + body


def _atomic_write(path, content):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _slug(name):
    s = _BAD_FN.sub("", str(name or "")).strip().strip(".")
    return s or "未命名"


def _walk():
    out = []
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fn in files:
            if not fn.lower().endswith(".md"):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, VAULT).replace("\\", "/")
            e = _parse_entry(full, rel)
            if e:
                out.append(e)
    return out


def _backup_daily():
    """启动后首次访问时压一次整库 zip，保留最近 BACKUP_KEEP 份。"""
    global _backup_done
    if _backup_done:
        return
    _backup_done = True
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        today = time.strftime("%Y-%m-%d")
        dest = os.path.join(BACKUP_DIR, "提示词库_%s.zip" % today)
        if not os.path.exists(dest):
            with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
                for root, dirs, files in os.walk(VAULT):
                    dirs[:] = [d for d in dirs if not d.startswith(".")]
                    for fn in files:
                        if fn.lower().endswith(".md"):
                            full = os.path.join(root, fn)
                            z.write(full, os.path.relpath(full, VAULT))
            olds = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("提示词库_") and f.endswith(".zip"))
            for old in olds[:-BACKUP_KEEP]:
                os.remove(os.path.join(BACKUP_DIR, old))
    except OSError as e:
        print("[kedou词库] 备份失败（不影响使用）：%s" % e)


# ─────────────────────────── 对外操作 ───────────────────────────

def list_prompts(q_type="", q_dir="", tag="", model="", q=""):
    _backup_daily()
    items = _walk()
    if q_type:
        items = [e for e in items if e["type"] == q_type]
    if q_dir:
        items = [e for e in items if e["dir"] == q_dir]
    if tag:
        items = [e for e in items if any(tag in t for t in e["tags"])]
    if model:
        items = [e for e in items if any(model.lower() in m.lower() for m in e["models"])]
    if q:
        ql = q.lower()
        items = [e for e in items if ql in e["name"].lower() or ql in e["positive"].lower()
                 or any(ql in t.lower() for t in e["tags"])]
    items.sort(key=lambda e: (not e["pinned"], -e["priority"], e["updated"] or "", e["name"]),
               reverse=False)
    # pinned 优先 → priority 降 → updated 降：用两次稳定排序更直白
    items.sort(key=lambda e: e["updated"], reverse=True)
    items.sort(key=lambda e: e["priority"], reverse=True)
    items.sort(key=lambda e: (not e["pinned"],))
    dirs = sorted({e["dir"] for e in items if e["dir"]})
    types = sorted({e["type"] for e in items})
    return {"ok": True, "items": items, "dirs": dirs, "types": types,
            "vault": VAULT, "count": len(items)}


def _find_path(pid):
    if not pid or not _ID_RE.match(pid):
        return None, None
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fn in files:
            if not fn.lower().endswith(".md"):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, VAULT).replace("\\", "/")
            e = _parse_entry(full, rel)
            if e and e["id"] == pid:
                return full, e
    return None, None


def save_prompt(body):
    pid = str(body.get("id") or "").strip()
    now = time.strftime("%Y-%m-%d")
    if pid:
        path, old = _find_path(pid)
        if path is None:
            return {"ok": False, "error": "条目不存在"}
        entry = dict(old)
        for k in ("name", "type", "category", "positive", "negative", "description",
                  "note", "avoid", "related"):
            if k in body:
                entry[k] = str(body[k] or "")
        for k in ("tags", "models"):
            if k in body:
                entry[k] = [str(x) for x in (body[k] or [])]
        if "priority" in body:
            entry["priority"] = int(body.get("priority") or 0)
        if "pinned" in body:
            entry["pinned"] = bool(body["pinned"])
        if "enabled" in body:
            entry["enabled"] = bool(body["enabled"])
        entry["updated"] = now
        entry["hash"] = hashlib.sha256(entry["positive"].encode("utf-8")).hexdigest()[:16]
        # 改名 → 文件跟着显示名走（id 不变）
        new_name = _slug(entry["name"]) + ".md"
        new_path = os.path.join(os.path.dirname(path), new_name)
        content = _serialize(entry)
        _atomic_write(new_path, content)
        if os.path.abspath(new_path) != os.path.abspath(path):
            os.remove(path)
        _cache.pop(path, None)
        rel = os.path.relpath(new_path, VAULT).replace("\\", "/")
        e2 = _parse_entry(new_path, rel)
        return {"ok": True, "item": e2}
    # 新建
    name = str(body.get("name") or "").strip()
    positive = str(body.get("positive") or "").strip()
    if not name or not positive:
        return {"ok": False, "error": "短名和提示词正文不能为空"}
    # 去重：正文 hash 撞了直接返回已有条目
    h = hashlib.sha256(positive.encode("utf-8")).hexdigest()[:16]
    for e in _walk():
        if e["hash"] == h:
            return {"ok": True, "item": e, "deduped": True}
    etype = str(body.get("type") or "精选")
    base_dir = str(body.get("dir") or "").strip() or (HISTORY_DIR if etype == "历史" else "99_未分类")
    stem = _slug(name)
    path = os.path.join(VAULT, base_dir, stem + ".md")
    n = 2
    while os.path.exists(path):
        path = os.path.join(VAULT, base_dir, "%s_%d.md" % (stem, n))
        n += 1
    entry = {
        "id": "%s.%s" % (etype, h[:8]),
        "name": name, "type": etype, "category": str(body.get("category") or ""),
        "models": [str(x) for x in (body.get("models") or [])],
        "tags": [str(x) for x in (body.get("tags") or [])],
        "priority": int(body.get("priority") or 0), "pinned": bool(body.get("pinned")),
        "enabled": True, "uses": 0, "created": now, "updated": now,
        "positive": positive, "negative": str(body.get("negative") or ""),
        "description": str(body.get("description") or ""),
    }
    _atomic_write(path, _serialize(entry))
    rel = os.path.relpath(path, VAULT).replace("\\", "/")
    return {"ok": True, "item": _parse_entry(path, rel)}


def save_history(positive):
    """自动历史：hash 去重（撞了 uses+1），50 条封顶（超出删最旧）。"""
    positive = (positive or "").strip()
    if len(positive) < 4:
        return {"ok": False, "error": "太短，不存历史"}
    h = hashlib.sha256(positive.encode("utf-8")).hexdigest()[:16]
    hist = [e for e in _walk() if e["type"] == "历史"]
    for e in hist:
        if e["hash"] == h:
            path, old = _find_path(e["id"])
            if old:
                old["uses"] += 1
                old["updated"] = time.strftime("%Y-%m-%d")
                _atomic_write(path, _serialize(old))
                _cache.pop(path, None)
            return {"ok": True, "item": e, "deduped": True}
    name = positive[:20] + ("…" if len(positive) > 20 else "")
    r = save_prompt({"name": name, "type": "历史", "positive": positive})
    if r.get("ok") and not r.get("deduped"):
        hist = [e for e in _walk() if e["type"] == "历史"]
        if len(hist) > HISTORY_CAP:
            hist.sort(key=lambda e: e["updated"])
            for old in hist[: len(hist) - HISTORY_CAP]:
                path, _ = _find_path(old["id"])
                if path:
                    os.remove(path)
                    _cache.pop(path, None)
    return r


def delete_prompt(pid):
    path, entry = _find_path(pid)
    if path is None:
        return {"ok": False, "error": "条目不存在"}
    os.makedirs(TRASH_DIR, exist_ok=True)
    dest = os.path.join(TRASH_DIR, os.path.basename(path))
    n = 2
    while os.path.exists(dest):
        dest = os.path.join(TRASH_DIR, "%s_%d.md" % (os.path.splitext(path)[0] and os.path.basename(path)[:-3], n))
        n += 1
    shutil.move(path, dest)
    _cache.pop(path, None)
    return {"ok": True, "trashed": os.path.basename(dest)}


def bump_use(pid):
    path, entry = _find_path(pid)
    if path is None:
        return {"ok": False, "error": "条目不存在"}
    entry["uses"] += 1
    _atomic_write(path, _serialize(entry))
    _cache.pop(path, None)
    return {"ok": True, "uses": entry["uses"]}


# ─────────────────────────── 路由注册 ───────────────────────────

def register_routes(routes):
    from aiohttp import web

    @routes.get("/ps/prompts")
    async def _list(request):
        q = request.query
        return web.json_response(list_prompts(
            q.get("type", ""), q.get("dir", ""), q.get("tag", ""),
            q.get("model", ""), q.get("q", "")))

    @routes.post("/ps/prompts/save")
    async def _save(request):
        try:
            body = await request.json()
        except Exception:                           # noqa: BLE001
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        return web.json_response(save_prompt(body))

    @routes.post("/ps/prompts/history")
    async def _hist(request):
        try:
            body = await request.json()
        except Exception:                           # noqa: BLE001
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        return web.json_response(save_history(str((body or {}).get("positive") or "")))

    @routes.post("/ps/prompts/delete")
    async def _del(request):
        try:
            body = await request.json()
        except Exception:                           # noqa: BLE001
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        return web.json_response(delete_prompt(str((body or {}).get("id") or "")))

    @routes.post("/ps/prompts/use")
    async def _use(request):
        try:
            body = await request.json()
        except Exception:                           # noqa: BLE001
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        return web.json_response(bump_use(str((body or {}).get("id") or "")))

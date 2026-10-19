# -*- coding: utf-8 -*-
"""prompt_vault —— 蝌蚪提示词库（一条一 .md，直接读写磁盘，Obsidian 不是运行时依赖）。

数据格式
- 一个目录 = 一个库（vault），递归子目录，每条一个 .md。
- frontmatter 存稳定 id（文件名只是显示用，改标题不换 id）；正文按 `# Positive`
  `# Negative` `# Description` `# Use` `# Avoid` `# Related` 一级标题切段。
- 文件安全：原子写（tmp + os.replace）；每日整库 zip 备份留 BACKUP_KEEP 份；删除进 .trash。
- 去重：正文 SHA256 前 16 位。
- 无第三方依赖（有 PyYAML 就用，缺失时退手写解析）。

两套并存的数据（都放在库目录的 .kedou/ 里，不往 Obsidian 的笔记堆里塞）
- 语库 = 上面的 .md 条目，只放用户主动保存的长提示词。
- 历史 = .kedou/history.json，出图自动记录，按 hash 去重、HISTORY_CAP 条封顶。
  历史不再写 .md；旧版本留下的 type=历史 笔记会在首次访问时迁进 JSON 并移到 .trash。
- 词库 = .kedou/phrases.json，短词/标签，首次使用从 phrases_seed.json 播种。
  词库只有用户主动新建/编辑时才写盘。

库位置怎么定（resolve_vault，按优先级）
1. 环境变量 KEDOU_PROMPT_VAULT
2. user/default/kedou_prompt_vault.txt 的首行（词库面板上的"改路径"写的就是它）
3. ComfyUI 设置项 Kedou.PromptVault（存在 <ComfyUI>/user/default/comfy.settings.json，
   后端直接读那个文件，所以不需要前端先把值传过来；给手改配置的高级用户）
4. 兜底默认 <ComfyUI>/user/default/kedou_prompts

三条都刻意不写死任何个人路径：这个库会随插件分发给别人，装到谁的机器上都应该自己长出
一个能用的空库，而不是指着作者盘符报错。默认位置选在 user/default 下而不是插件目录，
是因为 custom_nodes 会被 Comfy-Manager 更新/卸载直接删掉 —— 用户攒下来的词库不能寄生在
一个能一键删除的目录里。

首次在新位置建库时（仅限"目录是我们刚建的"或"用的是默认位置"），从随包的 sample/ 投放
几条示例，让人一眼看懂格式；已经有内容的库绝不投放，也不会重复投放（靠 .kedou_seeded 标记）。
"""

import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
import zipfile

try:
    import yaml
except Exception:                                   # noqa: BLE001
    yaml = None

ENV_KEY = "KEDOU_PROMPT_VAULT"
SETTING_KEY = "Kedou.PromptVault"
DEFAULT_SUBDIR = "kedou_prompts"
CONFIG_NAME = "kedou_prompt_vault.txt"             # 非 ComfyUI 调用方（脚本/启动器）的备用配置
SEED_MARKER = ".kedou_seeded"
HISTORY_DIR = "00_History"                         # 旧版本历史笔记所在目录，仅用于迁移
HISTORY_CAP = 50
BACKUP_KEEP = 7
STORE_DIR = ".kedou"                               # 历史 / 词库的 JSON 都放这里（不污染笔记）
HISTORY_FILE = "history.json"
PHRASES_FILE = "phrases.json"
PHRASES_SEED = "phrases_seed.json"
PHRASE_GROUP_FALLBACK = "我的词"
PHRASE_CAT_FALLBACK = "未分类"

_FM_RE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?", re.S)
_SECTION_RE = re.compile(r"^# ([A-Za-z_ ]+)\s*$", re.M)
_ID_RE = re.compile(r"^[0-9A-Za-z_.\-\u4e00-\u9fff]+$")
_BAD_FN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_PLAIN_SCALAR_RE = re.compile(r"^[A-Za-z0-9_./\-\u4e00-\u9fff]+$")
_NUM_SCALAR_RE = re.compile(r"^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$")
_YAML_LOOKS_BOOL = {"true", "false", "yes", "no", "on", "off", "null", "~", "none"}


def _yaml_scalar(v) -> str:
    """把任意字符串写成安全的 YAML 标量。

    以前直接 `name: %s`，短名里有 ": "、"#"、"[" 或换行就会写出解析失败的
    frontmatter —— 文件在，词条却永远不显示。这里简单 token 原样写，其余一律
    用 JSON 双引号形式（JSON 字符串同时是合法的 YAML 双引号标量）。
    """
    s = "" if v is None else str(v)
    s = " ".join(s.splitlines()).strip()          # frontmatter 值只允许单行
    if (s and _PLAIN_SCALAR_RE.match(s)
            and s.lower() not in _YAML_LOOKS_BOOL
            and not _NUM_SCALAR_RE.match(s)):
        return s
    return json.dumps(s, ensure_ascii=False)


def _to_int(v, default=0) -> int:
    """手改文件里的 uses/priority 可能是 'many'，不能让它把整个接口打 500。"""
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _safe_subdir(raw):
    """客户端传来的 dir -> 词库内相对子目录；不合法返回 None。"""
    s = str(raw or "").replace("\\", "/").strip().strip("/")
    if not s:
        return ""
    if len(s) > 200 or re.search(r"[\x00-\x1f]", s) or re.match(r"^[A-Za-z]:", s):
        return None
    parts = []
    for p in s.split("/"):
        if p in ("", "."):
            continue
        if p == "..":
            return None
        parts.append(p)
    return "/".join(parts)


def _inside(root, path) -> bool:
    try:
        r = os.path.normcase(os.path.realpath(root))
        p = os.path.normcase(os.path.realpath(path))
        return os.path.commonpath([r, p]) == r
    except (OSError, ValueError):
        return False


def _unique_path(directory, stem) -> str:
    path = os.path.join(directory, stem + ".md")
    n = 2
    while os.path.exists(path):
        path = os.path.join(directory, "%s_%d.md" % (stem, n))
        n += 1
    return path

# 解析缓存：{路径: (mtime_ns, size, entry)} —— 文件没变不重复解析
_cache = {}
# 库位置相关的进程内状态：一次解析出来就复用，出错也记住，免得每次请求都重跑一遍磁盘
_state = {"seed_checked": False, "backups": set(), "created": set(), "migrated": set()}
# 历史 / 词库是整文件读改写，多个请求同时保存会互相覆盖，改动必须串行
_store_lock = threading.RLock()

SAMPLE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample")


# ─────────────────────────── 库位置 ───────────────────────────

def _user_default_dir():
    """ComfyUI 的 per-user 数据目录（user/default）；脱离 ComfyUI 单独跑时退回 ~/.kedou。"""
    try:
        from folder_paths import get_user_directory      # noqa: PLC0415
        ud = get_user_directory()
        if ud:
            dflt = os.path.join(ud, "default")
            return dflt if os.path.isdir(dflt) else ud
    except Exception:                                    # noqa: BLE001
        pass
    return os.path.join(os.path.expanduser("~"), ".kedou")


def _read_config_file(user_dir):
    """user/default/kedou_prompt_vault.txt：首行非注释即路径。给不走 ComfyUI 设置面板的场合。"""
    try:
        with open(os.path.join(user_dir, CONFIG_NAME), encoding="utf-8-sig") as f:
            for line in f:
                s = line.strip()
                if s and not s.startswith("#"):
                    return s
    except OSError:
        pass
    return ""


def _read_comfy_setting(user_dir):
    """从 ComfyUI 自己写的 comfy.settings.json 里取设置项，不依赖前端回传。"""
    try:
        with open(os.path.join(user_dir, "comfy.settings.json"), encoding="utf-8-sig") as f:
            data = json.load(f)
        v = data.get(SETTING_KEY) if isinstance(data, dict) else None
        return str(v).strip() if v else ""
    except (OSError, ValueError):
        return ""


def resolve_vault():
    """-> (path, source)；source ∈ env|config|setting|default。

    config（我们自己的面板写的那个文件）排在 ComfyUI 设置项前面，是为了让面板上"改路径"
    这件事一定生效 —— 否则用户在面板里填完，却可能被供应商手动塞进 comfy.settings.json 的
    旧值覆盖，现场根本没法解释。
    """
    env = str(os.environ.get(ENV_KEY) or "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env)), "env"
    user_dir = _user_default_dir()
    for reader, source in ((_read_config_file, "config"), (_read_comfy_setting, "setting")):
        raw = reader(user_dir)
        if raw:
            return os.path.abspath(os.path.expanduser(raw)), source
    return os.path.join(user_dir, DEFAULT_SUBDIR), "default"


def _seed_examples(vault, fresh, default_location):
    """往空库投放示例词条。只在"这个目录是我们刚建的"或"用的是默认位置"时做，
    并且只在库里一条 .md 都没有时做 —— 别人指到自己的 Obsidian 目录就不该往里塞东西。"""
    if _state["seed_checked"]:
        return
    _state["seed_checked"] = True
    if not (fresh or default_location):
        return
    if os.path.exists(os.path.join(vault, SEED_MARKER)):
        return
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        if any(fn.lower().endswith(".md") for fn in files):
            _touch_marker(vault)                        # 有内容：记下"不用再播种"，别再反复扫描
            return
    if not os.path.isdir(SAMPLE_DIR):
        return
    n = 0
    for fn in sorted(os.listdir(SAMPLE_DIR)):
        if not fn.lower().endswith(".md"):
            continue
        src = os.path.join(SAMPLE_DIR, fn)
        rel = os.path.join("99_未分类", fn)
        try:
            os.makedirs(os.path.dirname(os.path.join(vault, rel)), exist_ok=True)
            if not os.path.exists(os.path.join(vault, rel)):
                shutil.copyfile(src, os.path.join(vault, rel))
                n += 1
        except OSError as e:
            print("[kedou词库] 示例投放失败（不影响使用）：%s" % e)
            return
    _touch_marker(vault)
    if n:
        print("[kedou词库] 已在 %s 投放 %d 条示例" % (vault, n))


def _touch_marker(vault):
    try:
        with open(os.path.join(vault, SEED_MARKER), "w", encoding="utf-8") as f:
            f.write(time.strftime("seeded %Y-%m-%d\n"))
    except OSError:
        pass


def vault_dir():
    """可用的库目录，或 None（配了但建不起来）。失败原因记在 last_error()。"""
    path, source = resolve_vault()
    _state["path"], _state["source"] = path, source
    _state["error"] = None
    if not path:
        _state["error"] = "%s 没配上有效路径" % ENV_KEY
        return None
    if not os.path.isdir(path):
        if path in _state["created"] or os.path.exists(path):
            _state["error"] = "词库目录不存在：%s" % path
            return None
        try:
            os.makedirs(path, exist_ok=True)
            _state["created"].add(path)
        except OSError as e:
            _state["error"] = ("词库目录建不出来：%s（来自 %s）：%s"
                               % (path, {"env": ENV_KEY, "setting": SETTING_KEY,
                                         "config": CONFIG_NAME, "default": "默认位置"}[source], e))
            return None
    _seed_examples(path, path in _state["created"], source == "default")
    try:
        _migrate_history(path)
    except Exception as e:                              # noqa: BLE001
        # 迁移失败不能把整个词库卡成不可用；旧历史最多还是留在语库里
        print("[kedou词库] 旧历史迁移失败（不影响使用）：%s" % e)
    return path


def last_error():
    return _state.get("error")


def vault_info():
    """给界面/排查用：当前到底在读哪个目录、这个决定是谁做的。"""
    path, source = resolve_vault()
    return {"vault": path, "vault_source": source,
            "exists": os.path.isdir(path), "error": _state.get("error") or ""}


def _reset_state():
    """改了库位置之后必须忘掉旧的解析结果，否则还是读老目录。"""
    _state["seed_checked"] = False
    _state["created"] = set()
    _state["migrated"] = set()
    _cache.clear()


def set_vault_config(path):
    """把库位置写进 user/default/kedou_prompt_vault.txt；空串 = 删掉它（回到设置项/默认）。

    当场建一次目录：填错盘符、指到只读位置这类问题要在这一步就报出来，
    而不是等用户写完词条才发现存不下。
    """
    user_dir = _user_default_dir()
    cfg = os.path.join(user_dir, CONFIG_NAME)
    raw = str(path or "").strip().strip('"').strip("'")
    if not raw:
        try:
            if os.path.exists(cfg):
                os.remove(cfg)
        except OSError as e:
            return {"ok": False, "error": "配置文件清不掉：%s" % e}
        _reset_state()
        return dict({"ok": True, "cleared": True}, **vault_info())
    if len(raw) > 400 or re.search(r"[\x00-\x1f]", raw):
        return {"ok": False, "error": "路径不合法"}
    expanded = os.path.expanduser(raw)
    # 必须在 abspath 之前判：abspath 会拿当前目录把相对路径补成绝对，那样这条校验永远为真
    if not os.path.isabs(expanded):
        return {"ok": False, "error": "要写绝对路径，例如 D:\\MyDocs\\提示词库"}
    target = os.path.abspath(expanded)
    if os.path.exists(target) and not os.path.isdir(target):
        return {"ok": False, "error": "那儿已经有个同名文件，不是目录：%s" % target}
    try:
        if not os.path.isdir(target):
            os.makedirs(target, exist_ok=True)
    except OSError as e:
        return {"ok": False, "error": "这个目录建不出来：%s（%s）" % (target, e)}
    try:
        os.makedirs(user_dir, exist_ok=True)
        _atomic_write(cfg, "# kedou 词库目录（词库面板「改路径」写入；删掉本文件即回到默认）\n%s\n" % target)
    except OSError as e:
        return {"ok": False, "error": "配置文件写不进去：%s" % e}
    _reset_state()
    return dict({"ok": True}, **vault_info())


def _backup_dir(vault):
    return os.path.join(vault, ".backup")


def _trash_dir(vault):
    return os.path.join(vault, ".trash")


# ─────────────────────────── 词库内部 JSON 存储 ───────────────────────────
# 历史与短词都是「整份读、整份写」的小数据，单文件比几百个 .md 更适合：
# 不会在 Obsidian 里刷屏，也不会因为一次出图写 5 个文件而拖慢列表。

def _store_path(vault, name):
    return os.path.join(vault, STORE_DIR, name)


def _read_store(vault, name, default):
    """坏文件不能让接口 500：改名留档后按空数据继续。"""
    path = _store_path(vault, name)
    try:
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
        return data
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as e:
        try:
            os.replace(path, path + ".bad-" + time.strftime("%Y%m%d-%H%M%S"))
            print("[kedou词库] %s 解析失败，已留档：%s" % (name, e))
        except OSError:
            pass
        return default


def _write_store(vault, name, data):
    _atomic_write(_store_path(vault, name), json.dumps(data, ensure_ascii=False, indent=1))


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _hash16(text):
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()[:16]


def _usage_list(usage):
    """usage 可能是单值、list 或 None（旧客户端两种都发过），统一成字符串列表。"""
    if isinstance(usage, (list, tuple)):
        return [str(x).strip() for x in usage if str(x).strip()]
    s = str(usage or "").strip()
    return [s] if s else []


def _history_items(vault):
    data = _read_store(vault, HISTORY_FILE, {"version": 1, "items": []})
    raw = data.get("items") if isinstance(data, dict) else data
    out = []
    for it in raw if isinstance(raw, list) else []:
        if not isinstance(it, dict):
            continue
        pos = str(it.get("positive") or "").strip()
        if len(pos) < 4:
            continue
        uses = _to_int(it.get("uses"))
        usage = it.get("use_for")
        if isinstance(usage, str):
            usage = [usage]
        out.append({
            "id": str(it.get("id") or ("h." + _hash16(pos)[:10])),
            "name": str(it.get("name") or pos[:20]),
            "type": "历史",
            "positive": pos,
            "negative": "",
            "use_for": [str(x) for x in (usage or []) if str(x)] or ["文生图"],
            "uses": uses,
            "created": str(it.get("created") or ""),
            "updated": str(it.get("updated") or ""),
            "hash": str(it.get("hash") or _hash16(pos)),
            "kind": "history",
        })
    out.sort(key=lambda e: e.get("updated") or "", reverse=True)
    return out


def _write_history(vault, items):
    _write_store(vault, HISTORY_FILE, {"version": 1, "items": items[:HISTORY_CAP]})


def _phrase_items(vault):
    """首次调用时从随包的 phrases_seed.json 播种（只在 phrases.json 不存在时做）。"""
    path = _store_path(vault, PHRASES_FILE)
    if not os.path.exists(path):
        with _store_lock:
            # 两个请求同时第一次打开词库：只让一个播种，另一个直接读结果
            if not os.path.exists(path):
                seed_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), PHRASES_SEED)
                seed = []
                try:
                    with open(seed_path, encoding="utf-8") as f:
                        seed = json.load(f)
                except (OSError, ValueError):
                    seed = []
                items = []
                seen = set()
                now = _now()
                for row in seed if isinstance(seed, list) else []:
                    if not isinstance(row, dict):
                        continue
                    pos = str(row.get("positive") or "").strip()
                    if not pos:
                        continue
                    name = str(row.get("name") or pos).strip() or pos
                    group = str(row.get("group") or PHRASE_GROUP_FALLBACK).strip() or PHRASE_GROUP_FALLBACK
                    cat = str(row.get("category") or "").strip() or PHRASE_CAT_FALLBACK
                    base = "p." + _hash16("%s|%s|%s" % (group, cat, pos))[:10]
                    pid, n = base, 2
                    while pid in seen:
                        pid = "%s_%d" % (base, n)
                        n += 1
                    seen.add(pid)
                    items.append({
                        "id": pid, "name": name, "positive": pos, "type": "词条",
                        "group": group, "category": cat, "pinned": False, "uses": 0,
                        "created": now, "updated": now, "hash": _hash16(pos),
                    })
                if items:
                    try:
                        _write_store(vault, PHRASES_FILE, {"version": 1, "items": items})
                    except OSError as e:
                        print("[kedou词库] 短词库初始化失败（不影响长语库）：%s" % e)
                return items

    data = _read_store(vault, PHRASES_FILE, {"version": 1, "items": []})
    raw = data.get("items") if isinstance(data, dict) else data
    out = []
    for it in raw if isinstance(raw, list) else []:
        if not isinstance(it, dict):
            continue
        pos = str(it.get("positive") or "").strip()
        if not pos:
            continue
        name = str(it.get("name") or pos).strip() or pos
        group = str(it.get("group") or "").strip() or PHRASE_GROUP_FALLBACK
        cat = str(it.get("category") or "").strip() or PHRASE_CAT_FALLBACK
        if cat == PHRASE_CAT_FALLBACK:
            group = PHRASE_GROUP_FALLBACK
        out.append({
            "id": str(it.get("id") or ("p." + _hash16(pos)[:10])),
            "name": name, "positive": pos, "type": "词条",
            "group": group,
            "category": cat,
            "pinned": bool(it.get("pinned")),
            "uses": _to_int(it.get("uses")),
            "created": str(it.get("created") or ""),
            "updated": str(it.get("updated") or ""),
            "hash": str(it.get("hash") or _hash16(pos)),
            "kind": "phrase",
        })
    return out


def _write_phrases(vault, items):
    _write_store(vault, PHRASES_FILE, {"version": 1, "items": items})


def _history_to_trash(vault, files):
    """旧历史笔记迁走后放进 .trash（可找回），不留在 Obsidian 的笔记树里。"""
    tdir = _trash_dir(vault)
    try:
        os.makedirs(tdir, exist_ok=True)
    except OSError:
        return
    for full in files:
        try:
            stem = os.path.splitext(os.path.basename(full))[0]
            dest = os.path.join(tdir, os.path.basename(full))
            n = 2
            while os.path.exists(dest):
                dest = os.path.join(tdir, "%s_%d.md" % (stem, n))
                n += 1
            shutil.move(full, dest)
        except OSError as e:
            print("[kedou词库] 旧历史笔记移动失败：%s（%s）" % (full, e))
            return


def _migrate_history(vault):
    """把旧版本 `type=历史` 的 .md 迁进 history.json，再把笔记移到 .trash。

    迁移后语库里不会再出现历史条目；重复调用只做一次（进程内按库路径记）。
    """
    key = os.path.normcase(os.path.abspath(vault))
    if key in _state["migrated"]:
        return
    _state["migrated"].add(key)
    old = []
    for e in _walk(vault):
        rel = str(e.get("file") or "")
        first = rel.split("/")[0] if rel else ""
        if e.get("type") == "历史" or first == HISTORY_DIR:
            old.append(e)
    if not old:
        try:
            hd = os.path.join(vault, HISTORY_DIR)
            if os.path.isdir(hd) and not os.listdir(hd):
                os.rmdir(hd)
        except OSError:
            pass
        return
    with _store_lock:
        items = _history_items(vault)
        known = {it["hash"] for it in items}
        now = _now()
        for e in old:
            if e["hash"] not in known:
                known.add(e["hash"])
                items.append({
                    "id": "h." + e["hash"][:10],
                    "name": e.get("name") or (e.get("positive") or "")[:20],
                    "type": "历史",
                    "positive": e.get("positive") or "",
                    "negative": "",
                    "use_for": e.get("use_for") or ["文生图"],
                    "uses": _to_int(e.get("uses")),
                    "created": e.get("created") or now,
                    "updated": e.get("updated") or now,
                    "hash": e["hash"],
                })
        items.sort(key=lambda x: x.get("updated") or "", reverse=True)
        _write_history(vault, items)
    _history_to_trash(vault, [os.path.join(vault, *str(e["file"]).split("/")) for e in old])
    try:
        hd = os.path.join(vault, HISTORY_DIR)
        if os.path.isdir(hd) and not os.listdir(hd):
            os.rmdir(hd)                            # 空的旧历史目录也收走，Obsidian 里不再多一个空文件夹
    except OSError:
        pass
    print("[kedou词库] 已迁移 %d 条旧历史到 %s" % (len(old), HISTORY_FILE))


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
        except Exception:                               # noqa: BLE001
            return None, body                           # None = yaml 解析失败
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
        # errors="replace"：GBK/UTF-16 手改文件也不能让整个 /ps/prompts 挂掉
        text = open(path, encoding="utf-8-sig", errors="replace").read()
        meta, body = _split_fm(text)
        if meta is None:
            # frontmatter 坏了也保留正文：至少能在列表里看到并删掉，而不是永久隐身
            print("[kedou词库] frontmatter 解析失败，按无 meta 处理：%s" % rel)
            meta = {}
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
            "priority": _to_int(meta.get("priority")),
            "pinned": bool(meta.get("pinned")),
            "enabled": meta.get("enabled", True) is not False,
            "uses": _to_int(meta.get("uses")),
            "created": str(meta.get("created") or ""),
            "updated": str(meta.get("updated") or ""),
            "positive": positive,
            "negative": secs.get("negative", ""),
            "description": secs.get("description", ""),
            "note": secs.get("use", ""),
            "use_for": _strlist(meta.get("usage")) or ["文生图"],
            "avoid": secs.get("avoid", ""),
            "related": secs.get("related", ""),
            "file": rel,
            "hash": hashlib.sha256(positive.encode("utf-8")).hexdigest()[:16],
        }
        _cache[path] = (st.st_mtime_ns, st.st_size, entry)
        return entry
    except Exception as e:                              # noqa: BLE001
        # 单个坏文件不能拖垮整个列表：跳过并留下可排查的日志
        print("[kedou词库] 读取失败，跳过：%s（%s: %s）" % (rel, type(e).__name__, e))
        return None


def _serialize(entry):
    fm = ["id: %s" % _yaml_scalar(entry["id"]), "type: %s" % _yaml_scalar(entry["type"])]
    if entry.get("category"):
        fm.append("category: %s" % _yaml_scalar(entry["category"]))
    fm.append("name: %s" % _yaml_scalar(entry["name"]))
    for k in ("models", "tags"):
        v = entry.get(k) or []
        fm.append("%s:" % k)
        fm.extend("  - %s" % _yaml_scalar(x) for x in v)
    fm.append("priority: %d" % _to_int(entry.get("priority")))
    fm.append("pinned: %s" % ("true" if entry.get("pinned") else "false"))
    fm.append("enabled: %s" % ("true" if entry.get("enabled", True) else "false"))
    fm.append("uses: %d" % _to_int(entry.get("uses")))
    fm.append("usage:")
    fm.extend("  - %s" % _yaml_scalar(x) for x in (entry.get("use_for") or ["文生图"]))
    if entry.get("created"):
        fm.append("created: %s" % _yaml_scalar(entry["created"]))
    fm.append("updated: %s" % _yaml_scalar(entry.get("updated") or time.strftime("%Y-%m-%d")))
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


def _walk(vault):
    out = []
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fn in files:
            if not fn.lower().endswith(".md"):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, vault).replace("\\", "/")
            e = _parse_entry(full, rel)
            if e:
                out.append(e)
    return out


def _backup_daily(vault):
    """首次访问时压一次整库 zip，保留最近 BACKUP_KEEP 份。备份落在库目录内部的 .backup，
    不再往上一级目录写 —— 用户可能把库存为自己的 Obsidian vault，那里不该多出兄弟目录。"""
    today = time.strftime("%Y-%m-%d")
    key = (vault, today)
    if key in _state["backups"]:
        return
    _state["backups"].add(key)
    bdir = _backup_dir(vault)
    try:
        os.makedirs(bdir, exist_ok=True)
        dest = os.path.join(bdir, "prompts_%s.zip" % today)
        if not os.path.exists(dest):
            with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
                for root, dirs, files in os.walk(vault):
                    dirs[:] = [d for d in dirs if not d.startswith(".")]
                    for fn in files:
                        if fn.lower().endswith(".md"):
                            full = os.path.join(root, fn)
                            z.write(full, os.path.relpath(full, vault))
                # .kedou 是隐藏目录，上面的 walk 不会进去；词库/历史是用户数据，单独补进备份
                for extra in (PHRASES_FILE, HISTORY_FILE):
                    full = _store_path(vault, extra)
                    if os.path.isfile(full):
                        z.write(full, os.path.join(STORE_DIR, extra))
            olds = sorted(f for f in os.listdir(bdir) if f.startswith("prompts_") and f.endswith(".zip"))
            for old in olds[:-BACKUP_KEEP]:
                os.remove(os.path.join(bdir, old))
    except Exception as e:                              # noqa: BLE001
        print("[kedou词库] 备份失败（不影响使用）：%s" % e)


# ─────────────────────────── 对外操作 ───────────────────────────

def list_prompts(q_type="", q_dir="", tag="", model="", q="", use=""):
    vault = vault_dir()
    if not vault:
        return dict({"ok": False, "error": last_error() or "词库目录不可用", "items": [],
                     "dirs": [], "types": [], "count": 0}, **vault_info())
    # 兼容旧调用方：显式要 type=历史 时只返回历史（从 JSON 读），默认列表里永远没有历史
    if q_type == "历史":
        items = _history_items(vault)
        if use:
            items = [e for e in items if use in e["use_for"]]
        if q:
            ql = q.lower()
            items = [e for e in items if ql in e["name"].lower() or ql in e["positive"].lower()]
        return dict({"ok": True, "items": items, "dirs": [], "types": ["历史"],
                     "count": len(items)}, **vault_info())
    _backup_daily(vault)
    items = [e for e in _walk(vault) if e["type"] != "历史"]
    if use:
        items = [e for e in items if use in e["use_for"]]
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
    # pinned 优先 → priority 降 → updated 降：用连续稳定排序表达
    items.sort(key=lambda e: (not e["pinned"], -e["priority"], e["updated"] or "", e["name"]))
    items.sort(key=lambda e: e["updated"], reverse=True)
    items.sort(key=lambda e: e["priority"], reverse=True)
    items.sort(key=lambda e: (not e["pinned"],))
    dirs = sorted({e["dir"] for e in items if e["dir"]})
    types = sorted({e["type"] for e in items})
    return dict({"ok": True, "items": items, "dirs": dirs, "types": types,
                 "count": len(items)}, **vault_info())


def _find_path(vault, pid):
    if not pid or not _ID_RE.match(pid):
        return None, None
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fn in files:
            if not fn.lower().endswith(".md"):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, vault).replace("\\", "/")
            e = _parse_entry(full, rel)
            if e and e["id"] == pid:
                return full, e
    return None, None


def save_prompt(body):
    vault = vault_dir()
    if not vault:
        return {"ok": False, "error": last_error() or "词库目录不可用"}
    # 历史只进 JSON，不再生成 .md。旧版 PS 面板仍按 type=历史 调这个接口，这里做一次转发。
    if str(body.get("type") or "") == "历史":
        return save_history(str(body.get("positive") or ""), _usage_list(body.get("usage")))
    pid = str(body.get("id") or "").strip()
    now = time.strftime("%Y-%m-%d")
    if pid:
        path, old = _find_path(vault, pid)
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
        if "usage" in body:
            entry["use_for"] = [str(x) for x in (body["usage"] or [])] or ["文生图"]
        if "priority" in body:
            entry["priority"] = _to_int(body.get("priority"))
        if "pinned" in body:
            entry["pinned"] = bool(body["pinned"])
        if "enabled" in body:
            entry["enabled"] = bool(body["enabled"])
        entry["updated"] = now
        entry["hash"] = hashlib.sha256(entry["positive"].encode("utf-8")).hexdigest()[:16]
        # 改名 → 文件跟着显示名走（id 不变）
        new_stem = _slug(entry["name"])
        new_path = os.path.join(os.path.dirname(path), new_stem + ".md")
        if (os.path.abspath(new_path) != os.path.abspath(path)
                and os.path.exists(new_path)):
            # 同名文件属于另一条词条：另起 _2/_3，绝不能覆盖别人的内容
            new_path = _unique_path(os.path.dirname(path), new_stem)
        if not _inside(vault, new_path):
            return {"ok": False, "error": "目标路径越出词库目录"}
        content = _serialize(entry)
        _atomic_write(new_path, content)
        if os.path.abspath(new_path) != os.path.abspath(path):
            try:
                os.remove(path)
            except OSError as e:
                print("[kedou词库] 旧文件删不掉（新文件已写入）：%s（%s）" % (path, e))
        _cache.pop(path, None)
        rel = os.path.relpath(new_path, vault).replace("\\", "/")
        return {"ok": True, "item": _parse_entry(new_path, rel)}
    # 新建
    name = " ".join(str(body.get("name") or "").splitlines()).strip()
    positive = str(body.get("positive") or "").strip()
    if not name or not positive:
        return {"ok": False, "error": "短名和提示词正文不能为空"}
    # 去重：正文 hash 撞了直接返回已有条目（同时把新用途并进去）
    h = hashlib.sha256(positive.encode("utf-8")).hexdigest()[:16]
    for e in _walk(vault):
        if e["type"] == "历史":
            continue
        if e["hash"] == h:
            if "usage" in body:
                add = [str(x) for x in (body.get("usage") or []) if str(x).strip()]
                merged = list(dict.fromkeys((e.get("use_for") or []) + add))
                if merged != (e.get("use_for") or []):
                    p, old = _find_path(vault, e["id"])
                    if old:
                        old["use_for"] = merged
                        _atomic_write(p, _serialize(old))
                        _cache.pop(p, None)
                        e = old
            return {"ok": True, "item": e, "deduped": True}
    etype = str(body.get("type") or "精选")
    raw_dir = str(body.get("dir") or "").strip()
    base_dir = _safe_subdir(raw_dir) if raw_dir else "99_未分类"
    if base_dir is None:
        return {"ok": False, "error": "目录不合法（不能是绝对路径或包含 ..）"}
    stem = _slug(name)
    dir_path = os.path.join(vault, *base_dir.split("/")) if base_dir else vault
    path = _unique_path(dir_path, stem)
    if not _inside(vault, path):
        return {"ok": False, "error": "目标路径越出词库目录"}
    entry = {
        "id": "%s.%s" % (etype, h[:8]),
        "name": name, "type": etype, "category": str(body.get("category") or ""),
        "models": [str(x) for x in (body.get("models") or [])],
        "tags": [str(x) for x in (body.get("tags") or [])],
        "priority": _to_int(body.get("priority")), "pinned": bool(body.get("pinned")),
        "enabled": True, "uses": 0, "created": now, "updated": now,
        "positive": positive, "negative": str(body.get("negative") or ""),
        "description": str(body.get("description") or ""),
        "use_for": [str(x) for x in (body.get("usage") or [])] or ["文生图"],
    }
    _atomic_write(path, _serialize(entry))
    rel = os.path.relpath(path, vault).replace("\\", "/")
    return {"ok": True, "item": _parse_entry(path, rel)}


def save_history(positive, usage=None):
    """自动历史：只写 .kedou/history.json，绝不生成 .md。

    同一条提示词按正文 hash 去重（撞了 uses+1、并用途），HISTORY_CAP 条封顶。
    """
    vault = vault_dir()
    if not vault:
        return {"ok": False, "error": last_error() or "词库目录不可用"}
    positive = (positive or "").strip()
    if len(positive) < 4:
        return {"ok": False, "error": "太短，不存历史"}
    usages = _usage_list(usage)
    h = _hash16(positive)
    now = _now()
    with _store_lock:
        items = _history_items(vault)
        for it in items:
            if it["hash"] == h:
                it["uses"] = _to_int(it.get("uses")) + 1
                it["updated"] = now
                if usages:
                    it["use_for"] = list(dict.fromkeys((it.get("use_for") or []) + usages))
                items.sort(key=lambda x: x.get("updated") or "", reverse=True)
                _write_history(vault, items)
                return {"ok": True, "item": it, "deduped": True}
        name = " ".join((positive[:20] + ("…" if len(positive) > 20 else "")).splitlines()).strip()
        it = {
            "id": "h." + h[:10], "name": name, "type": "历史", "positive": positive,
            "negative": "", "use_for": usages or ["文生图"],
            "uses": 1, "created": now, "updated": now, "hash": h,
        }
        items.insert(0, it)
        items.sort(key=lambda x: x.get("updated") or "", reverse=True)
        _write_history(vault, items)
        return {"ok": True, "item": it}


def list_history(use="", q=""):
    vault = vault_dir()
    if not vault:
        return {"ok": False, "error": last_error() or "词库目录不可用", "items": [], "count": 0}
    items = _history_items(vault)
    if use:
        items = [e for e in items if use in e["use_for"]]
    if q:
        ql = q.lower()
        items = [e for e in items if ql in e["name"].lower() or ql in e["positive"].lower()]
    return dict({"ok": True, "items": items, "count": len(items)}, **vault_info())


def delete_history(pid):
    vault = vault_dir()
    if not vault:
        return {"ok": False, "error": last_error() or "词库目录不可用"}
    with _store_lock:
        items = _history_items(vault)
        keep = [it for it in items if it["id"] != pid]
        if len(keep) == len(items):
            return {"ok": False, "error": "条目不存在"}
        _write_history(vault, keep)
    return {"ok": True}


def clear_history():
    vault = vault_dir()
    if not vault:
        return {"ok": False, "error": last_error() or "词库目录不可用"}
    with _store_lock:
        _write_history(vault, [])
    return {"ok": True, "cleared": True}


# ─────────────────────────── 词库（短词/标签） ───────────────────────────

def list_phrases(q="", category="", group=""):
    vault = vault_dir()
    if not vault:
        return {"ok": False, "error": last_error() or "词库目录不可用",
                "items": [], "categories": [], "groups": [], "count": 0}
    items = _phrase_items(vault)
    # 置顶优先、再按更新时间：新保存/移入的词（尤其「未分类」）总排在前面，
    # 不会因为「全部」只渲染前 400 条而找不到。
    items.sort(key=lambda x: (bool(x.get("pinned")), x.get("updated") or ""),
               reverse=True)
    cats, groups = [], []
    for it in items:
        if it["group"] not in groups:
            groups.append(it["group"])
        key = (it["group"], it["category"])
        if key not in cats:
            cats.append(key)
    # 新建/移入的词默认落在「我的词 · 未分类」，即使当前还是空的也要能选到
    if PHRASE_GROUP_FALLBACK not in groups:
        groups.append(PHRASE_GROUP_FALLBACK)
    if (PHRASE_GROUP_FALLBACK, PHRASE_CAT_FALLBACK) not in cats:
        cats.append((PHRASE_GROUP_FALLBACK, PHRASE_CAT_FALLBACK))
    if group:
        items = [e for e in items if e["group"] == group]
    if category:
        items = [e for e in items if e["category"] == category]
    if q:
        ql = q.lower()
        items = [e for e in items
                 if ql in e["name"].lower() or ql in e["positive"].lower()
                 or ql in e["category"].lower()]
    return dict({"ok": True, "items": items,
                 "categories": [{"group": g, "name": c} for g, c in cats],
                 "groups": groups, "count": len(items)}, **vault_info())


def save_phrase(body):
    vault = vault_dir()
    if not vault:
        return {"ok": False, "error": last_error() or "词库目录不可用"}
    pid = str(body.get("id") or "").strip()
    now = _now()
    with _store_lock:
        items = _phrase_items(vault)
        if pid:
            for it in items:
                if it["id"] != pid:
                    continue
                # 只改客户端真正带上来的字段：右键「置顶」只传 id + pinned
                if "positive" in body:
                    pos = " ".join(str(body.get("positive") or "").splitlines()).strip()
                    if not pos:
                        return {"ok": False, "error": "词的内容不能为空"}
                    it["positive"] = pos[:500]
                    it["hash"] = _hash16(it["positive"])
                if "name" in body:
                    it["name"] = " ".join(str(body.get("name") or "").splitlines()).strip() or it["positive"][:24]
                if "category" in body:
                    it["category"] = " ".join(str(body.get("category") or "").splitlines()).strip() or PHRASE_CAT_FALLBACK
                if "group" in body and str(body.get("group") or "").strip():
                    it["group"] = str(body["group"]).strip()
                if "pinned" in body:
                    it["pinned"] = bool(body["pinned"])
                # 「未分类」固定归属「我的词」，不跟着旧分组飘
                if it["category"] == PHRASE_CAT_FALLBACK:
                    it["group"] = PHRASE_GROUP_FALLBACK
                # 分类被改到一个已有分类时，沿用那个分类所属的大组，避免分裂
                if "category" in body and "group" not in body and it["category"] != PHRASE_CAT_FALLBACK:
                    moved = [x for x in items if x["id"] != pid and x["category"] == it["category"]]
                    if moved:
                        it["group"] = moved[0]["group"]
                it["updated"] = now
                _write_phrases(vault, items)
                return {"ok": True, "item": it}
            return {"ok": False, "error": "词条不存在"}
        # 新建
        name = " ".join(str(body.get("name") or "").splitlines()).strip()
        positive = " ".join(str(body.get("positive") or "").splitlines()).strip()
        cat_in = " ".join(str(body.get("category") or "").splitlines()).strip() or PHRASE_CAT_FALLBACK
        if not positive:
            return {"ok": False, "error": "词的内容不能为空"}
        positive = positive[:500]
        if not name:
            name = positive[:24]
        # 同组同分类下同一内容直接复用
        for it in items:
            if it["positive"] == positive and it["category"] == cat_in:
                return {"ok": True, "item": it, "deduped": True}
        group = str(body.get("group") or "").strip()
        if cat_in == PHRASE_CAT_FALLBACK:
            group = PHRASE_GROUP_FALLBACK
        if not group:
            same = [x for x in items if x["category"] == cat_in and cat_in]
            group = same[0]["group"] if same else PHRASE_GROUP_FALLBACK
        it = {
            "id": "p." + uuid.uuid4().hex[:10],
            "name": name, "positive": positive, "type": "词条",
            "group": group, "category": cat_in, "pinned": bool(body.get("pinned")),
            "uses": 0, "created": now, "updated": now, "hash": _hash16(positive),
        }
        items.append(it)
        _write_phrases(vault, items)
        return {"ok": True, "item": it}


def delete_phrase(pid):
    vault = vault_dir()
    if not vault:
        return {"ok": False, "error": last_error() or "词库目录不可用"}
    with _store_lock:
        items = _phrase_items(vault)
        gone = [it for it in items if it["id"] == pid]
        if not gone:
            return {"ok": False, "error": "词条不存在"}
        keep = [it for it in items if it["id"] != pid]
        _write_phrases(vault, keep)
        # 短词删了也留一份，删错了能翻回来
        try:
            tdir = _trash_dir(vault)
            os.makedirs(tdir, exist_ok=True)
            with open(os.path.join(tdir, "phrases_deleted.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps({"deleted": _now(), "item": gone[0]}, ensure_ascii=False) + "\n")
        except OSError:
            pass
    return {"ok": True}


def bump_phrase_use(pid):
    vault = vault_dir()
    if not vault:
        return {"ok": False, "error": last_error() or "词库目录不可用"}
    with _store_lock:
        items = _phrase_items(vault)
        for it in items:
            if it["id"] == pid:
                it["uses"] = _to_int(it.get("uses")) + 1
                it["updated"] = _now()
                _write_phrases(vault, items)
                return {"ok": True, "uses": it["uses"]}
    return {"ok": False, "error": "词条不存在"}


def delete_prompt(pid):
    vault = vault_dir()
    if not vault:
        return {"ok": False, "error": last_error() or "词库目录不可用"}
    path, entry = _find_path(vault, pid)
    if path is None:
        # 旧客户端可能把历史 id 发到这里：历史现在是 JSON，走对应的删除
        if pid.startswith("h."):
            return delete_history(pid)
        return {"ok": False, "error": "条目不存在"}
    tdir = _trash_dir(vault)
    os.makedirs(tdir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(path))[0]
    dest = os.path.join(tdir, os.path.basename(path))
    n = 2
    while os.path.exists(dest):
        dest = os.path.join(tdir, "%s_%d.md" % (stem, n))
        n += 1
    shutil.move(path, dest)
    _cache.pop(path, None)
    return {"ok": True, "trashed": os.path.basename(dest)}


def bump_use(pid):
    vault = vault_dir()
    if not vault:
        return {"ok": False, "error": last_error() or "词库目录不可用"}
    path, entry = _find_path(vault, pid)
    if path is None:
        # 历史/短词现在不在 .md 里：按 id 前缀兜底，旧前端不用改调用
        if pid.startswith("h."):
            with _store_lock:
                items = _history_items(vault)
                for it in items:
                    if it["id"] == pid:
                        it["uses"] = _to_int(it.get("uses")) + 1
                        it["updated"] = _now()
                        _write_history(vault, items)
                        return {"ok": True, "uses": it["uses"]}
        elif pid.startswith("p."):
            return bump_phrase_use(pid)
        return {"ok": False, "error": "条目不存在"}
    entry["uses"] += 1
    _atomic_write(path, _serialize(entry))
    _cache.pop(path, None)
    return {"ok": True, "uses": entry["uses"]}


# ─────────────────────────── 路由注册 ───────────────────────────

def register_routes(routes):
    """把 HTTP 接口挂到任意 aiohttp RouteTableDef 上（不是 app.router，那上面没有 .get/.post）。

    ComfyUI 里传 PromptServer.instance.routes —— 启动器和 PS 面板走的就是这条路；
    要独立起服务就 `routes = web.RouteTableDef(); register_routes(routes); app.add_routes(routes)`。
    逻辑层没有 ComfyUI 依赖，所以换哪个宿主都不用改代码。
    """
    from aiohttp import web
    import asyncio                                      # noqa: PLC0415 —— 文件 I/O 放线程池

    async def _body(request):
        try:
            b = await request.json()
        except Exception:                               # noqa: BLE001
            return None
        return b if isinstance(b, dict) else None

    @routes.get("/ps/prompts")
    async def _list(request):
        q = request.query
        items = await asyncio.to_thread(
            list_prompts, q.get("type", ""), q.get("dir", ""), q.get("tag", ""),
            q.get("model", ""), q.get("q", ""), q.get("use", ""))
        return web.json_response(items)

    @routes.post("/ps/prompts/save")
    async def _save(request):
        body = await _body(request)
        if body is None:
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        return web.json_response(await asyncio.to_thread(save_prompt, body))

    @routes.post("/ps/prompts/history")
    async def _hist(request):
        body = await _body(request) or {}
        result = await asyncio.to_thread(
            save_history, str(body.get("positive") or ""), body.get("usage"))
        return web.json_response(result)

    @routes.get("/ps/prompts/history")
    async def _hist_list(request):
        q = request.query
        result = await asyncio.to_thread(list_history, q.get("use", ""), q.get("q", ""))
        return web.json_response(result)

    @routes.post("/ps/prompts/history/delete")
    async def _hist_del(request):
        body = await _body(request) or {}
        return web.json_response(await asyncio.to_thread(
            delete_history, str(body.get("id") or "")))

    @routes.post("/ps/prompts/history/clear")
    async def _hist_clear(request):
        return web.json_response(await asyncio.to_thread(clear_history))

    # ── 词库（短词/标签） ──
    @routes.get("/ps/prompts/phrases")
    async def _phrases(request):
        q = request.query
        result = await asyncio.to_thread(
            list_phrases, q.get("q", ""), q.get("category", ""), q.get("group", ""))
        return web.json_response(result)

    @routes.post("/ps/prompts/phrases/save")
    async def _phrase_save(request):
        body = await _body(request)
        if body is None:
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        return web.json_response(await asyncio.to_thread(save_phrase, body))

    @routes.post("/ps/prompts/phrases/delete")
    async def _phrase_del(request):
        body = await _body(request) or {}
        return web.json_response(await asyncio.to_thread(
            delete_phrase, str(body.get("id") or "")))

    @routes.post("/ps/prompts/phrases/use")
    async def _phrase_use(request):
        body = await _body(request) or {}
        return web.json_response(await asyncio.to_thread(
            bump_phrase_use, str(body.get("id") or "")))

    @routes.post("/ps/prompts/delete")
    async def _del(request):
        body = await _body(request) or {}
        return web.json_response(await asyncio.to_thread(
            delete_prompt, str(body.get("id") or "")))

    @routes.post("/ps/prompts/use")
    async def _use(request):
        body = await _body(request) or {}
        return web.json_response(await asyncio.to_thread(
            bump_use, str(body.get("id") or "")))

    @routes.post("/ps/prompts/vault")
    async def _vault(request):
        body = await _body(request)
        if body is None or "path" not in body:
            return web.json_response({"ok": False, "error": "bad json"}, status=400)
        return web.json_response(await asyncio.to_thread(
            set_vault_config, str(body.get("path") or "")))


__all__ = [
    "resolve_vault", "vault_dir", "vault_info", "last_error", "set_vault_config",
    "list_prompts", "save_prompt", "save_history", "delete_prompt", "bump_use",
    "list_history", "delete_history", "clear_history",
    "list_phrases", "save_phrase", "delete_phrase", "bump_phrase_use",
    "register_routes",
    "ENV_KEY", "SETTING_KEY", "CONFIG_NAME",
]

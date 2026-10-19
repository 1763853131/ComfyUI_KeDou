# -*- coding: utf-8 -*-
"""应用：发现、参数规格、sidecar 回写、UI→API 转换与执行图构建。"""

import copy
import importlib.util
import json
import os

from . import compat, paths
from .common import (KIND_CN, NOISE_INPUTS, _clean_label, _kind_of,
                     _split_ref, _widget_values)
from .registry import (build_object_info, widget_spec, _unknown_in_ui,
                       _unknown_types, _widget_index)
from .state import _load_app_state, _save_app_state


# ---------------------------------------------------------------- 应用解析
def is_app_workflow(data: dict, filename: str = "") -> bool:
    if filename.lower().endswith(".app.json"):
        return True
    extra = data.get("extra") or {}
    return bool(extra.get("linearMode"))


def find_app_files(root: str = None) -> list:
    root = root or paths.WORKFLOW_DIR
    out = []
    for r, _dirs, files in os.walk(root):
        for fn in files:
            if fn.startswith(".") or not fn.lower().endswith(".json"):
                continue
            low = fn.lower()
            if low.endswith(".kapp.json") or low.endswith(".app.json"):
                out.append(os.path.join(r, fn))
    # 同 stem 同时有 .kapp.json 与 .app.json：kapp 优先（自研格式遮蔽官方格式）
    by_stem = {}
    for p in out:
        stem = paths._stem(os.path.basename(p)).lower()
        prev = by_stem.get(stem)
        if prev is None or (p.lower().endswith(".kapp.json")
                            and not prev.lower().endswith(".kapp.json")):
            by_stem[stem] = p
    return sorted(by_stem.values())


# ---------------------------------------------------------------- 自研应用包（kapp）
#
# 官方应用模式（linearMode）的三项额外成本：参数靠 linearData 勾选（勾到哪个控件就叫什么名）、
# widgets_values 按位置对位、每次运行都要 UI→API 翻译。kapp 把三样全部显式化：
#   * graph 直接存 API 格式（「导出 API 格式」同构）—— 没有翻译、没有位置对位；
#   * params 逐条声明 node + input + widget —— 插件不推断、不特判；
#   * outputs 显式列出 SaveImage 类节点 id。
# 打包：POST /ps/pack（source = 任意 UI 格式工作流，含 .app.json）。
# 插件仍是纯通道：声明是什么就是什么，不针对任何应用做特判。

_KAPP_WIDGETS = ("text", "number", "toggle", "combo", "image", "kedou_media", "prompt")
_KAPP_KIND = {"text": "text", "number": "number", "toggle": "bool",
              "combo": "combo", "image": "image", "kedou_media": "text",
              # prompt 是「提示词 + 用途」复合控件；kind 仍报 text，
              # 不认识新 widget 的旧客户端退回普通文本框，不会坏。
              "prompt": "text"}


def _is_kapp(path: str) -> bool:
    return os.path.basename(path).lower().endswith(".kapp.json")


def _load_kapp(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or int(data.get("kedou_app") or 0) != 1:
        raise ValueError("不是 kapp 应用包（缺少 kedou_app: 1）")
    if not isinstance(data.get("graph"), dict) or not data["graph"]:
        raise ValueError("kapp 缺少 graph（API 格式工作流）")
    return data


def _kapp_param_item(entry: dict, object_info: dict) -> dict:
    """声明条目 -> 面板参数（与官方格式同形，多带 widget 字段）。"""
    node_id = str(entry.get("node") or "")
    input_name = str(entry.get("input") or "")
    widget = str(entry.get("widget") or "text")
    if widget not in _KAPP_WIDGETS:
        raise ValueError("未知 widget 类型：%s" % widget)
    ctype = str(entry.get("node_type") or "")
    spec = widget_spec(object_info, ctype, input_name)
    item = {
        "node": node_id,
        "input": input_name,
        "label": str(entry.get("label") or input_name),
        "kind": _KAPP_KIND.get(widget, "text"),
        "widget": widget,
        "default": entry.get("default"),
        "spec": spec,
        "node_type": ctype,
        "node_title": str(entry.get("node_title") or ""),
    }
    if widget == "number":
        for k in ("min", "max", "step"):
            if entry.get(k) is not None:
                item[k] = entry[k]
                item["spec"][k] = entry[k]
        if not item["spec"].get("type"):
            item["spec"]["type"] = "INT"
    if widget == "combo" and isinstance(entry.get("options"), list) and entry["options"]:
        item["spec"]["options"] = entry["options"]
    if widget == "text" and entry.get("multiline"):
        item["multiline"] = True
        item["spec"]["multiline"] = True
    if widget == "image":
        item["source"] = "canvas"          # 与官方格式同语义：默认取 PS 当前画布
        item["spec"].pop("options", None)
        item["spec"].pop("options_truncated", None)
    if widget == "prompt":
        # 用途是复合控件的一部分。kapp 里声明了 usage_options 就以声明为准（打包器本来就会写）：
        # 图像应用不该被迫列出「文生视频」这类自己用不上的用途。只有旧 kapp 没写时才从节点声明现场取。
        usage = str(entry.get("usage_input") or "")
        if usage:
            item["usage_input"] = usage
            uopts = entry.get("usage_options")
            if not (isinstance(uopts, list) and uopts):
                uspec = widget_spec(object_info, ctype, usage)
                uopts = uspec.get("options") if isinstance(uspec, dict) else None
            if isinstance(uopts, list) and uopts:
                item["usage_options"] = [str(x) for x in uopts if str(x)]
            if entry.get("usage_default") is not None:
                item["usage_default"] = entry.get("usage_default")
    if input_name in NOISE_INPUTS:
        item["hidden"] = True              # 管道参数，面板不显示
    return item


def build_kapp_spec(path: str, object_info: dict = None) -> dict:
    """kapp 的面板规格：参数完全按声明来，不推断。"""
    data = _load_kapp(path)
    graph = data["graph"]
    saved = _load_app_state(path)                    # sidecar 保存值覆盖声明里的 default
    if object_info is None and compat.NODE_MAP:
        object_info = build_object_info(sorted({str(v.get("class_type")) for v in graph.values()}))
    params = []
    for entry in (data.get("params") or []):
        if not isinstance(entry, dict):
            continue
        try:
            item = _kapp_param_item(entry, object_info)
        except ValueError as exc:
            raise ValueError("%s（参数 node=%s input=%s）"
                             % (exc, entry.get("node"), entry.get("input")))
        _sk = "%s:%s" % (entry.get("node"), entry.get("input"))
        if _sk in saved:
            item["default"] = saved[_sk]
        if item.get("usage_input"):
            _uk = "%s:%s" % (entry.get("node"), item["usage_input"])
            if _uk in saved:
                item["usage_default"] = saved[_uk]
        params.append(item)

    # 标签去重：与官方格式同一套兜底
    dup = {}
    for p in params:
        if not p.get("hidden"):
            dup[p["label"]] = dup.get(p["label"], 0) + 1
    seq = {}
    for p in params:
        if p.get("hidden"):
            continue
        if dup[p["label"]] > 1:
            seq[p["label"]] = seq.get(p["label"], 0) + 1
            p["label"] = "%s %d" % (p["label"], seq[p["label"]])

    tally = {}
    for p in params:
        if p.get("hidden"):
            continue
        tally[p["kind"]] = tally.get(p["kind"], 0) + 1
    desc = str(data.get("desc") or "").strip() or \
        " · ".join("%d 个%s" % (v, KIND_CN.get(k, k)) for k, v in tally.items()) or "无可调参数"

    stem = paths._stem(os.path.basename(path))
    return {
        "id": stem,
        "name": str(data.get("name") or stem),
        "desc": desc,
        "path": paths._rel(path),
        "params": params,
        "outputs": [str(x) for x in (data.get("outputs") or [])],
        "param_count": sum(1 for p in params if not p.get("hidden")),
        "node_count": len(graph),
        "has_image_input": any(p["kind"] == "image" for p in params),
        "has_subgraph": False,
        "linear_mode": False,
        "format": "kapp",
        "filename": os.path.basename(path),
        "unknown_types": _unknown_types([v.get("class_type") for v in graph.values()]),
    }


def _build_graph_kapp(path: str, values: dict, object_info: dict) -> dict:
    """kapp 取图：graph 已是 API 格式，深拷贝 + 注值即可（无转换）。"""
    data = _load_kapp(path)
    graph = copy.deepcopy(data["graph"])
    if object_info is None and compat.NODE_MAP:
        object_info = build_object_info(sorted({str(v.get("class_type")) for v in graph.values()}))
    applied, skipped, failed = _inject_values(graph, values)
    return {
        "ok": not failed,
        "graph": graph,
        "node_count": len(graph),
        "applied": applied,
        "skipped": skipped,
        "failed": failed,
        "float_notes": [],
        "unknown_types": _unknown_types([v.get("class_type") for v in graph.values()]),
        "path": paths._rel(path),
    }


def build_spec(path: str, object_info: dict = None) -> dict:
    """读一个应用文件，产出面板要用的规格。object_info 省略时自动从节点注册表取。"""
    if os.path.basename(path).lower().endswith(".kapp.json"):
        return build_kapp_spec(path, object_info)
    with open(path, "r", encoding="utf-8") as f:
        wf = json.load(f)
    saved = _load_app_state(path)                    # 面板保存值（sidecar）覆盖工作流默认值

    nodes = wf.get("nodes") or []
    by_id = {str(n.get("id")): n for n in nodes}
    meta = wf.get("extra") or {}
    ld = meta.get("linearData") or {}
    if object_info is None and compat.NODE_MAP:
        object_info = build_object_info(sorted({str(n.get("type")) for n in nodes}))

    # 应用名 = 文件名去掉 .app.json / .json 后缀（ComfyUI 的「应用」列表也是按文件名显示的）
    stem = paths._stem(os.path.basename(path))
    app_id = stem

    params = []
    for entry in (ld.get("inputs") or []):
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            continue
        node_id = _split_ref(entry[0])[0]
        widget = str(entry[1])
        node = by_id.get(str(node_id))
        if node is None:
            continue
        node_type = str(node.get("type") or "")
        wv = _widget_values(node)
        # 默认值必须按控件在 widgets_values 里的真实下标取；wv[0] 会把 seed 当成 steps
        _vi = _widget_index(object_info, node_type, widget) if object_info else None
        default = (wv[_vi] if (_vi is not None and _vi < len(wv))
                   else (wv[0] if len(wv) == 1 else None))
        _sk = "%s:%s" % (node_id, widget)
        if _sk in saved:
            default = saved[_sk]
        kind = _kind_of(node, widget, default)
        item = {
            "node": str(node_id),
            "input": widget,
            "label": _clean_label(node, widget),
            "kind": kind,
            "default": default,
            "spec": widget_spec(object_info, node_type, widget),
            "node_type": node_type,
            "node_title": (node.get("title") or "").strip(),
        }
        if kind == "image":
            item["source"] = "canvas"          # 默认取 PS 当前画布（见设计文档）
            item["spec"].pop("options", None)  # 图像输入由 PS 供给，不需要候选文件名列表
            item["spec"].pop("options_truncated", None)
        if widget in NOISE_INPUTS:
            item["hidden"] = True              # 管道参数，面板不显示
        params.append(item)

    # 标签去重：多个字段同名时自动加序号，免得面板上出现一排一模一样的输入框。
    # （在 ComfyUI 中为节点起有意义的名称可从根本上避免；此处为兜底）
    dup = {}
    for p in params:
        if not p.get("hidden"):
            dup[p["label"]] = dup.get(p["label"], 0) + 1
    seq = {}
    for p in params:
        if p.get("hidden"):
            continue
        base_label = p["label"]
        if dup[base_label] > 1:
            seq[base_label] = seq.get(base_label, 0) + 1
            p["label"] = "%s %d" % (base_label, seq[base_label])

    # 面向人的一句话概述
    tally = {}
    for p in params:
        if p.get("hidden"):
            continue
        tally[p["kind"]] = tally.get(p["kind"], 0) + 1
    desc = " · ".join("%d 个%s" % (v, KIND_CN.get(k, k)) for k, v in tally.items()) \
        or "无可调参数"

    return {
        "id": app_id,
        "name": stem,
        "desc": desc,
        "path": paths._rel(path),
        "params": params,
        "outputs": [str(x) for x in (ld.get("outputs") or [])],
        "param_count": sum(1 for p in params if not p.get("hidden")),
        "node_count": len(nodes),
        "has_image_input": any(p["kind"] == "image" for p in params),
        "has_subgraph": bool((wf.get("definitions") or {}).get("subgraphs")),
        "linear_mode": bool(meta.get("linearMode")),
        "filename": os.path.basename(path),
        "unknown_types": _unknown_in_ui(wf),     # 本机没装的节点：面板载入时就提示，不等运行失败
    }


def list_apps() -> list:
    apps = []
    for p in find_app_files():
        fname = os.path.basename(p)
        fmt = "kapp" if fname.lower().endswith(".kapp.json") else "official"
        try:
            spec = build_spec(p)
        except Exception as e:                       # noqa: BLE001
            # 不静默吞掉：把错误带出去，方便排查
            apps.append({"id": fname, "name": fname, "desc": "", "param_count": 0,
                         "node_count": 0, "has_image_input": False,
                         "linear_mode": False, "filename": fname, "format": fmt,
                         "error": "%s: %s" % (type(e).__name__, e)})
            continue
        item = {k: spec[k] for k in
                ("id", "name", "desc", "param_count", "node_count",
                 "has_image_input", "linear_mode", "filename")}
        item["format"] = fmt
        apps.append(item)
    return apps


def list_kapps() -> list:
    """打包面板的「编辑已有应用」列表：只读 kapp 头信息，不解析参数规格。"""
    out = []
    for p in find_app_files():
        if not p.lower().endswith(".kapp.json"):
            continue
        try:
            data = _load_kapp(p)
        except Exception as e:                       # noqa: BLE001
            out.append({"id": paths._stem(os.path.basename(p)), "name": os.path.basename(p),
                        "file": paths._rel(p), "desc": "", "param_count": 0, "node_count": 0,
                        "error": "%s: %s" % (type(e).__name__, e)})
            continue
        stem = paths._stem(os.path.basename(p))
        out.append({
            "id": stem,
            "name": str(data.get("name") or stem),
            "file": paths._rel(p),
            "desc": str(data.get("desc") or ""),
            "param_count": len(data.get("params") or []),
            "node_count": len(data.get("graph") or {}),
        })
    out.sort(key=lambda x: str(x.get("name") or "").lower())
    return out


def _find_app_path(app_id: str):
    """按 id（去后缀的文件名）或完整文件名找应用；先精确匹配，再大小写不敏感兜底。"""
    files = find_app_files()
    want = str(app_id or "")
    for p in files:
        base = os.path.basename(p)
        if paths._stem(base) == want or base == want:
            return p
    low = want.lower()
    if low:
        for p in files:
            base = os.path.basename(p)
            if paths._stem(base).lower() == low or base.lower() == low:
                return p
    return None


def get_app(app_id: str, object_info: dict = None):
    if not paths._safe_id(app_id):
        return None
    p = _find_app_path(app_id)
    if p is None:
        return None
    return build_spec(p, object_info)


def update_values(app_id: str, values: dict, object_info: dict = None) -> dict:
    """把 {"<节点id>:<控件名>": 值} 持久化到 sidecar 状态文件。

    工作流文件保持只读；这里仍会按 UI/kapp 结构校验节点、输入是否存在、是否连线，
    只把校验通过的值写入 user/default/kedou_app_state/<hash>.json。
    build_spec / build_graph 会自动叠加 sidecar 值，请求里显式传的值优先级更高。
    """
    path = _find_path(app_id)
    if path is None:
        return {"ok": False, "error": "app not found: %s" % app_id}
    try:
        with open(path, "rb") as f:
            original = f.read()
        wf = json.loads(original.decode("utf-8-sig"))
    except Exception as e:                           # noqa: BLE001
        return {"ok": False, "error": "读取工作流失败：%s: %s" % (type(e).__name__, e)}
    if not isinstance(wf, dict):
        return {"ok": False, "error": "工作流文件不是 JSON 对象"}

    changed, failed = [], []
    changed_values = {}
    graph = wf.get("graph")
    is_kapp = isinstance(graph, dict) and not isinstance(wf.get("nodes"), list)

    if is_kapp:
        # kapp（首推格式）：参数值直接住在 API 图的 inputs 里。
        # 旧版只认 nodes，导致 kapp 的每一次回写都报 no such node。
        params_by_key = {}
        for p in (wf.get("params") or []):
            if isinstance(p, dict):
                params_by_key[(str(p.get("node")), str(p.get("input")))] = p
        for key, val in (values or {}).items():
            nid, _, widget = str(key).partition(":")
            node = graph.get(str(nid))
            if not isinstance(node, dict):
                failed.append({"key": key, "why": "no such node"})
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict) or widget not in inputs:
                failed.append({"key": key, "why": "input 不存在"})
                continue
            cur = inputs.get(widget)
            if (isinstance(cur, (list, tuple)) and len(cur) == 2
                    and isinstance(cur[0], (str, int)) and not isinstance(cur[0], bool)):
                failed.append({"key": key, "why": "该输入是连线，不能作为可调参数回写"})
                continue
            inputs[widget] = val
            p = params_by_key.get((str(nid), widget))
            if p is not None:
                p["default"] = val
            changed.append(key)
            changed_values[key] = val
    else:
        nodes = wf.get("nodes") or []
        by_id = {str(n.get("id")): n for n in nodes if isinstance(n, dict)}
        if object_info is None and compat.NODE_MAP:
            object_info = build_object_info(
                sorted({str(n.get("type")) for n in nodes if isinstance(n, dict)}))

        for key, val in (values or {}).items():
            nid, _, widget = str(key).partition(":")
            node = by_id.get(str(nid))
            if node is None:
                failed.append({"key": key, "why": "no such node"})
                continue
            ntype = str(node.get("type") or "")
            idx = _widget_index(object_info, ntype, widget) if object_info else None
            wv = node.get("widgets_values")
            named = node.get("widgets_values_named")
            wrote = False

            # 新版前端可能同时写 widgets_values_named；有就一起更新
            if isinstance(named, dict) and widget in named:
                named[widget] = val
                wrote = True

            if isinstance(wv, dict):
                # 关键：绝不能把整个 dict 替换成 [val]（会把其它控件全清空）
                if widget in wv or idx is not None:
                    wv[widget] = val
                    wrote = True
            elif isinstance(wv, list):
                if idx is None and len(wv) == 1:
                    idx = 0
                if idx is not None:
                    while len(wv) <= idx:
                        wv.append(None)
                    wv[idx] = val
                    wrote = True
            elif wv is None and idx is not None:
                arr = [None] * (idx + 1)
                arr[idx] = val
                node["widgets_values"] = arr
                wrote = True

            if wrote:
                changed.append(key)
                changed_values[key] = val
            else:
                failed.append({"key": key, "why": "cannot locate widget index"})

    state_file = ""
    if changed_values:
        try:
            # 方案 B：工作流文件保持只读，面板值存同名 sidecar。
            # 好处：不产生 .bak、不制造工作流 diff、不会和多端同步/编辑器互相覆盖。
            state_file = _save_app_state(path, changed_values)
        except Exception as e:                       # noqa: BLE001
            return {"ok": False, "error": "状态写入失败：%s: %s" % (type(e).__name__, e),
                    "changed": [], "failed": failed, "path": paths._rel(path)}

    return {"ok": not failed, "changed": changed, "failed": failed, "path": paths._rel(path),
            "persisted": "sidecar",
            "state": paths._rel(state_file) if state_file else ""}

def _find_path(app_id: str):
    return _find_app_path(app_id)

# ------------------------------------------------- 出图：应用 -> 可提交的 API 图
# 分工原则（保持桥接极薄）：
#   桥接只做需要 ComfyUI 内部知识的事 —— 应用发现、参数翻译、界面格式转 API 格式。
#   上传 / 提交 / 取结果全部走 ComfyUI 原生接口，桥接不重复实现：
#     POST /upload/image (multipart, subfolder=ps_upload, overwrite=true)
#     POST /prompt       API 图
#     GET  /history/{id} GET /view

_CONVERTER = None


def _load_converter():
    """按文件路径加载插件根目录的 ui_to_api.py（不依赖 sys.path，也不怕重名）。"""
    global _CONVERTER
    if _CONVERTER is not None:
        return _CONVERTER
    p = os.path.join(paths.PLUGIN_DIR, "ui_to_api.py")
    if not os.path.exists(p):
        return None
    try:
        import importlib.util                      # noqa: PLC0415
        spec = importlib.util.spec_from_file_location("ui_to_api", p)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        _CONVERTER = m
        return m
    except Exception:                              # noqa: BLE001
        return None


def _inject_values(graph: dict, values: dict):
    """把面板值注入 API 图（官方格式与 kapp 共用）。

    连线保护：目标输入当前值是 [节点id, 槽号] 二元组 = 连线，跳过并报告；
    节点不在图 / 没有该输入名 = failed。绝不静默。
    """
    applied, skipped, failed = [], [], []
    for key, val in (values or {}).items():
        nid, _, widget = str(key).partition(":")
        node = graph.get(str(nid))
        if node is None:
            failed.append({"key": key, "why": "节点不在可执行图中（可能被静音/未安装）"})
            continue
        cur = (node.get("inputs") or {}).get(widget, "__MISSING__")
        if cur == "__MISSING__":
            failed.append({"key": key, "why": "该节点没有这个输入名"})
            continue
        if (isinstance(cur, list) and len(cur) == 2 and isinstance(cur[0], str)):
            skipped.append({"key": key, "why": "该输入是连线，不能直接赋值"})
            continue
        node["inputs"][widget] = val
        applied.append(key)
    return applied, skipped, failed


_GRAPH_CACHE = {}
_GRAPH_CACHE_MAX = 64


def _registry_stamp():
    """节点注册表指纹：节点增删（含自定义节点加载）后使转换缓存失效。"""
    try:
        return (id(compat.NODE_MAP), len(compat.NODE_MAP))
    except Exception:                                  # noqa: BLE001
        return (0, 0)


def _cache_get_ui(path: str, object_info):
    """命中返回 (entry, stat)；未命中返回 (None, stat)。显式传 object_info 时不走缓存。"""
    try:
        st = os.stat(path)
    except OSError:
        return None, None
    if object_info is not None:
        return None, st
    key = (st.st_mtime_ns, st.st_size, _registry_stamp())
    hit = _GRAPH_CACHE.get(path)
    if hit is not None and hit[0] == key:
        return hit, st
    return None, st


def _cache_put_ui(path: str, st, graph: dict, notes: list, unknown: dict) -> None:
    key = (st.st_mtime_ns, st.st_size, _registry_stamp())
    if len(_GRAPH_CACHE) >= _GRAPH_CACHE_MAX:
        _GRAPH_CACHE.pop(next(iter(_GRAPH_CACHE)), None)     # 简单 FIFO，够用
    # 缓存不可变底图；每次请求深拷贝后再注值，避免上一次的值污染下一次
    _GRAPH_CACHE[path] = (key, copy.deepcopy(graph), notes, unknown)


def _build_graph_ui(path: str, values: dict, object_info: dict = None) -> dict:
    """UI 格式应用：转换结果按文件/注册表缓存，运行期只深拷贝 + 注值。"""
    conv = _load_converter()
    if conv is None:
        return {"ok": False, "error": "插件目录里缺少 ui_to_api.py"}
    hit, st = _cache_get_ui(path, object_info)
    cache_state = "off"
    if hit is not None:
        _, base_graph, notes, unknown = hit
        graph = copy.deepcopy(base_graph)
        cache_state = "hit"
    else:
        try:
            with open(path, "r", encoding="utf-8") as f:
                wf = json.load(f)
        except Exception as e:                         # noqa: BLE001
            return {"ok": False, "error": "读取工作流失败：%s: %s"
                                         % (type(e).__name__, e)}
        nodes = wf.get("nodes") or []
        oi = object_info
        if oi is None and compat.NODE_MAP:
            oi = build_object_info(sorted({str(n.get("type")) for n in nodes}))
        graph, notes = conv.convert_ex(wf, oi or {})
        unknown = _unknown_in_ui(wf)
        if object_info is None:
            cache_state = "miss"
            try:
                st2 = os.stat(path)
                if st is not None and (st2.st_mtime_ns, st2.st_size) == (st.st_mtime_ns, st.st_size):
                    _cache_put_ui(path, st2, graph, notes, unknown)
            except OSError:
                pass

    applied, skipped, failed = _inject_values(graph, values)
    return {
        "ok": not failed,
        "graph": graph,
        "node_count": len(graph),
        "applied": applied,
        "skipped": skipped,
        "failed": failed,
        "float_notes": notes,                       # 子图展开说明
        "unknown_types": unknown,                   # 疑似未安装的节点
        "path": paths._rel(path),
        "cache": cache_state,
    }


def build_graph(app_id: str, values: dict = None, object_info: dict = None) -> dict:
    """
    把应用转成可直接 POST /prompt 的 API 图，并注入面板值。
    values 形如 {"33:prompt": "文本", "119:value": 2, "114:image": "ps_upload/x.png"}。
    持久化值从 sidecar 读取，请求里的 values 优先。
    """
    path = _find_path(app_id)
    if path is None:
        return {"ok": False, "error": "app not found: %s" % app_id}
    merged = _load_app_state(path)
    if values:
        merged.update(values)
    if _is_kapp(path):
        return _build_graph_kapp(path, merged, object_info)
    return _build_graph_ui(path, merged, object_info)

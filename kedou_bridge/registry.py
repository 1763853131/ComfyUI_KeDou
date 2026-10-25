# -*- coding: utf-8 -*-
"""ComfyUI 节点注册表适配：object_info、控件声明顺序与控件规格。"""

from . import compat
from .common import OPTIONS_CAP


def build_object_info(types) -> dict:
    """
    从 ComfyUI 自己的节点注册表取输入声明（不必走 HTTP）。
    返回结构与 /object_info 一致：{type: {"input": {required, optional}, "output": [...]}}
    output = RETURN_TYPES（打包校验连线槽号要用）。
    """
    if not compat.NODE_MAP:
        return {}
    out = {}
    for t in types:
        cls = compat.NODE_MAP.get(t)
        if cls is None:
            continue
        try:
            it = cls.INPUT_TYPES()
        except Exception:                            # noqa: BLE001
            continue
        try:
            rt = [str(x) for x in (cls.RETURN_TYPES or ())]
        except Exception:                            # noqa: BLE001
            rt = []
        out[t] = {"input": {"required": it.get("required", {}) or {},
                            "optional": it.get("optional", {}) or {}},
                  "output": rt}
    return out


# 只在前端存在的节点：API 图里没有它们，也不该报成「缺节点」
_FRONT_ONLY = {"PrimitiveNode", "Reroute", "Note", "MarkdownNote", "__Reroute"}


def _unknown_types(types, extra_ok=()) -> dict:
    """本机节点注册表里查不到的类型 → {type: 出现次数}。注册表还没就绪时返回 {}（不误报）。"""
    if not compat.NODE_MAP:
        return {}
    ok = _FRONT_ONLY | set(str(x) for x in extra_ok)
    unk = {}
    for t in types:
        t = str(t)
        if t in ok or t in compat.NODE_MAP:
            continue
        unk[t] = unk.get(t, 0) + 1
    return unk


def _unknown_in_ui(wf: dict) -> dict:
    """UI 格式工作流：跳过静音/旁路节点与子图本身。"""
    nodes = wf.get("nodes") or []
    sub_ids = set(str(s.get("id")) for s in
                  ((wf.get("definitions") or {}).get("subgraphs") or []))
    return _unknown_types([str(n.get("type")) for n in nodes
                           if int(n.get("mode", 0)) == 0], sub_ids)


# ---------------------------------------------------------------- 控件下标
# BOUNDING_BOX / BOUNDING_BOXES：「创建边界框」节点的框选控件（comfy_api 的 io 类型）。
# 它们是**会序列化进 widgets_values 的控件**，不列进来就会整体错位 ——
# 之前漏了这两种，editor_state 被当成纯输入过滤掉，打包面板上这个节点只剩
# 「高度」「数字」两个参数（2026-10-26 用户报的正是这个）。
_WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO",
                 "BOUNDING_BOX", "BOUNDING_BOXES"}


def _is_widget_spec(spec) -> bool:
    # 注意：ComfyUI 的 INPUT_TYPES() 惯例返回元组 ("STRING", {...})，
    # 只有经 /object_info 走 JSON 序列化后才变成列表。两种都要认 ——
    # 只认 list 的话，服务端构建 object_info 时会把所有控件判为无效，
    # 静默退化成 STRING（表现为：数值框变成单行文本、multiline 丢失）。
    if not isinstance(spec, (list, tuple)) or not spec:
        return False
    t = spec[0]
    if isinstance(t, (list, tuple)):
        return True          # 内联下拉选项
    if isinstance(t, str):
        return t in _WIDGET_TYPES or t.startswith("COMBO")
    return False


def _declared_widgets(object_info: dict, class_type: str) -> list:
    """按声明顺序返回该类型的控件名（与 widgets_values 位置对齐）。"""
    info = (object_info or {}).get(class_type)
    if not info:
        return []
    declared = info.get("input", {})
    names = []
    for section in ("required", "optional"):
        for nm, spec in (declared.get(section) or {}).items():
            if _is_widget_spec(spec):
                names.append(nm)
    return names


def _ctl_after_gen(object_info: dict, class_type: str, name: str) -> bool:
    info = (object_info or {}).get(class_type)
    if not info:
        return False
    for section in ("required", "optional"):
        spec = (info.get("input", {}).get(section) or {}).get(name)
        if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict):
            return bool(spec[1].get("control_after_generate"))
    return False


def _widget_index(object_info: dict, class_type: str, name: str):
    names = _declared_widgets(object_info, class_type)
    if name not in names:
        return None
    idx = 0
    for n in names:
        if n == name:
            return idx
        idx += 1
        if _ctl_after_gen(object_info, class_type, n):
            idx += 1
    return None


# ------------------------------------------------- 控件规格（通用，零应用定制）
#
# 设计原则：插件是纯通道。
#   应用由任何人用 ComfyUI 的 App Builder 搭好，接上就能用；
#   不允许出现"针对某个应用/某个特定节点"的特判（那等于插件作者在替别人接线）。
#
# 所以这里只做类型驱动的通用推断：控件长什么样，完全由节点自己声明的规格决定。
# 面板怎么画（文本框/滑杆/下拉/分段选择器）属于"呈现"，归 PS 侧按 spec 自行决定。


def _find_spec(object_info: dict, class_type: str, name: str):
    """在 object_info 里取出某类型某控件的 (声明类型, 选项字典)。"""
    info = (object_info or {}).get(class_type)
    if not info:
        return None, {}
    for section in ("required", "optional"):
        spec = (info.get("input", {}).get(section) or {}).get(name)
        if isinstance(spec, (list, tuple)) and spec:
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            return spec[0], opts
    return None, {}


def widget_spec(object_info: dict, class_type: str, name: str) -> dict:
    """
    给面板用的控件规格，完全由节点声明推导：
      {"type": "INT|FLOAT|STRING|COMBO|BOOLEAN|…",
       "min","max","step","options","multiline","range_size"}
    range_size 只在能算出来时给（面板可用它决定是否渲染成分段选择器）。
    """
    first, opts = _find_spec(object_info, class_type, name)
    out = {"type": "STRING"}
    if isinstance(first, list):
        out["type"] = "COMBO"
        vals = [str(x) for x in first]
        if len(vals) > OPTIONS_CAP:
            vals = vals[:OPTIONS_CAP]
            out["options_truncated"] = True
        out["options"] = vals
    elif isinstance(first, str):
        out["type"] = first
        # 自定义类型名也可能带选项列表（如 ResolutionSelector 的 aspect_ratio）：
        # 有 choices/options 就一并给出，避免下拉在应用中退化为输入框
        ch = opts.get("choices") or opts.get("options")
        if isinstance(ch, (list, tuple)) and ch:
            vals = [str(x) for x in ch]
            if len(vals) > OPTIONS_CAP:
                vals = vals[:OPTIONS_CAP]
                out["options_truncated"] = True
            out["options"] = vals
    for k in ("min", "max", "step"):
        if isinstance(opts.get(k), (int, float)):
            out[k] = opts[k]
    if isinstance(opts.get("multiline"), bool):
        out["multiline"] = opts["multiline"]
    if out["type"] in ("INT", "FLOAT") and "min" in out and "max" in out:
        step = out.get("step") or (1 if out["type"] == "INT" else 0.01)
        try:
            out["range_size"] = int(round((out["max"] - out["min"]) / step)) + 1
        except Exception:                            # noqa: BLE001
            pass
    return out

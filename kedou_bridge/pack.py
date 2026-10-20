# -*- coding: utf-8 -*-
"""应用打包：候选清单、UI→API 打包、kapp 校验与落盘。"""

import json
import os
import re
import urllib.parse
import uuid

from . import apps, compat, paths
from .common import (_clean_label, _dom_handle, _panel_widget, _ref_parts,
                     _widget_values)
from .registry import (build_object_info, widget_spec, _ctl_after_gen,
                       _declared_widgets, _find_spec, _widget_index)
from .state import _load_app_state


def _find_workflow_file(name: str):
    """按文件名或 stem 在 paths.WORKFLOW_DIR 里找工作流（打包的 source）。"""
    want = os.path.basename(str(name or ""))
    if not want or not paths._safe_id(want):
        return None
    stem = paths._stem(want).lower()
    for r, _dirs, files in os.walk(paths.WORKFLOW_DIR):
        for fn in files:
            if fn == want or paths._stem(fn).lower() == stem:
                return os.path.join(r, fn)
    return None


def _prompt_usage_of(class_type: str, name: str) -> str:
    """提示词主体输入 -> 同节点里承载「用途」的输入名（不是提示词主体则返回空串）。

    这是「提示词框」复合控件的唯一约定：打包时它俩合成一条参数，
    类别单独列出来没有意义（用途只用于词库筛选）。只认本家节点，
    与上面 KedouImageLoader / LoadImage 两处品牌特判同性质。
    """
    if class_type == "KedouPromptBox" and name == "prompt_state":
        return "usage"
    return ""


def _ui_widget_names(node: dict) -> list:
    """UI 工作流里声明为控件的输入名（含 frontend-only 节点）；socket 输入没有 widget 键。"""
    out = []
    for inp in (node.get("inputs") if isinstance(node, dict) else None) or []:
        if not isinstance(inp, dict):
            continue
        w = inp.get("widget") if isinstance(inp.get("widget"), dict) else None
        name = str((w or {}).get("name") or "")
        if name and name not in out:
            out.append(name)
    return out


def _suggest_widget(object_info: dict, class_type: str, name: str, node: dict = None) -> str:
    """打包候选的建议 widget（按节点声明推断，仅几处品牌特判：本家节点）。
    自定义类型名不按名称推断：声明 cfg 里带 choices/options 选项列表的即为下拉 ——
    判为 text 会使应用中的下拉退化为输入框（ResolutionSelector 的 aspect_ratio 即如此）。"""
    if class_type == "KedouImageLoader" and name == "media_state":
        return "kedou_media"
    if class_type == "LoadImage" and name == "image":
        return "image"
    if _prompt_usage_of(class_type, name):
        return "prompt"
    decl, cfg = _find_spec(object_info, class_type, name)
    if decl in ("INT", "FLOAT"):
        return "number"
    if decl == "BOOLEAN":
        return "toggle"
    if decl == "COMBO":
        return "combo"
    if isinstance(cfg, dict):
        ch = cfg.get("choices") or cfg.get("options")
        if isinstance(ch, (list, tuple)) and ch:
            return "combo"
    # 注册表里查不到（前端节点/子图）时，退回 UI 工作流里的输入声明
    for inp in (node.get("inputs") if isinstance(node, dict) else None) or []:
        if not isinstance(inp, dict) or str(inp.get("name") or "") != name:
            continue
        t = str(inp.get("type") or "").upper()
        if t in ("INT", "FLOAT"):
            return "number"
        if t == "BOOLEAN":
            return "toggle"
        if t == "COMBO":
            return "combo"
        if t == "STRING":
            return "text"
        break
    return "text"


def pack_candidates(source: str) -> dict:
    """GET /ps/pack/candidates —— 列出 UI 工作流里全部可暴露的控件候选。"""
    path = _find_workflow_file(source)
    if path is None:
        return {"ok": False, "error": "找不到工作流文件：%s" % source}
    with open(path, "r", encoding="utf-8") as f:
        wf = json.load(f)
    saved = _load_app_state(path)
    nodes = [n for n in (wf.get("nodes") or []) if int(n.get("mode", 0)) == 0]
    if not nodes:
        return {"ok": False, "error": "该文件不是 UI 格式工作流（没有 nodes）"}
    object_info = build_object_info(sorted({str(n.get("type")) for n in nodes})) if compat.NODE_MAP else {}
    out = []
    for node in nodes:
        ctype = str(node.get("type") or "")
        wv = _widget_values(node)
        names = _declared_widgets(object_info, ctype) or _ui_widget_names(node)
        # 被「提示词框」吸收的输入不再单独列为候选（否则应用里会出现两个用途下拉）
        absorbed = set()
        for nm in names:
            u = _prompt_usage_of(ctype, nm)
            if u:
                absorbed.add(u)
        vi = 0
        for name in names:
            default = wv[vi] if vi < len(wv) else None
            _sk = "%s:%s" % (node.get("id"), name)
            if _sk in saved:
                default = saved[_sk]
            vi += 1
            if _ctl_after_gen(object_info, ctype, name):
                vi += 1                     # control_after_generate 隐藏格
            if name in absorbed:
                continue
            widget = _suggest_widget(object_info, ctype, name, node)
            item = {
                "node": str(node.get("id")),
                "input": name,
                "label": _clean_label(node, name),
                "node_type": ctype,
                "widget": widget,
                "default": default,
            }
            usage = _prompt_usage_of(ctype, name)
            if usage:
                item["usage_input"] = usage
                uspec = widget_spec(object_info, ctype, usage)
                if isinstance(uspec.get("options"), list) and uspec["options"]:
                    item["usage_options"] = uspec["options"]
                uvi = _widget_index(object_info, ctype, usage)
                udef = wv[uvi] if (uvi is not None and uvi < len(wv)) else None
                _usk = "%s:%s" % (node.get("id"), usage)
                if _usk in saved:
                    udef = saved[_usk]
                item["usage_default"] = udef
            out.append(item)
    return {"ok": True, "source": os.path.basename(path), "candidates": out}


def _param_value(node, object_info, ctype, name, saved=None, nid=""):
    """控件当前值：优先 widgets_values_named（位置对位会错），退回按声明下标。"""
    named = node.get("widgets_values_named") if isinstance(node, dict) else None
    if isinstance(named, dict) and name in named:
        val = named[name]
    else:
        wv = _widget_values(node) if isinstance(node, dict) else []
        vi = _widget_index(object_info, ctype, name) if object_info else None
        val = wv[vi] if (vi is not None and vi < len(wv)) else None
    _sk = "%s:%s" % (nid, name)
    if saved and _sk in saved:
        val = saved[_sk]
    return val


def _build_kapp(wf, decls, name, desc, saved, object_info=None):
    """UI 工作流 + 参数声明 -> kapp 内容（不落盘）。

    pack_app（按文件打包）与 kapp_from_linear（按 App Builder 勾选打包）共用一套：
    同一张图、同一批声明，出来的包必须一模一样。
    """
    conv = apps._load_converter()
    if conv is None:
        return {"ok": False, "error": "插件目录里缺少 ui_to_api.py"}
    nodes = wf.get("nodes") or []
    by_id = {str(n.get("id")): n for n in nodes}
    if object_info is None:
        object_info = (build_object_info(sorted({str(n.get("type")) for n in nodes}))
                       if compat.NODE_MAP else {})
    try:
        graph, _notes = conv.convert_ex(wf, object_info or {})
    except Exception as e:                       # noqa: BLE001
        return {"ok": False, "error": "UI→API 转换失败：%s: %s" % (type(e).__name__, e)}
    # 完整性校验（与 save_kapp 同一标准）：转换后的图 + 勾选参数一起验，坏包不落盘
    warns = []
    vinfo = object_info or build_object_info(sorted({str(v.get("class_type")) for v in graph.values()}))
    if vinfo:
        errs, warns = _kapp_validate(graph, decls, vinfo)
        if errs:
            head = errs[:8]
            more = "" if len(errs) <= 8 else "（另有 %d 个问题）" % (len(errs) - 8)
            return {"ok": False,
                    "error": "打包图完整性校验未通过，共 %d 个问题：%s%s"
                             % (len(errs), "；".join(head), more)}

    kparams = []
    for p in decls:
        node_id = str(p.get("node"))
        input_name = str(p.get("input"))
        widget = str(p.get("widget") or "text")
        node = by_id.get(node_id)
        ctype = str((node or {}).get("type") or "")
        default = _param_value(node, object_info, ctype, input_name, saved, node_id)
        if node:
            label = str(p.get("label") or _clean_label(node, input_name))
        else:
            label = str(p.get("label") or input_name)
        spec = widget_spec(object_info, ctype, input_name)
        item = {
            "node": node_id,
            "input": input_name,
            "label": label,
            "widget": widget,
            "default": default,
            "node_type": ctype,
            "node_title": ((node.get("title") or "").strip() if node else ""),
        }
        if widget == "number":
            item["min"] = spec.get("min")
            item["max"] = spec.get("max")
            item["step"] = spec.get("step")
        if widget == "combo":
            item["options"] = spec.get("options") or []
        if widget == "text" and spec.get("multiline"):
            item["multiline"] = True
        if widget == "prompt":
            usage = str(p.get("usage_input") or "")
            if not usage and node:
                # 手写参数的兜底：同节点声明了 usage 就吸收进来
                names = _declared_widgets(object_info, ctype)
                if "usage" in names:
                    usage = "usage"
            if usage and node:
                item["usage_input"] = usage
                item["usage_default"] = _param_value(node, object_info, ctype, usage, saved, node_id)
                uspec = widget_spec(object_info, ctype, usage)
                if isinstance(uspec.get("options"), list) and uspec["options"]:
                    item["usage_options"] = uspec["options"]
        kparams.append(item)

    outputs = [nid for nid, node in graph.items()
               if "save" in str(node.get("class_type", "")).lower()]
    kapp = {
        "kedou_app": 1,
        "name": str(name),
        "desc": str(desc or ""),
        "graph": graph,
        "params": kparams,
        "outputs": outputs,
    }
    return {"ok": True, "kapp": kapp, "graph": graph, "params": kparams,
            "outputs": outputs, "warnings": warns}


def pack_app(source: str, params: list, name: str = None, desc: str = "") -> dict:
    """POST /ps/pack —— UI 工作流 + 勾选参数 -> 生成 <stem>.kapp.json（与 source 同目录）。"""
    path = _find_workflow_file(source)
    if path is None:
        return {"ok": False, "error": "找不到工作流文件：%s" % source}
    decls = []
    for p in (params or []):
        if not isinstance(p, dict):
            continue
        widget = str(p.get("widget") or "text")
        if widget not in apps._KAPP_WIDGETS:
            return {"ok": False, "error": "未知 widget 类型：%s" % widget}
        if not str(p.get("node") or "") or not str(p.get("input") or ""):
            return {"ok": False, "error": "参数缺少 node 或 input"}
        decls.append(p)
    if not decls:
        return {"ok": False, "error": "没有勾选任何参数"}
    with open(path, "r", encoding="utf-8") as f:
        wf = json.load(f)
    saved = _load_app_state(path)                    # 打包时也带上面板保存值
    stem = paths._stem(os.path.basename(path))
    built = _build_kapp(wf, decls, name or stem, desc, saved)
    if not built["ok"]:
        return built
    out_path = os.path.join(os.path.dirname(path), stem + ".kapp.json")
    try:
        paths._dump_json_atomic(out_path, built["kapp"], indent=1)
    except Exception as e:                       # noqa: BLE001
        return {"ok": False, "error": "写入失败：%s" % e}
    return {"ok": True, "file": paths._rel(out_path), "param_count": len(built["params"]),
            "node_count": len(built["graph"]), "outputs": built["outputs"],
            "warnings": built["warnings"]}


def kapp_from_linear(name, workflow, desc: str = "", target: str = None,
                     object_info: dict = None) -> dict:
    """App Builder 的勾选结果 -> kapp（POST /ps/pack/linear）。

    官方构建器已经把「哪些参数、什么顺序、什么显示名」全定好了，kapp 不缺任何信息，
    所以这里不需要人再勾一遍：linearData.inputs 逐条换成 kapp 的 params，
    outputs 用 linearData.outputs，图用同一张 UI 图转 API。
    """
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
        return {"ok": False, "error": "workflow 必须是 UI 格式工作流（画布序列化结果）"}
    linear = ((workflow.get("extra") or {}).get("linearData")) or {}
    entries = [e for e in (linear.get("inputs") or []) if isinstance(e, (list, tuple)) and len(e) >= 2]
    if not entries:
        return {"ok": False, "error": "App Builder 里还没有勾选输入：先在画布上点要暴露的参数"}
    nid_order = [str(x) for x in (linear.get("outputs") or []) if str(x)]
    if not nid_order:
        return {"ok": False, "error": "App Builder 里还没有勾选输出节点"}
    nodes = workflow["nodes"]
    by_id = {str(n.get("id")): n for n in nodes if isinstance(n, dict)}
    if object_info is None:
        object_info = (build_object_info(sorted({str(n.get("type")) for n in nodes}))
                       if compat.NODE_MAP else {})
    decls, errs = [], []
    for entry in entries:
        node_id, ref_name, stored = _ref_parts(entry)
        node = by_id.get(str(node_id))
        if node is None:
            errs.append("输入指向的节点 %s 不在工作流里" % node_id)
            continue
        ctype = str(node.get("type") or "")
        widget_name = _panel_widget(ctype, ref_name)      # DOM 把手 -> 真实控件
        label = _clean_label(node, widget_name)
        if stored and stored not in (widget_name, ref_name):
            label = stored                                # 构建器里改过的名字
        descr = ""
        if len(entry) > 2 and isinstance(entry[2], dict):
            descr = str(entry[2].get("description") or "").strip()
        decl = {"node": str(node_id), "input": widget_name, "label": label,
                "widget": _suggest_widget(object_info, ctype, widget_name, node)}
        if descr:
            decl["desc"] = descr
        decls.append(decl)
    if errs:
        return {"ok": False, "error": "；".join(errs[:8])}

    raw = str(name or "").strip()
    if target:
        out_path = _resolve_pack_target(target)
        if out_path is None:
            return {"ok": False, "error": "目标路径不合法（必须是工作流目录内的 .kapp.json）：%s" % target}
        stem = paths._stem(os.path.basename(out_path))
        out_dir = os.path.dirname(out_path)
    else:
        if not raw:
            return {"ok": False, "error": "应用名不能为空"}
        if not paths._safe_id(raw):
            return {"ok": False, "error": "应用名含非法字符（不能含 / \\ .. 或 :）"}
        stem = paths._stem(raw)
        if stem.lower().endswith(".kapp"):
            stem = stem[: -len(".kapp")]
        if not stem:
            return {"ok": False, "error": "应用名清洗后为空（请换个名字）"}
        out_dir = paths.WORKFLOW_DIR
        out_path = os.path.join(out_dir, stem + ".kapp.json")

    built = _build_kapp(workflow, decls, raw or stem, desc, {}, object_info)
    if not built["ok"]:
        return built
    kapp = built["kapp"]
    # 输出节点以构建器勾的为准（kapp 里就是这些节点 id），不在图里的直接拦下
    missing = [x for x in nid_order if x not in built["graph"]]
    if missing:
        return {"ok": False, "error": "输出节点 %s 不在可执行图里（可能没装或画布上删了）"
                                      % "、".join(missing)}
    kapp["outputs"] = nid_order

    try:
        os.makedirs(out_dir, exist_ok=True)
    except Exception as e:                        # noqa: BLE001
        return {"ok": False, "error": "工作流目录不可写：%s" % e}
    if not paths._under(out_dir, out_path):
        return {"ok": False, "error": "应用名解析后落在工作流目录之外，已拒绝写入：%s" % name}
    try:
        paths._dump_json_atomic(out_path, kapp, indent=1)
    except Exception as e:                       # noqa: BLE001
        return {"ok": False, "error": "写入失败：%s" % e}
    return {"ok": True, "id": stem, "file": paths._rel(out_path),
            "target": _pack_target(out_path), "param_count": len(built["params"]),
            "node_count": len(built["graph"]), "outputs": nid_order,
            "warnings": built["warnings"], "edited": bool(target)}

# ---------------------------------------------------------------- kapp 打包面板专用（只校验 + 落盘）
#
# 与 pack_app（按文件名读取 UI 工作流、服务端做 UI→API 转换）不同，这个入口给
# 「打包成应用」前端面板用：面板已经用 app.graphToPrompt() 拿到 API 格式图，
# 直接把成品 kapp 发过来。所以这里只做校验 + 落盘，不再翻译、不再碰工作流文件。
# 桥接仍是纯通道：声明是什么就是什么，不针对任何应用做特判。

def _kapp_validate(graph: dict, params: list, object_info: dict):
    """kapp 落盘前的完整性校验（打包面板 / 服务端打包共用）。返回 (errs, warns)。

    errs = 确定性的坏包，落盘前拦截；warns = 只是可能有问题，允许打包。
    拦截的（与 ComfyUI 自己的 prompt 校验同标准，运行时必挂）：
      1. 节点类型未注册；
      2. 连线指向不存在的节点 / 槽号越界；
      3. 参数勾在了悬空连线上（运行时注值必失败）。
    降级为提醒的（2026-09-28，用户实测 TextEncodeQwenImageEdit21 的 images 不连也能跑）：
      「缺必需输入」——很多节点对缺失输入有默认值或容错，打包时静态判断不了运行时行为，
      一刀切会误伤（ComfyUI 运行时自己会给出权威报错，到时再连也不迟）。
    """
    errs = []
    warns = []
    # 1) 节点类型必须已注册
    for nid, node in graph.items():
        ct = str(node.get("class_type") or "")
        if ct not in object_info:
            errs.append("节点 %s（%s）的类型未注册（插件没装或没重启生效）" % (nid, ct or "?"))
    # 2) 逐节点：连线目标存在、槽号合法；缺必需输入降级为提醒
    for nid, node in graph.items():
        ct = str(node.get("class_type") or "")
        info = object_info.get(ct)
        if not info:
            continue
        inputs = node.get("inputs") or {}
        for k, v in inputs.items():
            if (isinstance(v, (list, tuple)) and len(v) == 2
                    and isinstance(v[0], (str, int)) and not isinstance(v[0], bool)
                    and not isinstance(v[1], bool)):
                up = graph.get(str(v[0]))
                if up is None:
                    errs.append("节点 %s 的输入 %s 连到不在图里的节点 %s（画布上删了上游？）" % (nid, k, v[0]))
                    continue
                upct = str(up.get("class_type") or "")
                outs = object_info.get(upct, {}).get("output") or []
                slot = v[1]
                if outs and (not isinstance(slot, int) or slot < 0 or slot >= len(outs)):
                    errs.append("节点 %s 的输入 %s 连到 %s 的槽 %s，但该类型只有 %d 个输出"
                                % (nid, k, v[0], slot, len(outs)))
        req = (info.get("input") or {}).get("required") or {}
        for wname, spec in req.items():
            if wname in inputs:
                continue
            if not (isinstance(spec, (list, tuple)) and spec):
                continue        # 声明解析不了的不强求，避免自造误报
            warns.append("节点 %s（%s）缺输入 %s —— 多数节点能容错；若运行时报缺这个输入，"
                         "回画布连上再重新打包一次" % (nid, ct, wname))
    # 3) 参数必须指向图中真实存在的「普通输入」（不能是连线）
    for p in (params or []):
        if not isinstance(p, dict):
            continue
        nid = str(p.get("node") or "")
        wname = str(p.get("input") or "")
        shown = str(p.get("label") or wname)
        node = graph.get(nid)
        if node is None:
            errs.append("参数「%s」指向的节点 %s 不在打包图里" % (shown, nid))
            continue
        node_inputs = node.get("inputs") or {}
        val = node_inputs.get(wname)
        if wname not in node_inputs:
            errs.append("参数「%s」（%s:%s）不在打包图里 —— 画布上该输入是悬空连线，回画布修复后重新打包"
                        % (shown, nid, wname))
        elif isinstance(val, (list, tuple)) and len(val) == 2:
            errs.append("参数「%s」（%s:%s）在画布上是连线（来自节点 %s），不能作为可调参数；"
                        "要暴露它请在画布上把该输入转回普通输入（右键节点 → 转换为输入的反向操作）后重新打包"
                        % (shown, nid, wname, val[0]))
        # 提示词框的用途子输入：缺了或本身是连线，应用里选用途不会生效（不拦打包，只提醒）
        if str(p.get("widget") or "") == "prompt":
            usage = str(p.get("usage_input") or "")
            if usage:
                uval = node_inputs.get(usage)
                if usage not in node_inputs:
                    warns.append("参数「%s」（%s）声明的用途输入 %s 不在图里 —— "
                                 "应用里仍可输入提示词，但用途选择不会生效" % (shown, nid, usage))
                elif isinstance(uval, (list, tuple)) and len(uval) == 2:
                    warns.append("参数「%s」（%s）的用途输入 %s 在画布上是连线 —— "
                                 "应用里改用途会覆盖这条连线" % (shown, nid, usage))
    return errs, warns


def _pack_target(path: str) -> str:
    """打包面板回写用的 target：相对工作流目录的路径（跨盘符时退回绝对路径，前端会原样传回）。

    不能直接用 paths._rel()：那是相对 ComfyUI 根的路径，用户目录被 --user-directory
    指到别处时两者对不上，回写会落到错误的目录。
    """
    try:
        return os.path.relpath(path, paths.WORKFLOW_DIR).replace("\\", "/")
    except Exception:                                # noqa: BLE001
        return str(path).replace("\\", "/")


def _resolve_pack_target(target: str):
    """打包面板回写目标：工作流目录内的相对路径。"""
    t = str(target or "").strip().replace("\\", "/")
    if not t or "\x00" in t or t.startswith("/") or re.match(r"^[A-Za-z]:", t):
        return None
    parts = [p for p in t.split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts):
        return None
    path = os.path.join(paths.WORKFLOW_DIR, *parts)
    if not paths._under(paths.WORKFLOW_DIR, path) or not path.lower().endswith(".kapp.json"):
        return None
    return path


def save_kapp(name: str, desc, kapp, target: str = None) -> dict:
    """kapp 打包面板专用（POST /ps/pack/save）。

    校验 + 落盘：
      * kapp 必须是 dict，且 kedou_app == 1；
      * graph 必须是非空 dict（API 格式工作流）；
      * params 必须是 list，且每一条 widget 在 apps._KAPP_WIDGETS 内；
      * name 经 _safe_id 防穿越 + _stem 去 .kapp.json/.app.json/.json 后缀清洗；
      * 写前用 _under（realpath + commonpath）复核最终路径仍落在工作流目录内；
      * 新建：<工作流目录>/<stem>.kapp.json；
        编辑：target 指定已有 .kapp.json（同样必须在 paths.WORKFLOW_DIR 内），原文件回写。
    不合法如实返回中文错误，绝不静默。
    """
    if not isinstance(kapp, dict):
        return {"ok": False, "error": "kapp 必须是对象（需含 kedou_app / graph / params）"}
    try:
        _ver = int(kapp.get("kedou_app") or 0)
    except (TypeError, ValueError):
        _ver = 0
    if _ver != 1:
        return {"ok": False, "error": "kedou_app 必须为 1（不是合法的 kapp 包）"}
    graph = kapp.get("graph")
    if not isinstance(graph, dict) or not graph:
        return {"ok": False, "error": "graph 必须是非空的 API 格式工作流"}
    params = kapp.get("params")
    if not isinstance(params, list):
        return {"ok": False, "error": "params 必须是列表"}
    for i, p in enumerate(params):
        if not isinstance(p, dict):
            return {"ok": False, "error": "第 %d 个参数不是对象" % (i + 1)}
        widget = str(p.get("widget") or "text")
        if widget not in apps._KAPP_WIDGETS:
            return {"ok": False, "error": "第 %d 个参数 widget 非法：%s（允许：%s）"
                    % (i + 1, widget, "、".join(apps._KAPP_WIDGETS))}
        if widget == "prompt":
            usage = p.get("usage_input")
            if usage is not None and not isinstance(usage, str):
                return {"ok": False, "error": "第 %d 个参数的 usage_input 必须是字符串" % (i + 1)}
    raw = str(name or "").strip()
    if not raw:
        return {"ok": False, "error": "应用名不能为空"}
    if not paths._safe_id(raw):
        return {"ok": False, "error": "应用名含非法字符（不能含 / \\ .. 或 :）"}
    stem = paths._stem(raw)
    if stem.lower().endswith(".kapp"):           # 兜底：用户误带 .kapp 后缀
        stem = stem[: -len(".kapp")]
    if not stem:
        return {"ok": False, "error": "应用名清洗后为空（请换个名字）"}
    warns = []
    # 完整性校验：坏图坚决不落盘，把问题在人能看懂的地方说清楚
    vinfo = build_object_info(sorted({str(v.get("class_type")) for v in graph.values()})) if compat.NODE_MAP else {}
    if vinfo:
        errs, warns = _kapp_validate(graph, params, vinfo)
        if errs:
            head = errs[:8]
            more = "" if len(errs) <= 8 else "（另有 %d 个问题）" % (len(errs) - 8)
            return {"ok": False,
                    "error": "打包图完整性校验未通过，共 %d 个问题：%s%s"
                             % (len(errs), "；".join(head), more)}
    if target:
        out_path = _resolve_pack_target(target)
        if out_path is None:
            return {"ok": False, "error": "目标应用路径不合法（必须是工作流目录内的 .kapp.json）：%s"
                                          % target}
        out_dir = os.path.dirname(out_path)
    else:
        out_dir = paths.WORKFLOW_DIR
        out_path = os.path.join(out_dir, stem + ".kapp.json")
    try:
        os.makedirs(out_dir, exist_ok=True)
    except Exception as e:                        # noqa: BLE001
        return {"ok": False, "error": "工作流目录不可写：%s" % e}
    if not paths._under(out_dir, out_path):              # 落盘前按真实路径复核，绝不出工作流目录
        return {"ok": False, "error": "应用名解析后落在工作流目录之外，已拒绝写入：%s" % name}
    try:
        paths._dump_json_atomic(out_path, kapp, indent=1)
    except Exception as e:                        # noqa: BLE001
        return {"ok": False, "error": "写入失败：%s" % e}
    return {"ok": True, "file": paths._rel(out_path), "target": _pack_target(out_path),
            "param_count": len(params), "node_count": len(graph), "warnings": warns,
            "edited": bool(target)}


# ---------------------------------------------------------------- 官方应用（.app.json）
#
# 官方 App Mode 的「应用」就是 UI 工作流本身 + extra 里的两个字段（前端 1.55 的 appMode store）：
#   extra.linearMode = true
#   extra.linearData = {"inputs": [["<图id>:<节点id>:<控件名>", "<显示名>", {...}?]],
#                       "outputs": ["<节点id>"]}
# 第一段就是工作流顶层的 "id"（uuid），三段都走 encodeURIComponent；
# 可选的第三段是 {description, height}，由 App Builder 自己写，这里不碰。
#
# 与 kapp 的根本差别：官方应用保留整张 **UI 图**（位置、连线、控件值都在里面），
# 所以只能从画布序列化结果生成 —— API 图反推不回 UI 图，kapp 也就无法直接转官方包。
# 好处是同一个文件既能被本插件读，也能被 ComfyUI 自己的 Apps 侧栏打开。

# encodeURIComponent 不转义的那批字符
_ENCODE_SAFE = "-_.!~*'()"


def _app_widget_id(graph_id, node_id, name) -> str:
    """与前端 widgetId(graphId, nodeId, name) 同构：三段分别编码后 join(':')。"""
    return ":".join([urllib.parse.quote(str(graph_id), safe=_ENCODE_SAFE),
                     urllib.parse.quote(str(node_id), safe=_ENCODE_SAFE),
                     urllib.parse.quote(str(name), safe=_ENCODE_SAFE)])


def _app_node_widgets(node: dict) -> list:
    """画布上该节点真实存在的控件名（含自绘 DOM 控件；socket 输入不算）。"""
    named = node.get("widgets_values_named")
    if isinstance(named, dict) and named:
        return list(named.keys())
    return _ui_widget_names(node)


def _resolve_app_target(target: str):
    """官方应用回写目标：工作流目录内的相对 .app.json 路径。"""
    t = str(target or "").strip().replace("\\", "/")
    if not t or "\x00" in t or t.startswith("/") or re.match(r"^[A-Za-z]:", t):
        return None
    parts = [p for p in t.split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts):
        return None
    path = os.path.join(paths.WORKFLOW_DIR, *parts)
    if not paths._under(paths.WORKFLOW_DIR, path) or not path.lower().endswith(".app.json"):
        return None
    return path


def save_official_app(name, workflow, params, outputs, target: str = None) -> dict:
    """按官方 App Mode 的格式写 <stem>.app.json（POST /ps/pack/app）。

    workflow = 画布上那份 **UI 格式**工作流（app.graph.serialize()），原样落盘，只改 extra：
      * 顶层 id 缺失时补一个 uuid（官方 ref 的第一段就是它，前端自己也会认回来）；
      * 每个参数按「节点 + 控件」换成 "<图id>:<节点id>:<控件名>"，自绘控件换成 DOM 把手
        （media_state -> kedou_media，prompt_state -> kedou_promptbox）；
      * outputs 列节点 id。
    校验不过就不落盘（画布上没有的控件、不存在的节点/输出都如实报错，绝不静默丢弃）。
    """
    if not isinstance(workflow, dict):
        return {"ok": False, "error": "workflow 必须是 UI 格式工作流对象（画布序列化结果）"}
    nodes = [n for n in (workflow.get("nodes") or []) if isinstance(n, dict)]
    if not nodes:
        return {"ok": False, "error": "workflow 里没有 nodes —— 这不是 UI 格式工作流"
                                      "（API 图无法还原成官方应用，请改用 kapp）"}
    if not isinstance(params, list):
        return {"ok": False, "error": "params 必须是列表"}
    by_id = {str(n.get("id")): n for n in nodes}

    gid = str(workflow.get("id") or "").strip()
    if not gid:
        gid = str(uuid.uuid4())
        workflow = dict(workflow)
        workflow["id"] = gid

    errs = []
    inputs = []
    for i, p in enumerate(params):
        if not isinstance(p, dict):
            errs.append("第 %d 个参数不是对象" % (i + 1))
            continue
        nid = str(p.get("node") or "")
        widget = str(p.get("input") or "")
        node = by_id.get(nid)
        if node is None:
            errs.append("第 %d 个参数指向的节点 %s 不在工作流里" % (i + 1, nid))
            continue
        ntype = str(node.get("type") or "")
        handle = _dom_handle(ntype, widget)
        if handle not in _app_node_widgets(node):
            errs.append("节点 %s（%s）没有控件 %s —— 画布上不存在这个控件，不能暴露到应用"
                        % (nid, ntype, handle))
            continue
        label = str(p.get("label") or "").strip() or handle
        inputs.append([_app_widget_id(gid, nid, handle), label])

    outs = []
    for o in (outputs or []):
        nid = str(o)
        if nid not in by_id:
            errs.append("输出节点 %s 不在工作流里" % nid)
            continue
        outs.append(nid)
    if not outs:
        errs.append("至少要有一个输出节点（官方应用打开后没有图可看）")
    if errs:
        head = errs[:8]
        more = "" if len(errs) <= 8 else "（另有 %d 个问题）" % (len(errs) - 8)
        return {"ok": False, "error": "官方应用校验未通过，共 %d 个问题：%s%s"
                                      % (len(errs), "；".join(head), more)}

    if target:
        out_path = _resolve_app_target(target)
        if out_path is None:
            return {"ok": False, "error": "目标应用路径不合法（必须是工作流目录内的 .app.json）：%s"
                                          % target}
        out_dir = os.path.dirname(out_path)
        stem = paths._stem(os.path.basename(out_path))
    else:
        raw = str(name or "").strip()
        if not raw:
            return {"ok": False, "error": "应用名不能为空"}
        if not paths._safe_id(raw):
            return {"ok": False, "error": "应用名含非法字符（不能含 / \\ .. 或 :）"}
        stem = paths._stem(raw)
        if stem.lower().endswith(".app"):        # 兜底：用户误带 .app 后缀
            stem = stem[: -len(".app")]
        if not stem:
            return {"ok": False, "error": "应用名清洗后为空（请换个名字）"}
        out_dir = paths.WORKFLOW_DIR
        out_path = os.path.join(out_dir, stem + ".app.json")
    try:
        os.makedirs(out_dir, exist_ok=True)
    except Exception as e:                        # noqa: BLE001
        return {"ok": False, "error": "工作流目录不可写：%s" % e}
    if not paths._under(out_dir, out_path):
        return {"ok": False, "error": "应用名解析后落在工作流目录之外，已拒绝写入：%s" % name}

    # 官方只有这两个键；不动图上任何其它内容（位置、连线、控件值全部原样保留）
    extra = workflow.get("extra")
    if not isinstance(extra, dict):
        extra = {}
        workflow["extra"] = extra
    extra["linearMode"] = True
    extra["linearData"] = {"inputs": inputs, "outputs": outs}

    try:
        paths._dump_json_atomic(out_path, workflow, indent=1)
    except Exception as e:                        # noqa: BLE001
        return {"ok": False, "error": "写入失败：%s" % e}
    return {"ok": True, "id": stem, "file": paths._rel(out_path),
            "target": _pack_target(out_path), "graph_id": gid,
            "input_count": len(inputs), "output_count": len(outs),
            "outputs": outs, "edited": bool(target)}

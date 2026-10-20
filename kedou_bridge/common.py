# -*- coding: utf-8 -*-
"""应用解析共用的常量与纯函数（不依赖 ComfyUI 运行时）。"""

import urllib.parse


# 这些节点类型代表"要一张图进来"
IMAGE_LOADERS = {
    "LoadImage", "LoadImageMask", "LoadImageOutput", "ImageOnlyCheckpointLoader",
    "Load Image (Base64)", "ETN_LoadImageBase64", "LoadImageFromUrl",
}
# 管道参数：不暴露到面板（属于工作流作者范畴，非面向用户的可调项）
NOISE_INPUTS = {"filename_prefix"}

# 自绘面板的 DOM 控件（type=div）在官方 App Mode 里被当成「输入把手」：
# 真机样例 .app.json（前端 1.55，2026-10-20）写的是 "<gid>:508:kedou_media" 和
# "<gid>:509:kedou_promptbox"，而节点真正的数据控件叫 media_state / prompt_state。
# 两个名字都要认：
#   读官方应用 —— 把手还原成数据控件，否则默认值取不到、类型也判不出来（会退化成空文本框）；
#   写官方应用 —— 数据控件换成把手，因为 App Mode 只认画布上真实存在的 widget。
DOM_HANDLES = {
    "KedouImageLoader": {"media_state": "kedou_media"},
    "KedouPromptBox": {"prompt_state": "kedou_promptbox"},
}
# 把手对应的面板控件种类：图像输入 / 提示词输入
DOM_HANDLE_KIND = {"kedou_media": "image", "kedou_promptbox": "text"}


def _dom_handle(class_type: str, widget: str) -> str:
    """数据控件名 -> 官方应用里的 DOM 把手名（不是自绘控件则原样返回）。"""
    return (DOM_HANDLES.get(str(class_type)) or {}).get(str(widget), str(widget))


def _panel_widget(class_type: str, widget: str) -> str:
    """官方把手名 -> 数据控件名（不是把手则原样返回）。"""
    for real, handle in (DOM_HANDLES.get(str(class_type)) or {}).items():
        if handle == str(widget):
            return real
    return str(widget)

# 给面板用的中文类型名
KIND_CN = {"text": "提示词", "number": "数值", "bool": "开关", "image": "图像"}

# 下拉选项最多带多少条（LoadImage 的文件名列表可能上千条，对面板没意义还占体积）
OPTIONS_CAP = 200

# 控件名 -> 面向修图师的兜底标签
FALLBACK_LABEL = {
    "prompt": "提示词", "text": "文本", "text1": "文本 1", "text2": "文本 2",
    "positive": "正向提示词", "negative": "负向提示词",
    "value": "数值", "image": "图像", "mask": "蒙版",
    "filename_prefix": "文件名前缀", "seed": "随机种子",
    "steps": "步数", "cfg": "引导强度", "denoise": "重绘幅度",
    "width": "宽度", "height": "高度", "scale": "缩放", "strength": "强度",
}

def _clean_label(node: dict, widget: str) -> str:
    """控件显示名：优先工作流里记录的控件标题，其次控件名，不再用节点标题。

    UI 工作流的 node.inputs 里通常带 localized_name（如「百万像素」）和 label；
    一个节点有多个控件时，用节点标题会让所有参数同名，用户分不清是哪个。
    """
    for inp in (node.get("inputs") or []):
        if not isinstance(inp, dict):
            continue
        wspec = inp.get("widget") if isinstance(inp.get("widget"), dict) else {}
        name = str(inp.get("name") or wspec.get("name") or "")
        if name != widget:
            continue
        for key in ("localized_name", "label"):
            text = " ".join(str(inp.get(key) or "").splitlines()).strip()
            if text:
                return text
    return FALLBACK_LABEL.get(widget, widget)


def _kind_of(node: dict, widget: str, default) -> str:
    """把控件归成四种输入类型：image / number / bool / text"""
    ntype = str(node.get("type") or "")
    if ntype in IMAGE_LOADERS and widget in ("image", "mask"):
        return "image"
    if ntype.startswith("Primitive") or widget in ("seed", "steps", "cfg", "denoise",
                                                   "width", "height", "scale", "value"):
        if isinstance(default, bool):
            return "bool"
        if isinstance(default, (int, float)):
            return "number"
    if isinstance(default, bool):
        return "bool"
    if isinstance(default, (int, float)):
        return "number"
    return "text"


def _widget_values(node: dict) -> list:
    wv = node.get("widgets_values")
    if isinstance(wv, list):
        return wv
    if isinstance(wv, dict):
        return list(wv.values())
    if wv is None:
        return []
    return [wv]


def _split_ref(ref):
    """节点引用 -> (节点id, 控件名)，各段先解码。

    官方规范形是 "<图uuid>:<节点id>:<控件名>"（三段都 encodeURIComponent），
    也见过旧式 "<节点id>:<控件名>"。控件名里可能有 %20 / %23（重名控件会变成 name#1）。
    """
    parts = str(ref).split(":")
    if len(parts) >= 3:
        return parts[-2], urllib.parse.unquote(parts[-1])
    if len(parts) == 2:
        return parts[0], urllib.parse.unquote(parts[1])
    return str(ref), ""


def _ref_parts(entry) -> tuple:
    """官方 linearData 的一条输入 -> (节点id, 控件名, 存下来的显示名)。

    关键差别（前端 1.55 实测）：规范形 ["<图uuid>:<节点id>:<控件名>", "<显示名>"] 的
    第二个元素是 **显示名**，不是控件名 —— 控件名在 ref 字符串里。
    旧式 ["<节点id>", "<控件名>"] / [12, "seed"] 才是控件名放在第二个元素。
    两种情况都认，读错会把中文标签当成控件名（默认值和类型全丢）。
    """
    if not isinstance(entry, (list, tuple)) or not entry:
        return "", "", ""
    stored = str(entry[1]) if len(entry) > 1 else ""
    node_id, widget = _split_ref(entry[0])
    if not widget:                     # 旧式：ref 只有节点 id，控件名在第二个元素
        widget = stored
        stored = ""
    return node_id, widget, stored

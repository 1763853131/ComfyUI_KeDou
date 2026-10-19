# -*- coding: utf-8 -*-
"""应用解析共用的常量与纯函数（不依赖 ComfyUI 运行时）。"""

import re


# 这些节点类型代表"要一张图进来"
IMAGE_LOADERS = {
    "LoadImage", "LoadImageMask", "LoadImageOutput", "ImageOnlyCheckpointLoader",
    "Load Image (Base64)", "ETN_LoadImageBase64", "LoadImageFromUrl",
}
# 管道参数：不暴露到面板（属于工作流作者范畴，非面向用户的可调项）
NOISE_INPUTS = {"filename_prefix"}

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
    """
    显示名优先取节点标题；"#01. Pos Prompt" 这种去掉 #序号前缀后仍可读。
    标题为空或只剩 #序号 时，退回按控件名给的兜底名。
    """
    title = (node.get("title") or "").strip()
    if title:
        stripped = re.sub(r"^#\s*\d+\s*[.、:]?\s*", "", title).strip()
        if stripped:
            return stripped
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


def _split_ref(ref: str):
    """节点引用形如 "<图uuid>:<节点id>:<控件名>"，也见过 "<节点id>:<控件名>"。"""
    parts = str(ref).split(":")
    if len(parts) >= 3:
        return parts[-2], parts[-1]
    if len(parts) == 2:
        return parts[0], parts[1]
    return str(ref), ""

# -*- coding: utf-8 -*-
"""自定义节点：蝌蚪图片加载器 / 蝌蚪提示词输入框，以及执行前的空槽连线清理。"""

import json
import os

from . import compat, media, paths


# ---------------------------------------------------------------- 图片加载器
# 一个节点，只做图片：自绘的多选面板（不是官方那套 image_upload 控件）。
#
# 不使用官方 image_upload 控件的原因（依据前端 WidgetSelect bundle 的实现）：
#   * 该控件仅支持单选 —— WidgetSelect bundle 里 multiselect 出现 0 次；
#   * 它还自带「遮罩编辑器 / 下载」两个按钮，与本节点职责重叠。
# 因此参照 MiniMaxH3-Easy 媒体加载器：唯一控件为一个隐藏的
# media_state(JSON)，清单由自绘面板管理；要的媒体在这里仅解码一次。
#
# media_state 形如 {"images":[{"filename":"a.png"}, ...]}，只接受相对路径
# （拒绝绝对路径与 ..），input 找不到会再试 output —— 保证工作流文件可移植、
# ComfyUI 的目录保护仍然管用。
#
# 输出：选几张就几路 IMAGE，上限 IMG_SLOTS 路（2026-09-28 从 10 提到 50 —— 用户要「不再限制数量」）。
# ComfyUI 的 RETURN_TYPES 必须静态声明，所以「不限制」只能体现为给一个足够大的上限；
# 实际露出几个由前端 syncOutputs 按实际输出图片数控制，并额外多留一个空位点位
# （1 张图也给第 2 个点位，方便继续往 Batch Images 这类下游铺线）；已连线的槽保留（连线不因临时
# 删图而断），空槽的连线由 /prompt 入口钩子剔除，避免 None 打挂 Batch Images 这类下游。
# 不足的槽一律输出 None（不再复用最后一张），下游多图节点会忽略该路；
# 空槽给 None 不抛异常 —— ComfyUI 会把所有输出都算一遍哪怕没接线。

IMG_SLOTS = 50
IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif")
# 输出长边上限的允许范围（像素）；0 表示不限制。上限存在 media_state 里。
MAX_SIDE_LIMIT = 16384


def _image_files() -> list:
    """input 目录里的图片（相对 POSIX 路径，含子目录），排序后返回。"""
    in_dir, _out = media._media_dirs()
    got = []
    if not os.path.isdir(in_dir):
        return got
    for r, _dirs, files in os.walk(in_dir):
        for fn in files:
            if fn.lower().endswith(IMG_EXTS):
                sub = os.path.relpath(r, in_dir).replace("\\", "/")
                got.append(fn if sub == "." else (sub + "/" + fn))
    return sorted(got)


def _media_state_value(value) -> dict:
    """media_state 规范化为 {"images":[{"filename":...}]}，只留合法的相对路径。"""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            value = {}
    out = {"images": [], "batch": False, "cursor": 0, "select": False, "picked": [], "max_side": 0}
    if not isinstance(value, dict):
        return out
    # 输出长边上限（2026-10-20）：0 = 原尺寸；只缩小不放大，宽高比不变。
    # 放在 media_state 里而不是另开控件：自绘面板只有一个隐藏 widget，
    # 旧工作流没有这个字段时按 0 处理，不会影响读取。
    try:
        max_side = int(value.get("max_side") or 0)
    except (TypeError, ValueError):
        max_side = 0
    out["max_side"] = max(0, min(max_side, MAX_SIDE_LIMIT))
    # 批次模式字段（2026-09-28）：batch 开关 + 游标，前端批次循环时逐份改 cursor 再排队
    out["batch"] = bool(value.get("batch"))
    try:
        out["cursor"] = int(value.get("cursor") or 0)
    except (TypeError, ValueError):
        out["cursor"] = 0
    # 选择模式字段（2026-09-28）：select 开关 + 按选择顺序排列的文件名列表
    out["select"] = bool(value.get("select"))
    pk = value.get("picked")
    if isinstance(pk, list):
        out["picked"] = [str(x).replace("\\", "/").lstrip("/") for x in pk if str(x).strip()]
    raw_list = value.get("images")
    if not isinstance(raw_list, list):
        return out
    seen = set()
    for raw in raw_list:
        name = str((raw.get("filename") if isinstance(raw, dict) else raw) or "").strip()
        name = name.replace("\\", "/").lstrip("/")
        if not name or "\x00" in name or os.path.isabs(name):
            continue
        parts = [p for p in name.split("/") if p and p != "."]
        if not parts or any(p == ".." for p in parts):
            continue
        norm = "/".join(parts)
        if norm in seen:
            continue
        seen.add(norm)
        out["images"].append({"filename": norm})
        if len(out["images"]) >= IMG_SLOTS:
            break
    return out


def _media_input_path(filename: str) -> str:
    """媒体文件名 -> 绝对路径：先找 input，找不到再试 output（媒体库「已生成」选的图也能跑）。

    两个目录都走 folder_paths 的越界检查（相对路径 + 拒绝 ..），安全性不变。
    """
    try:
        from folder_paths import (get_annotated_filepath, get_input_directory,   # noqa: PLC0415
                                  get_output_directory)
        path = get_annotated_filepath(filename, get_input_directory())
        if os.path.isfile(path):
            return path
        path = get_annotated_filepath(filename, get_output_directory())
    except Exception:                                       # noqa: BLE001
        in_dir, out_dir = media._media_dirs()
        path = os.path.join(in_dir, filename.replace("/", os.sep))
        if not os.path.isfile(path):
            path = os.path.join(out_dir, filename.replace("/", os.sep))
        # 兜底分支没有 folder_paths 的越界检查，自己补一道（同 save_kapp 的落盘前复核）
        if not (paths._under(in_dir, path) or paths._under(out_dir, path)):
            raise ValueError("Media filename escapes the media folders, rejected: %s" % filename)
    if not os.path.isfile(path):
        raise ValueError("Kedou Image Loader: file not found in input / output: %s" % filename)
    return path


def _media_state_json(value) -> str:
    return json.dumps(_media_state_value(value), ensure_ascii=True, separators=(",", ":"))


def _prune_stale_loader_links(prompt_graph: dict) -> int:
    """执行前丢掉指向图片加载器「空槽」的连线。

    前端 syncOutputs 会按实际张数收槽，但旧工作流、浏览器里缓存的旧前端、
    以及启动器/PS 面板用陈旧工作流文件直接提交的 API 图，仍可能保留这些连线。
    空槽在后端只能输出 None，Batch Images 这类不做空值容错的下游会直接
    AttributeError（'NoneType' has no attribute 'shape'），所以入口处再兜一层。
    返回被忽略的连线数。
    """
    removed = 0
    for nid, node in (prompt_graph or {}).items():
        if not isinstance(node, dict) or node.get("class_type") != "KedouImageLoader":
            continue
        state = _media_state_value((node.get("inputs") or {}).get("media_state", ""))
        imgs = state["images"]
        if state.get("select") and state.get("picked"):
            by_name = {e["filename"]: e for e in imgs}
            picked = [by_name[f] for f in state["picked"] if f in by_name]
            if picked:
                imgs = picked
        out_n = 1 if (state.get("batch") and imgs) else len(imgs)
        if out_n <= 0:
            continue                       # 真没图时让加载器自己报「无图」，信息更准确
        for other in prompt_graph.values():
            inputs = other.get("inputs") if isinstance(other, dict) else None
            if not isinstance(inputs, dict):
                continue
            for key, val in list(inputs.items()):
                if (isinstance(val, (list, tuple)) and len(val) == 2
                        and str(val[0]) == str(nid)
                        and isinstance(val[1], int) and not isinstance(val[1], bool)
                        and val[1] >= out_n):
                    inputs.pop(key, None)
                    removed += 1
    return removed


def _on_prompt_prune_empty_slots(json_data):
    """PromptServer.add_on_prompt_handler 回调：返回（可能已修改的）请求体。"""
    try:
        graph = json_data.get("prompt") if isinstance(json_data, dict) else None
        if isinstance(graph, dict):
            n = _prune_stale_loader_links(graph)
            if n:
                print("[KeDou] 图片加载器空槽连线已忽略：%d 条"
                      "（旧工作流/旧前端仍把线连到了没有图片的槽）" % n)
    except Exception:                                  # noqa: BLE001
        pass                                           # 兜底失败绝不拦运行
    return json_data


def _load_image(filename: str, max_side: int = 0):
    """单图 -> (1,H,W,3) float32 张量，与官方 LoadImage 的输出形状一致。

    max_side > 0 时按长边缩小，宽高比不变；只缩不放（比上限小的图保持原样）。
    """
    import numpy as np                                  # noqa: PLC0415
    import torch                                        # noqa: PLC0415
    from PIL import Image, ImageOps                     # noqa: PLC0415
    im = ImageOps.exif_transpose(Image.open(_media_input_path(filename))).convert("RGB")
    limit = int(max_side or 0)
    if 0 < limit < max(im.size):
        resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
        im.thumbnail((limit, limit), resample)
    arr = np.array(im).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


class KedouImageLoader:
    """蝌蚪图片加载器 —— 在面板上挑图片，一张图一路输出。"""

    CATEGORY = "kedou"
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE",) * IMG_SLOTS
    RETURN_NAMES = tuple("image_%d" % i for i in range(1, IMG_SLOTS + 1))
    DESCRIPTION = (
        "Pick images on the node panel (multi-select, upload supported); each image gets "
        "its own IMAGE output slot (up to %d). Unused slots emit None, so downstream "
        "multi-image nodes ignore that route. Turn on Select to output only the picked "
        "photos, in click order. Turn on Batch and press Run to queue the photos through "
        "the workflow one by one. The long-side limit shrinks each output image (aspect "
        "ratio kept, never upscales); 0 keeps the original size." % IMG_SLOTS
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"media_state": ("STRING", {"default": "", "multiline": False})}}

    @classmethod
    def IS_CHANGED(cls, media_state="", **_kw):
        """文件增删或文件本身变了都要重跑，否则 ComfyUI 会拿旧缓存。"""
        state = _media_state_value(media_state)
        sig = []
        for entry in state["images"]:
            name = entry["filename"]
            try:
                st = os.stat(_media_input_path(name))
                sig.append((name, st.st_mtime_ns, st.st_size))
            except (OSError, ValueError):
                sig.append((name, None, None))
        # 批次游标必须进签名：cursor 变了文件没变，不加的话 ComfyUI 会拿缓存不重跑
        if state.get("batch"):
            sig.append(("batch", state.get("cursor")))
        # 选择模式同理：开关切换、选中集合变化、甚至只改选择顺序，输出都会变，都要进签名
        sig.append(("select", state.get("select"), tuple(state.get("picked") or [])))
        # 长边上限变了，输出分辨率也变，必须重跑
        sig.append(("max_side", state.get("max_side")))
        return repr(sig)

    @classmethod
    def VALIDATE_INPUTS(cls, media_state="", **_kw):
        """2026-09-28 改：部分失效放行 —— 与 load() 的容错对齐（失败图占位 None，槽位不错位）。
        用户清理过输出目录后面板残留旧文件名，旧版一票否决把整个提交拦死；
        现在只有全部失效才拦（此时才真的没有一张可出）。"""
        state = _media_state_value(media_state)
        first_err = None
        missing = 0
        for entry in state["images"]:
            try:
                _media_input_path(entry["filename"])
            except ValueError as exc:
                missing += 1
                if first_err is None:
                    first_err = str(exc)
        if state["images"] and missing == len(state["images"]):
            return first_err or "Kedou Image Loader: none of the panel images exist in input / output"
        return True

    def load(self, media_state=""):
        state = _media_state_value(media_state)
        # 槽位语义（2026-09-28 六修）：**启用槽 = 面板上的实际照片数**。
        # 多余的槽输出 None —— 下游多图节点（如 TextEncodeQwenImageEdit21 固定 21 个图输入）
        # 对 None 容错并忽略该路参考图。旧版「复用最后一张填满」会让下游收到 N 份相同
        # 参考图，参考图权重翻倍、生成效果跑偏（用户实测），已废弃。
        # 批次模式：只有图片1 输出当前游标那张，其余槽全部 None（连着的线等于忽略信号）。
        # 加载失败的图也占位为 None：槽与面板序号一一对应，不会前移错位。
        # 选择模式（2026-09-28）：select 开 + picked 非空 → 只输出被选中的照片，
        # 顺序 = 选择顺序（picked[0] → 图片1）。picked 里已不在面板上的文件名自动跳过；
        # picked 为空或全失效时回退为全部照片，避免「选了又全取消」后一个槽都不出。
        imgs = state["images"]
        if state.get("select") and state.get("picked"):
            by_name = {e["filename"]: e for e in imgs}
            picked_imgs = [by_name[f] for f in state["picked"] if f in by_name]
            if picked_imgs:
                imgs = picked_imgs
        if state.get("batch"):
            if not imgs:
                raise ValueError("Kedou Image Loader: no image selected - pick photos on the "
                                 "loader node or in the app panel first")
            cur = max(0, min(int(state.get("cursor") or 0), len(imgs) - 1))
            entry = imgs[cur]
            try:
                pick = _load_image(entry["filename"], state.get("max_side"))
            except (OSError, ValueError) as e:
                raise ValueError("Kedou Image Loader: cannot read batch image %d/%d (%s): %s"
                                 % (cur + 1, len(imgs), entry["filename"], e))
            out = [pick]
        else:
            out = []
            for entry in imgs:
                try:
                    out.append(_load_image(entry["filename"], state.get("max_side")))
                except (OSError, ValueError) as e:
                    print("[kedou] 图片读不出来，该槽给空：%s（%s）" % (entry["filename"], e))
                    out.append(None)
            if not any(x is not None for x in out):
                # 全都读不出来才算无图；个别失败只空对应槽，不前移错位
                raise ValueError("Kedou Image Loader: none of the selected images could be read "
                                 "- check the files still exist in input / output")
            ok = sum(1 for x in out if x is not None)
            if ok < len(out):
                print("[kedou] 图片加载器：%d/%d 张有效；其余槽输出 None（下游多图节点会忽略）"
                      % (ok, len(out)))
        # 填充到 IMG_SLOTS：未启用的槽一律 None
        while len(out) < IMG_SLOTS:
            out.append(None)
        return tuple(out)



class KedouPromptBox:
    """蝌蚪提示词输入框：节点上直接写提示词 + 词库集成，STRING 输出。"""

    USAGES = ("文生图", "图像编辑", "文生视频", "图生视频", "参考生视频")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_state": ("STRING", {"default": ""}),
                "usage": (list(cls.USAGES), {"default": "文生图"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "run"
    CATEGORY = "kedou"

    def run(self, prompt_state="", usage="文生图"):
        # 值就是提示词字符串本身；usage 只用于前端词库过滤，不参与输出。
        # 注意：一个输出 = 一层元组（"文本",），不能写成 (("文本",),)，
        # 否则下游拿到的是元组，TextGenerate 等按字符串处理的节点会报
        # 'tuple' object has no attribute 'startswith'。
        return (prompt_state or "",)


KedouPromptBox.DESCRIPTION = (
    "Prompt input box with a built-in phrase library: type on the node, append entries from "
    "the library dropdown, pin/recall recent prompts and save the current text as a preset. "
    "Connect prompt to the positive conditioning input of a text encoder."
)


# ComfyUI 要求 custom_nodes 至少导出节点映射（可以为空）
NODE_CLASS_MAPPINGS = {
    "KedouImageLoader": KedouImageLoader,
    "KedouPromptBox": KedouPromptBox,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "KedouImageLoader": "Kedou Image Loader",
    "KedouPromptBox": "Kedou Prompt Box",
}


def register_hooks():
    """把「空槽连线清理」挂到 /prompt 入口；失败只提示，不影响其它功能。"""
    if not compat.HAS_COMFY:
        return
    try:
        compat.PromptServer.instance.add_on_prompt_handler(_on_prompt_prune_empty_slots)
    except Exception as e:                             # noqa: BLE001
        print("[KeDou] 空槽连线清理钩子注册失败（不影响其它功能）:", e)

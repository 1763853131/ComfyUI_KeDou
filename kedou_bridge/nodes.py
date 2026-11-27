# -*- coding: utf-8 -*-
"""自定义节点：蝌蚪图片加载器 / 蝌蚪提示词输入框，以及执行前的空槽连线清理。"""

import json
import math
import os

from . import av_state, compat, media, paths


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
# 分辨率桶：0 = 原尺寸；>0 表示把每张图对齐到该分辨率的「不动点」尺寸。
# 上限对齐官方 TextEncodeQwenImage21 的 resolution（0~4096，步进 32）。
BUCKET_MAX = 4096


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
    out = {"images": [], "batch": False, "cursor": 0, "select": False, "picked": [], "bucket": 0}
    if not isinstance(value, dict):
        return out
    # 分辨率桶（2026-10-21）：0 = 原尺寸；>0 = 对齐到该分辨率的「不动点」尺寸。
    # 旧字段 max_side（长边上限）沿用同一个数：它的取值范围本来就是 1024~4096 的预设，
    # 直接当桶分辨率读，旧工作流不至于因为字段改名变回「原尺寸」。
    # 放在 media_state 里而不是另开控件：自绘面板只有一个隐藏 widget。
    try:
        bucket = int(value.get("bucket", value.get("max_side")) or 0)
    except (TypeError, ValueError):
        bucket = 0
    out["bucket"] = max(0, min(bucket, BUCKET_MAX))
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


def _av_input_path(item: dict) -> str:
    """AV 素材按 item.tab 精确定位，失败才回退另一目录；两目录均做越界检查。"""
    filename = av_state._filename(item.get("filename"))
    tab = item.get("tab")
    first, second = (("output", "input") if tab == "output" else ("input", "output"))
    for candidate in (first, second):
        parent, _base = os.path.split(filename)
        found = media._media_file(_base, parent, candidate)
        if found:
            return found
    raise ValueError("Kedou AV Loader: file not found in input / output: %s" % filename)


def _media_state_json(value) -> str:
    return json.dumps(_media_state_value(value), ensure_ascii=True, separators=(",", ":"))


def _prune_stale_loader_links(prompt_graph: dict) -> int:
    """执行前清理图片空槽与 AV 节点模式下不存在的输出连线。"""
    removed = 0
    for nid, node in (prompt_graph or {}).items():
        if not isinstance(node, dict):
            continue
        ctype = node.get("class_type")
        if ctype not in ("KedouImageLoader", "KedouAVLoader"):
            continue
        try:
            state = (av_state.parse_av_state((node.get("inputs") or {}).get("media_state", ""))
                     if ctype == "KedouAVLoader"
                     else _media_state_value((node.get("inputs") or {}).get("media_state", "")))
        except (TypeError, ValueError):
            continue                       # 非法状态交给 VALIDATE_INPUTS 报完整错误
        if ctype == "KedouAVLoader":
            # 只保留当前媒体实际可能产生的端口；占位/增长槽由前端暂存，不进入 prompt 图。
            layout = av_state.output_layout(state)
            executable = set(av_state.executable_layout(state))
            keep = {index for index, key in enumerate(layout) if key in executable}
        else:
            imgs = state["images"]
            if state.get("select") and state.get("picked"):
                by_name = {e["filename"]: e for e in imgs}
                picked = [by_name[f] for f in state["picked"] if f in by_name]
                if picked:
                    imgs = picked
            out_n = 1 if (state.get("batch") and imgs) else len(imgs)
            if out_n <= 0:
                continue                   # 真没图时让加载器自己报「无图」
            keep = set(range(out_n))
        for other in prompt_graph.values():
            inputs = other.get("inputs") if isinstance(other, dict) else None
            if not isinstance(inputs, dict):
                continue
            for key, val in list(inputs.items()):
                if (isinstance(val, (list, tuple)) and len(val) == 2
                        and str(val[0]) == str(nid)
                        and isinstance(val[1], int) and not isinstance(val[1], bool)
                        and val[1] not in keep):
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


def bucket_size(width: int, height: int, resolution: int):
    """按官方编码器的取整公式，算出这张图对齐到该分辨率的尺寸（不动点）。

    官方 comfy_extras/nodes_qwen.py::TextEncodeQwenImage21 对每张参考图做的是：
        width  = round(sqrt(res^2 * w / h) / 32) * 32
        height = round(sqrt(res^2 / (w / h)) / 32) * 32
    尺寸恰好等于这个式子的输出时，它直接跳过缩放（``s = image``），空 latent 也按这张图
    的尺寸建 —— 画布与图像严格对齐，不会有像素偏移。这里就是提前把图做成那个尺寸。

    取整会轻微挪动比例，个别比例下式子的输出不是它自己；那就拿输出的比例再算一次，
    迭代到稳定（最多 6 轮，取比例误差最小的一轮兜底）。
    """
    if resolution <= 0:
        return int(width), int(height)
    ratio = float(width) / float(height)

    def once(r):
        w = max(32, int(round(math.sqrt(resolution * resolution * r) / 32.0)) * 32)
        h = max(32, int(round(math.sqrt(resolution * resolution / r) / 32.0)) * 32)
        return w, h

    best = None
    for _ in range(6):
        bw, bh = once(ratio)
        new_ratio = float(bw) / float(bh)
        err = abs(math.log(new_ratio / ratio))
        if best is None or err < best[0]:
            best = (err, (bw, bh))
        if abs(new_ratio - ratio) < 1e-9:          # 已是不动点
            break
        ratio = new_ratio
    return best[1]


def _cover_to(im, tw: int, th: int):
    """等比缩放到正好盖住 (tw, th) 再中心裁切；尺寸已经一致时原样返回（零重采样）。"""
    from PIL import Image                                  # noqa: PLC0415
    if im.size == (tw, th):
        return im
    scale = max(tw / float(im.width), th / float(im.height))
    nw = max(tw, int(round(im.width * scale)))
    nh = max(th, int(round(im.height * scale)))
    resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
    if (nw, nh) != im.size:
        im = im.resize((nw, nh), resample)
    left = (nw - tw) // 2
    top = (nh - th) // 2
    return im.crop((left, top, left + tw, top + th))


def _load_image(filename: str, bucket: int = 0):
    """单图 -> (1,H,W,3) float32 张量，与官方 LoadImage 的输出形状一致。

    bucket > 0 时把图对齐到该分辨率的不动点尺寸（等比放大到盖满后中心裁切，
    小图也会放大 —— 不放大就不是不动点，编码器那边仍会自己缩一遍）。
    """
    import numpy as np                                  # noqa: PLC0415
    import torch                                        # noqa: PLC0415
    from PIL import Image, ImageOps                     # noqa: PLC0415
    im = ImageOps.exif_transpose(Image.open(_media_input_path(filename))).convert("RGB")
    res = int(bucket or 0)
    if res > 0:
        im = _cover_to(im, *bucket_size(im.width, im.height, res))
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
        "the workflow one by one. The alignment resolution snaps each output image to the "
        "size the Qwen-Image text encoder would use at that resolution (multiples of 32, "
        "aspect ratio kept, cover-cropped); 0 keeps the original size." % IMG_SLOTS
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
        # 对齐分辨率变了，输出尺寸也变，必须重跑
        sig.append(("bucket", state.get("bucket")))
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
                pick = _load_image(entry["filename"], state.get("bucket"))
            except (OSError, ValueError) as e:
                raise ValueError("Kedou Image Loader: cannot read batch image %d/%d (%s): %s"
                                 % (cur + 1, len(imgs), entry["filename"], e))
            out = [pick]
        else:
            out = []
            for entry in imgs:
                try:
                    out.append(_load_image(entry["filename"], state.get("bucket")))
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



# ---------------------------------------------------------------- 音视频加载器

AV_SLOTS = av_state.AV_SLOTS
AV_MEMORY_LIMIT = media.AV_MEMORY_LIMIT


def _duration_seconds(container, stream, av):
    """流时长优先，容器时长兜底；未知或非法时长返回 None。"""
    if stream.duration is not None and stream.time_base:
        duration = float(stream.duration * stream.time_base)
        if math.isfinite(duration) and duration > 0:
            return duration
    if container.duration is not None and av.time_base:
        duration = float(container.duration / av.time_base)
        if math.isfinite(duration) and duration > 0:
            return duration
    return None


def _memory_limit(memory_limit=None):
    return AV_MEMORY_LIMIT if memory_limit is None else memory_limit


def _audio_memory_estimate(path, memory_limit=None):
    """返回整段 float32 波形估算，并检查本次可用的剩余预算。"""
    try:
        import av
    except ImportError as exc:
        raise ValueError("Kedou AV Loader: PyAV is unavailable") from exc
    limit = _memory_limit(memory_limit)
    try:
        with av.open(path, mode="r") as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                raise ValueError("Kedou AV Loader: no audio stream found: %s" % path)
            rate = int(stream.codec_context.sample_rate)
            channels = int(stream.channels)
            duration = _duration_seconds(container, stream, av)
            if duration is None:
                raise ValueError("Kedou AV Loader: cannot determine audio duration for memory guard")
            if rate <= 0 or channels <= 0:
                raise ValueError("Kedou AV Loader: invalid audio sample rate or channel count")
            # 官方加载器会同时保留解码帧、cat 结果和 float32 转换结果，按三份峰值预算。
            estimate = duration * rate * channels * 4 * 3
            if estimate > limit:
                raise ValueError("Kedou AV Loader: estimated audio memory %.2fGB exceeds the 2GB limit"
                                 % (estimate / float(1024 ** 3)))
            return estimate
    except (OSError, TypeError, RuntimeError, av.error.FFmpegError) as exc:
        raise ValueError("Kedou AV Loader: cannot decode audio (%s): %s" % (path, exc)) from exc


def _waveform_nbytes(waveform, fallback=0):
    # 切片是视图，逻辑 nbytes 小于实际 storage；预算必须按真实持有的整段存储计算。
    storage = getattr(waveform, "untyped_storage", None)
    if callable(storage):
        try:
            return int(storage().nbytes())
        except Exception:                           # noqa: BLE001
            pass
    if hasattr(waveform, "nbytes"):
        return int(waveform.nbytes)
    if hasattr(waveform, "numel") and hasattr(waveform, "element_size"):
        return int(waveform.numel()) * int(waveform.element_size())
    return int(fallback)


def _load_audio(path, memory_limit=None, trim_start=0, trim_end=None):
    """在剩余预算内解码音频，再按采样率精确切片；预算峰值仍按原文件全解码估算。"""
    trim_start, trim_end = av_state._trim_seconds(trim_start, trim_end)
    limit = _memory_limit(memory_limit)
    estimate = _audio_memory_estimate(path, limit)
    try:
        from comfy_extras.nodes_audio import load as official_load
    except ImportError as exc:
        raise ValueError("Kedou AV Loader: ComfyUI audio loader is unavailable") from exc
    try:
        waveform, sample_rate = official_load(path)
    except (OSError, ValueError, TypeError, RuntimeError) as exc:
        raise ValueError("Kedou AV Loader: cannot decode audio (%s): %s" % (path, exc)) from exc
    if trim_start > 0 or trim_end is not None:
        # 官方波形为 [channels, samples]；时间边界先对齐到采样点，再切这一维。
        sample_count = waveform.shape[-1]
        rate = int(sample_rate)
        try:
            start_sample = int(math.ceil(trim_start * rate - 1e-9))
        except OverflowError:
            start_sample = sample_count
        if trim_end is None:
            end_sample = sample_count
        else:
            try:
                end_sample = int(math.floor(trim_end * rate + 1e-9))
            except OverflowError:
                end_sample = sample_count
        end_sample = max(0, min(end_sample, sample_count))
        if start_sample >= sample_count or end_sample <= start_sample:
            raise ValueError("Kedou AV Loader: no audio samples in trim window")
        waveform = waveform[:, start_sample:end_sample]
    actual = _waveform_nbytes(waveform, estimate)
    if actual > limit:
        raise ValueError("Kedou AV Loader: estimated audio memory %.2fGB exceeds the 2GB limit"
                         % (actual / float(1024 ** 3)))
    return {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}


def _video_frames(path, options, memory_limit=None, trim_start=0, trim_end=None):
    """按解码顺序取帧；trim 窗口内再应用 start_frame/step/max_frames。"""
    import numpy as np
    import torch
    import av
    from PIL import Image

    trim_start, trim_end = av_state._trim_seconds(trim_start, trim_end)
    trimmed = trim_start > 0 or trim_end is not None
    opts = options
    limit = _memory_limit(memory_limit)
    if opts["start_frame"] > av_state.FRAME_LIMITS["start_frame"]:
        raise ValueError("Kedou AV Loader: start_frame exceeds limit %d"
                         % av_state.FRAME_LIMITS["start_frame"])
    selected = []
    index = 0
    wanted = opts["max_frames"]
    step = opts["frame_step"]
    try:
        with av.open(path, mode="r") as container:
            stream = next((s for s in container.streams if s.type == "video"), None)
            if stream is None:
                raise ValueError("Kedou AV Loader: no video stream found: %s" % path)
            # 源帧峰值含 RGB ndarray、PIL 副本和 float32 临时副本，不能只算一份 RGB。
            source_estimate = media._source_frame_memory(stream.width, stream.height)
            if source_estimate > limit:
                raise ValueError("Kedou AV Loader: one decoded frame is too large for the 2GB memory guard")
            origin = media.media_time_origin(container, stream, av)
            source_start = origin + trim_start
            source_end = origin + trim_end if trim_end is not None else None
            if trimmed and source_start > 0:
                time_base = getattr(stream, "time_base", None)
                if not time_base:
                    raise ValueError("Kedou AV Loader: video stream has no time base for trim seek")
                container.seek(int(source_start / float(time_base)), stream=stream,
                               backward=True, any_frame=False)
            for frame in container.decode(stream):
                if trimmed:
                    frame_time = getattr(frame, "time", None)
                    if frame_time is None:
                        pts = getattr(frame, "pts", None)
                        time_base = getattr(frame, "time_base", None) or getattr(stream, "time_base", None)
                        if pts is not None and time_base:
                            frame_time = float(pts * time_base)
                    if frame_time is None:
                        raise ValueError("Kedou AV Loader: cannot determine decoded frame time for trim")
                    frame_time = float(frame_time)
                    if not math.isfinite(frame_time):
                        raise ValueError("Kedou AV Loader: cannot determine decoded frame time for trim")
                    if frame_time < source_start:
                        continue
                    if source_end is not None and frame_time >= source_end:
                        break
                source_estimate = media._source_frame_memory(frame.width, frame.height)
                if source_estimate > limit:
                    raise ValueError("Kedou AV Loader: one decoded frame is too large for the 2GB memory guard")
                if index < opts["start_frame"]:
                    index += 1
                    continue
                if (index - opts["start_frame"]) % step == 0:
                    arr = frame.to_ndarray(format="rgb24")
                    im = media._rotate_frame_image(Image.fromarray(arr),
                                                   getattr(frame, "rotation", 0))
                    width, height = im.size
                    scale = (min(1.0, opts["max_side"] / float(max(width, height)))
                             if opts["max_side"] > 0 else 1.0)
                    out_w = max(1, int(round(width * scale)))
                    out_h = max(1, int(round(height * scale)))
                    planned = len(selected) + 1
                    # 已选帧与最终 stack 同时存在，另留 float32 转换/归一化临时副本。
                    output_estimate = (planned * 2 + 3) * out_w * out_h * 3 * 4
                    estimate = source_estimate + output_estimate
                    if estimate > limit:
                        raise ValueError("Kedou AV Loader: estimated frame memory %.2fGB exceeds the 2GB limit"
                                         % (estimate / float(1024 ** 3)))
                    if im.size != (out_w, out_h):
                        resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
                        im = im.resize((out_w, out_h), resample)
                    selected.append(np.asarray(im, dtype=np.float32) / 255.0)
                    if len(selected) >= wanted:
                        break
                index += 1
    except ValueError:
        raise
    except (OSError, RuntimeError, OverflowError, av.error.FFmpegError) as exc:
        raise ValueError("Kedou AV Loader: cannot decode video (%s): %s" % (path, exc)) from exc
    if not selected:
        raise ValueError("Kedou AV Loader: no frames decoded at start_frame=%d (check frame parameters)"
                         % opts["start_frame"])
    return torch.from_numpy(np.stack(selected, axis=0))


class KedouAVLoader:
    """蝌蚪音视频加载器：视频/音频各自多选，按可见语义端口输出最多八组。"""

    CATEGORY = "kedou"
    FUNCTION = "load"
    RETURN_TYPES = ("*",) * av_state.AV_OUTPUT_SLOTS
    RETURN_NAMES = tuple("output_%d" % index for index in range(1, av_state.AV_OUTPUT_SLOTS + 1))

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"media_state": ("STRING", {"default": "", "multiline": False})}}

    @classmethod
    def IS_CHANGED(cls, media_state="", **_kw):
        try:
            state = av_state.parse_av_state(media_state)
        except ValueError as exc:
            return repr(("invalid", str(exc)))
        # 完整列表和 effective 列表都进签名：顺序、选择回退、未选项变化均可追踪。
        sig = [("videos", tuple(state["videos"])), ("audios", tuple(state["audios"]))]
        for slot in ("videos", "audios"):
            effective = state["effective_%s" % slot]
            sig.append(("effective_%s" % slot, tuple(effective)))
            for item in effective:
                try:
                    path = _av_input_path(item)
                    st = os.stat(path)
                    sig.append((slot, item, path, st.st_mtime_ns, st.st_size))
                except (OSError, ValueError):
                    sig.append((slot, item, None, None, None))
        sig.extend([
            ("select", state["select"], tuple(state["picked_videos"]), tuple(state["picked_audios"])),
            ("batch", state["batch"], state["cursor"]),
            ("video_audio", state["video_audio"]),
            ("current_pair", state["current_pair"]),
            ("mode", state["output_mode"]),
            ("port_order", tuple(state["port_order"])),
            ("frame_options", state["frame_options"]),
        ])
        return repr(sig)

    @classmethod
    def VALIDATE_INPUTS(cls, media_state="", **_kw):
        try:
            state = av_state.parse_av_state(media_state)
            missing = 0
            total = 0
            first_err = None
            # 与图片加载器一致：部分素材失效时保留空槽，只有全部失效才拦截。
            for slot in ("videos", "audios"):
                for item in state["effective_%s" % slot]:
                    total += 1
                    try:
                        _av_input_path(item)
                    except (OSError, ValueError) as exc:
                        missing += 1
                        if first_err is None:
                            first_err = exc
            if total and missing == total:
                return av_state.public_error(str(first_err))
        except (OSError, ValueError) as exc:
            return av_state.public_error(str(exc))
        return True

    def load(self, media_state=""):
        try:
            return self._load(media_state)
        except ValueError as exc:
            raise ValueError(av_state.public_error(str(exc))) from exc

    def _load(self, media_state=""):
        state = av_state.parse_av_state(media_state)
        layout = av_state.output_layout(state)
        if state["batch"]:
            video_items = ([state["current_pair"]["video"]]
                           if state["current_pair"]["video"] is not None else [])
            audio_items = ([state["current_pair"]["audio"]]
                           if state["current_pair"]["audio"] is not None else [])
        else:
            video_items = state["effective_videos"][:av_state.AV_SLOTS]
            audio_items = state["effective_audios"][:av_state.AV_SLOTS]

        video_paths = []
        for item in video_items:
            try:
                video_paths.append(_av_input_path(item))
            except (OSError, ValueError):
                video_paths.append(None)
        audio_paths = []
        for item in audio_items:
            try:
                audio_paths.append(_av_input_path(item))
            except (OSError, ValueError):
                audio_paths.append(None)

        # 视频自带音频与纯音频统一预检，共享同一个 2GB 峰值预算。
        audio_jobs = []
        if state["video_audio"]:
            for index, (item, path) in enumerate(zip(video_items, video_paths), 1):
                if path is None:
                    continue
                audio_jobs.append({"key": "video_audio_%d" % index, "item": item,
                                   "path": path, "embedded": True, "missing": False})
        for index, (item, path) in enumerate(zip(audio_items, audio_paths), 1):
            if path is None:
                continue
            audio_jobs.append({"key": "audio_%d" % index, "item": item,
                               "path": path, "embedded": False, "missing": False})

        estimated_audio = 0
        for job in audio_jobs:
            try:
                estimate = _audio_memory_estimate(job["path"], AV_MEMORY_LIMIT - estimated_audio)
            except ValueError as exc:
                if job["embedded"] and "no audio stream found" in str(exc).lower():
                    job["missing"] = True
                    estimate = 0
                else:
                    raise
            job["estimate"] = estimate
            estimated_audio += estimate

        audio_used = 0
        values = {}
        for job in audio_jobs:
            if job["missing"]:
                values[job["key"]] = None
                continue
            item = job["item"]
            try:
                audio = _load_audio(job["path"], memory_limit=AV_MEMORY_LIMIT - audio_used,
                                    trim_start=item["trim_start"], trim_end=item["trim_end"])
            except ValueError as exc:
                if job["embedded"] and "no audio stream found" in str(exc).lower():
                    values[job["key"]] = None
                    continue
                raise
            values[job["key"]] = audio
            audio_used += _waveform_nbytes(audio["waveform"], job["estimate"])

        memory_used = audio_used
        for index, (item, video_path) in enumerate(zip(video_items, video_paths), 1):
            if video_path is None:
                continue
            if state["output_mode"] == "video":
                from comfy_api.latest import InputImpl
                trimmed = media.trimmed_video(video_path, trim_start=item["trim_start"],
                                              trim_end=item["trim_end"])
                if not trimmed.get("ok"):
                    raise ValueError("Kedou AV Loader: %s" % trimmed.get("error", "视频裁剪失败"))
                values["video_%d" % index] = InputImpl.VideoFromFile(trimmed["path"])
            else:
                frames = _video_frames(video_path, state["frame_options"],
                                       memory_limit=AV_MEMORY_LIMIT - memory_used,
                                       trim_start=item["trim_start"], trim_end=item["trim_end"])
                frame_nbytes = int(frames.nbytes) if hasattr(frames, "nbytes") else 0
                if frame_nbytes > AV_MEMORY_LIMIT - memory_used:
                    raise ValueError("Kedou AV Loader: estimated frame memory %.2fGB exceeds the 2GB limit"
                                     % (frame_nbytes / float(1024 ** 3)))
                values["frames_%d" % index] = frames
                memory_used += frame_nbytes

        out = [values.get(key) for key in layout]
        out.extend([None] * (av_state.AV_OUTPUT_SLOTS - len(out)))
        return tuple(out)


KedouAVLoader.DESCRIPTION = (
    "Multi-select videos and audio independently into visible semantic output ports within a "
    "%d-slot static return contract. Normal "
    "mode emits up to %d video/audio groups; Batch mode queues one cursor-indexed group at a "
    "time and supports up to %d stored items. Select outputs picked items in click order; "
    "an empty selection produces no output and is rejected. Video mode emits VIDEO; frames mode "
    "emits an IMAGE batch decoded in order. Enable video_audio to also decode each video's "
    "embedded audio track with the same trim window; videos without an audio stream emit "
    "None on that port. A video in the audio list still requires extract_audio=true. All "
    "audio (embedded and standalone) is preflighted together and shares one cumulative 2GB "
    "guard with retained frame bytes. Frame limits: start frame 100000, 128 frames, step 60, "
    "max side 2048. Each video/audio item supports trim_start seconds and trim_end seconds "
    "(null = through the end; start inclusive, end exclusive). Audio is sliced at exact "
    "sample positions after the official full decode; frames are filtered by timestamp inside "
    "the trim window before start_frame/frame_step/max_frames apply. Video output uses a "
    "cached PyAV stream copy without re-encoding; seek and cut boundaries are "
    "keyframe-approximate, and unsupported cuts return a Chinese error."
    % (av_state.AV_OUTPUT_SLOTS, av_state.AV_SLOTS, av_state.AV_ITEM_LIMIT)
)


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
    "KedouAVLoader": KedouAVLoader,
    "KedouPromptBox": KedouPromptBox,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "KedouImageLoader": "Kedou Image Loader",
    "KedouAVLoader": "Kedou AV Loader",
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

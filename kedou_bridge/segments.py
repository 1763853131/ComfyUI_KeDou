# -*- coding: utf-8 -*-
"""长视频分段分析与流复制导出。

快速引擎识别灰度缩帧上的硬切；可选 TransNetV2 或 OmniShotCut v1.5 高精度镜头检测。
所有解码和文件复制都在单一后台线程执行；HTTP 路由不直接跑这些耗时操作。
"""

from collections import OrderedDict, deque
import copy
import gc
import hashlib
import json
import math
import os
import shutil
import tempfile
import threading
import uuid
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

from . import media, paths


SEGMENTS_DIR = os.path.join(os.path.dirname(paths.WORKFLOW_DIR), "kedou_segments")
CACHE_DIR = os.path.join(SEGMENTS_DIR, "cache")
JOB_LIMIT = 128
SEGMENT_LIMIT = 500
SHOT_FRAME_SIZE = (96, 54)
SHOT_WINDOW = 16
_EPSILON = 1e-9

TRANSNET_WEIGHTS_URL = (
    "https://files.pythonhosted.org/packages/85/be/"
    "bb14f9015d357c9dff395a065bd658d1f7a199eb1f8d3abb9f4792416f11/"
    "transnetv2_pytorch-1.0.5-py3-none-any.whl"
)
_TRANSNET_WHEEL_SIZE = 32720474
_TRANSNET_WHEEL_SHA256 = "9f8e72085526aaa95383d219b6750b1fa45b865fd10d840cafa12ef78ab3bf27"
_TRANSNET_WEIGHT_NAME = "transnetv2-pytorch-weights.pth"
_TRANSNET_WEIGHT_MEMBER = "transnetv2_pytorch/" + _TRANSNET_WEIGHT_NAME
_TRANSNET_WEIGHT_SIZE = 30506391
_TRANSNET_WEIGHT_SHA256 = "a313d0b3bebfa9a71914b375bfdf918a30b5c3b1e6be51972d35dd8078b442de"
_TRANSNET_MODEL_LOCK = threading.Lock()
_TRANSNET_FOLDER_LOCK = threading.Lock()
_TRANSNET_REGISTERED_FOLDERS = set()

OMNISHOTCUT_WEIGHTS_URL = (
    "https://huggingface.co/uva-cv-lab/OmniShotCut_v1.5/resolve/main/OmniShotCut_ckpt.pth"
)
OMNISHOTCUT_WEIGHT_NAME = "OmniShotCut_ckpt.pth"
OMNISHOTCUT_WEIGHT_SIZE = 211261519
OMNISHOTCUT_WEIGHT_SHA256 = "5bafe33d8d0dde16c6e24fc63dfc580da9d5731804d6e51e1fc8de21d4600999"
OMNISHOTCUT_DETECTOR = "omnishotcut-v1.5"
_OMNISHOTCUT_MODEL_LOCK = threading.Lock()
_OMNISHOTCUT_FOLDER_LOCK = threading.Lock()
_OMNISHOTCUT_REGISTERED_FOLDERS = set()


class QueueFull(ValueError):
    """后台任务内存队列已满。"""


class _Cancelled(Exception):
    pass


class _Job:
    __slots__ = ("id", "status", "progress", "stage", "result", "error",
                 "cancelled", "cancel_event", "handler")

    def __init__(self, job_id, handler):
        self.id = job_id
        self.status = "queued"
        self.progress = 0.0
        self.stage = "等待执行"
        self.result = None
        self.error = None
        self.cancelled = False
        self.cancel_event = threading.Event()
        self.handler = handler

    def snapshot(self):
        return {
            "id": self.id,
            "status": self.status,
            "progress": self.progress,
            "stage": self.stage,
            "result": copy.deepcopy(self.result),
            "error": self.error,
            "cancelled": self.cancelled,
        }


_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kedou-segments")
_jobs = OrderedDict()
_jobs_lock = threading.RLock()


def _check_cancel(job):
    if job.cancel_event.is_set():
        raise _Cancelled()


def _update_job(job, progress=None, stage=None):
    with _jobs_lock:
        if job.cancelled or job.status not in ("queued", "running"):
            return
        if progress is not None:
            try:
                value = float(progress)
            except (TypeError, ValueError, OverflowError):
                return
            if math.isfinite(value):
                job.progress = max(0.0, min(1.0, value))
        if stage is not None:
            job.stage = str(stage)


def _mark_cancelled(job):
    with _jobs_lock:
        job.cancelled = True
        job.cancel_event.set()
        if job.status != "done":
            job.status = "cancelled"
            job.stage = "已取消"
            job.result = None
            job.error = None


def _run_job(job):
    with _jobs_lock:
        if job.cancel_event.is_set():
            job.cancelled = True
            job.status = "cancelled"
            job.stage = "已取消"
            return
        job.status = "running"
        job.stage = "正在准备"
    try:
        _check_cancel(job)
        result = job.handler(job)
        _check_cancel(job)
        with _jobs_lock:
            if job.cancelled:
                return
            job.result = copy.deepcopy(result)
            job.error = None
            job.progress = 1.0
            job.status = "done"
            if job.stage != "命中分析缓存":
                job.stage = "已完成"
    except _Cancelled:
        _mark_cancelled(job)
    except Exception as exc:  # noqa: BLE001
        with _jobs_lock:
            if job.cancelled:
                return
            job.status = "error"
            job.result = None
            job.error = _public_error(exc)


def _submit(handler):
    with _jobs_lock:
        # 只淘汰最旧的已结束任务；运行中的任务不能被新请求挤掉。
        while len(_jobs) >= JOB_LIMIT:
            oldest = next((job_id for job_id, job in _jobs.items()
                           if job.status in ("done", "error", "cancelled")), None)
            if oldest is None:
                raise QueueFull("分段任务队列已满，请稍后重试")
            _jobs.pop(oldest, None)
        job_id = uuid.uuid4().hex
        job = _Job(job_id, handler)
        _jobs[job_id] = job
        try:
            _executor.submit(_run_job, job)
        except Exception:
            _jobs.pop(job_id, None)
            raise
        return job_id


def get_job(job_id):
    with _jobs_lock:
        job = _jobs.get(str(job_id or ""))
        return job.snapshot() if job is not None else None


def cancel_job(job_id):
    with _jobs_lock:
        job = _jobs.get(str(job_id or ""))
        if job is None:
            return None
        job.cancel_event.set()
        if job.status in ("queued", "running"):
            job.cancelled = True
            job.status = "cancelled"
            job.stage = "已取消"
            job.result = None
            job.error = None
        return job.snapshot()


def _public_error(exc):
    text = str(exc or "").strip()
    if isinstance(exc, ImportError):
        return "PyAV 不可用，无法处理视频"
    if isinstance(exc, ValueError):
        return text or "视频分段参数无效"
    return "视频分段处理失败：%s" % (text or type(exc).__name__)


def _finite_number(value, name, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("%s 必须是有限数字" % name)
    try:
        number = float(value)
    except (OverflowError, ValueError) as exc:
        raise ValueError("%s 必须是有限数字" % name) from exc
    if not math.isfinite(number):
        raise ValueError("%s 必须是有限数字" % name)
    if minimum is not None and number < minimum:
        raise ValueError("%s 不能小于 %s" % (name, minimum))
    if maximum is not None and number > maximum:
        raise ValueError("%s 不能大于 %s" % (name, maximum))
    return number


def _source_fields(body):
    if not isinstance(body, dict):
        raise ValueError("请求体必须是 JSON 对象")
    name = body.get("name")
    if not isinstance(name, str):
        raise ValueError("name 必须是文件名")
    name = name.strip().replace("\\", "/")
    if (not name or "/" in name or "\x00" in name or any(ord(c) < 32 for c in name)
            or not paths._safe_id(name)):
        raise ValueError("不安全的视频文件名")
    if not name.lower().endswith(media.MEDIA_EXTS["video"]):
        raise ValueError("只支持视频文件")
    subfolder = body.get("subfolder", "")
    if subfolder is None:
        subfolder = ""
    if not isinstance(subfolder, str):
        raise ValueError("subfolder 必须是相对路径字符串")
    try:
        subfolder = media._safe_subfolder(subfolder)
    except ValueError as exc:
        raise ValueError(str(exc)) from exc
    tab = body.get("tab", "input")
    if tab not in ("input", "output"):
        raise ValueError("tab 必须是 input 或 output")
    return {"name": name, "subfolder": subfolder, "tab": tab}


def _reject_unknown_params(raw, allowed):
    unknown = [str(key) for key in raw if key not in allowed]
    if unknown:
        raise ValueError("不支持的分段参数：%s" % "、".join(sorted(unknown)))


def _compat_param(raw, name, alias, default):
    """兼容已发布面板的旧字段名；结果与缓存始终使用固定协议字段名。"""
    if name in raw and alias in raw and raw[name] != raw[alias]:
        raise ValueError("%s 与旧参数 %s 不能冲突" % (name, alias))
    return raw[name] if name in raw else raw.get(alias, default)


def validate_analyze_request(body):
    source = _source_fields(body)
    mode = body.get("mode")
    if mode not in ("duration", "shot"):
        raise ValueError("mode 必须是 duration 或 shot")
    raw = body.get("params", {})
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError("params 必须是对象")
    if mode == "duration":
        _reject_unknown_params(raw, {"segment_seconds", "remainder", "seconds", "tail"})
        seconds = _finite_number(_compat_param(raw, "segment_seconds", "seconds", 15),
                                 "segment_seconds", 0.5, 600)
        remainder = _compat_param(raw, "remainder", "tail", "keep")
        if remainder not in ("keep", "merge", "drop"):
            raise ValueError("remainder 必须是 keep、merge 或 drop")
        params = {"segment_seconds": seconds, "remainder": remainder}
    else:
        _reject_unknown_params(raw, {"engine", "threshold", "min_scene_len", "adaptive", "min_seconds"})
        engine = raw.get("engine", "fast")
        if engine not in ("fast", "transnet", "omnishotcut"):
            raise ValueError("engine 必须是 fast、transnet 或 omnishotcut")
        threshold = _finite_number(raw.get("threshold", 0.22 if engine == "fast" else 0.5),
                                   "threshold", 0.05 if engine == "fast" else 0.01,
                                   0.8 if engine == "fast" else 0.99)
        params = {
            "engine": engine,
            "threshold": threshold,
            "min_scene_len": _finite_number(_compat_param(raw, "min_scene_len", "min_seconds", 1.0),
                                            "min_scene_len", 0.2, 30),
            "adaptive": _finite_number(raw.get("adaptive", 2.5), "adaptive", 1, 6),
        }
    return source, mode, params


def validate_export_request(body):
    source = _source_fields(body)
    if body.get("mode") != "copy":
        raise ValueError("首版导出只支持 mode='copy'，不支持精确重编码")
    raw_segments = body.get("segments")
    if not isinstance(raw_segments, list):
        raise ValueError("segments 必须是数组")
    if not raw_segments:
        raise ValueError("至少选择一个导出片段")
    if len(raw_segments) > SEGMENT_LIMIT:
        raise ValueError("导出片段不能超过 %d 段" % SEGMENT_LIMIT)
    return source, validate_export_segments(raw_segments)


def validate_export_segments(raw_segments, duration=None):
    if not isinstance(raw_segments, list):
        raise ValueError("segments 必须是数组")
    if not raw_segments:
        raise ValueError("至少选择一个导出片段")
    if len(raw_segments) > SEGMENT_LIMIT:
        raise ValueError("导出片段不能超过 %d 段" % SEGMENT_LIMIT)
    out = []
    previous_end = 0.0
    for index, raw in enumerate(raw_segments, 1):
        if not isinstance(raw, dict):
            raise ValueError("第 %d 段必须是对象" % index)
        start = _finite_number(raw.get("start"), "第 %d 段 start" % index, 0)
        end = _finite_number(raw.get("end"), "第 %d 段 end" % index, 0)
        if end <= start:
            raise ValueError("第 %d 段 end 必须大于 start" % index)
        if duration is not None and end > duration:
            raise ValueError("第 %d 段 end 超出视频时长" % index)
        if start < previous_end:
            raise ValueError("导出片段必须按 start 排序且不能重叠")
        previous_end = end
        out.append({"start": start, "end": end})
    return out


def start_analyze(body):
    source, mode, params = validate_analyze_request(body)
    return _submit(lambda job: _analyze(job, source, mode, params))


def start_export(body):
    source, segments = validate_export_request(body)
    return _submit(lambda job: _export(job, source, segments))


def _resolve_source(source):
    src, used = media._resolve_media_file(source["name"], source["subfolder"], source["tab"])
    if not src:
        raise ValueError("文件不存在，或不在输入/输出目录内")
    src = os.path.abspath(os.fspath(src))
    try:
        stat = os.stat(src)
    except OSError as exc:
        raise ValueError("视频文件读取失败：%s" % exc) from exc
    return src, used, stat


def _duration(src):
    try:
        info = media._av_metadata(src)
    except ImportError as exc:
        raise ValueError("PyAV 不可用，无法读取视频信息") from exc
    except Exception as exc:  # noqa: BLE001
        raise ValueError("读取视频信息失败：%s" % exc) from exc
    duration = info.get("duration") if isinstance(info, dict) else None
    if (isinstance(duration, bool) or not isinstance(duration, (int, float))
            or not math.isfinite(float(duration)) or float(duration) <= 0):
        raise ValueError("无法确定视频时长，拒绝分段")
    # 真视频必须有画面尺寸；允许测试/兼容实现只返回 duration。
    if "width" in info and not info.get("width"):
        raise ValueError("文件没有可识别的视频流")
    return float(duration)


def _source_result(source, src, used, stat):
    return {
        "name": os.path.basename(src),
        "subfolder": source["subfolder"],
        "tab": used,
        "mtime_ns": int(stat.st_mtime_ns),
        "size": int(stat.st_size),
    }


def _ensure_source_unchanged(src, stat):
    try:
        current = os.stat(src)
    except OSError as exc:
        raise ValueError("视频文件在处理期间读取失败：%s" % exc) from exc
    if current.st_mtime_ns != stat.st_mtime_ns or current.st_size != stat.st_size:
        raise ValueError("源视频在处理期间已变化，请重试")


def _cache_key(src, stat, mode, params):
    source = os.path.normcase(os.path.realpath(os.path.abspath(os.fspath(src))))
    payload_data = {"mode": mode, "params": params}
    if mode == "shot" and params.get("engine") == "transnet":
        payload_data["detector"] = "transnetv2-1.0.5"
    elif mode == "shot" and params.get("engine") == "omnishotcut":
        payload_data["detector"] = OMNISHOTCUT_DETECTOR
    payload = json.dumps(payload_data, ensure_ascii=False,
                         sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256()
    for value in ("video-segments-v1", source, str(int(stat.st_mtime_ns)),
                  str(int(stat.st_size)), payload):
        raw = value.encode("utf-8")
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)
    return digest.hexdigest()


def _valid_cached_result(result, source_result, mode, params):
    try:
        if (not isinstance(result, dict) or result.get("v") != 1
                or result.get("source") != source_result
                or result.get("mode") != mode or result.get("params") != params):
            return False
        duration = float(result["duration"])
        if not math.isfinite(duration) or duration <= 0:
            return False
        segments = result["segments"]
        if not isinstance(segments, list) or not segments or len(segments) > SEGMENT_LIMIT:
            return False
        previous = 0.0
        for segment in segments:
            start, end = float(segment["start"]), float(segment["end"])
            if (not math.isfinite(start) or not math.isfinite(end)
                    or start < previous or start < 0 or end <= start or end > duration):
                return False
            if "confidence" in segment:
                confidence = float(segment["confidence"])
                if not math.isfinite(confidence) or not 0 <= confidence <= 1:
                    return False
            previous = end
        if segments and abs(float(segments[0]["start"])) > _EPSILON:
            return False
        drop_tail = mode == "duration" and params.get("remainder") == "drop"
        if not drop_tail and abs(previous - duration) > _EPSILON:
            return False
        return True
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def _load_cache(key, source_result, mode, params):
    path = os.path.join(CACHE_DIR, key + ".json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            result = json.load(handle)
    except (OSError, ValueError, TypeError):
        return None
    return result if _valid_cached_result(result, source_result, mode, params) else None


def _write_cache(key, result):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        paths._dump_json_atomic(os.path.join(CACHE_DIR, key + ".json"), result)
    except OSError as exc:
        print("[KeDou] 分析缓存写入失败（本次结果仍可使用）：%s" % exc)


def _analyze(job, source, mode, params):
    _update_job(job, 0.02, "正在定位视频")
    src, used, stat = _resolve_source(source)
    _check_cancel(job)
    _update_job(job, 0.05, "正在读取视频信息")
    duration = _duration(src)
    _ensure_source_unchanged(src, stat)
    source_result = _source_result(source, src, used, stat)
    key = _cache_key(src, stat, mode, params)
    cached = _load_cache(key, source_result, mode, params)
    _check_cancel(job)
    if cached is not None:
        _update_job(job, 1.0, "命中分析缓存")
        return cached

    if mode == "duration":
        _update_job(job, 0.15, "正在按时长分段")
        segments = duration_segments(duration, params["segment_seconds"], params["remainder"])
        if not segments:
            raise ValueError("分段结果为空，请增大视频时长或调整尾段处理")
        _update_job(job, 0.9, "正在生成分段结果")
    else:
        if params["engine"] == "transnet":
            _update_job(job, 0.08, "正在准备AI镜头检测")
            segments = _detect_shots_model(src, duration, params, job)
            _update_job(job, 0.9, "正在生成AI镜头分段")
        elif params["engine"] == "omnishotcut":
            _update_job(job, 0.08, "正在准备OmniShotCut高精度镜头检测")
            segments = _detect_shots_omnishotcut(src, duration, params, job)
            _update_job(job, 0.9, "正在生成高精度镜头分段")
        else:
            _update_job(job, 0.08, "正在解码视频检测硬切")
            segments = _detect_shots(src, duration, params, job)
            _update_job(job, 0.9, "正在生成镜头分段")

    _check_cancel(job)
    _ensure_source_unchanged(src, stat)
    result = {
        "v": 1,
        "source": source_result,
        "mode": mode,
        "params": copy.deepcopy(params),
        "duration": duration,
        "segments": segments,
    }
    _update_job(job, 0.96, "正在写入分析缓存")
    _write_cache(key, result)
    return result


def duration_segments(duration, segment_seconds=15, remainder="keep"):
    duration = _finite_number(duration, "duration", 0)
    if duration <= 0:
        raise ValueError("视频时长必须大于 0")
    seconds = _finite_number(segment_seconds, "segment_seconds", 0.5, 600)
    if remainder not in ("keep", "merge", "drop"):
        raise ValueError("remainder 必须是 keep、merge 或 drop")
    quotient = duration / seconds
    if not math.isfinite(quotient) or quotient > SEGMENT_LIMIT + 1:
        raise ValueError("分段结果超过 %d 段上限" % SEGMENT_LIMIT)
    full = int(math.floor(quotient + 1e-12))
    tail = duration - full * seconds
    if tail <= _EPSILON:
        tail = 0.0
    if remainder == "drop":
        count = full
    elif remainder == "merge" and tail > 0 and full > 0:
        count = full
    else:
        count = full + (1 if tail > 0 else 0)
    if count > SEGMENT_LIMIT:
        raise ValueError("分段结果超过 %d 段上限" % SEGMENT_LIMIT)
    segments = [{"start": index * seconds, "end": (index + 1) * seconds}
                for index in range(full)]
    if segments and not tail:
        segments[-1]["end"] = duration
    if tail > 0:
        if remainder == "drop":
            pass
        elif remainder == "merge" and segments:
            segments[-1]["end"] = duration
        else:
            # 只有一个短尾段时无法并入前段，保留它，避免得到空结果。
            segments.append({"start": full * seconds, "end": duration})
    if len(segments) > SEGMENT_LIMIT:
        raise ValueError("分段结果超过 %d 段上限" % SEGMENT_LIMIT)
    return segments


def _frame_seconds(frame, index, stream, rate):
    """PTS 优先；缺失时才退回帧时间和平均帧率，兼容 VFR。"""
    pts = getattr(frame, "pts", None)
    time_base = getattr(frame, "time_base", None) or getattr(stream, "time_base", None)
    if pts is not None and time_base:
        try:
            return float(pts * time_base)
        except (TypeError, ValueError, OverflowError):
            pass
    frame_time = getattr(frame, "time", None)
    if frame_time is not None:
        try:
            value = float(frame_time)
            if math.isfinite(value):
                return value
        except (TypeError, ValueError, OverflowError):
            pass
    return index / rate if rate > 0 else index / 30.0


def _frame_array(frame):
    try:
        return frame.to_ndarray(format="gray")
    except TypeError:
        return frame.to_ndarray()


def _gray_frame(frame):
    """PyAV 原生缩成约 96x54 灰度；兼容实现/测试帧用 NumPy 回退。"""
    import numpy as np

    array = None
    reformat = getattr(frame, "reformat", None)
    if callable(reformat):
        try:
            small = reformat(width=SHOT_FRAME_SIZE[0], height=SHOT_FRAME_SIZE[1], format="gray")
            if small is not None:
                array = _frame_array(small)
        except (AttributeError, TypeError, ValueError, RuntimeError):
            array = None
    if array is None:
        array = _frame_array(frame)
    array = np.asarray(array)
    if array.ndim == 3:
        rgb = array[..., :3].astype(np.float32)
        array = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114
    elif array.ndim != 2:
        raise ValueError("无法把视频帧转换为灰度图")
    if array.shape != SHOT_FRAME_SIZE:
        height, width = array.shape[:2]
        if height <= 0 or width <= 0:
            raise ValueError("视频帧尺寸无效")
        ys = np.linspace(0, height - 1, SHOT_FRAME_SIZE[1]).astype(np.intp)
        xs = np.linspace(0, width - 1, SHOT_FRAME_SIZE[0]).astype(np.intp)
        array = array[ys[:, None], xs[None, :]]
    if np.issubdtype(array.dtype, np.integer):
        array = array.astype(np.float32) / 255.0
    else:
        array = array.astype(np.float32)
        if array.size and float(np.nanmax(array)) > 1.5:
            array /= 255.0
    if not np.all(np.isfinite(array)):
        raise ValueError("视频帧包含无效像素")
    return array


def _file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _transnet_model_folders():
    """Return ComfyUI-registered TransNetV2 model folders, including the default one."""
    try:
        import folder_paths
    except ImportError:
        return []
    folders = []
    try:
        default = os.path.join(os.fspath(folder_paths.models_dir), "transnetv2")
        folders.append(default)
        key = os.path.normcase(os.path.abspath(default))
        with _TRANSNET_FOLDER_LOCK:
            if key not in _TRANSNET_REGISTERED_FOLDERS:
                folder_paths.add_model_folder_path("transnetv2", default)
                _TRANSNET_REGISTERED_FOLDERS.add(key)
    except (AttributeError, TypeError, ValueError, OSError):
        pass
    try:
        folders.extend(folder_paths.get_folder_paths("transnetv2") or [])
    except (AttributeError, TypeError, ValueError):
        pass
    out = []
    seen = set()
    for folder in folders:
        try:
            path = os.path.abspath(os.fspath(folder))
        except (TypeError, ValueError, OSError):
            continue
        key = os.path.normcase(path)
        if key not in seen:
            seen.add(key)
            out.append(path)
    return out


def _omnishotcut_model_folders():
    """Register and return OmniShotCut folders, always including ComfyUI's default."""
    folders = []
    try:
        import folder_paths
    except ImportError:
        folder_paths = None
    if folder_paths is not None:
        try:
            default = os.path.join(os.fspath(folder_paths.models_dir), "omnishotcut")
            folders.append(default)
            key = os.path.normcase(os.path.abspath(default))
            with _OMNISHOTCUT_FOLDER_LOCK:
                if key not in _OMNISHOTCUT_REGISTERED_FOLDERS:
                    folder_paths.add_model_folder_path("omnishotcut", default)
                    _OMNISHOTCUT_REGISTERED_FOLDERS.add(key)
        except (AttributeError, TypeError, ValueError, OSError):
            folders.append(os.path.join(os.fspath(paths.COMFY_ROOT), "models", "omnishotcut"))
        try:
            folders.extend(folder_paths.get_folder_paths("omnishotcut") or [])
        except (AttributeError, TypeError, ValueError):
            pass
    else:
        folders.append(os.path.join(os.fspath(paths.COMFY_ROOT), "models", "omnishotcut"))
    out, seen = [], set()
    for folder in folders:
        try:
            path = os.path.abspath(os.fspath(folder))
        except (TypeError, ValueError, OSError):
            continue
        key = os.path.normcase(path)
        if key not in seen:
            seen.add(key)
            out.append(path)
    return out


def _omnishotcut_weight_candidates(destination):
    return [os.path.join(folder, OMNISHOTCUT_WEIGHT_NAME)
            for folder in _omnishotcut_model_folders()] + [destination]


def _valid_omnishotcut_weights(path):
    try:
        return (os.path.isfile(path)
                and os.path.getsize(path) == OMNISHOTCUT_WEIGHT_SIZE
                and _file_sha256(path) == OMNISHOTCUT_WEIGHT_SHA256)
    except OSError:
        return False


def _download_omnishotcut_to_file(url, path, job):
    """Stream the official checkpoint with a hard byte ceiling."""
    request = urllib.request.Request(url, headers={"User-Agent": "KeDou-Bridge/OmniShotCut-v1.5"})
    written = 0
    with urllib.request.urlopen(request, timeout=60) as response, open(path, "wb") as handle:
        while True:
            _check_cancel(job)
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > OMNISHOTCUT_WEIGHT_SIZE:
                raise ValueError("OmniShotCut模型权重校验失败：官方文件大小不符合预期")
            handle.write(chunk)
        handle.flush()
        os.fsync(handle.fileno())
    if written != OMNISHOTCUT_WEIGHT_SIZE:
        raise ValueError("OmniShotCut模型权重校验失败：官方文件大小不符合预期")


def _ensure_omnishotcut_weights(job):
    """Model folders first, then user cache, then verified atomic download."""
    model_dir = os.path.join(SEGMENTS_DIR, "models", "omnishotcut")
    destination = os.path.join(model_dir, OMNISHOTCUT_WEIGHT_NAME)
    with _OMNISHOTCUT_MODEL_LOCK:
        _check_cancel(job)
        for candidate in _omnishotcut_weight_candidates(destination):
            if _valid_omnishotcut_weights(candidate):
                return candidate
        temporary = None
        try:
            os.makedirs(model_dir, exist_ok=True)
            if os.path.lexists(destination) and not os.path.isfile(destination):
                raise ValueError("OmniShotCut模型权重路径不是普通文件：%s" % destination)
            _update_job(job, stage="正在下载OmniShotCut模型")
            fd, temporary = tempfile.mkstemp(dir=model_dir, prefix=".omnishotcut-weights-", suffix=".tmp")
            os.close(fd)
            _download_omnishotcut_to_file(OMNISHOTCUT_WEIGHTS_URL, temporary, job)
            _check_cancel(job)
            # Two direct-weight checks: size first, then official SHA-256.
            if os.path.getsize(temporary) != OMNISHOTCUT_WEIGHT_SIZE:
                raise ValueError("OmniShotCut模型权重校验失败：文件大小不符合官方值")
            if _file_sha256(temporary) != OMNISHOTCUT_WEIGHT_SHA256:
                raise ValueError("OmniShotCut模型权重校验失败：SHA-256 不匹配")
            _check_cancel(job)
            os.replace(temporary, destination)
            temporary = None
            return destination
        except _Cancelled:
            raise
        except ValueError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ValueError("下载OmniShotCut模型失败：%s" % (str(exc) or type(exc).__name__)) from exc
        finally:
            if temporary:
                try:
                    os.remove(temporary)
                except OSError:
                    pass


def _transnet_weight_candidates(destination):
    folders = _transnet_model_folders()
    return [os.path.join(folder, _TRANSNET_WEIGHT_NAME) for folder in folders] + [destination]


def _valid_transnet_weights(path):
    try:
        if (not os.path.isfile(path)
                or os.path.getsize(path) != _TRANSNET_WEIGHT_SIZE
                or _file_sha256(path) != _TRANSNET_WEIGHT_SHA256):
            return False
        return True
    except OSError:
        return False


def _download_to_file(url, path, job):
    """流式下载，不在内存中缓存整个 wheel。"""
    request = urllib.request.Request(url, headers={"User-Agent": "KeDou-Bridge/TransNetV2"})
    written = 0
    with urllib.request.urlopen(request, timeout=60) as response, open(path, "wb") as handle:
        while True:
            _check_cancel(job)
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > _TRANSNET_WHEEL_SIZE:
                raise ValueError("AI模型权重校验失败：官方 wheel 大小不符合预期")
            handle.write(chunk)
        handle.flush()
        os.fsync(handle.fileno())
    if written != _TRANSNET_WHEEL_SIZE:
        raise ValueError("AI模型权重校验失败：官方 wheel 大小不符合预期")


def _ensure_transnet_weights(job):
    """Prefer ComfyUI model folders, then the user cache, then download atomically."""
    model_dir = os.path.join(SEGMENTS_DIR, "models", "transnetv2")
    destination = os.path.join(model_dir, _TRANSNET_WEIGHT_NAME)
    with _TRANSNET_MODEL_LOCK:
        _check_cancel(job)
        for candidate in _transnet_weight_candidates(destination):
            if _valid_transnet_weights(candidate):
                return candidate
        wheel_tmp = None
        weight_tmp = None
        try:
            os.makedirs(model_dir, exist_ok=True)
            if os.path.lexists(destination):
                if not os.path.isfile(destination):
                    raise ValueError("AI模型权重路径不是普通文件：%s" % destination)
                os.remove(destination)
            _update_job(job, stage="正在下载AI模型权重")
            fd, wheel_tmp = tempfile.mkstemp(dir=model_dir, prefix=".transnet-wheel-", suffix=".tmp")
            os.close(fd)
            _download_to_file(TRANSNET_WEIGHTS_URL, wheel_tmp, job)
            _check_cancel(job)
            if _file_sha256(wheel_tmp) != _TRANSNET_WHEEL_SHA256:
                raise ValueError("AI模型权重校验失败：官方 wheel 的 SHA-256 不匹配")

            fd, weight_tmp = tempfile.mkstemp(dir=model_dir, prefix=".transnet-weights-", suffix=".tmp")
            digest = hashlib.sha256()
            written = 0
            with os.fdopen(fd, "wb") as output, zipfile.ZipFile(wheel_tmp, "r") as archive:
                if _TRANSNET_WEIGHT_MEMBER not in archive.namelist():
                    raise ValueError("AI模型权重校验失败：wheel 内没有官方权重文件")
                with archive.open(_TRANSNET_WEIGHT_MEMBER, "r") as source:
                    while True:
                        _check_cancel(job)
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > _TRANSNET_WEIGHT_SIZE:
                            raise ValueError("AI模型权重校验失败：权重文件大小不符合官方值")
                        digest.update(chunk)
                        output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if written != _TRANSNET_WEIGHT_SIZE:
                raise ValueError("AI模型权重校验失败：权重文件大小不符合官方值")
            if digest.hexdigest() != _TRANSNET_WEIGHT_SHA256:
                raise ValueError("AI模型权重校验失败：权重文件的 SHA-256 不匹配")
            _check_cancel(job)
            os.replace(weight_tmp, destination)
            weight_tmp = None
            return destination
        except _Cancelled:
            raise
        except ValueError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ValueError("下载AI模型权重失败：%s" % (str(exc) or type(exc).__name__)) from exc
        finally:
            for temporary in (wheel_tmp, weight_tmp):
                if temporary:
                    try:
                        os.remove(temporary)
                    except OSError:
                        pass


def _create_transnet_model(weights_path):
    from .vendor.transnetv2 import TransNetV2

    return TransNetV2(device="auto", weights_path=weights_path)


def _transnet_frame(frame):
    """Decode one frame directly to the model's uint8 RGB input size."""
    import numpy as np

    reformat = getattr(frame, "reformat", None)
    small = frame
    if callable(reformat):
        try:
            small = reformat(width=48, height=27, format="rgb24")
            if small is None:
                small = frame
        except (AttributeError, TypeError, ValueError, RuntimeError):
            small = frame
    try:
        array = small.to_ndarray(format="rgb24")
    except TypeError:
        array = _frame_array(small)
    array = np.asarray(array)
    if array.shape != (27, 48, 3):
        raise ValueError("无法把视频帧转换为 TransNetV2 所需的 48x27 RGB 图")
    if array.dtype != np.uint8:
        raise ValueError("TransNetV2 视频帧必须是 uint8 RGB 像素")
    return np.ascontiguousarray(array)


def _transnet_window_input(buffer, next_window, decoded, final):
    """Reproduce official padding for one 100-frame window without whole-video frames."""
    import numpy as np

    frames = list(buffer)
    if not frames:
        raise ValueError("AI镜头检测窗口为空")
    prefix = suffix = 0
    if next_window == 0:
        first_real = 0
        real = frames if final else frames[:75]
        prefix = 25
    elif final:
        first_real = next_window - 25
        real = frames[-(decoded - first_real):]
    else:
        first_real = next_window - 25
        real = frames[-100:]
    suffix = 100 - prefix - len(real)
    if suffix < 0 or (first_real < 0 and next_window != 0):
        raise ValueError("AI镜头检测窗口索引无效")
    parts = []
    if prefix:
        parts.append(np.repeat(frames[0][None], prefix, axis=0))
    parts.append(np.stack(real))
    if suffix:
        parts.append(np.repeat(frames[-1][None], suffix, axis=0))
    window = np.concatenate(parts, axis=0)
    if window.shape != (100, 27, 48, 3) or window.dtype != np.uint8:
        raise ValueError("AI镜头检测窗口形状无效")
    return window


def _prediction_array(value):
    import numpy as np

    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    array = np.asarray(value, dtype=np.float32)
    if array.shape != (1, 100, 1) or not np.all(np.isfinite(array)):
        raise ValueError("TransNetV2 模型输出形状或数值无效")
    return np.clip(array, 0.0, 1.0)


def _predict_transnet_window(model, torch_module, device, window, job):
    batch = torch_module.from_numpy(window[None]).to(device)
    try:
        with torch_module.inference_mode():
            single, many_hot = model.predict_raw(batch)
        single = _prediction_array(single)
        _prediction_array(many_hot)  # Validate both official heads; cuts use single-frame probabilities.
        _check_cancel(job)
        return single[0, 25:75, 0].copy()
    finally:
        del batch


def _transnet_segments(duration, frame_times, probabilities, params):
    import numpy as np

    if len(frame_times) != len(probabilities) or not frame_times:
        raise ValueError("AI镜头检测没有有效的逐帧预测")
    values = np.asarray(probabilities, dtype=np.float32)
    threshold = params["threshold"]
    minimum = params["min_scene_len"]
    cuts = []
    last_cut = 0.0
    was_high = bool(values[0] > threshold)
    for index in range(1, len(values)):
        high = bool(values[index] > threshold)
        if high and not was_high:
            timestamp = float(frame_times[index])
            long_enough = timestamp - last_cut + _EPSILON >= minimum
            final_long_enough = duration - timestamp + _EPSILON >= minimum
            if (timestamp > 0 and timestamp < duration and long_enough and final_long_enough):
                if len(cuts) + 1 > SEGMENT_LIMIT:
                    raise ValueError("镜头分段结果超过 %d 段上限" % SEGMENT_LIMIT)
                cuts.append((timestamp, float(values[index])))
                last_cut = timestamp
        was_high = high
    segments = []
    start = 0.0
    for end, confidence in cuts:
        segments.append({"start": start, "end": end, "confidence": confidence})
        start = end
    segments.append({"start": start, "end": duration})
    return segments


def _omnishotcut_frame(frame, width, height):
    """PyAV native RGB reformat; no whole-video frame storage."""
    import numpy as np

    reformat = getattr(frame, "reformat", None)
    small = frame
    if callable(reformat):
        try:
            small = reformat(width=width, height=height, format="rgb24")
            if small is None:
                small = frame
        except (AttributeError, TypeError, ValueError, RuntimeError):
            small = frame
    try:
        array = small.to_ndarray(format="rgb24")
    except TypeError:
        array = _frame_array(small)
    array = np.asarray(array)
    if array.shape != (height, width, 3) or array.dtype != np.uint8:
        raise ValueError("无法把视频帧转换为 OmniShotCut 所需的 uint8 RGB 图")
    return np.ascontiguousarray(array)


def _omnishotcut_segments(duration, frame_times, prediction, params, vendor):
    """Convert official end-exclusive frame ranges to PTS-based seconds."""
    if len(frame_times) != prediction["ranges"][-1][1]:
        raise ValueError("OmniShotCut 帧范围与解码帧数不一致")
    ranges = prediction["ranges"]
    minimum = params["min_scene_len"]
    accepted = []
    last_cut = 0
    for index, (start, end) in enumerate(ranges[:-1]):
        end_time = float(frame_times[end]) if end < len(frame_times) else duration
        last_time = float(frame_times[last_cut]) if last_cut else 0.0
        if (end_time - last_time + _EPSILON < minimum):
            continue
        if duration - end_time + _EPSILON < minimum:
            continue
        accepted.append(index)
        last_cut = end
    boundaries = [0] + [ranges[index][1] for index in accepted] + [len(frame_times)]
    selected = [0] + [index + 1 for index in accepted] + [len(ranges) - 1]
    segments = []
    for output_index, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
        source_index = selected[output_index]
        start_time = 0.0 if start == 0 else float(frame_times[min(start, len(frame_times) - 1)])
        end_time = duration if end >= len(frame_times) else float(frame_times[end])
        segment = {"start": max(0.0, start_time), "end": max(start_time, end_time)}
        confidence = prediction["confidence"][source_index]
        if confidence is not None:
            segment["confidence"] = max(0.0, min(1.0, float(confidence)))
        intra = prediction["intra_labels"][source_index]
        inter = prediction["inter_labels"][source_index]
        segment["relation"] = vendor.intra_int2string.get(intra, str(intra))
        segment["transition"] = vendor.inter_int2string.get(inter, str(inter))
        segments.append(segment)
    if not segments or segments[-1]["end"] < duration:
        start = segments[-1]["end"] if segments else 0.0
        segments.append({"start": start, "end": duration})
    if len(segments) > SEGMENT_LIMIT:
        raise ValueError("镜头分段结果超过 %d 段上限" % SEGMENT_LIMIT)
    return segments


def _detect_shots_omnishotcut(src, duration, params, job):
    """Stream PyAV decode through official OmniShotCut v1.5 overlapping windows."""
    _update_job(job, 0.10, "正在检查OmniShotCut模型")
    try:
        import torch
    except ImportError as exc:
        raise ValueError("PyTorch 不可用，无法加载OmniShotCut高精度模型") from exc

    model = None
    device = None
    try:
        weights_path = _ensure_omnishotcut_weights(job)
        _check_cancel(job)
        _update_job(job, 0.12, "正在加载高精度模型")
        try:
            from .vendor import omnishotcut as vendor
        except ImportError as exc:
            raise ValueError("OmniShotCut 推理组件不可用，请检查 torch/torchvision 安装") from exc
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model, args = vendor.load_model(weights_path, device=device)
        device = getattr(model, "device", None) or device
        _check_cancel(job)
        try:
            import av
        except ImportError as exc:
            raise ValueError("PyAV 不可用，无法检测镜头") from exc
        chunk_size = int(args.max_process_window_length)
        width, height = int(args.process_width), int(args.process_height)
        overlap = 10
        if chunk_size <= overlap or width <= 0 or height <= 0:
            raise ValueError("OmniShotCut checkpoint 的窗口或分辨率参数无效")
        with av.open(src, mode="r") as container:
            stream = next((item for item in container.streams if item.type == "video"), None)
            if stream is None:
                raise ValueError("文件没有视频流，无法检测镜头")
            try:
                rate = float(stream.average_rate) if stream.average_rate else 0.0
            except (TypeError, ValueError, OverflowError):
                rate = 0.0
            frame_buffer = deque(maxlen=chunk_size)
            frame_times = []
            decoded = 0
            next_window = 0
            origin = None
            previous_time = None

            def window_stream():
                nonlocal decoded, next_window, origin, previous_time
                decoder = iter(container.decode(stream))
                pending = None
                exhausted = False
                while not exhausted:
                    frame = pending if pending is not None else next(decoder, None)
                    pending = None
                    if frame is None:
                        exhausted = True
                        break
                    _check_cancel(job)
                    raw_time = _frame_seconds(frame, decoded, stream, rate)
                    if not math.isfinite(raw_time):
                        raw_time = decoded / (rate or 30.0)
                    if origin is None:
                        origin = raw_time
                    timestamp = max(0.0, raw_time - origin)
                    if previous_time is not None and timestamp <= previous_time + 1e-9:
                        continue
                    frame_buffer.append(_omnishotcut_frame(frame, width, height))
                    frame_times.append(timestamp)
                    previous_time = timestamp
                    decoded += 1
                    _update_job(job, 0.12 + 0.76 * min(1.0, timestamp / duration),
                                "正在高精度检测镜头")
                    if len(frame_buffer) < chunk_size:
                        continue
                    # One-frame lookahead distinguishes a final full window from a
                    # non-final one, exactly matching official split_videos at EOF.
                    pending = next(decoder, None)
                    final = pending is None
                    valid_start = 0 if next_window == 0 else next_window + overlap // 2
                    valid_end = (decoded if final else
                                 next_window + chunk_size - (overlap - overlap // 2))
                    yield (np_stack_window(frame_buffer, chunk_size, height, width), chunk_size,
                           next_window, valid_start, valid_end)
                    if final:
                        return
                    for _ in range(chunk_size - overlap):
                        frame_buffer.popleft()
                    next_window += chunk_size - overlap
                _check_cancel(job)
                if not decoded:
                    raise ValueError("没有可解码的视频帧")
                if frame_buffer:
                    valid_start = 0 if next_window == 0 else next_window + overlap // 2
                    yield (np_stack_window(frame_buffer, chunk_size, height, width), len(frame_buffer),
                           next_window, valid_start, decoded)

            def progress(_count):
                timestamp = frame_times[-1] if frame_times else 0.0
                _update_job(job, 0.12 + 0.76 * min(1.0, timestamp / duration),
                            "正在高精度检测镜头")

            prediction = vendor.infer_windows(model, args, window_stream(), device=device,
                                              overlap=overlap, check_cancel=lambda: _check_cancel(job),
                                              progress=progress)
            _check_cancel(job)
            return _omnishotcut_segments(duration, frame_times, prediction, params, vendor)
    except _Cancelled:
        raise
    except Exception as exc:  # noqa: BLE001
        oom_type = getattr(torch.cuda, "OutOfMemoryError", ())
        is_oom = isinstance(exc, oom_type) if oom_type else False
        if not is_oom and str(device).startswith("cuda") and "out of memory" in str(exc).lower():
            is_oom = True
        if is_oom:
            raise ValueError("CUDA 显存不足，无法运行 OmniShotCut 高精度镜头检测；请关闭其他占显存程序后重试") from exc
        if isinstance(exc, ValueError):
            raise
        raise ValueError("OmniShotCut高精度镜头检测失败：%s" % (str(exc) or type(exc).__name__)) from exc
    finally:
        del model
        gc.collect()
        try:
            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass


def np_stack_window(frames, chunk_size, height, width):
    """Pad one bounded official window with black frames."""
    import numpy as np

    values = list(frames)
    if not values:
        raise ValueError("OmniShotCut检测窗口为空")
    window = np.stack(values, axis=0)
    missing = chunk_size - window.shape[0]
    if missing:
        padding = np.zeros((missing, height, width, 3), dtype=np.uint8)
        window = np.concatenate([window, padding], axis=0)
    if window.shape != (chunk_size, height, width, 3):
        raise ValueError("OmniShotCut检测窗口形状无效")
    return window


def _detect_shots_model(src, duration, params, job):
    """Stream PyAV frames through TransNetV2 using bounded 100-frame windows."""
    _update_job(job, 0.08, "正在加载AI检测模型")
    try:
        import torch
    except ImportError as exc:
        raise ValueError("PyTorch 不可用，无法加载AI检测模型") from exc

    model = None
    try:
        weights_path = _ensure_transnet_weights(job)
        _check_cancel(job)
        _update_job(job, 0.12, "正在加载AI检测模型")
        model = _create_transnet_model(weights_path)
        device = getattr(model, "device", None)
        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        _check_cancel(job)
        try:
            import av
        except ImportError as exc:
            raise ValueError("PyAV 不可用，无法检测镜头") from exc
        with av.open(src, mode="r") as container:
            stream = next((item for item in container.streams if item.type == "video"), None)
            if stream is None:
                raise ValueError("文件没有视频流，无法检测镜头")
            rate_value = getattr(stream, "average_rate", None)
            try:
                rate = float(rate_value) if rate_value else 0.0
            except (TypeError, ValueError, OverflowError):
                rate = 0.0

            frame_buffer = deque(maxlen=100)
            time_buffer = deque(maxlen=100)
            frame_times = []
            probabilities = []
            decoded = 0
            next_window = 0
            origin = None
            previous_time = None

            def infer_window(final):
                nonlocal next_window
                window = _transnet_window_input(frame_buffer, next_window, decoded, final)
                values = _predict_transnet_window(model, torch, device, window, job)
                count = min(50, decoded - next_window) if final else 50
                probabilities.extend(float(value) for value in values[:count])
                next_window += 50
                _update_job(job, 0.12 + 0.76 * min(1.0, time_buffer[-1] / duration),
                            "正在AI检测镜头")

            for frame in container.decode(stream):
                _check_cancel(job)
                raw_time = _frame_seconds(frame, decoded, stream, rate)
                if not math.isfinite(raw_time):
                    raw_time = decoded / (rate or 30.0)
                if origin is None:
                    origin = raw_time
                timestamp = max(0.0, raw_time - origin)
                if previous_time is not None and timestamp <= previous_time + 1e-9:
                    continue
                rgb = _transnet_frame(frame)
                frame_buffer.append(rgb)
                time_buffer.append(timestamp)
                frame_times.append(timestamp)
                previous_time = timestamp
                decoded += 1
                _update_job(job, 0.12 + 0.76 * min(1.0, timestamp / duration),
                            "正在AI检测镜头")
                if next_window + 75 <= decoded:
                    infer_window(False)
            _check_cancel(job)
            if not decoded:
                raise ValueError("没有可解码的视频帧")
            while next_window < decoded:
                infer_window(True)
            _check_cancel(job)
            return _transnet_segments(duration, frame_times, probabilities, params)
    except _Cancelled:
        raise
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ValueError("AI镜头检测失败：%s" % (str(exc) or type(exc).__name__)) from exc
    finally:
        del model
        gc.collect()
        try:
            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass


def _detect_shots(src, duration, params, job):
    try:
        import av
    except ImportError as exc:
        raise ValueError("PyAV 不可用，无法检测镜头") from exc
    try:
        with av.open(src, mode="r") as container:
            stream = next((item for item in container.streams if item.type == "video"), None)
            if stream is None:
                raise ValueError("文件没有视频流，无法检测镜头")
            rate_value = getattr(stream, "average_rate", None)
            try:
                rate = float(rate_value) if rate_value else 0.0
            except (TypeError, ValueError, OverflowError):
                rate = 0.0
            previous = None
            previous_time = None
            origin = None
            scores = deque(maxlen=SHOT_WINDOW)
            cuts = []
            last_cut = 0.0
            decoded = 0
            for frame in container.decode(stream):
                _check_cancel(job)
                decoded += 1
                raw_time = _frame_seconds(frame, decoded - 1, stream, rate)
                if not math.isfinite(raw_time):
                    raw_time = (decoded - 1) / (rate or 30.0)
                if origin is None:
                    origin = raw_time
                timestamp = max(0.0, raw_time - origin)
                if previous_time is not None and timestamp <= previous_time + 1e-9:
                    continue
                gray = _gray_frame(frame)
                _update_job(job, 0.08 + 0.8 * min(1.0, timestamp / duration),
                            "正在解码视频检测硬切")
                if previous is not None:
                    import numpy as np
                    score = float(np.mean(np.abs(gray - previous), dtype=np.float64))
                    recent = list(scores)
                    effective = params["threshold"]
                    if recent:
                        mean = float(np.mean(recent))
                        std = float(np.std(recent))
                        effective = max(effective, mean + params["adaptive"] * std)
                    scores.append(score)
                    long_enough = timestamp - last_cut + _EPSILON >= params["min_scene_len"]
                    final_long_enough = duration - timestamp + _EPSILON >= params["min_scene_len"]
                    if (score > 0 and score >= effective and long_enough and final_long_enough
                            and timestamp < duration):
                        confidence = min(1.0, score / max(effective, 1e-6))
                        cuts.append((timestamp, confidence))
                        if len(cuts) >= SEGMENT_LIMIT:
                            raise ValueError("镜头分段结果超过 %d 段上限" % SEGMENT_LIMIT)
                        last_cut = timestamp
                previous = gray
                previous_time = timestamp
            _check_cancel(job)
            if not decoded:
                raise ValueError("没有可解码的视频帧")
            segments = []
            start = 0.0
            for end, confidence in cuts:
                segments.append({"start": start, "end": end, "confidence": confidence})
                start = end
            segments.append({"start": start, "end": duration})
            return segments
    except _Cancelled:
        raise
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ValueError("镜头检测失败：%s" % exc) from exc


def _publish_copy(source_path, target_dir, stem, ext, index, input_dir):
    """同目录临时文件 + hardlink；目标存在时继续选 _库N，绝不覆盖。"""
    import errno

    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as exc:
        raise ValueError("创建导出目录失败：%s" % exc) from exc
    if not paths._under(input_dir, target_dir):
        raise ValueError("导出目标目录越界")
    try:
        fd, tmp = tempfile.mkstemp(dir=target_dir, prefix=".kedou-segment-", suffix=".tmp")
    except OSError as exc:
        raise ValueError("创建导出临时文件失败：%s" % exc) from exc
    os.close(fd)
    try:
        try:
            shutil.copyfile(source_path, tmp)
        except OSError as exc:
            raise ValueError("复制导出片段失败：%s" % exc) from exc
        suffix = 0
        while True:
            name = "%s_seg%03d%s" % (stem, index, ext)
            if suffix:
                name = "%s_seg%03d_库%d%s" % (stem, index, suffix, ext)
            destination = os.path.join(target_dir, name)
            suffix += 1
            if os.path.lexists(destination):
                continue
            if not paths._under(input_dir, target_dir) or not paths._under(target_dir, destination):
                raise ValueError("导出目标路径越界")
            try:
                os.link(tmp, destination)
            except FileExistsError:
                continue
            except OSError as exc:
                unsupported = (exc.errno in (errno.EPERM, errno.EXDEV,
                                             getattr(errno, "EOPNOTSUPP", errno.ENOTSUP),
                                             errno.ENOSYS)
                               or getattr(exc, "winerror", None) == 1)
                if unsupported:
                    raise ValueError("当前平台/文件系统不支持硬链接，无法安全发布导出文件：%s" % exc) from exc
                raise ValueError("硬链接发布导出文件失败（未覆盖目标）：%s" % exc) from exc
            return destination
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _export(job, source, segments):
    _update_job(job, 0.02, "正在定位源视频")
    src, _used, stat = _resolve_source(source)
    _check_cancel(job)
    _update_job(job, 0.05, "正在读取视频信息")
    duration = _duration(src)
    _ensure_source_unchanged(src, stat)
    segments = validate_export_segments(segments, duration)
    input_dir, _output_dir = media._media_dirs()
    target_dir = os.path.join(input_dir, source["subfolder"].replace("/", os.sep))
    if not paths._under(input_dir, target_dir):
        raise ValueError("导出目标目录越界")
    stem, ext = os.path.splitext(os.path.basename(src))
    items = []
    published = []
    total = len(segments)
    try:
        for index, segment in enumerate(segments, 1):
            _check_cancel(job)
            _ensure_source_unchanged(src, stat)
            _update_job(job, 0.05 + 0.9 * (index - 1) / total,
                        "正在导出第 %d/%d 段" % (index, total))
            trimmed = media.trimmed_video(src, trim_start=segment["start"], trim_end=segment["end"])
            if not trimmed.get("ok"):
                raise ValueError(trimmed.get("error") or "视频流复制失败")
            _check_cancel(job)
            _ensure_source_unchanged(src, stat)
            _update_job(job, 0.05 + 0.9 * (index - 0.5) / total,
                        "正在发布第 %d/%d 段" % (index, total))
            destination = _publish_copy(trimmed["path"], target_dir, stem, ext, index, input_dir)
            published.append(destination)
            _check_cancel(job)
            filename = os.path.relpath(destination, input_dir).replace("\\", "/")
            items.append({
                "name": os.path.basename(destination),
                "filename": filename,
                "subfolder": source["subfolder"],
                "tab": "input",
                "kind": "video",
                "start": segment["start"],
                "end": segment["end"],
            })
            _update_job(job, 0.05 + 0.9 * index / total,
                        "正在导出第 %d/%d 段" % (index, total))
    except Exception:
        for path in reversed(published):
            try:
                os.remove(path)
            except OSError as exc:
                print("[KeDou] 取消导出后清理已发布片段失败：%s（%s）" % (path, exc))
        raise
    return {"items": items}

# Copyright (c) 2026 UVA Computer Vision Lab
"""Inference-only adaptation of the official OmniShotCut engine.

Video decode/reformat and PTS handling live in kedou_bridge.segments. This module
never stacks a complete video: ``infer_windows`` consumes one bounded window at
a time. Window tiling, local decoding, cut collection and range assembly follow
the official v1.5 implementation.
"""
import hashlib
import os
from types import SimpleNamespace

import numpy as np
import torch

from .architecture.model import build_model
from .labels import GENERAL_INTRA_ID, NEW_START_INTER_ID, intra_int2string, inter_int2string

CHECKPOINT_URL = "https://huggingface.co/uva-cv-lab/OmniShotCut_v1.5/resolve/main/OmniShotCut_ckpt.pth"
CHECKPOINT_FILENAME = "OmniShotCut_ckpt.pth"
CHECKPOINT_SIZE = 211261519
CHECKPOINT_SHA256 = "5bafe33d8d0dde16c6e24fc63dfc580da9d5731804d6e51e1fc8de21d4600999"
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_model(checkpoint_path, device="auto"):
    """Load an official v1.5 checkpoint after size and SHA-256 verification.

    The checkpoint contains an argparse Namespace, hence weights_only=False is
    required. Verification always happens before torch.load is called.
    """
    path = os.path.abspath(os.fspath(checkpoint_path))
    if not os.path.isfile(path):
        raise FileNotFoundError("OmniShotCut checkpoint not found: %s" % path)
    if os.path.getsize(path) != CHECKPOINT_SIZE:
        raise ValueError("OmniShotCut 模型大小校验失败")
    if file_sha256(path) != CHECKPOINT_SHA256:
        raise ValueError("OmniShotCut 模型 SHA-256 校验失败")
    if device == "auto" or device is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    if not isinstance(checkpoint, dict) or "args" not in checkpoint or "model" not in checkpoint:
        raise ValueError("OmniShotCut checkpoint must contain 'args' and 'model'")
    args = checkpoint["args"]
    if isinstance(args, dict):
        args = SimpleNamespace(**args)
    model = build_model(args)
    model.load_state_dict(checkpoint["model"], strict=True)
    model.to(device)
    model.eval()
    return model, args


def normalize_rgb(frames):
    """Reproduce Video_Augmentation_Transform(val): uint8 RGB /255 + ImageNet."""
    array = np.asarray(frames)
    if array.ndim != 4 or array.shape[-1] != 3 or array.dtype != np.uint8:
        raise ValueError("OmniShotCut input must be a uint8 RGB (T,H,W,3) array")
    tensor = torch.from_numpy(np.ascontiguousarray(array)).float().div_(255.0)
    tensor = tensor.permute(0, 3, 1, 2).contiguous()
    mean = tensor.new_tensor(IMAGENET_MEAN).view(1, 3, 1, 1)
    std = tensor.new_tensor(IMAGENET_STD).view(1, 3, 1, 1)
    return (tensor - mean) / std


def split_videos(video, chunk_size, overlap_size):
    """Official v1.5 tiling (kept as a pure helper for parity tests)."""
    assert video.ndim == 4, "video must be (T, H, W, C)"
    assert overlap_size >= 0 and overlap_size < chunk_size
    total, height, width, channels = video.shape
    stride = chunk_size - overlap_size
    result = []
    window_start = 0
    while window_start < total:
        window_end = window_start + chunk_size
        valid_len = min(chunk_size, total - window_start)
        chunk = video[window_start:min(window_end, total)]
        num_pad = chunk_size - valid_len
        if num_pad:
            black = np.zeros((num_pad, height, width, channels), dtype=video.dtype)
            chunk = np.concatenate([chunk, black], axis=0)
        left_overlap = overlap_size // 2
        right_overlap = overlap_size - left_overlap
        valid_start = 0 if window_start == 0 else window_start + left_overlap
        valid_end = total if window_end >= total else window_end - right_overlap
        result.append([chunk, num_pad, window_start, valid_start, valid_end, valid_len])
        if window_end >= total:
            break
        window_start += stride
    return result


def decode_window_segments(query_intra_idx, query_inter_idx, query_range_idx, valid_len):
    """Official local contiguous ranges; labels belong to the shot that starts."""
    segments = []
    start = 0
    for intra, inter, end in zip(query_intra_idx, query_inter_idx, query_range_idx):
        pred_intra = int(intra.detach().cpu()) if hasattr(intra, "detach") else int(intra)
        pred_inter = int(inter.detach().cpu()) if hasattr(inter, "detach") else int(inter)
        end = int(end.detach().cpu()) if hasattr(end, "detach") else int(end)
        end = min(end, valid_len)
        if start >= end:
            continue
        segments.append((start, end, pred_intra, pred_inter))
        start = end
        if end >= valid_len:
            break
    return segments


def collect_cuts_from_window(segments, window_start_idx, valid_start_idx, valid_end_idx):
    """Official cut collection; the window's opening segment is always skipped."""
    cuts = []
    for segment in segments[1:]:
        position = window_start_idx + segment[0]
        if valid_start_idx < position <= valid_end_idx:
            cuts.append({"pos": int(position), "intra_label": int(segment[2]),
                         "inter_label": int(segment[3])})
    return cuts


def assemble_ranges(global_cuts, total_frames, duplicate_tolerance=0):
    """Official full-video range and start-relation label assembly."""
    ordered = sorted(global_cuts, key=lambda cut: cut["pos"])
    deduped = []
    for cut in ordered:
        if deduped and abs(cut["pos"] - deduped[-1]["pos"]) <= duplicate_tolerance:
            continue
        if cut["pos"] <= 0 or cut["pos"] >= total_frames:
            continue
        deduped.append(cut)
    ranges, intra_labels, inter_labels = [], [], []
    previous = 0
    for index, cut in enumerate(deduped):
        position = cut["pos"]
        if position <= previous:
            continue
        ranges.append([int(previous), int(position)])
        if index == 0:
            intra_labels.append(GENERAL_INTRA_ID)
            inter_labels.append(NEW_START_INTER_ID)
        else:
            intra_labels.append(int(deduped[index - 1]["intra_label"]))
            inter_labels.append(int(deduped[index - 1]["inter_label"]))
        previous = position
    if previous < total_frames:
        ranges.append([int(previous), int(total_frames)])
        if not deduped:
            intra_labels.append(GENERAL_INTRA_ID)
            inter_labels.append(NEW_START_INTER_ID)
        else:
            intra_labels.append(int(deduped[-1]["intra_label"]))
            inter_labels.append(int(deduped[-1]["inter_label"]))
    return ranges, intra_labels, inter_labels


def iter_window_predictions(model, args, windows, device="auto", overlap=10,
                            check_cancel=None, progress=None):
    """Yield bounded per-window predictions without retaining decoded video.

    ``windows`` yields ``(uint8_rgb_window, valid_len, window_start_idx,
    valid_start_idx, valid_end_idx)``. Padding is applied by the caller.
    """
    if device == "auto" or device is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    if not 0 <= overlap < args.max_process_window_length:
        raise ValueError("OmniShotCut overlap must be smaller than the model window")
    model.eval()
    for index, (window, valid_len, start, valid_start, valid_end) in enumerate(windows):
        if check_cancel:
            check_cancel()
        array = np.asarray(window)
        expected = args.max_process_window_length
        if array.shape != (expected, args.process_height, args.process_width, 3):
            raise ValueError("OmniShotCut window shape does not match checkpoint args")
        batch = normalize_rgb(array).unsqueeze(0).to(device)
        try:
            with torch.inference_mode():
                outputs = model(batch)
                intra_prob = outputs["intra_clip_logits"].softmax(-1)[0, :, :-1]
                inter_prob = outputs["inter_clip_logits"].softmax(-1)[0, :, :-1]
                range_prob = outputs["pred_shot_logits"].softmax(-1)[0, :, :-1]
                intra_idx = intra_prob.argmax(dim=-1)
                inter_idx = inter_prob.argmax(dim=-1)
                range_idx = range_prob.argmax(dim=-1)
                # The predicted end frame's probability is the segment confidence.
                range_confidence = range_prob.gather(1, range_idx[:, None]).squeeze(1)
                local_segments = decode_window_segments(intra_idx, inter_idx, range_idx, valid_len)
                cuts = collect_cuts_from_window(local_segments, start, valid_start, valid_end)
                # Match confidence by local segment end; collect_cuts omits the opener.
                by_end = {segment[1]: float(range_confidence[position].detach().cpu())
                          for position, segment in enumerate(local_segments)}
                for cut in cuts:
                    cut["confidence"] = by_end.get(cut["pos"] - start, 0.0)
            if check_cancel:
                check_cancel()
            yield {"window_start_idx": start, "valid_start_idx": valid_start,
                   "valid_end_idx": valid_end, "valid_len": valid_len,
                   "segments": local_segments, "cuts": cuts}
        finally:
            del batch
        if progress:
            progress(index + 1)


def infer_windows(model, args, windows, device="auto", overlap=10,
                  check_cancel=None, progress=None):
    """Consume bounded windows and return official ranges, labels and confidence."""
    cuts = []
    total_frames = 0
    for prediction in iter_window_predictions(model, args, windows, device, overlap,
                                              check_cancel, progress):
        cuts.extend(prediction["cuts"])
        total_frames = max(total_frames,
                           prediction["window_start_idx"] + prediction["valid_len"])
    if total_frames <= 0:
        raise ValueError("OmniShotCut 没有可推理的视频帧")
    ranges, intra, inter = assemble_ranges(cuts, total_frames)
    cut_by_position = {cut["pos"]: cut for cut in cuts}
    confidence = [None] * len(ranges)
    for index in range(len(ranges) - 1):
        cut = cut_by_position.get(ranges[index][1])
        if cut is not None:
            confidence[index] = float(cut["confidence"])
    return {"ranges": ranges, "intra_labels": intra, "inter_labels": inter,
            "confidence": confidence}

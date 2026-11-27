# Copyright (c) 2026 UVA Computer Vision Lab
"""OmniShotCut v1.5 streaming inference and official window stitching.

Derived from https://github.com/uva-cv-lab/OmniShotCut (MIT).
The Facebook DETR-derived architecture retains its original notices.
"""
from .engine import (
    GENERAL_INTRA_ID, NEW_START_INTER_ID,
    split_videos, decode_window_segments, collect_cuts_from_window, assemble_ranges,
    infer_windows, load_model, normalize_rgb,
)
from .labels import intra_int2string, inter_int2string

__all__ = [
    "load_model", "infer_windows", "normalize_rgb", "split_videos",
    "decode_window_segments", "collect_cuts_from_window", "assemble_ranges",
    "GENERAL_INTRA_ID", "NEW_START_INTER_ID", "intra_int2string", "inter_int2string",
]

# -*- coding: utf-8 -*-
"""ComfyUI / aiohttp 兼容层：这些依赖只在 ComfyUI 进程里存在。"""

try:
    from aiohttp import web
    from server import PromptServer
    HAS_COMFY = True
except Exception:                                   # noqa: BLE001
    web = None
    PromptServer = None
    HAS_COMFY = False

try:
    from nodes import NODE_CLASS_MAPPINGS as NODE_MAP
except Exception:                                   # noqa: BLE001
    NODE_MAP = {}




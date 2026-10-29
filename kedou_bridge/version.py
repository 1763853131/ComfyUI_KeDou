# -*- coding: utf-8 -*-
"""插件版本号 —— 唯一事实源。

改版本只改这里，然后同步 pyproject.toml 的 version（ComfyUI-Manager 读的是那个）。
`tools/pack_release.py` 打包前会校验两者一致，不一致直接拒绝出包。

版本号规则：只加末位（1.0.0 → 1.0.1），不管改动多大。中间位/首位不动。
"""

__version__ = "1.0.2"

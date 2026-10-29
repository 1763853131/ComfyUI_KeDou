# -*- coding: utf-8 -*-
"""ComfyUI_KeDou 的内部实现包。

入口文件只有一层：加载这个包、注册路由、导出节点映射。各模块职责见文件名。
"""

from .version import __version__  # noqa: F401
from . import compat, paths, common, state, registry, apps, pack, media, nodes, routes  # noqa: F401




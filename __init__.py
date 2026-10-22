# -*- coding: utf-8 -*-
"""
ComfyUI_KeDou —— 修图工坊 · ComfyUI 桥接（入口）

把 ComfyUI 里的工作流变成可点击的 App：应用发现、参数读写、UI→API 转换、
媒体库、缩略图、打包/编辑 .kapp.json。实现按职责放在 kedou_bridge/ 包里，
本文件只做三件事：加载内部包、注册 HTTP 路由/钩子、导出节点映射。

模块划分：
      kedou_bridge/paths.py     根目录 / 用户目录 / 工作流目录 / 越界检查
      kedou_bridge/common.py    应用解析共用常量与纯函数
      kedou_bridge/registry.py  object_info、控件声明顺序与控件规格
      kedou_bridge/state.py     sidecar 状态 + 写接口令牌/来源鉴权
      kedou_bridge/apps.py      应用发现、规格、sidecar 回写、UI→API、执行图
      kedou_bridge/pack.py      打包候选、kapp 校验/落盘、编辑回写
      kedou_bridge/media.py     媒体清单、媒体选取、真缩略图
      kedou_bridge/nodes.py     蝌蚪图片加载器 / 提示词框、空槽连线清理
      kedou_bridge/routes.py    /ps/* HTTP 路由注册

路由清单见 README。改完重启 ComfyUI。
"""

from __future__ import annotations

import importlib.util
import os
import sys

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIRECTORY = "./web"


# ---------------------------------------------------------------- 内部实现包
def _load_bridge():
    """按文件路径加载 kedou_bridge/ 包。

    ComfyUI 导入 custom_nodes 时不会把插件目录放进 sys.path，
    所以不能直接 `import kedou_bridge`；这里显式给出 submodule_search_locations，
    包内的相对导入才能正常工作。
    """
    pkg_dir = os.path.join(PLUGIN_DIR, "kedou_bridge")
    init_py = os.path.join(pkg_dir, "__init__.py")
    if not os.path.isfile(init_py):
        raise ImportError("ComfyUI_KeDou 安装不完整：缺少 kedou_bridge/")
    # 插件被热重载时丢掉旧子模块，避免继续用上一版代码
    for name in [m for m in list(sys.modules)
                 if m == "kedou_bridge" or m.startswith("kedou_bridge.")]:
        sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(
        "kedou_bridge", init_py, submodule_search_locations=[pkg_dir])
    mod = importlib.util.module_from_spec(spec)
    sys.modules["kedou_bridge"] = mod
    spec.loader.exec_module(mod)
    return mod


_BRIDGE = _load_bridge()
_nodes = _BRIDGE.nodes
_compat = _BRIDGE.compat

if _compat.HAS_COMFY:
    try:
        _BRIDGE.routes.register(_compat.PromptServer.instance.routes)
    except Exception as _e:                          # noqa: BLE001
        print("[KeDou] HTTP 路由注册失败:", _e)
    _nodes.register_hooks()


# ComfyUI 要求 custom_nodes 至少导出节点映射（可以为空）
NODE_CLASS_MAPPINGS = _nodes.NODE_CLASS_MAPPINGS
NODE_DISPLAY_NAME_MAPPINGS = _nodes.NODE_DISPLAY_NAME_MAPPINGS


# ---------------------------------------------------------------- 提示词库
if _compat.HAS_COMFY:
    # 词库逻辑 vendored 在 prompt_vault/ 包里（上游是独立仓库）。
    # sys.path 不含插件目录，故按文件路径加载。
    try:
        _pv_dir = os.path.join(PLUGIN_DIR, "prompt_vault")
        _pv_init = os.path.join(_pv_dir, "__init__.py")
        if not os.path.isfile(_pv_init):
            raise FileNotFoundError("找不到 vendored 的 prompt_vault 包：%s" % _pv_init)
        _pv_spec = importlib.util.spec_from_file_location(
            "kedou_prompt_vault", _pv_init, submodule_search_locations=[_pv_dir])
        _kedou_prompt_vault = importlib.util.module_from_spec(_pv_spec)
        sys.modules[_pv_spec.name] = _kedou_prompt_vault
        _pv_spec.loader.exec_module(_kedou_prompt_vault)
        _kedou_prompt_vault.register_routes(_compat.PromptServer.instance.routes)
        _pv = _kedou_prompt_vault.vault_info()
        print("[KeDou] 词库已就绪：%s（%s，%s）" % (
            _pv.get("vault"), _pv.get("vault_source"),
            "可读" if _pv.get("exists") else "目录还不存在，首次写入时建"))
    except Exception as _pe:                          # noqa: BLE001
        print("[KeDou] 词库加载失败:", _pe)


# ---------------------------------------------------------------- 旧导入兼容
# 以前所有东西都在 __init__.py 里；外部脚本若还在用 kedou.list_apps 这类名字，
# 这里转发到新模块。变量走动态代理，避免 from 导入拿到启动时的旧快照。
_REEXPORTS = {
    "WORKFLOW_DIR": ("paths", "WORKFLOW_DIR"),
    "COMFY_ROOT": ("paths", "COMFY_ROOT"),
    "list_apps": ("apps", "list_apps"),
    "list_kapps": ("apps", "list_kapps"),
    "get_app": ("apps", "get_app"),
    "build_graph": ("apps", "build_graph"),
    "update_values": ("apps", "update_values"),
    "find_app_files": ("apps", "find_app_files"),
    "pack_candidates": ("pack", "pack_candidates"),
    "pack_app": ("pack", "pack_app"),
    "save_kapp": ("pack", "save_kapp"),
    "list_media": ("media", "list_media"),
    "pick_media": ("media", "pick_media"),
    "_prune_stale_loader_links": ("nodes", "_prune_stale_loader_links"),
}


def __getattr__(name):
    target = _REEXPORTS.get(name)
    if target:
        return getattr(getattr(_BRIDGE, target[0]), target[1])
    raise AttributeError("module %r has no attribute %r" % (__name__, name))

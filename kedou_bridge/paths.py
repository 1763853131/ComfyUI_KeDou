# -*- coding: utf-8 -*-
"""路径工具：ComfyUI 根目录、用户目录、工作流目录，以及防越界的通用函数。"""

import json
import os
import tempfile



def _find_comfy_root() -> str:
    """
    从本文件往上找到「包含 custom_nodes 的那一层」= ComfyUI 根目录。

    不能按固定层数硬算：本文件在 <插件>/kedou_bridge/ 下，
       custom_nodes/ComfyUI_KeDou/kedou_bridge/paths.py 往上两层才是插件目录，
       再往上才是 ComfyUI 根；硬算层数一旦搬家就会算错，
       于是 WORKFLOW_DIR 指向不存在的地方 → /ps/apps 返回空列表、
       启动器和 PS 插件上「一个应用都没有」，且不报任何错误（最难查的情况）。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        if os.path.isdir(os.path.join(here, "custom_nodes")):
            return here
        up = os.path.dirname(here)
        if up == here:
            break
        here = up
    # 本文件在 <插件>/kedou_bridge/ 下，兜底要往上三层才是插件所在目录的上一层
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMFY_ROOT = _find_comfy_root()


def _user_default_dir() -> str:
    """ComfyUI 的 user/default（尊重 --user-directory）；独立脚本退回根目录约定。"""
    try:
        from folder_paths import get_user_directory       # noqa: PLC0415
        ud = get_user_directory()
        if ud:
            d = os.path.join(ud, "default")
            return d if os.path.isdir(d) else ud
    except Exception:                                     # noqa: BLE001
        pass
    return os.path.join(COMFY_ROOT, "user", "default")


WORKFLOW_DIR = os.path.join(_user_default_dir(), "workflows")
if not os.path.isdir(os.path.join(COMFY_ROOT, "custom_nodes")):
    # 启动自检：根目录推断错误时立即报出，避免应用列表为空却无任何提示
    print("[KeDou] 警告：ComfyUI 根目录推断可能不对 -> %s" % COMFY_ROOT)

def _safe_id(app_id: str) -> bool:
    """防路径穿越：只允许纯文件名（不含 / \\ .. 和 :）

    ":" 也要挡：Windows 下 "C:evil" 这类盘限定名会让 os.path.join 直接丢掉基准目录，
    "x:y" 还会在 NTFS 上写出备用数据流（ADS）。
    """
    return (bool(app_id) and "/" not in app_id and "\\" not in app_id
            and ".." not in app_id and ":" not in app_id)


def _under(base_dir: str, path: str) -> bool:
    """path 落在 base_dir 内才算数（realpath 归一化后比 commonpath，符号链接也拦得住）。

    落盘前最后一道闸：_safe_id 只是字符层面的黑名单，这里按解析后的真实路径复核，
    防住盘限定名、符号链接、大小写盘符等一切 join 层面的逃逸。
    """
    base = os.path.realpath(base_dir)
    target = os.path.realpath(path)
    try:
        return os.path.commonpath([base, target]) == base
    except ValueError:                                  # 不同盘符 / 大小写盘符
        return False

def _stem(filename: str) -> str:
    """应用名 = 文件名去掉 .kapp.json / .app.json / .json 后缀（ComfyUI 应用列表也按文件名显示）"""
    low = filename.lower()
    if low.endswith(".kapp.json"):
        return filename[:-len(".kapp.json")]
    if low.endswith(".app.json"):
        return filename[:-len(".app.json")]
    if low.endswith(".json"):
        return filename[:-len(".json")]
    return filename


def _rel(path: str) -> str:
    """相对 ComfyUI 根目录；跨盘符时 relpath 会抛异常，退回绝对路径。"""
    try:
        return os.path.relpath(path, COMFY_ROOT).replace("\\", "/")
    except Exception:                                # noqa: BLE001
        return str(path).replace("\\", "/")

def _dump_json_atomic(path: str, data, indent: int = 2) -> None:
    """同目录临时文件 + os.replace：写到一半崩了也不会留下半截 JSON。"""
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, indent=indent)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise

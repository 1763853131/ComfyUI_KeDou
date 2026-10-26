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


_USER_DEFAULT = _user_default_dir()
WORKFLOW_DIR = os.path.join(_USER_DEFAULT, "workflows")

# 应用归档目录：一个应用 = 一个 .kapp.json + 一份同名工作流副本，都放这里。
#
# 为什么放在工作流目录**外面**（用户 2026-10-26 要求）：
#   * 工作流目录里已经有几十个文件，应用包混进去后用户分不清哪个是「拿来改的工作流」、
#     哪个是「应用的归档副本」；
#   * ComfyUI 自己的工作流列表只扫 user/default/workflows，放外面就彻底不碍眼。
# 代价：ComfyUI 自己的「打开工作流」看不到副本，改应用只能走打包面板的「切回工作流」。
#
# 目录是扁平的（<名>.kapp.json 与 <名>.json 并列），和用户确认过：一眼看全最省事。
APPS_DIR = os.path.join(_USER_DEFAULT, "kedou_apps")
# 回写口径里代表应用归档目录的前缀（相对 user/default）。
APPS_PREFIX = "kedou_apps/"

# 删应用包时的回收站：故意放在工作流目录**外面**。
# 放里面会被 find_app_files 的 os.walk 扫到（文件名不带点），删掉的应用又冒出来。
TRASH_DIR = os.path.join(_USER_DEFAULT, "kedou_trash")
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


def pack_rel(path: str) -> str:
    """应用包 / 工作流副本的「回写口径」（kapp 的 source、列表的 target 都用它）。

    两种形态，前端原样传回、后端能反解：
      * 应用归档目录里的文件 → ``kedou_apps/<名>.json``（相对 user/default）
      * 工作流目录里的文件   → ``修图/x.json``（相对工作流目录，老口径，已有包都是这个）

    不能统一成一种：老包存的 source/target 是相对工作流目录的，改了前缀它们就全部解析不到
    （表现是「切回工作流」按钮全灰、删除报目标不合法）。带 ``kedou_apps/`` 前缀天然能区分。
    """
    if _under(APPS_DIR, path):
        rel = os.path.relpath(path, APPS_DIR).replace("\\", "/")
        return APPS_PREFIX + rel
    try:
        return os.path.relpath(path, WORKFLOW_DIR).replace("\\", "/")
    except Exception:                                # noqa: BLE001
        return str(path).replace("\\", "/")


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

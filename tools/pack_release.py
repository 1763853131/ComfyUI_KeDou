# -*- coding: utf-8 -*-
"""出包：把仓库里「该发的东西」打成 ComfyUI_KeDou-v<版本>.zip。

为什么要这个脚本
----------------
以前是直接把 `custom_nodes/ComfyUI_KeDou/` 整个文件夹压给朋友，那个目录里混着
一个 2026-10-13 的旧 `.git`（落后 46 个提交）、118KB 的旧 `__init__.pyc`、
15 个 `.bak-*` 备份。对方只要在节点管理器点一次「更新」，git 就会把
`__init__.py` 回滚成 72KB 的老单文件架构，而 `kedou_bridge/`（在旧仓库里是未跟踪）
反而留着 —— 新模块 + 旧入口，表现就是「装的像旧版」。

所以出包只认仓库、只认白名单，出完自己再开包验一遍。

用法
----
    python tools/pack_release.py              # 出包到 dist/
    python tools/pack_release.py --check      # 只校验，不出包
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(REPO, "dist")
PKG_NAME = "ComfyUI_KeDou"

# 要发的东西：文件按名，目录按整棵子树
WHITELIST_FILES = [
    "__init__.py",
    "pyproject.toml",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "ui_to_api.py",
]
WHITELIST_DIRS = [
    "kedou_bridge",
    "locales",
    "prompt_vault",
    "web",
    "docs",
]

# 递归排除：这些东西进包就是事故
EXCLUDE_DIRS = {"__pycache__", ".git", ".workbuddy-ai", "Python", "tests", ".idea", ".vscode"}
EXCLUDE_SUFFIX = (".pyc", ".pyo", ".zip", ".7z", ".rar")
EXCLUDE_NAME_PATTERNS = [r"\.bak", r"^\.git", r"~$", r"\.swp$"]


def _excluded(name: str) -> bool:
    if name in EXCLUDE_DIRS:
        return True
    if name.endswith(EXCLUDE_SUFFIX):
        return True
    for pat in EXCLUDE_NAME_PATTERNS:
        if re.search(pat, name, re.IGNORECASE):
            return True
    return False


def _read_version() -> str:
    """从 kedou_bridge/version.py 取版本（唯一事实源）。"""
    fp = os.path.join(REPO, "kedou_bridge", "version.py")
    with open(fp, "r", encoding="utf-8") as f:
        m = re.search(r'__version__\s*=\s*["\']([^"\']+)["\']', f.read())
    if not m:
        raise SystemExit("× kedou_bridge/version.py 里找不到 __version__")
    return m.group(1)


def _read_pyproject_version() -> str:
    fp = os.path.join(REPO, "pyproject.toml")
    with open(fp, "r", encoding="utf-8") as f:
        for line in f:
            m = re.match(r'\s*version\s*=\s*["\']([^"\']+)["\']', line)
            if m:
                return m.group(1)
    raise SystemExit("× pyproject.toml 里找不到 version")


def _collect() -> list:
    """返回 [(绝对路径, 包内相对路径)]。"""
    items = []

    for fn in WHITELIST_FILES:
        fp = os.path.join(REPO, fn)
        if not os.path.isfile(fp):
            raise SystemExit("× 白名单里的文件不存在：%s" % fn)
        items.append((fp, fn))

    for d in WHITELIST_DIRS:
        root = os.path.join(REPO, d)
        if not os.path.isdir(root):
            raise SystemExit("× 白名单里的目录不存在：%s" % d)
        for dp, dns, fns in os.walk(root):
            dns[:] = sorted(x for x in dns if not _excluded(x))
            for fn in sorted(fns):
                if _excluded(fn):
                    continue
                fp = os.path.join(dp, fn)
                rel = os.path.relpath(fp, REPO).replace(os.sep, "/")
                items.append((fp, rel))

    return items


def _preflight(ver: str, py_ver: str) -> None:
    """出包前的硬检查。任何一条不过就不许出包。"""
    problems = []

    if ver != py_ver:
        problems.append("版本号不一致：version.py=%s  pyproject.toml=%s" % (ver, py_ver))

    init_fp = os.path.join(REPO, "__init__.py")
    size = os.path.getsize(init_fp)
    if size > 20000:
        problems.append("__init__.py 有 %d 字节，超过薄入口上限（旧单文件架构是 72KB+），"
                        "确认是不是又退回老写法了" % size)

    bridge = os.path.join(REPO, "kedou_bridge")
    pys = [f for f in os.listdir(bridge) if f.endswith(".py")]
    if len(pys) < 10:
        problems.append("kedou_bridge/ 只有 %d 个 .py，模块不齐" % len(pys))

    for must in ("kedou_bridge/routes.py", "kedou_bridge/version.py", "web/kedou_media.js"):
        if not os.path.isfile(os.path.join(REPO, must)):
            problems.append("缺少关键文件：%s" % must)

    # 仓库里不该有 pyc / 备份混进来（有也无所谓，反正不打包，但提醒一下）
    for junk in (".git", "__pycache__"):
        if os.path.isdir(os.path.join(REPO, junk)):
            print("  · 提示：仓库里有 %s/，出包时会排除" % junk)

    if problems:
        print("\n× 出包前检查没过：")
        for p in problems:
            print("   -", p)
        raise SystemExit(1)

    print("  · 版本号 %s（version.py 与 pyproject.toml 一致）" % ver)
    print("  · __init__.py %d 字节（薄入口）" % size)
    print("  · kedou_bridge/ %d 个模块" % len(pys))


def _verify_zip(zip_path: str, ver: str) -> None:
    """开包复验：不许有脏文件，必须有核心文件。"""
    problems = []
    names = []
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()

    prefix = PKG_NAME + "/"
    rel = [n[len(prefix):] for n in names if n.startswith(prefix) and not n.endswith("/")]

    for n in rel:
        base = os.path.basename(n)
        if _excluded(base) or "/__pycache__/" in "/" + n:
            problems.append("包里有脏文件：%s" % n)

    must_have = ["__init__.py", "pyproject.toml", "kedou_bridge/routes.py",
                 "kedou_bridge/version.py", "web/kedou_media.js", "locales/zh/main.json"]
    for m in must_have:
        if m not in rel:
            problems.append("包里缺文件：%s" % m)

    # pyproject 版本必须和 version.py 一致
    with zipfile.ZipFile(zip_path) as z:
        pj = z.read(prefix + "pyproject.toml").decode("utf-8")
    m = re.search(r'^\s*version\s*=\s*["\']([^"\']+)["\']', pj, re.M)
    if not m or m.group(1) != ver:
        problems.append("包内 pyproject 版本不对：%s" % (m.group(1) if m else "缺失"))

    if problems:
        print("\n× 包自检没过：")
        for p in problems:
            print("   -", p)
        raise SystemExit(1)

    size_mb = os.path.getsize(zip_path) / 1024 / 1024
    print("  · 包内 %d 个文件，%.2f MB，无 .pyc / .bak / .git" % (len(rel), size_mb))
    print("  · 版本号复验通过：%s" % ver)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只做检查，不出包")
    args = ap.parse_args()

    print("[1/4] 读版本号")
    ver = _read_version()
    py_ver = _read_pyproject_version()

    print("[2/4] 出包前检查")
    _preflight(ver, py_ver)

    items = _collect()
    print("[3/4] 收集文件：%d 个" % len(items))

    if args.check:
        print("\n√ 检查通过（--check 模式，未出包）")
        return 0

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, "%s-v%s.zip" % (PKG_NAME, ver))
    if os.path.isfile(out):
        os.remove(out)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for fp, rel in items:
            z.write(fp, PKG_NAME + "/" + rel)

    print("[4/4] 包自检")
    _verify_zip(out, ver)

    print("\n√ 出包完成：%s" % out)
    print("  对方安装：解压后把 %s 整个文件夹放进 ComfyUI/custom_nodes/，重启 ComfyUI" % PKG_NAME)
    print("  装对了的话，启动日志第一行会有：[KeDou] ComfyUI_KeDou v%s 已加载" % ver)
    return 0


if __name__ == "__main__":
    sys.exit(main())

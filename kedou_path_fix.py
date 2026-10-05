# -*- coding: utf-8 -*-
"""kedou_path_fix —— ComfyUI 路径解析垫片（KedouLauncher 出品）

解决的问题：工作流 JSON 按文件名引用模型（如 "lightx2v_4steps.safetensors"），
文件一旦挪进子目录，ComfyUI 按「根目录 + 名字」拼路径就找不到，报 file not found。

本垫片在路径解析层兜底：根目录找不到时，按文件名全库递归搜索子目录，
用真实路径加载。对外接口完全不变——工作流一个字不用改，节点保持原生，
UI 下拉照常。文件名依然是引用键（改名仍会断链），但位置彻底自由。

部署形态：并入 ComfyUI_KeDou（本文件 = ComfyUI_KeDou/kedou_path_fix.py），
由 __init__.py 的 _load_path_fix() 就地加载（custom_nodes 不在 sys.path，
且 ComfyUI 加载目录插件不设包上下文，相对导入不可用——同 ui_to_api.py 的处理）。
import 本模块即自动对 folder_paths 打补丁（幂等，重复 import 无副作用）。

设计原则：
- 只包一层原函数（不复制 ComfyUI 内部实现），ComfyUI 升级存活率最高；
- 任何异常静默回落原生行为——垫片失效最多回到现状，绝不弄坏 ComfyUI；
- 同名冲突规则：根目录优先 > 目录层浅优先 > 逐段目录名字典序（不能比拼好的
  路径字符串：Windows 下 "sub2" < "sub\\"，反斜杠的 ASCII 大于数字），行为可预期；
- 校验列表追加的裸名用原始大小写（lowercase 只作查找键，否则 validate 误拒）；
- 索引带缓存（默认 5 秒 TTL），兜底未命中且索引偏旧时自动重建，新文件秒级可见。
"""

import os
import time
import logging

log = logging.getLogger("kedou_path_fix")

_TTL = 5.0  # 索引缓存秒数
_idx_cache = {}  # folder_name -> {"built": float, "map": {basename_lower: relpath}}


def _apply(fp):
    """把兜底逻辑包到 folder_paths 模块上。返回 True 表示已生效。"""
    if getattr(fp, "_kedou_path_fix", False):
        return False
    orig_get_full_path = fp.get_full_path
    orig_get_filename_list = fp.get_filename_list

    def _better(cand_a, cand_b):
        # cand = (base_idx, depth, parts)：根目录排前 > 层浅排前 > 逐段目录名字典序
        return cand_a < cand_b

    def _index(folder_name):
        folder_name = fp.map_legacy(folder_name)
        now = time.time()
        c = _idx_cache.get(folder_name)
        if c and (now - c["built"]) <= _TTL:
            return c["map"]
        try:
            exts = {e.lower() for e in fp.supported_pt_extensions}
        except Exception:
            exts = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".sft"}
        best = {}  # basename_lower -> ((base_idx, depth, parts), relpath, orig_name)
        for bi, base in enumerate(fp.get_folder_paths(folder_name)):
            for dirpath, subdirs, files in os.walk(base):
                subdirs[:] = [d for d in subdirs if not d.startswith(".") and d != "__pycache__"]
                for f in files:
                    if os.path.splitext(f)[1].lower() not in exts:
                        continue
                    try:
                        rel = os.path.relpath(os.path.join(dirpath, f), base)
                    except Exception:
                        continue
                    key = f.lower()
                    # 按路径分段比较（不能用拼好的字符串：Windows 下 "sub2" < "sub\" 会反序）
                    cand = (bi, rel.count(os.sep), [p.lower() for p in rel.split(os.sep)])
                    old = best.get(key)
                    if old is None or _better(cand, old[0]):
                        best[key] = (cand, rel, f)
        mapping = {k: (v[1], v[2]) for k, v in best.items()}
        _idx_cache[folder_name] = {"built": now, "map": mapping}
        return mapping

    def get_full_path_patched(folder_name, filename):
        r = orig_get_full_path(folder_name, filename)
        if r:
            return r
        try:
            fn = fp.map_legacy(folder_name)
            key = os.path.basename(str(filename)).lower()
            if not key:
                return None
            m = _index(fn)
            hit = m.get(key)
            if hit is None:
                m = _force_rebuild(fn)
                hit = m.get(key)
            if hit:
                rel = hit[0]
                for base in fp.get_folder_paths(fn):
                    p = os.path.join(base, rel)
                    if os.path.isfile(p):
                        log.info("[kedou_path_fix] 兜底命中：%s -> %s", filename, p)
                        return p
        except Exception:
            pass
        return None

    def _force_rebuild(folder_name):
        _idx_cache.pop(folder_name, None)
        return _index(folder_name)

    def get_filename_list_patched(folder_name):
        base_list = orig_get_filename_list(folder_name)
        try:
            base_set = set(base_list)
            # 用原始大小写的裸名追加（工作流引用的是原始大小写；lowercase 键只用于查找）
            extra = [hit[1] for hit in _index(fp.map_legacy(folder_name)).values()
                     if hit[1] not in base_set]
            if extra:
                return sorted(base_set | set(extra))
        except Exception:
            pass
        return base_list

    fp.get_full_path = get_full_path_patched
    fp.get_filename_list = get_filename_list_patched
    fp._kedou_path_fix = True
    return True


try:
    import folder_paths as _fp

    if _apply(_fp):
        log.info("[kedou_path_fix] 路径兜底已启用：根目录找不到的模型会按文件名搜索子目录")
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}
    __all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "_apply"]
except Exception:
    log.exception("[kedou_path_fix] 初始化失败，ComfyUI 将使用原生路径解析（无副作用）")

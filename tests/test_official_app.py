# -*- coding: utf-8 -*-
r"""官方 .app.json 写入器 + 读取修复的自测（不依赖 ComfyUI 进程）。

用法：<comfyui>\python_embeded\python.exe _experiment\test_official_app.py

覆盖：
  1. 真机工作流（千问2.1多图编辑.json）-> 生成官方包 -> build_spec 读回，与同名 kapp 参数对账
  2. 自绘节点的 DOM 把手：写 kedou_media / 读回 media_state + kind=image + 默认值
  3. widgets_values_named 优先（位置对位错的老问题）
  4. 旧式 ref（"节点:控件" / [节点, 控件]）仍能解析
  5. 校验失败不落盘（不存在的节点 / 画布上没有的控件 / 没有输出）
  6. 同 stem 的 .kapp.json 遮蔽 .app.json（find_app_files 去重）
"""

import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOWS = r"D:\ComfyUI_KeDou_v1\ComfyUI\user\default\workflows"

FAILS = []


def check(label, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + label + ("" if cond else "  <- " + str(extra)))
    if not cond:
        FAILS.append(label)


def load_bridge():
    pkg_dir = os.path.join(REPO, "kedou_bridge")
    spec = importlib.util.spec_from_file_location(
        "kedou_bridge", os.path.join(pkg_dir, "__init__.py"),
        submodule_search_locations=[pkg_dir])
    mod = importlib.util.module_from_spec(spec)
    sys.modules["kedou_bridge"] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    bridge = load_bridge()
    paths, pack, apps = bridge.paths, bridge.pack, bridge.apps
    common = bridge.common

    tmp = tempfile.mkdtemp(prefix="kedou_official_")
    paths.WORKFLOW_DIR = tmp
    old_root = paths.COMFY_ROOT
    paths.COMFY_ROOT = os.path.dirname(tmp)
    try:
        run(tmp, paths, pack, apps, common)
    finally:
        paths.COMFY_ROOT = old_root
        shutil.rmtree(tmp, ignore_errors=True)
    print("\n%s（%d 项失败）" % ("全部通过" if not FAILS else "有失败项", len(FAILS)))
    return 1 if FAILS else 0


def run(tmp, paths, pack, apps, common):
    # ---------------------------------------------------------------- 1. 真机工作流对账
    src = os.path.join(WORKFLOWS, "千问2.1多图编辑.json")
    kapp_path = os.path.join(WORKFLOWS, "千问2.1多图编辑.kapp.json")
    if not (os.path.isfile(src) and os.path.isfile(kapp_path)):
        print("跳过：找不到真机工作流 %s" % src)
        return
    with open(src, "r", encoding="utf-8") as f:
        ui_wf = json.load(f)
    with open(kapp_path, "r", encoding="utf-8") as f:
        kapp = json.load(f)

    print("\n[1] 真机工作流 -> 官方包")
    params = [{"node": p["node"], "input": p["input"], "label": p.get("label")}
              for p in kapp["params"]]
    res = pack.save_official_app("千问2.1多图编辑", ui_wf, params, kapp["outputs"])
    check("写入成功", res.get("ok"), res)
    out = os.path.join(tmp, "千问2.1多图编辑.app.json")
    check("文件落在工作流目录内", os.path.isfile(out), res.get("file"))

    with open(out, "r", encoding="utf-8") as f:
        written = json.load(f)
    gid = written.get("id")
    ld = (written.get("extra") or {}).get("linearData") or {}
    check("顶层 id 保留原 uuid", gid == ui_wf["id"], gid)
    check("linearMode = true", (written.get("extra") or {}).get("linearMode") is True)
    check("inputs 数量与 kapp 一致", len(ld.get("inputs") or []) == len(kapp["params"]),
          ld.get("inputs"))
    check("outputs 一致", ld.get("outputs") == [str(x) for x in kapp["outputs"]],
          ld.get("outputs"))

    wid = re.compile(r"^(?P<graphId>[^:]+):(?P<nodeId>[^:]+):(?P<name>[^:]+)$")
    all_refs_ok = all(wid.match(e[0]) for e in ld["inputs"])
    check("每条 ref 都是 <图id>:<节点>:<控件>", all_refs_ok, ld["inputs"])
    check("ref 第一段 = 顶层 id", all(e[0].split(":")[0] == gid for e in ld["inputs"]))

    loader = [e for e in ld["inputs"] if ":477:" in e[0]]
    check("图片加载器写的是 DOM 把手 kedou_media",
          loader and loader[0][0].endswith(":kedou_media"), loader)

    # ---------------------------------------------------------------- 2. 读回
    print("\n[2] build_spec 读回（官方格式）")
    spec = apps.build_spec(out, object_info={})
    check("format = official", spec.get("format") == "official", spec.get("format"))
    check("linear_mode = true", spec.get("linear_mode") is True)
    by = {(p["node"], p["input"]): p for p in spec["params"]}
    check("返回真实控件名 media_state（不是把手）", ("477", "media_state") in by, list(by))
    p_loader = by.get(("477", "media_state")) or {}
    check("图片输入 kind = image", p_loader.get("kind") == "image", p_loader.get("kind"))
    check("图片默认值取到了媒体状态", isinstance(p_loader.get("default"), str)
          and "images" in (p_loader.get("default") or ""), p_loader.get("default"))
    check("把手名另存在 app_widget", p_loader.get("app_widget") == "kedou_media",
          p_loader.get("app_widget"))

    # 与源工作流对账：读回的默认值必须等于 UI 工作流里 widgets_values_named 的值
    # （不能拿 kapp 的默认值比：kapp 是当时打包的快照，工作流后来改过）
    ui_named = {}
    for n in ui_wf.get("nodes") or []:
        for k, v in (n.get("widgets_values_named") or {}).items():
            ui_named[(str(n.get("id")), k)] = v
    same, diffs = 0, []
    for key, want in ui_named.items():
        sp = by.get(key)
        if sp is not None and sp.get("default") == want:
            same += 1
        elif sp is not None:
            diffs.append((key, sp.get("default"), want))
    check("读回的默认值与源工作流逐条一致（%d/%d）" % (same, len(by)), same == len(by), diffs)

    # ---------------------------------------------------------------- 3. widgets_values_named 优先
    print("\n[3] widgets_values_named 优先（位置对位错）")
    fake = os.path.join(tmp, "named.app.json")
    fake_wf = {
        "id": "11111111-2222-3333-4444-555555555555",
        "nodes": [
            {"id": 1, "type": "TextGenerate",
             # 位置数组故意错位：按位置会读成 "on"，按名字才是 false
             "widgets_values": ["", 4096, "on", 1, 20, 0.95],
             "widgets_values_named": {"thinking": False, "max_tokens": 4096,
                                      "sampling_mode": "on"},
             "inputs": []},
            {"id": 2, "type": "SaveImage", "widgets_values": ["out"],
             "widgets_values_named": {"filename_prefix": "out"}, "inputs": []},
        ],
        "extra": {"linearMode": True, "linearData": {
            "inputs": [["11111111-2222-3333-4444-555555555555:1:thinking", "thinking"]],
            "outputs": ["2"]}},
    }
    with open(fake, "w", encoding="utf-8") as f:
        json.dump(fake_wf, f, ensure_ascii=False)
    fs = apps.build_spec(fake, object_info={})
    p0 = (fs["params"] or [{}])[0]
    check("thinking 取到的是 false（不是 'on'）", p0.get("default") is False, p0.get("default"))
    check("thinking kind = bool", p0.get("kind") == "bool", p0.get("kind"))

    # ---------------------------------------------------------------- 4. 旧式 ref 兼容
    print("\n[4] 旧式 ref 兼容")
    legacy = [
        [["1:thinking", "thinking"], ["2", "filename_prefix"]],
        [[1, "thinking"]],
    ]
    for refs in legacy:
        wf = json.loads(json.dumps(fake_wf))
        wf["extra"]["linearData"]["inputs"] = refs
        p = os.path.join(tmp, "legacy_%d.app.json" % len(refs[0][0]) if isinstance(refs[0][0], str)
                         else os.path.join(tmp, "legacy_tuple.app.json"))
        with open(p, "w", encoding="utf-8") as f:
            json.dump(wf, f, ensure_ascii=False)
        ls = apps.build_spec(p, object_info={})
        check("旧式 ref 解析出参数：%r" % (refs,), len(ls["params"]) == len(refs),
              ls["params"])

    # ---------------------------------------------------------------- 5. 校验失败不落盘
    print("\n[5] 校验失败不落盘")
    base = os.path.join(tmp, "不落盘.app.json")
    r1 = pack.save_official_app("不落盘", ui_wf,
                                [{"node": "9999", "input": "seed"}], ["461"])
    check("节点不存在 -> 拒绝", r1.get("ok") is False and "9999" in r1.get("error", ""), r1)
    r2 = pack.save_official_app("不落盘", ui_wf,
                                [{"node": "483", "input": "不存在的控件"}], ["461"])
    check("控件不存在 -> 拒绝", r2.get("ok") is False, r2)
    r3 = pack.save_official_app("不落盘", ui_wf, [{"node": "483", "input": "seed"}], [])
    check("没有输出 -> 拒绝", r3.get("ok") is False and "输出" in r3.get("error", ""), r3)
    check("三次拒绝都没写文件", not os.path.exists(base))

    # ---------------------------------------------------------------- 6. kapp 遮蔽 app
    print("\n[6] 同 stem：kapp 遮蔽官方包")
    for ext in (".kapp.json", ".app.json"):
        with open(os.path.join(tmp, "同名" + ext), "w", encoding="utf-8") as f:
            json.dump({"kedou_app": 1, "graph": {"1": {"class_type": "X"}}} if "kapp" in ext
                      else {"nodes": []}, f)
    files = apps.find_app_files(tmp)
    check("find_app_files 只留一个", len([p for p in files if "同名" in p]) == 1, files)
    check("留下的是 .kapp.json",
          [p for p in files if "同名" in p][0].endswith(".kapp.json"))

    # ---------------------------------------------------------------- 7. 官方样例只读校验
    sample = os.path.join(WORKFLOWS, "image_qwen_image_2_1_turbo_image_edit.app.json")
    if os.path.isfile(sample):
        print("\n[7] 真机官方样例（image_qwen…app.json）读回")
        ss = apps.build_spec(sample, object_info={})
        sb = {(p["node"], p["input"]): p for p in ss["params"]}
        th = sb.get(("523", "thinking")) or {}
        check("thinking 不再是采样模式的 'on'", th.get("default") != "on", th.get("default"))
        imgs = [p for p in ss["params"] if p["kind"] == "image"]
        check("图片加载器的把手识别成 image", len(imgs) == 1, [p["input"] for p in imgs])


if __name__ == "__main__":
    sys.exit(main())

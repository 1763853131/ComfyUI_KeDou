# -*- coding: utf-8 -*-
"""视频 / 音频输入 kind 的最小回归（不依赖 ComfyUI 进程与真机工作流）。

覆盖：
  1. 官方 .app.json 的 LoadVideo.file -> video、LoadAudio.audio -> audio
  2. VHS_LoadAudio 升版后的 audio_file 也认成 audio
  3. kapp 打包的 _suggest_widget 与官方 kind 同口径
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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
    fails = []

    def check(label, cond, extra=""):
        print(("  ok   " if cond else "  FAIL ") + label + ("" if cond else "  <- " + str(extra)))
        if not cond:
            fails.append(label)

    tmp = tempfile.mkdtemp(prefix="kedou_media_kind_")
    old_dir = paths.WORKFLOW_DIR
    paths.WORKFLOW_DIR = tmp
    try:
        media_path = os.path.join(tmp, "media_kind.app.json")
        wf = {
            "id": "11111111-2222-3333-4444-777777777777",
            "nodes": [
                {"id": 1, "type": "LoadVideo", "widgets_values": ["clip.mp4"], "inputs": []},
                {"id": 2, "type": "LoadAudio", "widgets_values": ["voice.wav"], "inputs": []},
                {"id": 3, "type": "VHS_LoadAudio", "widgets_values": ["vhs.wav"], "inputs": []},
            ],
            "extra": {"linearMode": True, "linearData": {
                "inputs": [
                    ["11111111-2222-3333-4444-777777777777:1:file", "视频"],
                    ["11111111-2222-3333-4444-777777777777:2:audio", "音频"],
                    ["11111111-2222-3333-4444-777777777777:3:audio_file", "VHS 音频"],
                ],
                "outputs": ["1"]}},
        }
        with open(media_path, "w", encoding="utf-8") as f:
            json.dump(wf, f, ensure_ascii=False)
        spec = apps.build_spec(media_path, object_info={})
        by = {(p["node"], p["input"]): p for p in spec["params"]}
        check("LoadVideo.file -> video", (by.get(("1", "file")) or {}).get("kind") == "video",
              by.get(("1", "file")))
        check("LoadAudio.audio -> audio", (by.get(("2", "audio")) or {}).get("kind") == "audio",
              by.get(("2", "audio")))
        check("VHS_LoadAudio.audio_file -> audio",
              (by.get(("3", "audio_file")) or {}).get("kind") == "audio",
              by.get(("3", "audio_file")))
        check("概述按视频 / 音频计数",
              "视频" in (spec.get("desc") or "") and "音频" in (spec.get("desc") or ""),
              spec.get("desc"))

        oi = {
            "LoadVideo": {"input": {"required": {"file": [["clip.mp4"], {}]}}},
            "VHS_LoadAudio": {"input": {"required": {"audio_file": ["STRING", {}]}}},
        }
        check("kapp 特判 LoadVideo.file -> video",
              pack._suggest_widget(oi, "LoadVideo", "file") == "video")
        check("kapp 特判 VHS_LoadAudio.audio_file -> audio",
              pack._suggest_widget(oi, "VHS_LoadAudio", "audio_file") == "audio")
    finally:
        paths.WORKFLOW_DIR = old_dir
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n%s（%d 项失败）" % ("全部通过" if not fails else "有失败项", len(fails)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

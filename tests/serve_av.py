"""KedouAVLoader 前端隔离验证：真实 DOM + 媒体库桩，不启动 ComfyUI。"""

from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sys
import time
from tempfile import TemporaryDirectory
from types import ModuleType
from unittest.mock import patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899

PAGE = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>kedou av verify</title>
<style>html,body{margin:0;background:#171718;color:#fff;font:13px system-ui}#host{width:min(484px,100vw);min-height:420px;padding:12px;box-sizing:border-box}#out{max-width:100vw;overflow-wrap:anywhere;white-space:pre-wrap;font:11px ui-monospace}</style>
<div id="host"></div><pre id="out">running…</pre>
<script>
(async function(){
  const loc = await (await fetch('/locale')).json();
  window.__t = function(k,p){ let s=loc[k]||k; for(const x in (p||{})) s=s.split('{'+x+'}').join(String(p[x])); return s; };
  window.__app = { graph:{_nodes:[],links:new Map(),getNodeById:(id)=>window.__app.graph._nodes.find(n=>n.id===id)},
    canvas:{selected_nodes:null}, configuringGraph:false, extensionManager:{registerSidebarTab(){}},
    registerExtension(){}, ui:{}, api:{addEventListener(){}}, queuePrompt:async()=>true };
  window.__segExports = [];
  window.__segAnalyzes = [];
  window.__testFetch = (u,o)=>{
    if(String(u).endsWith('/ps/video/segments/export')) {
      try { window.__segExports.push(JSON.parse(o.body)); } catch (_) {}
    }
    if(String(u).endsWith('/ps/video/segments/analyze')) {
      try { window.__segAnalyzes.push(JSON.parse(o.body)); } catch (_) {}
    }
    return fetch(u,o);
  };
  await import('/media.js');
  await import('/av.js');
  const s=document.createElement('script'); s.src='/tests.js'; document.head.appendChild(s);
})().catch(e=>{document.getElementById('out').textContent='RESULT'+JSON.stringify({total:0,failed:1,bad:[{name:'bootstrap',error:String(e)}]});});
</script>
"""


def strip_module(text):
    text = re.sub(r"^import .*?;\s*$", "", text, flags=re.M)
    return re.sub(r"^export\s*\{[^}]*\};?\s*$", "", text, flags=re.M)


def media_text():
    text = strip_module((ROOT / "web" / "kedou_media.js").read_text(encoding="utf-8"))
    prefix = "const app=window.__app; const fetch=window.__testFetch;\n"
    prefix += "const t=window.__t, locale=()=> 'zh', initI18n=async()=>{}, onLocaleChange=()=>()=>{}, serverError=x=>x;\n"
    tools = ["ensureCss", "thumbUrl", "fetchLibrary", "kdToast", "nodeOnCanvas", "settleQueueSubmission", "kdGesture", "hideMediaStateInput"]
    entries = ",".join('%s:(typeof %s!=="undefined"?%s:null)' % (n, n, n) for n in tools)
    return prefix + text + "\nwindow.__kdTools={" + entries + "};\n"


def av_text():
    text = strip_module((ROOT / "web" / "kedou_av.js").read_text(encoding="utf-8"))
    prefix = "const app=window.__app; const fetch=window.__testFetch; const t=window.__t, initI18n=async()=>{}, onLocaleChange=()=>()=>{}, serverError=x=>x;\n"
    prefix += "const {ensureCss,thumbUrl,fetchLibrary,kdToast,nodeOnCanvas,settleQueueSubmission,kdGesture,hideMediaStateInput}=window.__kdTools;\n"
    return prefix + text + "\nwindow.__avTools={readState,writeState,effectiveList,pairCount,pairAt,outputLayout,legacyOutputKey,build,runAV,cleanItem};\n"


def main():
    with TemporaryDirectory(prefix="kedou_av_ui_") as tmp, ExitStack() as stack:
        pkg = ModuleType("_kedou_av_ui_bridge")
        pkg.__path__ = [str(ROOT / "kedou_bridge")]
        stack.enter_context(patch.dict(sys.modules, {
            pkg.__name__: pkg, "aiohttp": None, "server": None,
            "nodes": None, "folder_paths": None, "torch": None,
        }))
        importlib = __import__("importlib")
        importlib.import_module(pkg.__name__ + ".paths")
        jobs = {}
        exports = []
        av_sets = []

        class Handler(BaseHTTPRequestHandler):
            def reply(self, data, content_type="application/json", status=200):
                raw = json.dumps(data, ensure_ascii=False).encode() if content_type == "application/json" else data.encode()
                self.send_response(status)
                self.send_header("Content-Type", content_type + "; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                path = urlsplit(self.path).path
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length) if length else b"{}"
                body = {}
                if path.startswith("/ps/video/segments/") or path.startswith("/ps/av-sets/"):
                    try:
                        body = json.loads(raw or b"{}")
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        self.send_error(400)
                        return
                if path == "/ps/media/upload":
                    time.sleep(0.2)
                    match = re.search(br'filename="([^"]+)"', raw)
                    filename = match.group(1).decode("utf-8", "replace") if match else "uploaded.mp4"
                    ext = os.path.splitext(filename)[1].lower()
                    kind = "audio" if "type=audio" in self.path else "video"
                    if (kind == "audio" and ext not in (".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus")) or (
                            kind == "video" and ext not in (".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".ogv")):
                        self.reply({"ok": False, "error": "unsupported extension"}, status=400)
                        return
                    self.reply({"ok": True, "filename": filename, "name": filename})
                    return
                if path == "/ps/av-sets/save":
                    item = dict(body)
                    item["id"] = body.get("id") or "av-set-%d" % (len(av_sets) + 1)
                    item["name"] = body.get("name") or "AV set"
                    existing = next((x for x in av_sets if x["id"] == item["id"]), None)
                    if existing:
                        existing.update(item)
                        item = existing
                    else:
                        av_sets.append(item)
                    self.reply({"ok": True, "item": item})
                    return
                if path == "/ps/av-sets/load":
                    item = next((x for x in av_sets if x["id"] == body.get("id")), None)
                    if not item:
                        self.send_error(404)
                        return
                    self.reply({"ok": True, "item": item, "missing": []})
                    return
                if path == "/ps/av-sets/rename":
                    item = next((x for x in av_sets if x["id"] == body.get("id")), None)
                    if not item:
                        self.send_error(404)
                        return
                    item["name"] = body.get("name") or item["name"]
                    self.reply({"ok": True, "item": item})
                    return
                if path == "/ps/av-sets/delete":
                    before = len(av_sets)
                    av_sets[:] = [x for x in av_sets if x["id"] != body.get("id")]
                    self.reply({"ok": len(av_sets) < before})
                    return
                if path == "/ps/video/segments/analyze":
                    mode = body.get("mode", "duration")
                    params = body.get("params", {})
                    job_id = "%s-job-%d" % (mode, len(jobs) + 1)
                    if mode == "duration":
                        segments = [
                            {"start": 0, "end": 5},
                            {"start": 5, "end": 10},
                        ]
                    elif params.get("engine") == "omnishotcut":
                        segments = [
                            {"start": 0, "end": 2.4, "confidence": 0.97},
                            {"start": 2.4, "end": 5.1, "confidence": 0.83},
                            {"start": 5.1, "end": 7.8, "confidence": 0.69},
                            {"start": 7.8, "end": 10, "confidence": 0.92},
                        ]
                    else:
                        segments = [
                            {"start": 0, "end": 3, "confidence": 0.91},
                            {"start": 3, "end": 7, "confidence": 0.76},
                            {"start": 7, "end": 10, "confidence": 0.88},
                        ]
                    result = {
                        "v": 1,
                        "source": {
                            "name": body.get("name"), "subfolder": body.get("subfolder", ""),
                            "tab": body.get("tab", "input"), "mtime_ns": 1, "size": 1024,
                        },
                        "mode": mode, "params": body.get("params", {}),
                        "duration": 10, "segments": segments,
                    }
                    jobs[job_id] = {"id": job_id, "status": "done", "progress": 1,
                                    "stage": "done", "result": result, "error": None, "cancelled": False}
                    self.reply({"ok": True, "job_id": job_id})
                    return
                cancel_match = re.fullmatch(r"/ps/video/segments/jobs/([^/]+)/cancel", path)
                if cancel_match:
                    job = jobs.get(cancel_match.group(1))
                    if not job:
                        self.send_error(404)
                        return
                    job["status"] = "cancelled"
                    job["cancelled"] = True
                    job["stage"] = "cancelled"
                    self.reply({"ok": True, "job": job})
                    return
                if path == "/ps/video/segments/export":
                    requested = body.get("segments", [])
                    exports.append(body)
                    job_id = "export-job-%d" % len(exports)
                    items = [{
                        "name": "clip_%03d.mp4" % (i + 1),
                        "filename": "clip_%03d.mp4" % (i + 1),
                        "subfolder": "segments", "tab": "input", "kind": "video",
                        "start": segment.get("start"), "end": segment.get("end"),
                    } for i, segment in enumerate(requested)]
                    jobs[job_id] = {"id": job_id, "status": "done", "progress": 1,
                                    "stage": "done", "result": {"items": items},
                                    "error": None, "cancelled": False}
                    self.reply({"ok": True, "job_id": job_id})
                    return
                self.send_error(404)

            def do_GET(self):
                path = urlsplit(self.path).path
                if path == "/":
                    self.reply(PAGE, "text/html")
                elif path == "/media.js":
                    self.reply(media_text(), "text/javascript")
                elif path == "/av.js":
                    self.reply(av_text(), "text/javascript")
                elif path == "/tests.js":
                    self.reply((ROOT / "tests" / "av_browser.js").read_text(encoding="utf-8"), "text/javascript")
                elif path == "/locale":
                    self.reply(json.loads((ROOT / "locales" / "zh" / "main.json").read_text(encoding="utf-8")))
                elif re.fullmatch(r"/ps/video/segments/jobs/[^/]+", path):
                    job = jobs.get(path.rsplit("/", 1)[-1])
                    if not job:
                        self.send_error(404)
                        return
                    self.reply({"ok": True, "job": job})
                elif path == "/ps/av-sets":
                    self.reply({"ok": True, "items": av_sets})
                elif path == "/ps/media":
                    items = [
                        {"name":"ref.mp4","subfolder":"","tab":"input","kind":"video"},
                        {"name":"ref.mp4","subfolder":"","tab":"output","kind":"video"},
                        {"name":"second.mp4","subfolder":"","tab":"input","kind":"video"},
                        {"name":"voice.wav","subfolder":"","tab":"input","kind":"audio"},
                        {"name":"second.wav","subfolder":"","tab":"input","kind":"audio"},
                    ]
                    self.reply({"ok": True, "items": items})
                elif path == "/ps/media/info":
                    self.reply({"ok": True, "duration": 3.2, "width": 640, "height": 360, "sample_rate": 44100})
                else:
                    self.send_error(404)

        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        print("AV UI test bridge listening on 127.0.0.1:%d" % PORT, flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == "__main__":
    main()

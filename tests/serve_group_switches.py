"""Isolated browser-test bridge; never submits prompts or writes user data."""

from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import json
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
from types import ModuleType
from unittest.mock import patch
from urllib.parse import urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def main():
    with TemporaryDirectory(prefix="kedou_groups_ui_") as tmp, ExitStack() as stack:
        pkg = ModuleType("_group_ui_bridge")
        pkg.__path__ = [str(ROOT / "kedou_bridge")]
        stack.enter_context(patch.dict(sys.modules, {
            pkg.__name__: pkg, "aiohttp": None, "server": None,
            "nodes": None, "folder_paths": None, "torch": None,
        }))
        pack = importlib.import_module(pkg.__name__ + ".pack")
        apps = importlib.import_module(pkg.__name__ + ".apps")
        paths = importlib.import_module(pkg.__name__ + ".paths")
        compat = importlib.import_module(pkg.__name__ + ".compat")
        root = Path(tmp)
        user = root / "user" / "default"
        for folder in ("kedou_apps", "workflows", "kedou_trash"):
            (user / folder).mkdir(parents=True, exist_ok=True)
        stack.enter_context(patch.multiple(
            paths, COMFY_ROOT=str(root), APPS_DIR=str(user / "kedou_apps"),
            WORKFLOW_DIR=str(user / "workflows"), TRASH_DIR=str(user / "kedou_trash"),
            _user_default_dir=lambda: str(user),
        ))
        with urlopen("http://127.0.0.1:8188/object_info", timeout=10) as response:
            info = json.load(response)
        registry = {}
        for name, entry in info.items():
            registry[name] = type(name, (), {
                "INPUT_TYPES": classmethod(lambda cls, entry=entry: entry.get("input", {})),
                "RETURN_TYPES": entry.get("output", []),
            })
        stack.enter_context(patch.object(compat, "NODE_MAP", registry))

        class Handler(BaseHTTPRequestHandler):
            def reply(self, data, content_type="application/json"):
                raw = json.dumps(data, ensure_ascii=False).encode() if content_type == "application/json" else data.encode()
                self.send_response(200)
                self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:8188")
                self.send_header("Content-Type", content_type + "; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_OPTIONS(self):
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:8188")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.end_headers()

            def do_GET(self):
                path = urlsplit(self.path).path
                if path in ("/module.js", "/before.js"):
                    filename = "kedou_media.js" if path == "/module.js" else "kedou_media.js.bak-20261107-groups"
                    text = (ROOT / "web" / filename).read_text(encoding="utf-8")
                    text = re.sub(r"^import .*?;\s*$", "", text, flags=re.M)
                    prefix = "const app=window.__groupTestApp; const fetch=window.__groupTestFetch;\n"
                    prefix += "const t=window.__groupTestTranslate, locale=()=> 'zh', initI18n=async()=>{}, onLocaleChange=()=>()=>{}, serverError=x=>x;\n"
                    text += "\nwindow.__groupTools={openPackPanel,closePackPanel,doGenerate,collectCandidates,kpCss:KPCSS,kpGroupPrompt:typeof kpGroupPrompt==='function'?kpGroupPrompt:null,kpGroupCandidates:typeof kpGroupCandidates==='function'?kpGroupCandidates:null};"
                    self.reply(prefix + text, "text/javascript")
                elif path == "/tests.js":
                    text = (ROOT / "tests/group_switches_browser.js").read_text(encoding="utf-8")
                    text = text.replace('import("/scripts/app.js")', 'import("http://127.0.0.1:8188/scripts/app.js")')
                    self.reply(text, "text/javascript")
                elif path == "/pack_rows.js":
                    text = (ROOT / "tests/pack_rows_browser.js").read_text(encoding="utf-8")
                    self.reply(text, "text/javascript")
                elif path == "/locale":
                    self.reply(json.loads((ROOT / "locales/zh/main.json").read_text(encoding="utf-8")))
                elif path == "/ps/pack/apps":
                    self.reply({"ok": True, "apps": []})
                elif path.endswith("/package"):
                    name = path.split("/")[-2]
                    file = Path(paths.APPS_DIR) / (name + ".kapp.json")
                    self.reply({"ok": True, "target": "kedou_apps/" + file.name,
                                "kapp": json.loads(file.read_text(encoding="utf-8"))})
                elif path.startswith("/ps/apps/"):
                    self.reply(apps.get_app(path.split("/")[-1]))
                else:
                    self.send_error(404)

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                try:
                    if self.path == "/ps/pack/save":
                        result = pack.save_kapp(data["name"], data.get("desc", ""), data["kapp"],
                                                target=data.get("target"), workflow=data.get("workflow"))
                    elif self.path.endswith("/graph"):
                        result = apps.build_graph(self.path.split("/")[-2], data.get("values", {}))
                    elif self.path.endswith("/values"):
                        result = apps.update_values(self.path.split("/")[-2], data.get("values", {}))
                    else:
                        self.send_error(404)
                        return
                    self.reply(result)
                except Exception as error:
                    self.reply({"ok": False, "error": str(error)})

        server = ThreadingHTTPServer(("127.0.0.1", 8896), Handler)
        print("Group UI test bridge listening on 127.0.0.1:8896; isolated storage=" + tmp, flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == "__main__":
    main()

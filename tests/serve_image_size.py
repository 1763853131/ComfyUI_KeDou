# -*- coding: utf-8 -*-
"""悬浮尺寸功能的隔离验证服务：真路由 + 真缩略图 + 临时媒体目录。

用法（必须用带 aiohttp / Pillow 的解释器，例如 ComfyUI 的 python_embeded）：
    <comfyui>/python_embeded/python.exe tests/serve_image_size.py [port]
然后用无头 Chrome 打开 http://127.0.0.1:8897/?module=module.js（改动后）
或 ?module=before.js（改动前的备份，反向测试）。

为什么不去连正在跑的 ComfyUI：新路由要重启才注册，重启会打断用户手上的队列。
这里把 routes.register 原样挂到一个独立的 aiohttp 应用上，路径全部指到临时目录，
读的是真文件、走的是真处理函数，但不碰用户的 input/output、不写 sidecar、不提交任何图。
"""

from contextlib import ExitStack
import importlib
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType
from unittest.mock import patch

from aiohttp import web

ROOT = Path(__file__).resolve().parents[1]
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8897
# 反向测试的基线：默认拿「选择模式也出预览图」改动前的备份；可用第二个参数换别的备份。
BACKUP = sys.argv[2] if len(sys.argv) > 2 else "kedou_media.js.bak-20261111-select-preview"
# 真·长文件名：11px 下约 480px 宽，超过信息条名字行的 322px 上限，用来验省略号。
LONG_NAME = "金属臂灵汐_最终版_改改改_再改_交付_真的最终版_还要再改_这次真的不改了_备份_副本_归档.png"


def load_bridge(stack):
    """把 kedou_bridge 当独立包加载：aiohttp 用真的，ComfyUI 那几个依赖挡掉。

    注意 server 不能直接 stub 成 None：compat 把 `from aiohttp import web` 和
    `from server import PromptServer` 放在同一个 try 里，后者一炸前者也跟着变 None，
    路由注册时就是 'NoneType' has no attribute 'middleware'。给个 instance=None 的壳，
    aiohttp 那半照常成立，中间件挂载那步自己会走 except（本来就不需要 CORS，同源）。
    """
    pkg = ModuleType("_kedou_size_bridge")
    pkg.__path__ = [str(ROOT / "kedou_bridge")]
    server = ModuleType("server")
    server.PromptServer = type("PromptServer", (), {"instance": None})
    stack.enter_context(patch.dict(sys.modules, {
        pkg.__name__: pkg, "server": server, "nodes": None,
        "folder_paths": None, "torch": None,
    }))
    mods = {}
    for name in ("paths", "compat", "media", "state", "routes", "nodes"):
        mods[name] = importlib.import_module(pkg.__name__ + "." + name)
    return mods


def make_fixtures(in_dir, out_dir, nodes):
    """造一批「尺寸已知」的图，覆盖比例 / 格式 / EXIF / 目录回退 / 坏文件。"""
    from PIL import Image

    def put(path, size, orientation=None, color=(90, 140, 200)):
        path.parent.mkdir(parents=True, exist_ok=True)
        im = Image.new("RGB", size, color)
        if orientation is None:
            im.save(path)
        else:
            exif = Image.Exif()
            exif[274] = orientation
            im.save(path, exif=exif)
        return {"name": path.name, "w": size[0], "h": size[1]}

    files = [
        put(in_dir / "wide.png", (1600, 900)),
        # 存的是横向像素 + 方向标记 6：看得见的应该是 900×1600
        put(in_dir / "rot.jpg", (1600, 900), orientation=6, color=(200, 120, 90)),
        put(in_dir / "small.webp", (240, 160), color=(120, 190, 140)),
        put(in_dir / "tiny.gif", (64, 48), color=(190, 170, 110)),
        put(out_dir / "gen.png", (1024, 1536), color=(150, 110, 190)),
        put(in_dir / "both.png", (300, 200)),
        put(out_dir / "both.png", (500, 400), color=(110, 110, 110)),
    ]
    # 已经正好落在 1024 档不动点上的图：桶开着也不该多出一条「输出」
    fw, fh = nodes.bucket_size(1600, 900, 1024)
    files.append(put(in_dir / "fixed.png", (fw, fh), color=(80, 160, 200)))
    files.append(put(in_dir / LONG_NAME, (1600, 900), color=(190, 120, 160)))
    (in_dir / "broken.png").write_bytes(b"\x89PNG\r\n\x1a\nnot a real png")
    return files


def bucket_cases(nodes):
    """前端 kdBucketSize 的对照表：期望值一律由后端 bucket_size 算，不靠前端自证。"""
    sizes = [(1600, 900), (900, 1600), (1024, 1536), (240, 160), (64, 48),
             (1089, 4096), (3024, 4032), (100, 100), (1376, 768), (4096, 1089)]
    out = []
    for w, h in sizes:
        for res in (0, 512, 1024, 1328, 2048):
            bw, bh = nodes.bucket_size(w, h, res)
            out.append({"w": w, "h": h, "res": res, "bw": bw, "bh": bh})
    return out


PAGE = """<!doctype html>
<meta charset="utf-8">
<title>kedou hover size verify</title>
<style>
  html,body{margin:0;background:var(--background,#1b1b20);color:var(--foreground,#e8e8ee);font:13px/1.5 system-ui,sans-serif}
  #host{position:relative;width:460px;height:380px;overflow:auto;margin:12px}
  #out{white-space:pre-wrap;padding:8px 12px;font:11px/1.5 ui-monospace,monospace}
</style>
<div id="host"></div>
<pre id="out">running…</pre>
<script>
(async function () {
  const params = new URLSearchParams(location.search);
  const which = params.get("module") || "module.js";
  // 主题变量按本机前端 main-*.css 的实测映射注入：--comfy-menu-bg:var(--background)。
  // 旧前端 --comfy-menu-bg 恒定深色，新前端随主题变；白主题的 --background/--foreground
  // 由前端主题系统在运行时注入（用户截图实测为白底黑字），这里照此复现两种主题。
  // 不注入的话 var() 全走深色回退，白主题下「浅字压白底」这类 bug 永远测不出来。
  const rs = document.documentElement.style;
  if ((params.get("theme") || "dark") === "light") {
    rs.setProperty("--background", "#ffffff");
    rs.setProperty("--foreground", "#000000");
  } else {
    rs.setProperty("--background", "#171718");
    rs.setProperty("--foreground", "#ffffff");
  }
  rs.setProperty("--comfy-menu-bg", "var(--background)");
  rs.setProperty("--fg-color", "var(--foreground)");
  rs.setProperty("--p-primary-color", "#4a7dff");
  const loc = await (await fetch("/ps/locale?lang=zh")).json();
  const dict = (loc && loc.messages) || {};
  window.__t = function (key, params) {
    let s = dict[key] || key;
    for (const k in (params || {})) s = s.split("{" + k + "}").join(String(params[k]));
    return s;
  };
  window.__app = {
    graph: { links: {}, getLink: () => null },
    canvas: { selected_nodes: null },
    configuringGraph: false,
    extensionManager: { registerSidebarTab() {} },
    registerExtension() {},
    ui: {}, api: { addEventListener() {} },
  };
  // 数请求 + 可切换成「后端还没有这条路由」的样子
  window.__sizeCalls = [];
  window.__blockSize = false;
  window.__testFetch = function (url, opts) {
    const u = String(url);
    if (u.indexOf("/ps/imgsize") >= 0) {
      window.__sizeCalls.push(u);
      if (window.__blockSize) return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return fetch(url, opts);
  };
  // 必须按 ES module 加载：桩里的 const fetch 若落在全局词法作用域，
  // window.__testFetch 内部那句 fetch() 会解析到它自己 → 无限递归。
  // module 作用域里影子只覆盖被测文件，桩函数用的还是真 fetch。
  await import("/" + which);
  const s2 = document.createElement("script");
  s2.src = "/tests.js";
  document.head.appendChild(s2);
})().catch((e) => {
  document.getElementById("out").textContent = "RESULT" + JSON.stringify({
    total: 0, failed: 1, bad: [{ name: "bootstrap", error: String(e) }] });
});
</script>
"""


def module_text(filename):
    """ES module → 普通脚本：换掉 import 行，注入桩，末尾导出被测函数。"""
    import re
    text = (ROOT / "web" / filename).read_text(encoding="utf-8")
    text = re.sub(r"^import .*?;\s*$", "", text, flags=re.M)
    prefix = ("const app=window.__app; const fetch=window.__testFetch;\n"
              "const t=window.__t, locale=()=>'zh', initI18n=async()=>{}, "
              "onLocaleChange=()=>()=>{}, serverError=x=>x;\n")
    tools = ["renderPanel", "openBig", "openLibrary", "ensureCss", "readState", "writeState",
             "attachZoom", "kdGesture", "kdZoomHide", "kdBucketSize", "kdFillSize",
             "kdSizeCache", "thumbUrl"]
    # 反向测试要跑改动前的备份：那时这些函数/常量还不存在，直接引用会整个 ReferenceError，
    # 一条断言都看不到。逐个 typeof 兜底，缺的就是 null，断言会逐条失败而不是整页崩。
    entries = ",".join('%s:(typeof %s!=="undefined"?%s:null)' % (n, n, n) for n in tools)
    suffix = ("\nwindow.__kdTools={" + entries +
              ",zoomEl:()=>(typeof kdZoomEl!=='undefined'?kdZoomEl:null)"
              ",marquee:()=>(typeof kdMarquee!=='undefined'?kdMarquee:false)};\n")
    return prefix + text + suffix


def main():
    with TemporaryDirectory(prefix="kedou_size_ui_") as tmp, ExitStack() as stack:
        mods = load_bridge(stack)
        paths, media, nodes, routes = mods["paths"], mods["media"], mods["nodes"], mods["routes"]
        root = Path(tmp)
        user = root / "user" / "default"
        for folder in ("kedou_apps", "workflows", "kedou_trash", "kedou_thumbs"):
            (user / folder).mkdir(parents=True, exist_ok=True)
        in_dir, out_dir = root / "input", root / "output"
        in_dir.mkdir()
        out_dir.mkdir()
        stack.enter_context(patch.multiple(
            paths, COMFY_ROOT=str(root), APPS_DIR=str(user / "kedou_apps"),
            WORKFLOW_DIR=str(user / "workflows"), TRASH_DIR=str(user / "kedou_trash"),
            _user_default_dir=lambda: str(user),
        ))
        stack.enter_context(patch.object(media, "_media_dirs", lambda: (str(in_dir), str(out_dir))))
        stack.enter_context(patch.object(media, "THUMB_DIR", str(user / "kedou_thumbs")))
        files = make_fixtures(in_dir, out_dir, nodes)
        cases = bucket_cases(nodes)

        table = web.RouteTableDef()
        routes.register(table)          # 真路由：/ps/imgsize、/ps/thumb、/ps/media、/ps/locale…

        @table.get("/")
        async def index(request):
            return web.Response(text=PAGE, content_type="text/html")

        @table.get("/module.js")
        async def module_js(request):
            return web.Response(text=module_text("kedou_media.js"), content_type="text/javascript")

        @table.get("/before.js")
        async def before_js(request):
            return web.Response(text=module_text(BACKUP), content_type="text/javascript")

        @table.get("/tests.js")
        async def tests_js(request):
            text = (ROOT / "tests" / "image_size_browser.js").read_text(encoding="utf-8")
            return web.Response(text=text, content_type="text/javascript")

        @table.get("/fixtures.json")
        async def fixtures(request):
            return web.json_response({"files": files, "cases": cases, "longName": LONG_NAME})

        @table.get("/view")
        async def view(request):
            """ComfyUI 原生 /view 的替身：大图预览要读原图。"""
            qq = request.query
            src = media._media_file(qq.get("filename"), qq.get("subfolder"),
                                    "output" if qq.get("type") == "output" else "input")
            if not src:
                return web.Response(status=404)
            return web.FileResponse(src)

        app = web.Application()
        app.add_routes(table)

        # 被测文件一律 no-store：改完刷新就该看到新的，别让浏览器把上一版 module.js 缓存住
        # （反向测试尤其容易被坑：以为在跑备份，其实跑的还是缓存里的新版）。
        @web.middleware
        async def no_store(request, handler):
            resp = await handler(request)
            if request.path in ("/", "/module.js", "/before.js", "/tests.js", "/fixtures.json"):
                resp.headers["Cache-Control"] = "no-store"
            return resp

        app.middlewares.append(no_store)
        print("[kedou] 悬浮尺寸验证服务：http://127.0.0.1:%d/  （媒体目录 %s）" % (PORT, in_dir))
        web.run_app(app, host="127.0.0.1", port=PORT, print=None)


if __name__ == "__main__":
    main()
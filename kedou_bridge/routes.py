# -*- coding: utf-8 -*-
"""HTTP 路由：/ps/apps · /ps/media · /ps/thumb · /ps/pack · /ps/prompt 等。

只定义注册函数，不在导入时碰 PromptServer；由插件入口在 ComfyUI 里调用。
"""

import asyncio
import hashlib
import json
import os
import re

from . import apps, compat, image_sets, media, pack, paths, state

LOCALE_DIR = os.path.join(paths.PLUGIN_DIR, "locales")
_thumb_pruned = False


def register(routes):


# ---------------------------------------------------------------- 路由
    # 首次启动生成写接口令牌文件（外部面板可读取后放进 X-Kedou-Token；
    # 本机无 Origin 的旧客户端仍放行，设 KEDOU_BRIDGE_REQUIRE_TOKEN=1 可强制令牌）。
    try:
        state._get_bridge_token(create=True)
    except Exception as _e:                            # noqa: BLE001
        print("[KeDou] 写接口令牌生成失败（本机调用仍可用）:", _e)

    # UXP 的 fetch 会做跨域检查，而 ComfyUI 默认不回 CORS 头 →
    # PS 插件请求会被浏览器内核拦掉（表现为"连不上"）。
    # 这里只给 /ps/ 下的路由加 CORS，不影响 ComfyUI 自己的接口。
    @compat.web.middleware
    async def _ps_cors_middleware(request, handler):
        if not request.path.startswith("/ps/"):
            return await handler(request)
        # 写接口先过来源/令牌检查：默认拒绝来自其它网站的写请求。
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and not state._write_allowed(request):
            resp = compat.web.json_response(
                {"ok": False,
                 "error": "unauthorized: pass X-Kedou-Token (see user/default/kedou_bridge_token.txt)"},
                status=403)
        elif request.method == "OPTIONS":
            resp = compat.web.Response(status=204)
        else:
            resp = await handler(request)
        try:
            resp.headers["Access-Control-Allow-Origin"] = "*"
            resp.headers["Access-Control-Allow-Headers"] = "*"
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        except Exception:                            # noqa: BLE001
            pass
        return resp

    try:
        # aiohttp 按列表顺序把第一个中间件包在最外层。ComfyUI 自带 origin_only
        # 注册在前面，直接 append 的话我们永远轮不到；插到最前面才能真正回 CORS 头。
        # 跨站请求仍会被后面的 origin_only 拦掉（我们只给它的 403 补头，不绕过它）。
        compat.PromptServer.instance.app.middlewares.insert(0, _ps_cors_middleware)
    except Exception as _e:                          # noqa: BLE001
        try:
            compat.PromptServer.instance.app.middlewares.append(_ps_cors_middleware)
        except Exception:                            # noqa: BLE001
            print("[KeDou] CORS 中间件注册失败（插件可能仍能用，但跨域可能被拦）:", _e)

    @routes.get("/ps/version")
    async def ps_version(request):
        """外部面板握手：协议版本 + 本版关键能力，避免靠猜。"""
        token_file = state._bridge_token_file()
        return compat.web.json_response({
            "ok": True,
            "bridge": "ComfyUI_KeDou",
            "schema_version": state.BRIDGE_SCHEMA_VERSION,
            "features": {
                "sidecar_state": True,
                "graph_cache": True,
                "write_token": True,
                "image_sets": True,
                "app_formats": ["kapp", "official"],
            },
            "write_auth": {
                "header": "X-Kedou-Token",
                "token_file": paths._rel(token_file) if os.path.isfile(token_file) else "",
                "require_token_env": "KEDOU_BRIDGE_REQUIRE_TOKEN",
            },
        })

    @routes.get("/ps/apps")
    async def ps_apps_list(request):
        # 目录遍历 + 逐个解析工作流可能很慢，放线程池，别卡住 ComfyUI 的事件循环
        return compat.web.json_response({"apps": await asyncio.to_thread(apps.list_apps),
                                  "root": paths.WORKFLOW_DIR})

    @routes.get("/ps/apps/{app_id}")
    async def ps_apps_get(request):
        app_id = request.match_info.get("app_id", "")
        if not paths._safe_id(app_id):
            return compat.web.json_response({"error": "bad id"}, status=400)
        spec = await asyncio.to_thread(apps.get_app, app_id)
        if spec is None:
            return compat.web.json_response({"error": "app not found"}, status=404)
        return compat.web.json_response(spec)

    @routes.get("/ps/apps/{app_id}/package")
    async def ps_apps_package(request):
        """打包面板「编辑已有应用」：返回原始 kapp（含 graph/params），只支持 .kapp.json。"""
        app_id = request.match_info.get("app_id", "")
        if not paths._safe_id(app_id):
            return compat.web.json_response({"error": "bad id"}, status=400)
        path = await asyncio.to_thread(apps._find_path, app_id)
        if path is None:
            return compat.web.json_response({"error": "app not found"}, status=404)
        if not apps._is_kapp(path):
            return compat.web.json_response({"error": "only .kapp.json can be edited"}, status=400)
        try:
            data = await asyncio.to_thread(apps._load_kapp, path)
        except Exception as e:                       # noqa: BLE001
            return compat.web.json_response({"error": "%s: %s" % (type(e).__name__, e)}, status=400)
        # file 是展示用（相对 ComfyUI 根）；target 是回写用（相对工作流目录），
        # 用户目录被指到别处时这两者可能不同，前端保存必须用 target。
        return compat.web.json_response({"ok": True, "file": paths._rel(path),
                                  "target": pack._pack_target(path), "kapp": data})

    @routes.post("/ps/apps/{app_id}/values")
    async def ps_apps_values(request):
        """把面板上的编辑存到 sidecar（工作流文件不改；默认值会在读取应用时叠加）"""
        app_id = request.match_info.get("app_id", "")
        if not paths._safe_id(app_id):
            return compat.web.json_response({"error": "bad id"}, status=400)
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            return compat.web.json_response({"error": "bad json"}, status=400)
        values = (body or {}).get("values") if isinstance(body, dict) else None
        if not isinstance(values, dict):
            return compat.web.json_response(
                {"error": 'body must be {"values": {"<node>:<widget>": value}}'}, status=400)
        result = await asyncio.to_thread(apps.update_values, app_id, values)
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.post("/ps/apps/{app_id}/graph")
    async def ps_apps_graph(request):
        """界面格式转 API 格式 + 注入面板的值，返回可直接 POST /prompt 的图"""
        app_id = request.match_info.get("app_id", "")
        if not paths._safe_id(app_id):
            return compat.web.json_response({"error": "bad id"}, status=400)
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            body = {}
        values = (body or {}).get("values") if isinstance(body, dict) else None
        result = await asyncio.to_thread(apps.build_graph, app_id, values or {})
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)


    # 够不到仓库根的 locales/，所以自己开一条只读口（注册表的 /i18n 走的是另一套，
    # 它只在启动时读一次，且我们自己的面板要能随 Comfy.Locale 切换即时重绘）。
    # 注意：LOCALE_DIR 用模块级那份（基于 paths.PLUGIN_DIR），不要再按 __file__ 算 ——
    # 本文件在 kedou_bridge/ 里，dirname 会指到 kedou_bridge/locales（不存在），
    # 语言包读不到就会整体回退英文。
    @routes.get("/ps/locale")
    async def ps_locale(request):
        """GET /ps/locale?lang=zh -> { ok, messages }，messages 即 locales/<lang>/main.json。"""
        lang = str(request.query.get("lang") or "")
        if not re.fullmatch(r"[A-Za-z][A-Za-z-]{1,7}", lang):
            return compat.web.json_response({"ok": False, "error": "lang 非法"})
        path = os.path.join(LOCALE_DIR, lang, "main.json")
        if not paths._under(LOCALE_DIR, path) or not os.path.isfile(path):
            return compat.web.json_response({"ok": True, "messages": {}})   # 没这个语言包：回英文
        try:
            with open(path, "r", encoding="utf-8") as f:
                messages = json.load(f)
        except Exception as e:                        # noqa: BLE001
            return compat.web.json_response({"ok": False, "error": "语言包读取失败：%s" % e})
        return compat.web.json_response({"ok": True, "messages": messages})

    @routes.get("/ps/media")
    async def ps_media(request):
        """GET /ps/media?type=image|video|audio&tab=all|input|output&q=关键词"""
        qq = request.query
        items = await asyncio.to_thread(media.list_media, qq.get("type", "image"),
                                        qq.get("tab", "all"), qq.get("q", ""))
        return compat.web.json_response({"ok": True, "items": items})

    @routes.post("/ps/media/pick")
    async def ps_media_pick(request):
        """POST /ps/media/pick {name, subfolder, tab} -> {ok, filename, copied}"""
        try:
            body = await request.json()
        except Exception:                                    # noqa: BLE001
            body = {}
        body = body if isinstance(body, dict) else {}
        result = await asyncio.to_thread(media.pick_media, body.get("name"),
                                         body.get("subfolder"), body.get("tab"))
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

    # ---- 图片排列预设：只存文件名/顺序，不复制图片 ----
    @routes.get("/ps/image-sets")
    async def ps_image_sets_list(request):
        return compat.web.json_response(await asyncio.to_thread(image_sets.list_sets))

    @routes.post("/ps/image-sets/save")
    async def ps_image_sets_save(request):
        try:
            body = await request.json()
        except Exception:                                    # noqa: BLE001
            body = {}
        body = body if isinstance(body, dict) else {}
        result = await asyncio.to_thread(
            image_sets.save_set, body.get("name", ""), body.get("images"),
            body.get("batch", False), body.get("select", False),
            body.get("picked"), body.get("id", ""))
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.post("/ps/image-sets/load")
    async def ps_image_sets_load(request):
        try:
            body = await request.json()
        except Exception:                                    # noqa: BLE001
            body = {}
        body = body if isinstance(body, dict) else {}
        result = await asyncio.to_thread(image_sets.load_set, body.get("id", ""))
        return compat.web.json_response(result, status=200 if result.get("ok") else 404)

    @routes.post("/ps/image-sets/rename")
    async def ps_image_sets_rename(request):
        try:
            body = await request.json()
        except Exception:                                    # noqa: BLE001
            body = {}
        body = body if isinstance(body, dict) else {}
        result = await asyncio.to_thread(
            image_sets.rename_set, body.get("id", ""), body.get("name", ""))
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.post("/ps/image-sets/delete")
    async def ps_image_sets_delete(request):
        try:
            body = await request.json()
        except Exception:                                    # noqa: BLE001
            body = {}
        body = body if isinstance(body, dict) else {}
        result = await asyncio.to_thread(image_sets.delete_set, body.get("id", ""))
        return compat.web.json_response(result, status=200 if result.get("ok") else 404)

    @routes.get("/ps/thumb")
    async def ps_thumb(request):
        """GET /ps/thumb?filename=&subfolder=&type=input|output&w=256 -> image/webp

        只服务图片；不是图 / 解不开 / 越界，一律 404，由前端回退到 /view 原图。
        """
        global _thumb_pruned
        qq = request.query
        tab = "output" if str(qq.get("type") or "input") == "output" else "input"
        try:
            w = int(qq.get("w") or 256)
        except ValueError:
            w = 256
        w = max(32, min(media.THUMB_MAX_SIDE, w))
        src = media._media_file(qq.get("filename"), qq.get("subfolder"), tab)
        if not src:
            return compat.web.Response(status=404)
        if not _thumb_pruned:
            _thumb_pruned = True
            await asyncio.to_thread(media._thumb_prune_old)
        try:
            st = os.stat(src)
        except OSError:
            return compat.web.Response(status=404)
        key = hashlib.sha1(("%s|%d|%d|%d" % (src, st.st_mtime_ns, st.st_size, w)
                            ).encode("utf-8")).hexdigest()
        dst = os.path.join(media.THUMB_DIR, key + ".webp")
        if not os.path.isfile(dst):
            try:
                await asyncio.to_thread(media._make_thumb, src, dst, w)
            except Exception:                              # noqa: BLE001
                return compat.web.Response(status=404)
        # 文件名带源图指纹，内容变了 key 就变，可以放心让浏览器永久缓存
        return compat.web.FileResponse(dst, headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @routes.get("/ps/pack/apps")
    async def ps_pack_apps(request):
        """打包面板「编辑已有应用」下拉：只列 .kapp.json。"""
        return compat.web.json_response({"ok": True,
                                  "apps": await asyncio.to_thread(apps.list_kapps)})

    @routes.get("/ps/pack/candidates")
    async def ps_pack_candidates(request):
        """GET /ps/pack/candidates?source=<工作流文件名> —— 打包前的控件候选清单"""
        return compat.web.json_response(await asyncio.to_thread(
            pack.pack_candidates, request.query.get("source", "")))

    @routes.post("/ps/pack")
    async def ps_pack(request):
        """POST /ps/pack {source, name?, desc?, params:[{node,input,label,widget}]}
        —— 生成 <stem>.kapp.json（自研应用包，graph 为 API 格式）"""
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        if not isinstance(body, dict):
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        return compat.web.json_response(await asyncio.to_thread(
            pack.pack_app, str(body.get("source") or ""), body.get("params") or [],
            body.get("name"), str(body.get("desc") or "")))

    @routes.post("/ps/pack/save")
    async def ps_pack_save(request):
        """POST /ps/pack/save {name, desc?, kapp, target?}
        —— kapp 打包面板专用：前端已用 graphToPrompt() 构好 API 图，这里只校验+落盘。
        不依赖工作流文件先保存（与 /ps/pack 按文件打包区分）。
        带 target（工作流目录内相对路径）时回写该 .kapp.json，用于「编辑已打包的应用」。"""
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        if not isinstance(body, dict):
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        result = await asyncio.to_thread(pack.save_kapp, body.get("name"),
                                         body.get("desc"), body.get("kapp"),
                                         body.get("target"))
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

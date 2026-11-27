# -*- coding: utf-8 -*-
"""HTTP 路由：/ps/apps · /ps/media · /ps/thumb · /ps/pack · /ps/prompt 等。

只定义注册函数，不在导入时碰 PromptServer；由插件入口在 ComfyUI 里调用。
"""

import asyncio
import concurrent.futures
import hashlib
import json
import os
import re
import threading

from . import apps, av_sets, compat, image_sets, media, pack, paths, segments, state, version

LOCALE_DIR = os.path.join(paths.PLUGIN_DIR, "locales")
_thumb_pruned = False
_waveform_pruned = False
# 缩略图 URL 只带 filename/subfolder/w，**不带内容指纹** —— 源图被同名覆盖
# （上传时 overwrite=true 是常态）后 URL 一字不变。所以绝不能给 immutable：
# 那会让浏览器永远不再回源，缩略图永远停在旧图（服务端 key 带 mtime 也没用，
# 浏览器根本不会来问）。改成协商缓存：FileResponse 自带 ETag/Last-Modified，
# 命中回 304（几百字节），既不会看到旧图，开销也可以忽略。
_THUMB_CACHE_HEADER = {"Cache-Control": "no-cache"}
# 缩略图解码单独一个池：默认线程池是 min(32, cpu+4)，面板一屏几十格会瞬间塞满，
# 8K 图单张解码上百 MB，低内存机器直接 OOM 或卡死几十秒。这里限 4 并发，其余排队。
_thumb_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="kedou-thumb")
# 队列也必须封顶：只限 worker 的话，突发请求仍会把 Future 无限堆进内存。
# 80 刚好覆盖面板一屏 80 格全部同时请求；第 81 个起直接 429，避免多屏/刷新风暴堆积。
_THUMB_MAX_INFLIGHT = 80
_thumb_slots = threading.BoundedSemaphore(_THUMB_MAX_INFLIGHT)
_WAVEFORM_TIMEOUT = 120


async def _json_object(request):
    try:
        body = await request.json()
    except Exception:                                    # noqa: BLE001
        return None
    return body if isinstance(body, dict) else None


def register(routes):


# ---------------------------------------------------------------- 路由
    # UXP 的 fetch 会做跨域检查，而 ComfyUI 默认不回 CORS 头 →
    # PS 插件请求会被浏览器内核拦掉（表现为"连不上"）。
    # 这里只给 /ps/ 下的路由加 CORS，不影响 ComfyUI 自己的接口。
    # 插件不实现令牌鉴权；是否需要限制局域网/公网访问由 ComfyUI 启动参数和外层配置负责。
    @compat.web.middleware
    async def _ps_cors_middleware(request, handler):
        if not request.path.startswith("/ps/"):
            return await handler(request)
        if request.method == "OPTIONS":
            resp = compat.web.Response(status=204)
        else:
            resp = await handler(request)
        try:
            resp.headers["Access-Control-Allow-Origin"] = "*"
            resp.headers["Access-Control-Allow-Headers"] = "*"
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
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
        return compat.web.json_response({
            "ok": True,
            "bridge": "ComfyUI_KeDou",
            "version": version.__version__,
            "schema_version": state.BRIDGE_SCHEMA_VERSION,
            "features": {
                "sidecar_state": True,
                "graph_cache": True,
                "image_sets": True,
                "image_size": True,
                "media_delete": True,
                "av_loader": True,
                "video_segments": True,
                "app_formats": ["kapp", "official"],
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
            return compat.web.json_response({"error": "bad json"}, status=400)
        if not isinstance(body, dict):
            return compat.web.json_response({"error": "body must be an object"}, status=400)
        values = body.get("values")
        if values is not None and not isinstance(values, dict):
            return compat.web.json_response({"error": "values must be an object or null"}, status=400)
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

    @routes.post("/ps/media/upload")
    async def ps_media_upload(request):
        """POST /ps/media/upload?type=image|video|audio&subfolder=...，流式 multipart file。"""
        result = await media.upload_media(request, request.query.get("type", "image"),
                                          request.query.get("subfolder", ""))
        status = 200 if result.get("ok") else (429 if result.get("status") == 429 else 400)
        return compat.web.json_response(result, status=status)

    @routes.post("/ps/media/pick")
    async def ps_media_pick(request):
        """POST /ps/media/pick {name, subfolder, tab, copy_output?}"""
        try:
            body = await request.json()
        except Exception:                                    # noqa: BLE001
            body = {}
        body = body if isinstance(body, dict) else {}
        copy_output = body.get("copy_output", True)
        if not isinstance(copy_output, bool):
            return compat.web.json_response({"ok": False, "error": "copy_output must be a boolean"},
                                            status=400)
        result = await asyncio.to_thread(media.pick_media, body.get("name"),
                                         body.get("subfolder"), body.get("tab"), copy_output)
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.post("/ps/media/delete")
    async def ps_media_delete(request):
        """POST /ps/media/delete {name, subfolder, tab} -> {ok, name, tab, trashed}

        媒体库右键删除：移到 user/default/kedou_trash/media/…，不真删（可捞回）。
        写接口不做插件级令牌鉴权；这里只校验参数口径。
        """
        try:
            body = await request.json()
        except Exception:                                    # noqa: BLE001
            body = {}
        body = body if isinstance(body, dict) else {}
        result = await asyncio.to_thread(media.delete_media, body.get("name"),
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

    # ---- 音视频排列预设：独立存储，不与图片排列混存 ----
    @routes.get("/ps/av-sets")
    async def ps_av_sets_list(request):
        return compat.web.json_response(await asyncio.to_thread(av_sets.list_sets))

    @routes.post("/ps/av-sets/save")
    async def ps_av_sets_save(request):
        body = await _json_object(request) or {}
        result = await asyncio.to_thread(
            av_sets.save_set, body.get("name", ""), body.get("videos"), body.get("audios"),
            body.get("batch", False), body.get("select", False),
            body.get("picked_videos"), body.get("picked_audios"),
            body.get("output_mode", "video"), body.get("video_audio", False),
            body.get("frame_options"), body.get("id", ""))
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.post("/ps/av-sets/load")
    async def ps_av_sets_load(request):
        body = await _json_object(request) or {}
        result = await asyncio.to_thread(av_sets.load_set, body.get("id", ""))
        return compat.web.json_response(result, status=200 if result.get("ok") else 404)

    @routes.post("/ps/av-sets/rename")
    async def ps_av_sets_rename(request):
        body = await _json_object(request) or {}
        result = await asyncio.to_thread(av_sets.rename_set, body.get("id", ""), body.get("name", ""))
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.post("/ps/av-sets/delete")
    async def ps_av_sets_delete(request):
        body = await _json_object(request) or {}
        result = await asyncio.to_thread(av_sets.delete_set, body.get("id", ""))
        return compat.web.json_response(result, status=200 if result.get("ok") else 404)

    @routes.get("/ps/thumb")
    async def ps_thumb(request):
        """GET /ps/thumb?filename=&subfolder=&type=input|output&w=256&fit=3x4 -> image/jpeg|image/png

        图片出真缩略图，视频取首帧；不是媒体 / 解不开 / 越界，一律 404。面板 setThumb 收到 404 会在日志里
        留一行「缩略图失败（HTTP 404 …）」，不会拿原图兜底（一屏 80 张 8MB 原图会把面板堵死）。
        格式按源图有没有透明通道定（见 media.THUMB_EXTS 那段注释：UXP 解不了 webp）；
        fit=<宽x高> 让整图缩进这个比例并补边，位图比例严格等于面板格子（见 media.THUMB_PAD_RGB）。
        """
        global _thumb_pruned
        qq = request.query
        tab = "output" if str(qq.get("type") or "input") == "output" else "input"
        try:
            w = int(qq.get("w") or 256)
        except ValueError:
            w = 256
        w = max(32, min(media.THUMB_MAX_SIDE, w))
        fit = str(qq.get("fit") or "")
        if not media._thumb_box(fit, w):
            fit = ""                                        # 比例串不合法就按长边封顶出图
        # mode=raw：保持原比例、不补边。ComfyUI 面板用它（格子靠 CSS cover 裁切、悬浮层靠
        # contain 显示完整）；不传则沿用「补边成精确比例」，PS 面板要的就是那个（UXP 会把
        # max-width/max-height 各自钳位，不给方图就会被拽变形）。
        mode = "raw" if str(qq.get("mode") or "") == "raw" else ""
        src, _used = media._resolve_media_file(qq.get("filename"), qq.get("subfolder"), tab)
        if not src:
            return compat.web.Response(status=404)
        is_video = src.lower().endswith(media.MEDIA_EXTS["video"])
        if not is_video and not src.lower().endswith(media.MEDIA_EXTS["image"]):
            return compat.web.Response(status=404)
        if not _thumb_pruned:
            _thumb_pruned = True
            await asyncio.to_thread(media._thumb_prune_old)
        try:
            st = os.stat(src)
        except OSError:
            return compat.web.Response(status=404)
        # 指纹要带上 mode：同一个 w/fit 下「原比例」和「补边方图」是两份不同的文件，
        # 不区分就会互相命中、拿到错的缓存。mode 为空时不拼进去，老缓存继续有效。
        key_src = "%s|%d|%d|%d|%s" % (src, st.st_mtime_ns, st.st_size, w, fit)
        if mode:
            key_src += "|" + mode
        key = hashlib.sha1(key_src.encode("utf-8")).hexdigest()
        for ext in media.THUMB_EXTS:                        # 同一指纹只会有一种扩展名落地
            hit = os.path.join(media.THUMB_DIR, key + ext)
            if os.path.isfile(hit):
                return compat.web.FileResponse(hit, headers=_THUMB_CACHE_HEADER)
        base = os.path.join(media.THUMB_DIR, key)
        # 信号量在提交 Future 前非阻塞获取，等待中和执行中的请求都会计入上限。
        if not _thumb_slots.acquire(blocking=False):
            return compat.web.Response(status=429, headers={"Retry-After": "1"})
        released = False

        def release_once(_done=None):
            nonlocal released
            if not released:
                released = True
                _thumb_slots.release()

        try:
            loop = asyncio.get_running_loop()
            future = loop.run_in_executor(
                _thumb_pool, media._make_video_thumb if is_video else media._make_thumb,
                src, base, w, fit, mode)
            # 名额跟 Future 的真实结束绑定；连续取消也不能在 worker 仍解码时提前释放。
            future.add_done_callback(release_once)
            dst = await asyncio.shield(future)
        except asyncio.CancelledError:
            raise
        except Exception:                              # noqa: BLE001
            release_once()                              # 提交 Future 前失败等异常路径
            return compat.web.Response(status=404)
        if not os.path.isfile(dst):
            return compat.web.Response(status=404)
        # 文件名带源图指纹，内容变了 key 就变，可以放心让浏览器永久缓存
        return compat.web.FileResponse(dst, headers=_THUMB_CACHE_HEADER)

    @routes.get("/ps/media/info")
    async def ps_media_info(request):
        """GET /ps/media/info?filename=&subfolder=&type=input|output -> 媒体元数据。"""
        qq = request.query
        tab = "output" if str(qq.get("type") or "input") == "output" else "input"
        info = await asyncio.to_thread(media.media_info, qq.get("filename"),
                                       qq.get("subfolder"), tab)
        return compat.web.json_response(info, status=200 if info.get("ok") else 404,
                                        headers={"Cache-Control": "no-cache"})

    # ---- 长视频分段：提交后立即返回 job_id，解码/导出均在 segments 的单线程池里执行 ----
    @routes.post("/ps/video/segments/analyze")
    async def ps_video_segments_analyze(request):
        body = await _json_object(request)
        if body is None:
            return compat.web.json_response({"ok": False, "error": "请求 JSON 无效或不是对象"}, status=400)
        try:
            job_id = await asyncio.to_thread(segments.start_analyze, body)
        except segments.QueueFull as exc:
            return compat.web.json_response({"ok": False, "error": str(exc)}, status=429)
        except ValueError as exc:
            return compat.web.json_response({"ok": False, "error": str(exc)}, status=400)
        except Exception as exc:                           # noqa: BLE001
            return compat.web.json_response({"ok": False, "error": "分段服务异常：%s" % exc}, status=500)
        return compat.web.json_response({"ok": True, "job_id": job_id})

    @routes.get("/ps/video/segments/jobs/{job_id}")
    async def ps_video_segments_job(request):
        job_id = request.match_info.get("job_id", "")
        job = await asyncio.to_thread(segments.get_job, job_id)
        if job is None:
            return compat.web.json_response({"ok": False, "error": "分段任务不存在"}, status=404)
        return compat.web.json_response({"ok": True, "job": job}, headers={"Cache-Control": "no-cache"})

    @routes.post("/ps/video/segments/jobs/{job_id}/cancel")
    async def ps_video_segments_cancel(request):
        body = await _json_object(request)
        if body is None:
            return compat.web.json_response({"ok": False, "error": "请求 JSON 无效或不是对象"}, status=400)
        job_id = request.match_info.get("job_id", "")
        job = await asyncio.to_thread(segments.cancel_job, job_id)
        if job is None:
            return compat.web.json_response({"ok": False, "error": "分段任务不存在"}, status=404)
        return compat.web.json_response({"ok": True, "job": job})

    @routes.post("/ps/video/segments/export")
    async def ps_video_segments_export(request):
        body = await _json_object(request)
        if body is None:
            return compat.web.json_response({"ok": False, "error": "请求 JSON 无效或不是对象"}, status=400)
        try:
            job_id = await asyncio.to_thread(segments.start_export, body)
        except segments.QueueFull as exc:
            return compat.web.json_response({"ok": False, "error": str(exc)}, status=429)
        except ValueError as exc:
            return compat.web.json_response({"ok": False, "error": str(exc)}, status=400)
        except Exception as exc:                           # noqa: BLE001
            return compat.web.json_response({"ok": False, "error": "分段服务异常：%s" % exc}, status=500)
        return compat.web.json_response({"ok": True, "job_id": job_id})

    @routes.get("/ps/waveform")
    async def ps_waveform(request):
        """GET /ps/waveform?filename=&subfolder=&type=...&w=1024 -> 音频峰值波形 PNG。"""
        global _waveform_pruned
        qq = request.query
        tab = "output" if str(qq.get("type") or "input") == "output" else "input"
        try:
            width = int(qq.get("w") or media.WAVEFORM_WIDTH)
        except (TypeError, ValueError):
            width = media.WAVEFORM_WIDTH
        width = max(128, min(2048, width))
        src, _used = media._resolve_media_file(qq.get("filename"), qq.get("subfolder"), tab)
        if not src or not src.lower().endswith(media.MEDIA_EXTS["audio"] + media.MEDIA_EXTS["video"]):
            return compat.web.Response(status=404)
        try:
            st = os.stat(src)
        except OSError:
            return compat.web.Response(status=404)
        if not _waveform_pruned:
            _waveform_pruned = True
            await asyncio.to_thread(media._waveform_prune_old)
        key_src = "%s|%d|%d|%d" % (src, st.st_mtime_ns, st.st_size, width)
        key = hashlib.sha1(key_src.encode("utf-8")).hexdigest()
        base = os.path.join(media.WAVEFORM_DIR, key)
        dst = base + ".png"
        if os.path.isfile(dst):
            return compat.web.FileResponse(dst, headers=_THUMB_CACHE_HEADER)
        if not _thumb_slots.acquire(blocking=False):
            return compat.web.Response(status=429, headers={"Retry-After": "1"})
        released = False

        def release_once(_done=None):
            nonlocal released
            if not released:
                released = True
                _thumb_slots.release()
            if _done is not None:
                # 请求取消后没人 await 结果；取出 worker 异常，避免 asyncio 报未读取异常。
                try:
                    _done.exception()
                except (asyncio.CancelledError, concurrent.futures.CancelledError):
                    pass

        cancel = threading.Event()
        try:
            future = asyncio.get_running_loop().run_in_executor(
                _thumb_pool, media._make_waveform, src, base, width, cancel, _WAVEFORM_TIMEOUT)
            future.add_done_callback(release_once)
            dst = await asyncio.shield(future)
        except asyncio.CancelledError:
            cancel.set()
            raise
        except Exception:                              # noqa: BLE001
            release_once()
            return compat.web.Response(status=404)
        if not os.path.isfile(dst):
            return compat.web.Response(status=404)
        return compat.web.FileResponse(dst, headers=_THUMB_CACHE_HEADER)

    @routes.get("/ps/imgsize")
    async def ps_imgsize(request):
        """GET /ps/imgsize?filename=&subfolder=&type=input|output
        -> {ok,width,height,bytes,tab,format}（找不到 / 不是图 = 404 + ok:false）

        给悬浮预览显示原图尺寸用：缩略图是缩过的、/ps/media 的 size 是字节数，
        都答不了「这张图多少像素」。只读文件头，不解码，也不发图。
        tab 只是「先找哪个目录」，另一个目录会自动兜底，回包里的 tab 是真正命中的那个。
        和缩略图一样用 no-cache：同名覆盖是常态，不能让浏览器把旧尺寸缓存死。
        """
        qq = request.query
        tab = "output" if str(qq.get("type") or "input") == "output" else "input"
        # 用默认线程池而不是 _thumb_pool：读文件头是亚毫秒级的事，
        # 挤进 4 并发的解码池只会排在一堆大图解码后面，悬浮半天不出数字。
        info = await asyncio.to_thread(media.image_size, qq.get("filename"),
                                       qq.get("subfolder"), tab)
        return compat.web.json_response(info, status=200 if info.get("ok") else 404,
                                        headers={"Cache-Control": "no-cache"})

    @routes.get("/ps/pack/apps")
    async def ps_pack_apps(request):
        """打包面板「已打包的应用」列表：只列 .kapp.json。"""
        return compat.web.json_response({"ok": True,
                                  "apps": await asyncio.to_thread(apps.list_kapps)})

    @routes.post("/ps/pack/delete")
    async def ps_pack_delete(request):
        """POST /ps/pack/delete {file} —— 把应用包移到 user/default/kedou_trash。

        file 是相对工作流目录的路径（列表里的 target）。不直接删：移到回收站，
        手滑点错还能捞回来。
        """
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        if not isinstance(body, dict):
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        result = await asyncio.to_thread(pack.delete_kapp, body.get("file"))
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.get("/ps/pack/candidates")
    async def ps_pack_candidates(request):
        """GET /ps/pack/candidates?source=<工作流文件名> —— 打包前的控件候选清单"""
        return compat.web.json_response(await asyncio.to_thread(
            pack.pack_candidates, request.query.get("source", "")))

    @routes.get("/ps/pack/workflow")
    async def ps_pack_workflow(request):
        """GET /ps/pack/workflow?file=<相对工作流目录的路径> —— 读工作流原文。

        给打包面板「打开对应工作流」用：kapp 里记的 source 指到哪张工作流，
        就把那张 UI 图整份读出来，前端直接 app.loadGraphData。
        只认工作流目录内的文件，越界一律当不存在。
        """
        return compat.web.json_response(await asyncio.to_thread(
            pack.load_workflow_file, request.query.get("file", "")))

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
        """POST /ps/pack/save {name, desc?, kapp, target?, workflow?}
        —— kapp 打包面板专用：前端已用 graphToPrompt() 构好 API 图，这里只校验+落盘。
        不依赖工作流文件先保存（与 /ps/pack 按文件打包区分）。
        workflow 是画布序列化结果（UI 格式）：带上它就另存一份 <应用名>.json 到应用归档目录，
        kapp 的 source 指向这份副本 —— 「以后一定能切回工作流」靠的就是它。
        带 target（相对路径，kedou_apps/ 或工作流目录内）时回写该 .kapp.json，
        用于「编辑已打包的应用」。"""
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        if not isinstance(body, dict):
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        result = await asyncio.to_thread(pack.save_kapp, body.get("name"),
                                         body.get("desc"), body.get("kapp"),
                                         body.get("target"), body.get("workflow"))
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.post("/ps/pack/app")
    async def ps_pack_app_file(request):
        """POST /ps/pack/app {name, workflow, params:[{node,input,label?}], outputs:[...], target?}
        —— 按 ComfyUI 官方 App Mode 的格式写 <stem>.app.json。

        workflow 必须是画布的真实 **UI 图**（app.graph.serialize()）：官方应用保留整张界面图，
        API 图反推不回位置与连线，所以 kapp 不能直接转成官方包。
        写出来的文件 ComfyUI 自己的 Apps 侧栏（suffix app.json）也能直接打开。
        带 target 时回写同一个 .app.json（编辑已打包的应用）。"""
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        if not isinstance(body, dict):
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        result = await asyncio.to_thread(pack.save_official_app,
                                         body.get("name"), body.get("workflow"),
                                         body.get("params") or [],
                                         body.get("outputs") or [],
                                         body.get("target"))
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.post("/ps/pack/linear")
    async def ps_pack_linear(request):
        """POST /ps/pack/linear {name?, desc?, workflow, target?}
        —— 直接按 ComfyUI 官方 App Builder 的勾选结果生成 kapp。

        workflow 是画布的 UI 图（app.graph.serialize()），里面的 extra.linearData 就是
        构建器里点的输入/输出（顺序、显示名、描述都在里面），所以不需要人再勾一遍：
        桥接读 linearData 换算出 params，同一张图转成 API 图当 graph。
        """
        try:
            body = await request.json()
        except Exception:                            # noqa: BLE001
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        if not isinstance(body, dict):
            return compat.web.json_response({"ok": False, "error": "bad json"}, status=400)
        result = await asyncio.to_thread(pack.kapp_from_linear,
                                         body.get("name"), body.get("workflow"),
                                         body.get("desc") or "",
                                         body.get("target"), None,
                                         str(body.get("source") or ""))
        return compat.web.json_response(result, status=200 if result.get("ok") else 400)

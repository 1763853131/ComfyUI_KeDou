// i18n.js —— KeDou 前端文案层（英文为源语言，中文等资源从 locales/ 加载）
//
// 规矩（ComfyUI 注册表要求节点 UI 文案为英文）：
//   * 代码里一律写英文原句，并把它当 key：t("Media library")
//   * 其它语言放 locales/<lang>/main.json，结构就是 { "英文原句": "译文" }
//   * 查不到译文回落到 key 本身（英文），所以 en 不需要语言包
//   * 语言取 ComfyUI 设置项 Comfy.Locale，改完即时生效（SettingChanged）
//
// 带变量的句子用 {占位}：t("Selected {n} images", { n: 3 })。一律整句模板，不拼串，
// 否则译文会出现 "个 已选" 这种语序错乱。

import { app } from "../../scripts/app.js";

const BASE = "/ps/locale";

let dict = {};
let current = "en";
let dictSeq = 0;          // 只有最后发出的语言请求可以改字典/当前语言
const listeners = new Set();

function normalizeLocale(raw) {
  const loc = String(raw || "en").toLowerCase();
  if (!loc.startsWith("zh")) return loc;
  return (loc.startsWith("zh-tw") || loc.startsWith("zh-hant")) ? "zh-TW" : "zh";
}

export function locale() {
  return current;
}

export function t(key, params) {
  let s = dict[key] || key;
  if (params) {
    for (const k in params) s = s.split("{" + k + "}").join(String(params[k]));
  }
  return s;
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 后端 /ps/* 的错误串按用户决定保持中文（启动器和 PS 面板直接展示），
// 但 ComfyUI 里的 toast 不能露中文：非中文界面下，含中文的原文只进 console，
// 界面给通用提示；不含中文的原文（HTTP 500、网络错误等）照常透出，信息量不丢。
export function serverError(text) {
  const raw = String(text || "");
  if (!/[一-鿿]/.test(raw) || current.startsWith("zh")) return raw;
  console.warn("[kedou] server error:", raw);
  return raw ? t("see console for details") : t("request failed");
}

// 扩展入口 await 一次；重复调用只生效一次（两个扩展文件都会调）
let started = null;
export function initI18n(theApp) {
  if (started) return started;
  started = (async () => {
    const a = theApp || app;
    let changedDuringInit = false;
    let initLocale = "en";
    try {
      a.api.addEventListener("SettingChanged", async ([key, value]) => {
        if (key !== "Comfy.Locale") return;
        changedDuringInit = true;
        const next = normalizeLocale(value);
        initLocale = next;
        const prev = current;
        const applied = await loadDict(next);
        if (applied && next !== prev) {
          listeners.forEach((fn) => { try { fn(current); } catch (_) { /* 单个面板重绘失败不牵连其它 */ } });
        }
      });
    } catch (_) { /* 老前端没有该事件：语言在下次刷新时生效 */ }
    const initial = normalizeLocale(await readLocale(a));
    await loadDict(changedDuringInit ? initLocale : initial);
    return t;
  })();
  return started;
}

async function readLocale(a) {
  try {
    return await a.ui.settings.getSettingValue("Comfy.Locale", "en");
  } catch (_) {
    try { return localStorage.getItem("Comfy.Locale") || "en"; } catch (__) { return "en"; }
  }
}

async function loadDict(loc) {
  const seq = ++dictSeq;
  if (loc === "en") {
    if (seq === dictSeq) { dict = {}; current = loc; } // 英文快速路径仍会作废在途请求
    return seq === dictSeq;
  }
  let nextDict = {};
  try {
    const resp = await fetch(`${BASE}?lang=${encodeURIComponent(loc)}`);
    const body = resp.ok ? await resp.json() : null;
    nextDict = (body && body.ok && body.messages) || {};
  } catch (_) {
    nextDict = {};                        // 拿不到语言包就退回英文，绝不白屏
  }
  if (seq !== dictSeq) return false;
  dict = nextDict;
  current = loc;
  return true;
}

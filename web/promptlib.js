// 蝌蚪提示词库（轻量版 v6）—— 语库 / 词库 / 历史 三个入口都在「蝌蚪提示词输入框」节点上
// 后端：prompt_vault 包（vendored 在 ComfyUI_KeDou/prompt_vault/，上游是 D:\Git\prompt_vault，
//       改动在那边提交后跑 sync.py 推过来）
//       GET /ps/prompts（语库）、/ps/prompts/history（历史）、/ps/prompts/phrases（短词）
//       POST save|delete|use|history|history/clear|phrases/save|phrases/delete|phrases/use|vault
//       KedouPromptBox 节点（prompt_state STRING 直通输出 prompt；usage COMBO 记工作流用途）
// 交互定稿（用户 2026-10-12 / 2026-10-19 拍板）：
//   1) 入口离作用对象要近——不再有右侧抽屉/右下角 pill，库只活在节点上。
//   2) 语库 = 长提示词（.md，只主动保存才写文档）；词库 = 短词/标签（.kedou/phrases.json）；
//      历史 = 自动记录（.kedou/history.json），不生成文档、不混进语库。
//   3) 语库按用途分类：文生图/图像编辑/文生视频/图生视频/参考生视频；
//      节点上选当前工作流用途，语库/历史只显示该用途适用的条目；词库不按用途筛。
//   4) 语库/词库/历史三个入口都放在节点上，点哪个开哪个，面板内部不再分标签页；
//      面板贴在提示词输入框正右方（右边放不下翻到左边），不盖住输入框。
//      节点下方的常用按钮只放「置顶语库」的缩名（最多 4 个字），词库和历史都不进这里。
//   5) 「保存」先选去处：语库（.md）或词库（我的词·未分类）；右键可在三个库之间
//      添加/移动（历史→语库/词库是复制，词库↔语库是先建后删的移动）。
// 主题规矩：随主题变可用 --fg-color --content-bg --interface-panel-surface --interface-stroke --error-text；
//   恒定深色 --comfy-menu-bg --comfy-input-bg --border-color --descrip-text 禁用（白主题黑块坑）。
// 动效：只动 transform/opacity；prefers-reduced-motion 只留 fade。
import { app } from "../../scripts/app.js";
import { t, initI18n, onLocaleChange, serverError } from "./i18n.js";

const API = "/ps/prompts";
const PBOX_CLASS = "KedouPromptBox";
// ⚠️ USAGES 是数据不是文案：会被写进工作流 JSON 的 usage 控件值，也被后端 prompt_vault
// 存进用户词库条目的 use_for 字段。这里的中文值一个字节都不许改。
const USAGES = ["文生图", "图像编辑", "文生视频", "图生视频", "参考生视频"];
// 显示层映射：只用于界面呈现，提交/比较/兜底继续用上面的原始中文值。
const USAGE_LABELS = {
  "文生图": "Text to image",
  "图像编辑": "Image edit",
  "文生视频": "Text to video",
  "图生视频": "Image to video",
  "参考生视频": "Reference to video",
};
const usageLabel = (u) => t(USAGE_LABELS[u] || u);
// type 同理：后端存的是 "精选" 中文数据，提交时继续用原值。

// ───────── 样式（全主题安全色 + 深色回退） ─────────
const CSS = `
.kd-pbox{display:flex;flex-direction:column;gap:8px;padding:10px;font:12.5px/1.5 system-ui,sans-serif;
  color:var(--fg-color,#ddd);box-sizing:border-box;width:100%;height:100%;}
.kd-pbox-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.kd-pbox-top b{font-size:12.5px;}
.kd-pbox-use{background:var(--content-bg,#16161c);border:1px solid var(--interface-stroke,#3a3a44);border-radius:8px;
  color:var(--fg-color,#ddd);font:inherit;font-size:11.5px;padding:4px 8px;outline:none;cursor:pointer;}
.kd-pbox-use:focus{border-color:var(--p-primary-color,#4a7dff);}
.kd-pbox-btn{border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#bbb);
  font:inherit;font-size:11px;padding:4px 10px;border-radius:7px;cursor:pointer;
  transition:border-color .15s,color .15s,transform .12s;}
.kd-pbox-btn:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}
.kd-pbox-btn:active{transform:scale(.96);}
.kd-pbox-btn.kd-main{background:var(--p-primary-color,#4a7dff);border-color:var(--p-primary-color,#4a7dff);color:#fff;}
.kd-pbox-btn.kd-main:hover{opacity:.88;color:#fff;}
.kd-pbox-btn.kd-accent{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}
.kd-pbox-btn.kd-accent.kd-on{background:var(--p-primary-color,#4a7dff);color:#fff;}
.kd-pbox-btn.kd-accent.kd-on:hover{opacity:.88;color:#fff;}
.kd-pbox-ta{flex:1;min-height:110px;resize:none;background:var(--content-bg,#16161c);border:1px solid var(--interface-stroke,#3a3a44);
  border-radius:10px;color:var(--fg-color,#ddd);padding:9px 11px;font:inherit;font-size:13px;line-height:1.55;outline:none;
  width:100%;box-sizing:border-box;scrollbar-width:none;-ms-overflow-style:none;}
.kd-pbox-ta::-webkit-scrollbar{display:none;}
.kd-pbox-ta:focus{border-color:var(--p-primary-color,#4a7dff);}
.kd-pbox-chips{display:flex;flex-wrap:wrap;gap:5px;max-height:96px;overflow-y:auto;
  scrollbar-width:none;-ms-overflow-style:none;}
.kd-pbox-chips::-webkit-scrollbar{display:none;}
.kd-pbox-chip{border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#aaa);
  font:inherit;font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;max-width:150px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:border-color .15s,color .15s;}
.kd-pbox-chip:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}
.kd-pbox-chip.kd-pin{border-color:var(--p-primary-color,#4a7dff88);color:var(--fg-color,#ddd);}
.kd-pbox-chip.kd-hist{opacity:.86;}
.kd-pbox-chip.kd-used{border-color:var(--p-primary-color,#4a7dff);background:rgba(74,125,255,.16);color:var(--p-primary-color,#8fb0ff);}
.kd-pbox-chip .kd-star{color:#e2b341;margin-right:3px;}
/* ── 库面板：贴在提示词输入框右侧，点哪个按钮就显示哪一类（不再分内部标签页） ── */
.kd-plib{position:fixed;z-index:99993;display:flex;flex-direction:column;overflow:hidden;
  width:min(620px,calc(100vw - 24px));height:min(800px,calc(100vh - 24px));
  background:var(--interface-panel-surface,#232329);color:var(--fg-color,#ddd);
  border:1px solid var(--interface-stroke,#3a3a44);border-radius:14px;
  box-shadow:0 20px 60px rgba(0,0,0,.42);font:12.5px/1.5 system-ui,sans-serif;
  opacity:0;transform:translateY(6px);
  transition:opacity .16s ease-out,transform .2s cubic-bezier(.34,1.2,.64,1);}
.kd-plib.kd-in{opacity:1;transform:translateY(0);}
.kd-plib.kd-out{opacity:0;transform:translateY(6px);
  transition:opacity .13s ease-in,transform .13s ease-in;}
.kd-plib-head{display:flex;align-items:center;gap:9px;padding:12px 14px 8px;}
.kd-plib-title{font-size:14px;font-weight:600;color:var(--fg-color,#e0e0e0);white-space:nowrap;}
.kd-plib-use{font-size:11px;color:var(--p-primary-color,#6a9bff);border:1px solid var(--p-primary-color,#4a7dff66);
  border-radius:999px;padding:2px 9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.kd-plib-x{border:none;background:none;color:var(--fg-color,#999);font-size:17px;cursor:pointer;padding:2px 7px;margin-left:auto;}
.kd-plib-x:hover{color:var(--error-text,#ffb3b3);}
.kd-plib-tools{display:flex;align-items:center;gap:7px;padding:0 14px 8px;}
.kd-plib-q{flex:1;min-width:0;background:var(--content-bg,#16161c);border:1px solid var(--interface-stroke,#3a3a44);
  border-radius:9px;color:var(--fg-color,#ccc);padding:7px 11px;font:inherit;font-size:12.5px;outline:none;}
.kd-plib-q:focus{border-color:var(--p-primary-color,#4a7dff);}
.kd-plib-tools .kd-pbox-btn{white-space:nowrap;}
.kd-plib-tools [hidden],.kd-plib-cats[hidden],.kd-plib-subcats[hidden]{display:none !important;}
.kd-plib-cats,.kd-plib-subcats{display:flex;gap:6px;padding:0 14px 8px;overflow-x:auto;
  scrollbar-width:none;-ms-overflow-style:none;}
.kd-plib-cats::-webkit-scrollbar,.kd-plib-subcats::-webkit-scrollbar{display:none;}
.kd-plib-cat{border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#999);
  border-radius:999px;padding:3px 11px;font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap;
  transition:border-color .15s,color .15s,background .15s;}
.kd-plib-cat:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#6a9bff);}
.kd-plib-cat.kd-on{border-color:var(--p-primary-color,#4a7dff);background:rgba(74,125,255,.14);
  color:var(--p-primary-color,#8fb0ff);}
.kd-plib-subcats .kd-plib-cat{font-size:11px;padding:2px 9px;}
.kd-plib-list{flex:1;overflow-y:auto;padding:0 14px 12px;scrollbar-width:thin;
  scrollbar-color:var(--interface-stroke,#3a3a44) transparent;}
.kd-plib-list::-webkit-scrollbar{width:8px;}
.kd-plib-list::-webkit-scrollbar-thumb{background:var(--interface-stroke,#3a3a44);border-radius:4px;}
.kd-lib-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(250px,100%),1fr));gap:7px;}
.kd-row{border:1px solid var(--interface-stroke,#3a3a44);border-radius:10px;padding:8px 11px;cursor:pointer;
  background:transparent;transition:border-color .15s,background .15s;}
.kd-row.kd-used{border-color:var(--p-primary-color,#4a7dff88);background:rgba(74,125,255,.08);}
.kd-row.kd-used .kd-row-name::after{content:"✓";margin-left:6px;color:var(--p-primary-color,#6a9bff);font-size:11px;}
.kd-row:hover{border-color:var(--p-primary-color,#4a7dff);background:var(--content-bg,#16161c);}
.kd-row-name{font-size:12.5px;font-weight:600;color:var(--fg-color,#e0e0e0);display:flex;align-items:baseline;gap:6px;min-width:0;}
.kd-row-name .kd-name-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kd-row-name .kd-badge{font-size:10px;font-weight:400;color:var(--fg-color,#888);border:1px solid var(--interface-stroke,#3a3a44);
  border-radius:5px;padding:0 5px;margin-left:auto;white-space:nowrap;flex:none;}
.kd-row-prev{font-size:11.5px;color:var(--fg-color,#9a9a9a);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.kd-row:hover .kd-row-prev{white-space:normal;overflow:visible;}
.kd-star{color:#e2b341;}
/* 词库：分组标题 + 两行小卡 */
.kd-tag-group{font-size:11px;font-weight:600;color:var(--fg-color,#8a8a8a);margin:11px 1px 6px;
  display:flex;align-items:center;gap:6px;}
.kd-tag-group::after{content:"";flex:1;height:1px;background:var(--interface-stroke,#3a3a44);opacity:.7;}
.kd-tag-group:first-child{margin-top:2px;}
.kd-tag-wrap{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(158px,100%),1fr));gap:5px;}
.kd-tag{display:flex;flex-direction:column;align-items:flex-start;gap:0;min-width:0;text-align:left;
  border:1px solid var(--interface-stroke,#3a3a44);border-radius:9px;background:transparent;
  padding:5px 9px;cursor:pointer;color:inherit;font:inherit;transition:border-color .15s,background .15s;}
.kd-tag:hover{border-color:var(--p-primary-color,#4a7dff);background:var(--content-bg,#16161c);}
.kd-tag.kd-used{border-color:var(--p-primary-color,#4a7dff88);background:rgba(74,125,255,.08);}
.kd-tag-name{font-size:12px;font-weight:600;color:var(--fg-color,#ddd);max-width:100%;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.kd-tag-val{font-size:10.5px;color:var(--fg-color,#8a8a8a);max-width:100%;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.kd-tag.kd-used .kd-tag-name::after{content:"✓";margin-left:5px;color:var(--p-primary-color,#6a9bff);font-size:10px;}
.kd-plib-empty{padding:26px 8px;text-align:center;color:var(--fg-color,#777);font-size:12.5px;}
.kd-plib-empty-where{margin-top:7px;font-size:10.5px;color:var(--fg-color,#666);word-break:break-all;}
.kd-plib-foot{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 14px;
  border-top:1px solid var(--interface-stroke,#3a3a44);font-size:11px;color:var(--fg-color,#888);}
.kd-plib-tip{flex:1;min-width:120px;}
.kd-plib-foot .kd-pbox-btn{margin-left:0;}
/* 库位置：后端到底在读哪个目录。分发出去以后最难查的就是"看着是空的，其实在读别处"。 */
.kd-plib-loc{display:flex;flex-wrap:wrap;gap:6px;align-items:center;max-width:100%;}
.kd-plib-vault{max-width:min(320px,100%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:10.5px;color:var(--fg-color,#777);border:1px solid var(--interface-stroke,#3a3a44);
  border-radius:6px;padding:2px 6px;}
.kd-plib-vault i{font-style:normal;opacity:.6;margin-left:5px;}
.kd-plib-vault.kd-bad{border-color:var(--error-text,#a33);color:var(--error-text,#ffb3b3);}
.kd-plib-path-in{width:260px;max-width:50vw;background:var(--content-bg,#16161c);border:1px solid var(--interface-stroke,#3a3a44);
  border-radius:6px;color:var(--fg-color,#ddd);font:inherit;font-size:11px;padding:3px 7px;outline:none;}
.kd-plib-path-in:focus{border-color:var(--p-primary-color,#4a7dff);}
/* ── 右键菜单 + 就地编辑 ── */
.kd-menu{position:fixed;z-index:99995;display:flex;flex-direction:column;gap:2px;min-width:120px;padding:5px;
  background:var(--interface-panel-surface,#232329);border:1px solid var(--interface-stroke,#3a3a44);border-radius:10px;
  box-shadow:0 8px 28px rgba(0,0,0,.35);opacity:0;transform:translateY(6px);
  transition:opacity .14s ease-out,transform .18s cubic-bezier(.34,1.3,.64,1);}
.kd-menu.kd-in{opacity:1;transform:translateY(0);}
.kd-menu button{border:none;background:none;text-align:left;color:var(--fg-color,#ccc);font:inherit;font-size:12px;padding:6px 10px;border-radius:7px;cursor:pointer;}
.kd-menu button:hover{background:var(--content-bg,#16161c);color:var(--p-primary-color,#6a9bff);}
.kd-menu button.kd-armed{color:var(--error-text,#ffb3b3);background:var(--content-bg,#16161c);}
.kd-menu-title{font-size:10.5px;color:var(--fg-color,#777);padding:3px 10px 5px;margin-bottom:2px;
  border-bottom:1px solid var(--interface-stroke,#3a3a44);}
.kd-edit{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding:8px;
  border:1px dashed var(--interface-stroke,#3a3a44);border-radius:9px;background:rgba(0,0,0,.08);}
.kd-edit input,.kd-edit textarea{background:var(--content-bg,#16161c);border:1px solid var(--interface-stroke,#3a3a44);border-radius:8px;color:var(--fg-color,#ddd);padding:6px 9px;font:inherit;font-size:12px;outline:none;scrollbar-width:none;-ms-overflow-style:none;}
.kd-edit textarea::-webkit-scrollbar,.kd-edit input::-webkit-scrollbar{display:none;}
.kd-edit textarea{min-height:70px;resize:vertical;}
.kd-edit input:focus,.kd-edit textarea:focus{border-color:var(--p-primary-color,#4a7dff);}
.kd-phrase-form{margin:0 0 10px;}
.kd-form-row{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.kd-use-row{display:flex;flex-wrap:wrap;gap:8px;}
.kd-use-c{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--fg-color,#aaa);cursor:pointer;}
.kd-edit-acts{display:flex;align-items:center;gap:6px;}
@media (max-width:640px){
  .kd-plib-tools{flex-wrap:wrap;}
  .kd-form-row{grid-template-columns:1fr;}
}
@media (prefers-reduced-motion: reduce){
  .kd-plib,.kd-menu,.kd-pbox-btn,.kd-pbox-chip,.kd-tag,.kd-row{transition:opacity .15s ease-out !important;}
  .kd-plib{opacity:1;transform:none !important;}
  .kd-plib.kd-out{opacity:0;}
}
`;

// ───────── 小工具 ─────────
let toastEl = null;
function toast(msg, isErr) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(12px);z-index:99999;padding:9px 16px;border-radius:10px;border:1px solid var(--interface-stroke,#3a3a44);background:var(--interface-panel-surface,#232329);color:var(--fg-color,#ccc);font-size:13px;opacity:0;transition:opacity .2s,transform .2s;";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.borderColor = isErr ? "var(--error-text,#a33)" : "var(--interface-stroke,#3a3a44)";
  toastEl.style.color = isErr ? "var(--error-text,#ffb3b3)" : "var(--fg-color,#ccc)";
  toastEl.style.opacity = "1";
  toastEl.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => {
    toastEl.style.opacity = "0";
    toastEl.style.transform = "translateX(-50%) translateY(12px)";
  }, 2600);
}

async function api(path, body) {
  const r = await fetch(API + path, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  if (!r.ok) {
    let msg = "HTTP " + r.status;
    try { const d = await r.json(); if (d && d.error) msg = d.error; } catch (_) { /* 非 JSON */ }
    throw new Error(msg);
  }
  return r.json();
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function reducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ───────── 三套数据各自缓存：语库是 .md，词库/历史是后端 JSON，互不混 ─────────
let libCache = null;          // 语库 { items, dirs }
let libStamp = 0;
async function lib(force) {
  if (force || !libCache || Date.now() - libStamp > 30000) {
    libCache = await api("");
    libStamp = Date.now();
  }
  return libCache;
}
let phraseCache = null;       // 词库（短词/标签）
let phraseStamp = 0;
async function phraseLib(force) {
  if (force || !phraseCache || Date.now() - phraseStamp > 30000) {
    phraseCache = await api("/phrases");
    phraseStamp = Date.now();
  }
  return phraseCache;
}
let histCache = null;         // 自动历史
let histStamp = 0;
async function historyLib(force) {
  if (force || !histCache || Date.now() - histStamp > 30000) {
    histCache = await api("/history");
    histStamp = Date.now();
  }
  return histCache;
}
function libInvalidate() { libCache = phraseCache = histCache = null; }

// ───────── 库面板：语库 / 词库 / 历史 三个入口都在节点上，面板内部不再分标签页 ─────────
let libPanel = null;
let libOwner = null;   // 哪个节点打开的
let libTab = "prompts";
let libSession = 0;    // 关掉再开：旧请求回来不能画到新面板上
let libReposition = null;   // 窗口尺寸变化时重新贴到节点旁边
const libState = {
  editId: null,            // 语库就地编辑
  phraseEditId: null,      // 词库编辑
  phraseFormOpen: false,   // 词库新建
  phraseInit: false,       // 只在第一次拿到数据时选默认分类
  phraseGroup: "",         // ""=全部 / "__fav"=收藏 / 顶层分组名
  phraseCat: "",           // 词库二级分类
  q: { prompts: "", phrases: "", history: "" },
  clearArmed: 0,
};
let libData = { prompts: [], phrases: [], history: [], groups: [], categories: [] };
let libErrors = { prompts: "", phrases: "", history: "" };
const USE_URL = { prompt: "/use", history: "/use", phrase: "/phrases/use" };

// 存/移进词库的词一律落在「我的词 · 未分类」；下次打开词库直接停在这一格
function applyPhraseItemState(item) {
  if (!item) return;
  libState.phraseInit = true;
  if (item.group) libState.phraseGroup = item.group;
  if (item.category) libState.phraseCat = item.category;
  libState.q.phrases = "";
}
function panelUsage() {
  const pb = libOwner && libOwner.__kdPbox;
  return (pb && pb.useSel.value) || USAGES[0];
}

// 右键菜单（编辑 / 置顶 / 跨库添加或移动 / 删除两步确认）
let menuEl = null;
function closeMenu() {
  if (!menuEl) return;
  const m = menuEl; menuEl = null;
  m.remove();
}
function openRowMenu(x, y, entry, kind, onChanged) {
  closeMenu();
  const isPhrase = kind === "phrase";
  const isHistory = kind === "history";
  menuEl = document.createElement("div");
  menuEl.className = "kd-menu";
  menuEl.innerHTML = `
    ${isHistory ? "" : `<button data-a="edit">✎ ${t("Edit")}</button>`}
    ${isHistory ? "" : `<button data-a="pin">${entry.pinned ? t("Unpin") : "★ " + t("Pin")}</button>`}
    ${isHistory
      ? `<button data-a="toLib">＋ ${t("Add to prompt library")}</button>
         <button data-a="toTags">＋ ${t("Add to tag library")}</button>`
      : isPhrase
        ? `<button data-a="toLib">→ ${t("Move to prompt library")}</button>`
        : `<button data-a="toTags">→ ${t("Move to tag library")}</button>`}
    <button data-a="del">🗑 ${t("Delete")}</button>`;
  menuEl.style.left = Math.max(6, Math.min(x, window.innerWidth - 170)) + "px";
  menuEl.style.top = Math.max(6, Math.min(y, window.innerHeight - (isHistory ? 150 : 185))) + "px";
  document.body.appendChild(menuEl);
  void menuEl.offsetWidth;   // 强制回流提交初始态：rAF 在后台/节流标签页里可能永不触发，入场类不能挂在它上面
  menuEl.classList.add("kd-in");

  const editBtn = menuEl.querySelector("[data-a=edit]");
  if (editBtn) editBtn.onclick = () => {
    closeMenu();
    if (isPhrase) {
      libState.phraseEditId = entry.id;
      libState.phraseFormOpen = true;
    } else {
      libState.editId = entry.id;
    }
    if (libRepaint) libRepaint();
  };
  const pinBtn = menuEl.querySelector("[data-a=pin]");
  if (pinBtn) pinBtn.onclick = async () => {
    closeMenu();
    try {
      const r = await api(isPhrase ? "/phrases/save" : "/save", { id: entry.id, pinned: !entry.pinned });
      if (!r.ok) { toast(t("Save failed: {error}", { error: serverError(r.error) }), true); return; }
      toast(entry.pinned ? t("Unpinned") : t("Pinned"));
      onChanged();
    } catch (e) {
      toast(t("Save failed: {error}", { error: serverError(e.message) }), true);
    }
  };

  // 历史 → 语库/词库：复制一份，历史保留
  const toLibBtn = menuEl.querySelector("[data-a=toLib]");
  if (toLibBtn) toLibBtn.onclick = async () => {
    closeMenu();
    try {
      const r = await api("/save", {
        name: entry.name || String(entry.positive || "").slice(0, 20),
        type: "精选",
        positive: entry.positive,
        usage: (entry.use_for && entry.use_for.length) ? entry.use_for : [panelUsage()],
      });
      if (!r.ok) { toast(t("Save failed: {error}", { error: serverError(r.error) }), true); return; }
      if (isHistory) {
        libState.q.prompts = "";
        toast(r.deduped ? t("Already in the prompt library") : t("Added to the prompt library"));
      } else {
        // 词库 → 语库：先建长提示词，成功后再删短词（移动）
        const d = await api("/phrases/delete", { id: entry.id });
        if (!d.ok) {
          toast(t("Copied, but the source could not be removed: {error}", { error: serverError(d.error) }), true);
          onChanged();
          return;
        }
        libState.phraseEditId = null;
        toast(t("Moved to the prompt library"));
      }
      onChanged();
    } catch (e) {
      toast(t("Move failed: {error}", { error: serverError(e.message) }), true);
    }
  };
  const toTagsBtn = menuEl.querySelector("[data-a=toTags]");
  if (toTagsBtn) toTagsBtn.onclick = async () => {
    closeMenu();
    try {
      const r = await api("/phrases/save", {
        name: entry.name || "", positive: entry.positive, category: "",
      });
      if (!r.ok) { toast(t("Save failed: {error}", { error: serverError(r.error) }), true); return; }
      applyPhraseItemState(r.item);
      if (isHistory) {
        toast(r.deduped ? t("Already in the tag library") : t("Added to the tag library"));
      } else {
        // 语库 → 词库：先建短词，成功后再删 .md（移动）
        const d = await api("/delete", { id: entry.id });
        if (!d.ok) {
          toast(t("Copied, but the source could not be removed: {error}", { error: serverError(d.error) }), true);
          onChanged();
          return;
        }
        libState.editId = null;
        toast(t("Moved to the tag library"));
      }
      onChanged();
    } catch (e) {
      toast(t("Move failed: {error}", { error: serverError(e.message) }), true);
    }
  };

  const delBtn = menuEl.querySelector("[data-a=del]");
  delBtn.onclick = async () => {
    if (!delBtn.classList.contains("kd-armed")) {
      delBtn.classList.add("kd-armed");
      delBtn.textContent = t("Confirm delete?");
      return;
    }
    closeMenu();
    const path = isPhrase ? "/phrases/delete" : isHistory ? "/history/delete" : "/delete";
    try {
      const r = await api(path, { id: entry.id });
      toast(r.ok ? (isPhrase || isHistory ? t("Deleted") : t("Deleted (recoverable from .trash)")) : t("Delete failed"), !r.ok);
      if (r.ok && libState.editId === entry.id) libState.editId = null;
      if (r.ok && libState.phraseEditId === entry.id) libState.phraseEditId = null;
      if (r.ok) onChanged();
    } catch (e) {
      toast(t("Delete failed") + ": " + serverError(e.message), true);
    }
  };
}
document.addEventListener("pointerdown", (e) => {
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
}, true);
document.addEventListener("contextmenu", (e) => {
  if (menuEl && libPanel && !libPanel.contains(e.target)) closeMenu();
}, true);

// 就地编辑（行内展开：短名 / 正文 / 负面 / 用途勾选 / 保存）
function renderRowEdit(row, entry, onSaved) {
  const box = document.createElement("div");
  box.className = "kd-edit";
  box.innerHTML = `
    <input data-f="name" value="${esc(entry.name)}" placeholder="${t("Short name")}">
    <textarea data-f="positive" placeholder="${t("Prompt body")}">${esc(entry.positive)}</textarea>
    <textarea data-f="negative" placeholder="${t("Negative (optional)")}" style="min-height:44px">${esc(entry.negative)}</textarea>
    <div class="kd-use-row">${USAGES.map((u) => `<label class="kd-use-c"><input type="checkbox" data-u="${esc(u)}" ${(entry.use_for || []).indexOf(u) !== -1 ? "checked" : ""}>${esc(usageLabel(u))}</label>`).join("")}</div>
    <div class="kd-edit-acts">
      <button class="kd-pbox-btn kd-main" data-a="save">${t("Save")}</button>
      <button class="kd-pbox-btn" data-a="cancel">${t("Cancel")}</button>
    </div>`;
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  box.addEventListener("click", (e) => e.stopPropagation());
  box.querySelector("[data-a=cancel]").onclick = () => { libState.editId = null; onSaved(); };
  box.querySelector("[data-a=save]").onclick = async () => {
    const g = (f) => box.querySelector(`[data-f=${f}]`);
    const usage = USAGES.filter((u) => box.querySelector(`[data-u="${u}"]`).checked);
    if (!usage.length) { toast(t("Select at least one usage"), true); return; }
    const body = {
      id: entry.id,
      name: g("name").value.trim(),
      positive: g("positive").value,
      negative: g("negative").value,
      usage,
    };
    if (!body.name) { toast(t("Short name cannot be empty"), true); return; }
    if (!body.positive.trim() && !body.negative.trim()) { toast(t("Body and negative cannot both be empty"), true); return; }
    try {
      const r = await api("/save", body);
      toast(r.ok ? t("Saved") : t("Save failed: {error}", { error: serverError(r.error) }), !r.ok);
      if (r.ok) {
        libState.editId = null;         // 保存成功后退出编辑态（否则重绘会继续停在编辑框）
        onSaved();
      }
    } catch (e) {
      toast(t("Save failed: {error}", { error: serverError(e.message) }), true);
    }
  };
  row.appendChild(box);
  box.querySelector("[data-f=name]").focus();
}

// 词库新建/编辑：短名 + 词内容 + 分类，一行就够
function renderPhraseForm(entry, onSaved) {
  const box = document.createElement("div");
  box.className = "kd-edit kd-phrase-form";
  const cat = entry ? entry.category : "";
  box.innerHTML = `
    <div class="kd-form-row">
      <input data-f="name" value="${esc(entry ? entry.name : "")}" placeholder="${t("Short name (optional)")}">
      <input data-f="category" value="${esc(cat || "")}" placeholder="${t("Category (leave blank for Uncategorized)")}">
    </div>
    <textarea data-f="positive" placeholder="${t("Tag text…")}">${esc(entry ? entry.positive : "")}</textarea>
    <div class="kd-edit-acts">
      <button class="kd-pbox-btn kd-main" data-a="save">${t("Save")}</button>
      <button class="kd-pbox-btn" data-a="cancel">${t("Cancel")}</button>
    </div>`;
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  box.addEventListener("click", (e) => e.stopPropagation());
  const cancel = () => {
    libState.phraseFormOpen = false;
    libState.phraseEditId = null;
    if (libRepaint) libRepaint();
  };
  box.querySelector("[data-a=cancel]").onclick = cancel;
  box.querySelector("[data-a=save]").onclick = async () => {
    const g = (f) => box.querySelector(`[data-f=${f}]`);
    const positive = g("positive").value.trim();
    if (!positive) { toast(t("Tag text cannot be empty"), true); return; }
    const body = {
      name: g("name").value.trim(),
      positive,
      category: g("category").value.trim(),
    };
    if (entry) {
      body.id = entry.id;
      body.group = entry.group;
    }
    try {
      const r = await api("/phrases/save", body);
      if (!r.ok) { toast(t("Save failed: {error}", { error: serverError(r.error) }), true); return; }
      toast(t("Saved"));
      libState.phraseFormOpen = false;
      libState.phraseEditId = null;
      libState.q.phrases = "";        // 清掉搜索，保证刚保存的词立刻看得见
      if (r.item) {
        if (r.item.group) libState.phraseGroup = r.item.group;
        if (r.item.category) libState.phraseCat = r.item.category;
      }
      onSaved();
    } catch (e) {
      toast(t("Save failed: {error}", { error: serverError(e.message) }), true);
    }
  };
  rowFocus(box, entry ? "[data-f=name]" : "[data-f=positive]");
  return box;
}
function rowFocus(box, sel) {
  setTimeout(() => {
    const el = box.querySelector(sel);
    if (el) { try { el.focus(); } catch (_) { /* ignore */ } }
  }, 0);
}

let libRepaint = null;   // paint() 的引用，供菜单/语言切换触发重绘
let libRefresh = null;   // reload() 的引用：节点上「保存」/自动历史写入后要立刻把面板拉新
let libTouchT = null;
function libTouch() {    // 一次出图会写好几条历史，合并成一次刷新
  libInvalidate();
  clearTimeout(libTouchT);
  libTouchT = setTimeout(() => {
    if (libRefresh) libRefresh();
    refreshAllPbox();   // chips 里的置顶/最近历史也一起跟上
  }, 300);
}

// ───────── 词条插入/移除：点一下插到光标处，再点同一条移除 ─────────
// 目标就是「无脑」：不让人选追加还是替换、不管光标在哪、不手动补逗号。
// 每个 textarea 记住自己插过哪些条目（id -> 实际插入的文本），
// 再点时精确删掉那一段；用户手动改过、找不到原文就当作重新插入。
function insStore(ta) {
  if (!ta.__kdIns) ta.__kdIns = new Map();
  return ta.__kdIns;
}
function insRec(ta, entry) {
  const r = insStore(ta).get(String(entry.id));
  return (r && ta.value.indexOf(r.t) !== -1) ? r : null;
}
function insText(ta, entry) {
  const r = insRec(ta, entry);
  return r ? r.t : "";
}
function isSepChar(ch) {
  return /[\s,，、;；:：.!?。！？)\]）】]/.test(ch || "");
}
function toggleEntry(ta, sync, entry) {
  const body = String(entry.positive || entry.negative || "");
  if (!body) return "";
  const store = insStore(ta);
  const prev = insRec(ta, entry);
  if (prev) {
    const at = ta.value.indexOf(prev.t);
    ta.value = ta.value.slice(0, at) + prev.r + ta.value.slice(at + prev.t.length);
    store.delete(String(entry.id));
    const pos = Math.min(at + prev.r.length, ta.value.length);
    try { ta.setSelectionRange(pos, pos); ta.focus(); } catch (_) { /* ignore */ }
    sync();
    return "removed";
  }
  const st = typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length;
  const en = typeof ta.selectionEnd === "number" ? ta.selectionEnd : st;
  const before = ta.value.slice(0, st);
  const after = ta.value.slice(en);
  const replaced = ta.value.slice(st, en);   // 选中被替换的内容，再点移除时原样还回去
  // 只在需要时补分隔符：前/后已经是空白或标点就不加，避免 ",," 和双空格
  const prefix = (before && !isSepChar(before.slice(-1))) ? ", " : "";
  const suffix = (after && !isSepChar(after[0])) ? ", " : "";
  const text = prefix + body + suffix;
  if (typeof ta.setRangeText === "function") {
    ta.setRangeText(text, st, en, "end");
  } else {
    ta.value = before + text + after;
    try { ta.setSelectionRange(st + text.length, st + text.length); } catch (_) { /* ignore */ }
  }
  store.set(String(entry.id), { t: text, r: replaced });
  try { ta.focus(); } catch (_) { /* ignore */ }
  sync();
  return "inserted";
}

// 面板优先贴节点正右方；右边放不下翻左边，两边都挤就放到节点下方/上方，尽量不盖住输入框
function placePanel(node) {
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const m = 10;
  const maxW = Math.min(620, vw - m * 2);
  const maxH = Math.min(800, vh - m * 2);
  let r = null;
  try { r = node && node._kdCard && node._kdCard.getBoundingClientRect(); } catch (_) { /* ignore */ }
  if (!r || (!r.width && !r.height)) {
    return { left: Math.max(m, vw - maxW - m), top: 72, w: maxW, h: Math.min(maxH, vh - 72 - m) };
  }
  const sideTop = () => {
    const h = maxH;
    return Math.max(m, Math.min(r.top, vh - h - m));
  };
  // 1) 正右方
  const rightSpace = vw - r.right - m * 2;
  if (rightSpace >= 240) {
    const w = Math.min(maxW, rightSpace);
    const top = sideTop();
    return { left: r.right + m, top, w, h: Math.min(maxH, vh - top - m) };
  }
  // 2) 左侧
  const leftSpace = r.left - m * 2;
  if (leftSpace >= 240) {
    const w = Math.min(maxW, leftSpace);
    const top = sideTop();
    return { left: r.left - w - m, top, w, h: Math.min(maxH, vh - top - m) };
  }
  // 3) 下方
  let top = r.bottom + m;
  let h = Math.min(maxH, vh - top - m);
  if (h < 260) {
    // 4) 上方
    const above = Math.min(maxH, r.top - m * 2);
    if (above >= 260) { h = above; top = r.top - h - m; }
    else { top = m; h = maxH; }
  }
  const left = Math.max(m, Math.min(r.left, vw - maxW - m));
  return { left, top: Math.max(m, top), w: maxW, h: Math.max(220, h) };
}

// 面板开着的时候让对应按钮亮住（tab 传 null 即熄灭）
function markPboxBtns(node, tab) {
  const pb = node && node.__kdPbox;
  if (!pb) return;
  [pb.libBtn, pb.phraseBtn, pb.histBtn].forEach((b) => { if (b) b.classList.remove("kd-on"); });
  const b = tab === "phrases" ? pb.phraseBtn : tab === "history" ? pb.histBtn : tab ? pb.libBtn : null;
  if (b) b.classList.add("kd-on");
}

function openLib(node, tab) {
  closeLib(true);
  const pb = node && node.__kdPbox;
  if (!pb) return;
  libOwner = node;
  const session = ++libSession;
  libTab = tab === "phrases" ? "phrases" : tab === "history" ? "history" : "prompts";
  libState.editId = null;
  libState.phraseEditId = null;
  libState.phraseFormOpen = false;
  libState.clearArmed = 0;

  libPanel = document.createElement("div");
  libPanel.className = "kd-plib";
  libPanel.innerHTML = `
    <div class="kd-plib-head">
      <span class="kd-plib-title"></span>
      <span class="kd-plib-use">${esc(usageLabel(pb.useSel.value))}</span>
      <button class="kd-plib-x" title="${t("Close")}">✕</button>
    </div>
    <div class="kd-plib-tools">
      <input class="kd-plib-q" spellcheck="false">
      <button class="kd-pbox-btn kd-plib-new">＋ ${t("New tag")}</button>
      <button class="kd-pbox-btn kd-plib-clear">${t("Clear history")}</button>
    </div>
    <div class="kd-plib-cats"></div>
    <div class="kd-plib-subcats"></div>
    <div class="kd-plib-list"></div>
    <div class="kd-plib-foot">
      <span class="kd-plib-tip"></span>
      <div class="kd-plib-loc"></div>
    </div>`;

  const pos = placePanel(node);
  libPanel.style.left = pos.left + "px";
  libPanel.style.top = pos.top + "px";
  libPanel.style.width = pos.w + "px";
  libPanel.style.height = pos.h + "px";
  document.body.appendChild(libPanel);
  void libPanel.offsetWidth;   // 入场动画不依赖 rAF，后台标签页里也不会停在透明态
  libPanel.classList.add("kd-in");

  libReposition = () => {
    if (!libPanel) return;
    const p = placePanel(node);
    libPanel.style.left = p.left + "px";
    libPanel.style.top = p.top + "px";
    libPanel.style.width = p.w + "px";
    libPanel.style.height = p.h + "px";
  };

  const titleEl = libPanel.querySelector(".kd-plib-title");
  const qEl = libPanel.querySelector(".kd-plib-q");
  const catsEl = libPanel.querySelector(".kd-plib-cats");
  const subcatsEl = libPanel.querySelector(".kd-plib-subcats");
  const listEl = libPanel.querySelector(".kd-plib-list");
  const usePill = libPanel.querySelector(".kd-plib-use");
  const tipEl = libPanel.querySelector(".kd-plib-tip");
  const newBtn = libPanel.querySelector(".kd-plib-new");
  const clearBtn = libPanel.querySelector(".kd-plib-clear");
  const locEl = libPanel.querySelector(".kd-plib-loc");
  libPanel.querySelector(".kd-plib-x").onclick = () => closeLib();

  let loading = true;
  let reloadSeq = 0;
  let loc = { vault: "", source: "default", error: "" };
  let locEditing = false;
  const SRC_LABEL = { env: "env var", config: "panel", setting: "settings file", default: "default" };

  // ---- 库位置：显示后端实际在读哪个目录，并能就地改 ----
  function showLoc() {
    locEditing = false;
    locEl.innerHTML = `
      <span class="kd-plib-vault${loc.error ? " kd-bad" : ""}" title="${esc(loc.error || loc.vault)}">${esc(loc.vault)}<i>${esc(t(SRC_LABEL[loc.source] || loc.source))}</i></span>
      <button class="kd-pbox-btn">${t("Change folder")}</button>`;
    locEl.querySelector("button").onclick = editLoc;
  }
  function editLoc() {
    locEditing = true;
    locEl.innerHTML = `
      <input class="kd-plib-path-in" spellcheck="false" placeholder="${t("Absolute path, e.g. D:\\Docs\\prompts")}">
      <button class="kd-pbox-btn kd-main">${t("Save")}</button><button class="kd-pbox-btn">${t("Cancel")}</button>`;
    const inp = locEl.querySelector("input");
    const btns = locEl.querySelectorAll("button");
    inp.value = loc.error ? "" : loc.vault;
    inp.focus();
    btns[1].onclick = showLoc;
    const commit = async () => {
      const v = inp.value.trim();
      if (v === loc.vault && !loc.error) { showLoc(); return; }
      let r;
      try { r = await api("/vault", { path: v }); }
      catch (e) { toast(t("Library folder move failed: {error}", { error: serverError(e.message) }), true); return; }
      if (!r.ok) { toast(t("Library folder move failed: {error}", { error: serverError(r.error) }), true); return; }
      loc = { vault: r.vault || "", source: r.vault_source || "default", error: r.error || "" };
      locEditing = false;        // 成功后必须退出编辑态，否则刷新会一直跳过 showLoc，输入框留在原地
      showLoc();
      libInvalidate();
      libState.phraseInit = false;   // 换了库：分组/分类要按新库重新选
      libState.phraseGroup = "";
      libState.phraseCat = "";
      await reload(true);
      toast(v ? t("Library folder changed") : t("Back to the default folder"));
    };
    btns[0].onclick = commit;
    inp.onkeydown = (ev) => {
      ev.stopPropagation();                       // 别被节点的「输入即提示词」抢走
      if (ev.key === "Enter") commit();
      else if (ev.key === "Escape") showLoc();
    };
  }

  // ---- 标题 / 搜索 / 工具栏 ----
  function applyLabels() {
    titleEl.textContent = libTab === "phrases" ? t("Tags")
      : libTab === "history" ? t("History") : t("Prompts");
    usePill.textContent = usageLabel(pb.useSel.value);
    newBtn.textContent = "＋ " + t("New tag");
    clearBtn.textContent = t("Clear history");
    clearBtn.style.color = "";
    newBtn.hidden = libTab !== "phrases";
    clearBtn.hidden = libTab !== "history";
    qEl.placeholder = libTab === "phrases" ? t("Search tags…")
      : libTab === "history" ? t("Search history…") : t("Search prompts…");
    if (qEl.value !== (libState.q[libTab] || "")) qEl.value = libState.q[libTab] || "";
  }

  qEl.oninput = () => {
    libState.q[libTab] = qEl.value;
    clearTimeout(qEl._t);
    qEl._t = setTimeout(() => paint(), 140);
  };
  qEl.onkeydown = (e) => { if (e.key !== "Escape") e.stopPropagation(); };

  newBtn.onclick = () => {
    libState.phraseFormOpen = true;
    libState.phraseEditId = null;
    paintBody();
  };
  clearBtn.onclick = async () => {
    if (Date.now() - libState.clearArmed > 2500) {
      libState.clearArmed = Date.now();
      clearBtn.textContent = t("Confirm clear history?");
      clearBtn.style.color = "var(--error-text,#ff6b6b)";
      setTimeout(() => {
        if (Date.now() - libState.clearArmed >= 2500) {
          clearBtn.textContent = t("Clear history");
          clearBtn.style.color = "";
        }
      }, 2600);
      return;
    }
    libState.clearArmed = 0;
    clearBtn.textContent = t("Clear history");
    clearBtn.style.color = "";
    try {
      const r = await api("/history/clear", {});
      toast(r.ok ? t("History cleared") : t("Delete failed"), !r.ok);
      if (r.ok) reload(true);
    } catch (e) {
      toast(t("Delete failed") + ": " + serverError(e.message), true);
    }
  };

  // ---- 数据 ----
  async function reload(force) {
    const seq = ++reloadSeq;
    const reads = [
      (async () => {
        try {
          const d = await lib(force);
          libData.prompts = d.items || [];
          if (d.vault) loc = { vault: d.vault, source: d.vault_source || "default", error: d.error || "" };
          libErrors.prompts = "";
        } catch (e) {
          libErrors.prompts = serverError(e.message);
          loc.error = libErrors.prompts;
        }
      })(),
      (async () => {
        try {
          const d = await phraseLib(force);
          libData.phrases = d.items || [];
          libData.groups = d.groups || [];
          libData.categories = d.categories || [];
          if (d.vault && !loc.vault) loc = { vault: d.vault, source: d.vault_source || "default", error: d.error || "" };
          libErrors.phrases = "";
          if (!libState.phraseInit && libData.groups.length) {
            libState.phraseInit = true;   // 只在第一次选默认分类；之后记住用户的选择
            libState.phraseGroup = libData.groups[0];
            const cats = libData.categories.filter((c) => c.group === libState.phraseGroup);
            libState.phraseCat = cats.length ? cats[0].name : "";
          }
        } catch (e) {
          libErrors.phrases = serverError(e.message);
        }
      })(),
      (async () => {
        try {
          const d = await historyLib(force);
          libData.history = d.items || [];
          if (d.vault && !loc.vault) loc = { vault: d.vault, source: d.vault_source || "default", error: d.error || "" };
          libErrors.history = "";
        } catch (e) {
          libErrors.history = serverError(e.message);
        }
      })(),
    ];
    await Promise.all(reads);
    if (seq !== reloadSeq || session !== libSession || !libPanel) return;
    loading = false;
    if (!locEditing) showLoc();
    paint();
    pb.paintChips();
  }
  async function refresh() { await reload(true); }

  // ---- 渲染 ----
  function currentItems() {
    return libTab === "phrases" ? libData.phrases
      : libTab === "history" ? libData.history : libData.prompts;
  }
  function match(e, q) {
    if (!q) return true;
    return String(e.name || "").toLowerCase().includes(q)
      || String(e.positive || "").toLowerCase().includes(q)
      || String(e.negative || "").toLowerCase().includes(q)
      || String(e.category || "").toLowerCase().includes(q)
      || String(e.group || "").toLowerCase().includes(q);
  }
  function empty(msg, withWhere) {
    const d = document.createElement("div");
    d.className = "kd-plib-empty";
    d.textContent = msg;
    if (withWhere) {
      const w = document.createElement("div");
      w.className = "kd-plib-empty-where";
      w.textContent = loc.error || loc.vault;
      d.appendChild(w);
    }
    listEl.appendChild(d);
  }
  function bindToggle(el, e, kind) {
    el.onclick = (ev) => {
      ev.stopPropagation();
      if (kind === "prompt" && libState.editId === e.id) return;      // 编辑态不触发插入
      if (kind === "phrase" && libState.phraseEditId === e.id) return;
      const res = toggleEntry(pb.ta, pb.sync, e);
      if (!res) return;
      const label = e.name || String(e.positive || "").slice(0, 12);
      if (res === "inserted") {
        api(USE_URL[kind], { id: e.id }).catch(() => { /* 静默 */ });
        e.uses = (e.uses || 0) + 1;
        toast(t('Inserted "{name}"', { name: label }));
      } else {
        toast(t('Removed "{name}"', { name: label }));
      }
      // 只更新被点的那一项：整页重绘会把正在填的词库表单一起清掉
      el.classList.toggle("kd-used", res === "inserted");
      const badge = el.querySelector(".kd-badge");
      if (badge && kind !== "phrase") badge.textContent = t("{n} uses", { n: e.uses || 0 });
      pb.paintChips();
    };
  }

  function paint() {
    if (!libPanel) return;
    applyLabels();
    if (libTab === "phrases") paintCats();
    else { catsEl.hidden = true; subcatsEl.hidden = true; }
    paintBody();
    tipEl.textContent = libTab === "phrases"
      ? t("Click a tag to insert · click again to remove · right-click to edit")
      : libTab === "history"
        ? t("Prompts you run land here automatically · right-click to delete")
        : t("Click to insert · click again to remove · right-click for more");
  }

  function paintCats() {
    catsEl.innerHTML = "";
    subcatsEl.innerHTML = "";
    if ((libState.q.phrases || "").trim()) {
      catsEl.hidden = true;
      subcatsEl.hidden = true;
      return;
    }
    catsEl.hidden = false;
    const add = (label, active, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kd-plib-cat" + (active ? " kd-on" : "");
      b.textContent = label;
      b.onclick = onClick;
      catsEl.appendChild(b);
    };
    add(t("All"), libState.phraseGroup === "", () => {
      libState.phraseGroup = ""; libState.phraseCat = ""; paint();
    });
    add(t("Favorites"), libState.phraseGroup === "__fav", () => {
      libState.phraseGroup = "__fav"; libState.phraseCat = ""; paint();
    });
    (libData.groups || []).forEach((g) => add(g, libState.phraseGroup === g, () => {
      libState.phraseGroup = g;
      const cats = libData.categories.filter((c) => c.group === g);
      libState.phraseCat = cats.length ? cats[0].name : "";
      paint();
    }));

    const cats = libState.phraseGroup && libState.phraseGroup !== "__fav"
      ? libData.categories.filter((c) => c.group === libState.phraseGroup).map((c) => c.name)
      : [];
    subcatsEl.hidden = cats.length < 2;
    if (cats.length < 2) return;
    const addSub = (label, active, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kd-plib-cat" + (active ? " kd-on" : "");
      b.textContent = label;
      b.onclick = onClick;
      subcatsEl.appendChild(b);
    };
    addSub(t("All categories"), !libState.phraseCat, () => {
      libState.phraseCat = ""; paint();
    });
    cats.forEach((c) => addSub(c, libState.phraseCat === c, () => {
      libState.phraseCat = c; paint();
    }));
  }

  function paintBody() {
    if (!libPanel) return;
    listEl.innerHTML = "";
    if (loading && !currentItems().length) {
      empty(t("Loading…"));
      return;
    }
    const err = libErrors[libTab];
    if (err && !currentItems().length) {
      empty(t("Failed to load: {error}", { error: err }), true);
      return;
    }
    if (libTab === "prompts") paintPrompts();
    else if (libTab === "phrases") paintPhrases();
    else paintHistory();
  }

  function paintPrompts() {
    const use = pb.useSel.value;
    const q = (libState.q.prompts || "").trim().toLowerCase();
    const pool = (libData.prompts || []).filter((e) => (e.use_for || []).indexOf(use) !== -1);
    const rows = pool.filter((e) => match(e, q));
    if (!pool.length && !q) {
      empty(t('No prompts for "{usage}" yet — write one and hit "Save"', { usage: usageLabel(use) }), true);
      return;
    }
    if (!rows.length) { empty(t("Nothing matches this filter")); return; }
    const grid = document.createElement("div");
    grid.className = "kd-lib-grid";
    rows.forEach((e) => {
      const row = document.createElement("div");
      row.className = "kd-row" + (insText(pb.ta, e) ? " kd-used" : "");
      row.dataset.id = e.id;
      row.title = (e.positive || e.negative || "").slice(0, 400);
      row.innerHTML = `
        <div class="kd-row-name">${e.pinned ? '<span class="kd-star">★</span>' : ""}<span class="kd-name-t">${esc(e.name)}</span>
          <span class="kd-badge">${t("{n} uses", { n: e.uses || 0 })}</span></div>
        <div class="kd-row-prev">${esc((e.positive || e.negative || "").slice(0, 80)) || t("(Body is in the Negative field)")}</div>`;
      bindToggle(row, e, "prompt");
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openRowMenu(ev.clientX, ev.clientY, e, "prompt", refresh);
      };
      if (libState.editId === e.id) renderRowEdit(row, e, refresh);
      grid.appendChild(row);
    });
    listEl.appendChild(grid);
  }

  function phraseChip(e) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kd-tag" + (insText(pb.ta, e) ? " kd-used" : "");
    b.title = e.positive;
    const showVal = e.name && e.name.toLowerCase() !== e.positive.toLowerCase();
    b.innerHTML = `<span class="kd-tag-name">${e.pinned ? '<span class="kd-star">★</span>' : ""}${esc(e.name || e.positive)}</span>`
      + (showVal ? `<span class="kd-tag-val">${esc(e.positive)}</span>` : "");
    bindToggle(b, e, "phrase");
    b.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openRowMenu(ev.clientX, ev.clientY, e, "phrase", refresh);
    };
    return b;
  }

  function paintPhrases() {
    const q = (libState.q.phrases || "").trim().toLowerCase();
    if (libState.phraseFormOpen || libState.phraseEditId) {
      const editing = libState.phraseEditId
        ? (libData.phrases || []).find((e) => e.id === libState.phraseEditId) : null;
      listEl.appendChild(renderPhraseForm(editing || null, refresh));
    }
    if (!(libData.phrases || []).length) {
      empty(t('No tags yet — click "New tag" to add one'), true);
      return;
    }
    let pool = libData.phrases || [];
    if (q) {
      pool = pool.filter((e) => match(e, q));
    } else if (libState.phraseGroup === "__fav") {
      pool = pool.filter((e) => e.pinned);
    } else if (libState.phraseGroup) {
      pool = pool.filter((e) => e.group === libState.phraseGroup);
      if (libState.phraseCat) pool = pool.filter((e) => e.category === libState.phraseCat);
    }
    if (!pool.length) {
      empty(q ? t("Nothing matches this filter")
        : libState.phraseGroup === "__fav" ? t("No favorites yet — right-click a tag and pin it")
          : t("No tags in this category yet"));
      return;
    }
    const MAX = 400;
    const capped = pool.length > MAX;
    if (capped) pool = pool.slice(0, MAX);
    const groups = new Map();
    pool.forEach((e) => {
      const label = q || !libState.phraseGroup || libState.phraseGroup === "__fav"
        ? `${e.group || t("My tags")} · ${e.category || t("Uncategorized")}`
        : (e.category || t("Uncategorized"));
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(e);
    });
    groups.forEach((items, label) => {
      const h = document.createElement("div");
      h.className = "kd-tag-group";
      h.textContent = label;
      const wrap = document.createElement("div");
      wrap.className = "kd-tag-wrap";
      items.forEach((e) => wrap.appendChild(phraseChip(e)));
      listEl.appendChild(h);
      listEl.appendChild(wrap);
    });
    if (capped) {
      empty(t("Showing first {n} — use search or a category to narrow", { n: MAX }));
    }
  }

  function paintHistory() {
    const use = pb.useSel.value;
    const q = (libState.q.history || "").trim().toLowerCase();
    const pool = (libData.history || []).filter((e) => (e.use_for || []).indexOf(use) !== -1);
    const rows = pool.filter((e) => match(e, q));
    if (!pool.length) {
      empty(t("No history for this usage yet — prompts you run land here automatically"), true);
      return;
    }
    if (!rows.length) { empty(t("Nothing matches this filter")); return; }
    const grid = document.createElement("div");
    grid.className = "kd-lib-grid";
    rows.forEach((e) => {
      const row = document.createElement("div");
      row.className = "kd-row" + (insText(pb.ta, e) ? " kd-used" : "");
      row.dataset.id = e.id;
      row.title = (e.positive || "").slice(0, 400);
      const stamp = String(e.updated || "").slice(0, 16);
      row.innerHTML = `
        <div class="kd-row-name"><span class="kd-name-t">${esc(e.name)}</span>
          <span class="kd-badge">${t("{n} uses", { n: e.uses || 0 })}${stamp ? " · " + esc(stamp) : ""}</span></div>
        <div class="kd-row-prev">${esc((e.positive || "").slice(0, 80))}</div>`;
      bindToggle(row, e, "history");
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openRowMenu(ev.clientX, ev.clientY, e, "history", refresh);
      };
      grid.appendChild(row);
    });
    listEl.appendChild(grid);
  }

  libRepaint = () => { if (libPanel) { applyLabels(); paint(); } };
  libRefresh = refresh;

  paint();
  markPboxBtns(node, libTab);
  reload(true);
  qEl.focus();
}

function closeLib(instant) {
  closeMenu();
  libSession++;
  if (!libPanel) return;
  const panel = libPanel;
  markPboxBtns(libOwner, null);
  libPanel = null; libOwner = null;
  libReposition = null;
  libState.editId = null;
  libState.phraseEditId = null;
  libState.phraseFormOpen = false;
  libState.clearArmed = 0;
  libRepaint = null; libRefresh = null;
  if (instant || reducedMotion()) {
    if (panel) panel.remove();
    return;
  }
  if (panel) { panel.classList.remove("kd-in"); panel.classList.add("kd-out"); }
  setTimeout(() => { if (panel) panel.remove(); }, 200);
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (menuEl) closeMenu();
  if (libPanel) closeLib();
});
// 点画布别处收掉面板；点节点本身（输入框/用途/按钮）和右键菜单时保持
document.addEventListener("pointerdown", (e) => {
  if (!libPanel || !libOwner) return;
  if (libPanel.contains(e.target)) return;
  if (menuEl && menuEl.contains(e.target)) return;
  const card = libOwner._kdCard;
  if (card && card.contains(e.target)) return;
  closeLib();
}, true);
window.addEventListener("resize", () => { if (libReposition) libReposition(); });

// ───────── KedouPromptBox 节点面板 ─────────
function buildPromptBox(node) {
  const pw = (node.widgets || []).find((w) => w.name === "prompt_state");
  const uw = (node.widgets || []).find((w) => w.name === "usage");
  if (!pw) return;
  try { pw.options = pw.options || {}; pw.options.hidden = true; } catch (_) { /* ignore */ }
  try { uw.options = uw.options || {}; uw.options.hidden = true; } catch (_) { /* ignore */ }

  const card = document.createElement("div");
  card.className = "kd-pbox";

  const top = document.createElement("div");
  top.className = "kd-pbox-top";
  const lab = document.createElement("b");
  lab.textContent = t("Usage");
  const useSel = document.createElement("select");
  useSel.className = "kd-pbox-use";
  USAGES.forEach((u) => {
    const o = document.createElement("option");
    o.value = u; o.textContent = usageLabel(u);
    useSel.appendChild(o);
  });
  useSel.value = String((uw && uw.value) || USAGES[0]);
  useSel.onchange = () => {
    if (uw) uw.value = useSel.value;
    try { node.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }
    paintChips();
    // 面板开着时换用途：语库/历史立刻按新用途重新筛
    if (libOwner === node && libRefresh) libRefresh();
  };
  useSel.onpointerdown = (e) => e.stopPropagation();

  const libBtn = document.createElement("button");
  libBtn.type = "button"; libBtn.className = "kd-pbox-btn kd-accent"; libBtn.textContent = t("Prompts");
  libBtn.title = t("Open the prompt library");
  const phraseBtn = document.createElement("button");
  phraseBtn.type = "button"; phraseBtn.className = "kd-pbox-btn kd-accent"; phraseBtn.textContent = t("Tags");
  phraseBtn.title = t("Open the tag library");
  const histBtn = document.createElement("button");
  histBtn.type = "button"; histBtn.className = "kd-pbox-btn kd-accent"; histBtn.textContent = t("History");
  histBtn.title = t("Open the history list for this usage");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button"; saveBtn.className = "kd-pbox-btn"; saveBtn.textContent = t("Save");
  const clearBtn = document.createElement("button");
  clearBtn.type = "button"; clearBtn.className = "kd-pbox-btn"; clearBtn.textContent = t("Clear");
  clearBtn.style.marginLeft = "auto";   // 组整体靠右：清除 → 保存 → 语库 → 词库 → 历史
  top.append(lab, useSel, clearBtn, saveBtn, libBtn, phraseBtn, histBtn);

  const ta = document.createElement("textarea");
  ta.className = "kd-pbox-ta";
  ta.placeholder = t('Enter a prompt… open "Prompts" to insert / "Save" to store under the current usage');
  ta.value = String(pw.value || "");

  function sync() {
    pw.value = ta.value;
    try { node.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }
  }
  let usedT = null;
  ta.addEventListener("input", () => {
    sync();
    // 手动删掉已插入的文本后，高亮也要跟着灭；不重新请求，只重绘本地状态
    clearTimeout(usedT);
    usedT = setTimeout(() => {
      paintChips();
      if (libOwner === node && libRepaint) libRepaint();
    }, 250);
  });
  ta.addEventListener("pointerdown", (e) => e.stopPropagation());
  ta.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  card.append(top, ta);

  // 快捷 chips：只放置顶语库。一个入口点一下就能插，不打开面板。
  // 词库和历史都不进这里：短词数量大、历史更新频繁，都会把常用区挤满。
  const chips = document.createElement("div");
  chips.className = "kd-pbox-chips";
  card.append(chips);

  async function paintChips() {
    try {
      const [pd] = await Promise.allSettled([lib()]);
      const use = useSel.value;
      const prompts = pd.status === "fulfilled"
        ? (pd.value.items || []).filter((e) => (e.use_for || []).indexOf(use) !== -1) : [];
      const pool = prompts.filter((e) => e.pinned).slice(0, 5)
        .map((e) => ({ e, kind: "prompt" }));
      // 同一条内容只出现一次，避免旧数据里的重复条目撑满 chips
      const seen = new Set();
      const uniq = pool.filter(({ e }) => {
        const key = String(e.positive || "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      chips.innerHTML = "";
      if (!uniq.length) {
        const s = document.createElement("span");
        s.className = "kd-pbox-chip"; s.style.opacity = ".5"; s.style.cursor = "default";
        s.textContent = t('Pinned prompts for "{usage}" will appear here', { usage: usageLabel(use) });
        chips.appendChild(s);
        return;
      }
      uniq.forEach(({ e, kind }) => {
        const c = document.createElement("button");
        c.type = "button";
        c.className = "kd-pbox-chip"
          + (e.pinned ? " kd-pin" : "")
          + (insText(ta, e) ? " kd-used" : "");
        const content = e.positive || e.negative || "";
        const full = e.name || String(content).slice(0, 20);
        // 常用按钮只放缩名，最多 4 个字；完整名字/内容看悬停提示或面板
        const short = Array.from(full).slice(0, 4).join("") || "…";
        c.title = full + (content ? "\n" + String(content).slice(0, 300) : "");
        c.innerHTML = esc(short);   // 只放缩名；置顶的靠边框颜色区分
        c.onclick = (ev) => {
          ev.stopPropagation();
          const res = toggleEntry(ta, sync, e);
          if (!res) return;
          if (res === "inserted") {
            api(USE_URL[kind], { id: e.id }).catch(() => { /* 静默 */ });
            e.uses = (e.uses || 0) + 1;
            toast(t('Inserted "{name}"', { name: full }));
          } else {
            toast(t('Removed "{name}"', { name: full }));
          }
          paintChips();
          if (libOwner === node && libRepaint) libRepaint();
        };
        chips.appendChild(c);
      });
    } catch (_) { /* 静默 */ }
  }

  // 三个按钮各自打开面板的对应内容：再点当前那个就关，点另一个原地切换
  function togglePanel(tab) {
    if (libOwner === node && libPanel) {
      if (libTab === tab) { closeLib(); return; }
      libTab = tab;
      libState.editId = null;
      libState.phraseEditId = null;
      libState.phraseFormOpen = false;
      libState.clearArmed = 0;
      markPboxBtns(node, tab);
      if (libRepaint) libRepaint();
      if (libRefresh) libRefresh();
      return;
    }
    openLib(node, tab);
  }
  libBtn.onclick = () => togglePanel("prompts");
  phraseBtn.onclick = () => togglePanel("phrases");
  histBtn.onclick = () => togglePanel("history");
  // 「保存」先问去处：语库（长提示词 .md）还是词库（短词，落在「未分类」）
  async function saveCurrent(to) {
    const text = ta.value.trim();
    if (!text) { toast(t("The input box is empty"), true); return; }
    try {
      if (to === "tags") {
        const r = await api("/phrases/save", { name: text.slice(0, 20), positive: text, category: "" });
        if (!r.ok) { toast(t("Save failed: {error}", { error: serverError(r.error) }), true); return; }
        applyPhraseItemState(r.item);
        toast(r.deduped ? t("Already in the tag library") : t("Saved to the tag library (Uncategorized)"));
      } else {
        const r = await api("/save", { name: text.slice(0, 20), type: "精选", positive: text, usage: [useSel.value] });
        if (!r.ok) { toast(t("Save failed"), true); return; }
        libState.q.prompts = "";      // 保存后清掉搜索，刚存的那条一定看得见
        toast(r.deduped ? t("Already in the library")
          : t("Saved under {usage}", { usage: usageLabel(useSel.value) }));
      }
      libTouch();
    } catch (e) {
      toast(t("Save failed: {error}", { error: serverError(e.message) }), true);
    }
  }
  function openSaveMenu() {
    if (!ta.value.trim()) { toast(t("The input box is empty"), true); return; }
    closeMenu();
    const m = document.createElement("div");
    m.className = "kd-menu";
    m.innerHTML = `
      <div class="kd-menu-title">${t("Save to…")}</div>
      <button data-a="lib">→ ${t("Save to prompt library")}</button>
      <button data-a="tags">＋ ${t("Save to tag library")}</button>`;
    menuEl = m;                       // 复用全局菜单：点别处/Escape 都能收掉
    const r = saveBtn.getBoundingClientRect();
    const h = 96;
    m.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 190)) + "px";
    m.style.top = (r.bottom + 6 + h <= window.innerHeight ? r.bottom + 6 : Math.max(6, r.top - h - 6)) + "px";
    document.body.appendChild(m);
    void m.offsetWidth;
    m.classList.add("kd-in");
    m.querySelector("[data-a=lib]").onclick = () => { closeMenu(); saveCurrent("lib"); };
    m.querySelector("[data-a=tags]").onclick = () => { closeMenu(); saveCurrent("tags"); };
  }
  saveBtn.onclick = openSaveMenu;
  let clearArmed = 0;
  clearBtn.onclick = () => {
    if (!ta.value) return;
    // 原先靠 textContent.indexOf("确认") 判断按钮是否处于二次确认态；文案本地化后该串不可靠，
    // 改由时间戳判定（与 2500ms 窗口等价，行为不变）。
    if (Date.now() - clearArmed < 2500) {
      ta.value = ""; sync(); clearArmed = 0; clearBtn.textContent = t("Clear"); clearBtn.style.color = "";
    } else {
      clearArmed = Date.now();
      clearBtn.textContent = t("Confirm clear?"); clearBtn.style.color = "var(--error-text,#ff6b6b)";
      setTimeout(() => {
        if (Date.now() - clearArmed >= 2500) { clearBtn.textContent = t("Clear"); clearBtn.style.color = ""; }
      }, 2600);
    }
  };

  node.addDOMWidget("kedou_promptbox", "div", card, {
    getMinHeight: () => 240, serialize: false, hideOnZoom: false,
  });
  node._kdCard = card;

  const prevCfg = node.onConfigure;
  node.onConfigure = function () {
    const r = typeof prevCfg === "function" ? prevCfg.apply(this, arguments) : undefined;
    setTimeout(() => {
      ta.value = String(pw.value || "");
      ta.__kdIns = null;          // 工作流切换/重载：旧的插入记录不再可信
      useSel.value = String((uw && uw.value) || USAGES[0]);
      paintChips();
    }, 0);
    return r;
  };

  const prevRemoved = node.onRemoved;
  node.onRemoved = function () {
    if (libOwner === node) closeLib(true);   // 节点被删了，旁边开着的面板也一起收掉
    return typeof prevRemoved === "function" ? prevRemoved.apply(this, arguments) : undefined;
  };

  node.__kdPbox = { ta, sync, pw, useSel, paintChips, libBtn, phraseBtn, histBtn };
  paintChips();
}

// 词库存删改后，所有 pbox 节点刷新 chips
function refreshAllPbox() {
  try {
    for (const n of app.graph._nodes) {
      if (n.__kdPbox && n.__kdPbox.paintChips) n.__kdPbox.paintChips();
    }
  } catch (_) { /* ignore */ }
}

// ───────── 自动历史：execution_success 事件（带用途） ─────────
// 官方《ComfyUI Server Messages》(docs.comfy.org/development/comfyui-server/comms_messages)
// 把 2026-10-18 之前的写法（patch `api.executed`）否掉了两条：
//   ① executed **不是**「节点跑完」，原文是 "not sent whenever a node completes execution …
//      but only when the node returns a ui update"，即只有 main 函数 return {"ui":…, "result":…}
//      才发。提示词框返回的是普通元组（STRING 直通），所以这个事件对本节点永远不来；
//   ② 接收要 `api.addEventListener(type, handler)`（api 是 EventTarget，事件数据在 .detail），
//      往 api.executed 赋函数在新前端里没人调用。
// 结论：节点侧的自动历史一条都没写过；旧版本的 00_History 是 PS 面板存进去的，
// 现在已迁进 .kedou/history.json（不再生成 .md）。
// 换成 execution_success：整条工作流全部跑成功才发一次，语义正好是「我运行了几次」，
// 而且带 prompt_id —— 用它挡住同一轮重复记录（老写法每来一个事件就全图扫一遍）。
function recordRunPrompts(onFail, only) {
  const seen = new Set();
  let posted = 0;
  const post = (key, usage) => {
    seen.add(key);
    posted += 1;
    fetch(API + "/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ positive: key, usage }) })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((d) => {
        if (d && d.ok) libTouch();
        else onFail((d && d.error) || "save rejected");
      })
      .catch((e) => onFail(e && e.message ? e.message : String(e)));
  };
  for (const node of ((app.graph && app.graph._nodes) || [])) {
    if (!node.widgets) continue;
    // 只记这一轮真跑过的节点：画布上常挂着好几条工作流的提示词框，从 PS 面板发起的运行
    // 也不该把浏览器里开着的图存档成「你跑过」。
    if (only && only.size && !only.has(Number(node.id))) continue;
    const isPbox = ((node.constructor && node.constructor.comfyClass) || node.comfyClass || "") === PBOX_CLASS;
    // 提示词框按 widget 名字取（prompt_state）：它是我们自己的控件，类型名随 ComfyUI 版本
    // 叫 string / text / textarea 都有可能，按名字取就绕开了这个坑。
    const pw = isPbox ? node.widgets.find((w) => w.name === "prompt_state") : null;
    if (isPbox) {
      const key = pw && typeof pw.value === "string" ? pw.value.trim() : "";
      if (key.length >= 4 && !seen.has(key)) post(key, pboxUsage(node));
      continue;
    }
    // 其它节点：白名单只放文本类控件，combo 的取值也是字符串（采样器名等），
    // 不收进来就会把一串参数名写进历史。
    const usage = USAGES[0];
    const ntitle = String(node.title || "").toLowerCase();
    if (ntitle.indexOf("negative") !== -1 || ntitle.indexOf("负向") !== -1) continue;
    for (const w of node.widgets) {
      const wt = String(w.type || "").toLowerCase();
      if (wt !== "textarea" && wt !== "string" && wt !== "text") continue;
      if (typeof w.value !== "string") continue;
      // 负向提示词同样是文本控件：名字里带 negative / 负向 的不收，
      // 否则每轮出图都会把负面词当成一条正向历史存进去。
      const wname = String(w.name || "").toLowerCase();
      if (wname.indexOf("negative") !== -1 || wname.indexOf("负向") !== -1) continue;
      const key = w.value.trim();
      if (key.length < 4 || seen.has(key)) continue;
      post(key, usage);
    }
  }
  return posted;
}

// USAGES 是数据不是文案：控件值对不上这五个字（旧工作流、被别的插件改过）就回落默认，
// 不把脏值写进词库的 use_for。
function pboxUsage(node) {
  const uw = node.widgets.find((w) => w.name === "usage");
  const v = String((uw && uw.value) || "");
  return USAGES.indexOf(v) !== -1 ? v : USAGES[0];
}

function hookHistory(apiObj) {
  if (!apiObj || typeof apiObj.addEventListener !== "function") {
    console.warn("[kedou] 自动历史没接上：拿不到 api.addEventListener");
    return;
  }
  let lastPid = "";
  let lastAt = 0;
  let warned = false;
  let ran = new Set();          // 本轮真正执行过的节点 id
  const onFail = (msg) => {
    // 一次出图会写好几条，失败提示整个会话只弹一次，别把画布变成弹窗堆；原文进 console
    console.warn("[kedou] 自动历史失败：" + msg);
    if (warned) return;
    warned = true;
    try { toast(t("Auto-history failed: {error}", { error: serverError(msg) }), true); } catch (_) { /* ignore */ }
  };
  // executing 带 node（跑完时为 null）、execution_cached 带 nodes（被跳过的复用节点）。
  // 两类都算「这一轮跑过」——缓存节点同样用到了那条提示词。
  apiObj.addEventListener("execution_start", () => { ran = new Set(); });
  apiObj.addEventListener("executing", (ev) => {
    const n = ev && ev.detail && ev.detail.node;
    if (n !== null && n !== undefined) ran.add(Number(n));
  });
  apiObj.addEventListener("execution_cached", (ev) => {
    ((ev && ev.detail && ev.detail.nodes) || []).forEach((id) => ran.add(Number(id)));
  });
  apiObj.addEventListener("execution_success", (ev) => {
    const d = (ev && ev.detail) || {};
    const pid = String(d.prompt_id || "");
    // detail 里没有 prompt_id 时（前端版本差异）退化成 3 秒窗口去重
    if (pid ? pid === lastPid : Date.now() - lastAt < 3000) return;
    if (pid) lastPid = pid; else lastAt = Date.now();
    if (localStorage.getItem("kedou_plib_hist") === "0") return;
    try {
      // ran 为空（没收到 executing，比如老前端只发 executed）就退回全图扫描，宁多不漏
      recordRunPrompts(onFail, ran);
    } catch (e) {
      console.warn("[kedou] 自动历史扫描失败：" + (e && e.message ? e.message : e));
    }
    ran = new Set();   // 用完即清：下一轮万一漏了 execution_start，也不会拿上一轮的节点集去筛
  });
}

// ───────── 挂载 ─────────
app.registerExtension({
  name: "kedou.promptlib",
  async setup() {
    await initI18n(app);   // 保证建 UI 前语言包已就绪；重复调用只生效一次
    // 词库下拉列表 / 节点 chips 可重绘，接一下语言切换即时刷新；
    // 节点 widget 内部静态结构（<option>、按钮、标题）不接，下次建节点/重开面板生效。
    onLocaleChange(() => {
      try { if (libRepaint) libRepaint(); } catch (_) { /* ignore */ }
      try { refreshAllPbox(); } catch (_) { /* ignore */ }
    });
    try {
      if (!document.querySelector("style[data-kpl]")) {
        const st = document.createElement("style");
        st.setAttribute("data-kpl", "1");
        st.textContent = CSS;
        document.head.appendChild(st);
      }
    } catch (e) {
      console.error("[kedou] 词库样式挂载失败", e);
    }
    // 自动历史挂在 setup 而不是 registerApiHandlers：setup() 一定被调用（样式就是在这里挂上的，
    // 节点界面能正常显示即证明），而 registerApiHandlers 有没有触发我们无法在用户机器上验证。
    try {
      hookHistory(app.api);
    } catch (e) {
      console.error("[kedou] 历史 hook 失败", e);
    }
  },
  async nodeCreated(node) {
    const cls = (node.constructor && node.constructor.comfyClass) || node.comfyClass || "";
    if (cls !== PBOX_CLASS) return;
    try {
      buildPromptBox(node);
    } catch (e) {
      console.error("[kedou] 提示词输入框构建失败", e);
    }
  },
});

window.__kedouLibInvalidate = () => { libInvalidate(); refreshAllPbox(); };

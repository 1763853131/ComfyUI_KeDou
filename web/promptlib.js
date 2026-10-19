// 蝌蚪提示词库（轻量版 v4）—— 词库完全集成在「蝌蚪提示词输入框」节点上
// 后端：prompt_vault 包（vendored 在 ComfyUI_KeDou/prompt_vault/，上游是 D:\Git\prompt_vault，
//       改动在那边提交后跑 sync.py 推过来）
//       GET /ps/prompts?use=…, POST save|delete|use|history|vault
//       KedouPromptBox 节点（prompt_state STRING 直通输出 prompt；usage COMBO 记工作流用途）
// 交互定稿（用户 2026-10-12 拍板）：
//   1) 词库入口离作用对象要近——不再有右侧抽屉/右下角 pill，词库只活在节点上。
//   2) 词库按用途分类：文生图/图像编辑/文生视频/图生视频/参考生视频；
//      节点上选当前工作流用途，词库只显示该用途适用的条目。
//   3) 选词用下拉列表：每条只显示前几个字，悬停显示更多；列表顶满浏览器上下，可滚动。
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
// type 同理：后端存的是 "精选"/"历史" 中文数据，比较（e.type==="历史"）与提交（type:"精选"）用原值，
// 仅徽标展示时套用显示标签。
const TYPE_LABELS = { "精选": "Featured", "历史": "History" };
const typeLabel = (v) => t(TYPE_LABELS[v] || v);

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
.kd-pbox-chip .kd-uses{opacity:.55;margin-left:4px;}
/* ── 词库下拉列表（顶满浏览器上下） ── */
.kd-plib{position:fixed;top:0;bottom:0;z-index:99993;width:340px;display:flex;flex-direction:column;
  background:var(--interface-panel-surface,#232329);color:var(--fg-color,#ddd);
  border:1px solid var(--interface-stroke,#3a3a44);box-shadow:0 10px 40px rgba(0,0,0,.35);
  font:12.5px/1.5 system-ui,sans-serif;opacity:0;transform:translateY(8px);
  transition:opacity .22s ease-out,transform .26s cubic-bezier(.34,1.2,.64,1);}
.kd-plib.kd-in{opacity:1;transform:translateY(0);}
.kd-plib.kd-out{opacity:0;transform:translateY(8px);transition:opacity .16s ease-in,transform .16s ease-in;}
.kd-plib-head{display:flex;align-items:center;gap:8px;padding:12px 12px 8px;}
.kd-plib-title{font-size:13.5px;font-weight:600;flex:1;}
.kd-plib-use{font-size:11px;color:var(--p-primary-color,#6a9bff);border:1px solid var(--p-primary-color,#4a7dff66);
  border-radius:999px;padding:2px 9px;}
.kd-plib-x{border:none;background:none;color:var(--fg-color,#999);font-size:17px;cursor:pointer;padding:2px 7px;}
.kd-plib-x:hover{color:var(--error-text,#ffb3b3);}
.kd-plib-q{margin:0 12px 8px;background:var(--content-bg,#16161c);border:1px solid var(--interface-stroke,#3a3a44);
  border-radius:9px;color:var(--fg-color,#ccc);padding:7px 11px;font:inherit;font-size:12.5px;outline:none;}
.kd-plib-q:focus{border-color:var(--p-primary-color,#4a7dff);}
.kd-plib-list{flex:1;overflow-y:auto;padding:0 12px 12px;display:flex;flex-direction:column;gap:5px;
  scrollbar-width:none;-ms-overflow-style:none;}
.kd-plib-list::-webkit-scrollbar{display:none;}
.kd-row{border:1px solid var(--interface-stroke,#3a3a44);border-radius:9px;padding:7px 10px;cursor:pointer;
  opacity:0;transform:translateY(6px);transition:opacity .16s ease-out,transform .2s cubic-bezier(.34,1.3,.64,1),border-color .15s,background .15s;}
.kd-row.kd-show{opacity:1;transform:translateY(0);}
.kd-row:hover{border-color:var(--p-primary-color,#4a7dff);background:var(--content-bg,#16161c);}
.kd-row-name{font-size:12.5px;font-weight:600;color:var(--fg-color,#e0e0e0);display:flex;align-items:baseline;gap:6px;}
.kd-row-name .kd-badge{font-size:10px;font-weight:400;color:var(--fg-color,#888);border:1px solid var(--interface-stroke,#3a3a44);border-radius:5px;padding:0 5px;margin-left:auto;}
.kd-row-prev{font-size:11.5px;color:var(--fg-color,#9a9a9a);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.kd-row:hover .kd-row-prev{white-space:normal;overflow:visible;}
.kd-plib-empty{padding:22px 0;text-align:center;color:var(--fg-color,#777);font-size:12.5px;}
.kd-plib-foot{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:9px 12px;border-top:1px solid var(--interface-stroke,#3a3a44);font-size:11px;color:var(--fg-color,#888);}
.kd-plib-foot .kd-pbox-btn{margin-left:0;}
/* 库位置：后端到底在读哪个目录。分发出去以后最难查的就是"词库看着是空的，其实在读别处"。 */
.kd-plib-loc{display:flex;gap:6px;align-items:center;width:100%;}
.kd-plib-vault{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:10.5px;color:var(--fg-color,#777);border:1px solid var(--interface-stroke,#3a3a44);
  border-radius:6px;padding:2px 6px;}
.kd-plib-vault i{font-style:normal;opacity:.6;margin-left:5px;}
.kd-plib-vault.kd-bad{border-color:var(--error-text,#a33);color:var(--error-text,#ffb3b3);}
.kd-plib-path-in{flex:1;min-width:0;background:var(--content-bg,#16161c);border:1px solid var(--interface-stroke,#3a3a44);
  border-radius:6px;color:var(--fg-color,#ddd);font:inherit;font-size:11px;padding:3px 7px;outline:none;}
.kd-plib-path-in:focus{border-color:var(--p-primary-color,#4a7dff);}
.kd-plib-empty-where{margin-top:7px;font-size:10.5px;color:var(--fg-color,#666);word-break:break-all;}
/* ── 右键菜单 + 就地编辑 ── */
.kd-menu{position:fixed;z-index:99995;display:flex;flex-direction:column;gap:2px;min-width:120px;padding:5px;
  background:var(--interface-panel-surface,#232329);border:1px solid var(--interface-stroke,#3a3a44);border-radius:10px;
  box-shadow:0 8px 28px rgba(0,0,0,.35);opacity:0;transform:translateY(6px);
  transition:opacity .14s ease-out,transform .18s cubic-bezier(.34,1.3,.64,1);}
.kd-menu.kd-in{opacity:1;transform:translateY(0);}
.kd-menu button{border:none;background:none;text-align:left;color:var(--fg-color,#ccc);font:inherit;font-size:12px;padding:6px 10px;border-radius:7px;cursor:pointer;}
.kd-menu button:hover{background:var(--content-bg,#16161c);color:var(--p-primary-color,#6a9bff);}
.kd-menu button.kd-armed{color:var(--error-text,#ffb3b3);background:var(--content-bg,#16161c);}
.kd-edit{display:flex;flex-direction:column;gap:6px;margin-top:8px;}
.kd-edit input,.kd-edit textarea{background:var(--content-bg,#16161c);border:1px solid var(--interface-stroke,#3a3a44);border-radius:8px;color:var(--fg-color,#ddd);padding:6px 9px;font:inherit;font-size:12px;outline:none;scrollbar-width:none;-ms-overflow-style:none;}
.kd-edit textarea::-webkit-scrollbar,.kd-edit input::-webkit-scrollbar{display:none;}
.kd-edit textarea{min-height:70px;resize:vertical;}
.kd-edit input:focus,.kd-edit textarea:focus{border-color:var(--p-primary-color,#4a7dff);}
.kd-use-row{display:flex;flex-wrap:wrap;gap:8px;}
.kd-use-c{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--fg-color,#aaa);cursor:pointer;}
.kd-edit-acts{display:flex;align-items:center;gap:6px;}
@media (prefers-reduced-motion: reduce){
  .kd-plib,.kd-row,.kd-menu,.kd-pbox-btn,.kd-pbox-chip{transition:opacity .15s ease-out !important;transform:none !important;}
  .kd-plib{opacity:1;}
  .kd-row{opacity:1;}
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

// 全局词库缓存（一次拉全量，按用途在前端分桶——节点多也不重复请求）
let libCache = null;          // { items, dirs }
let libStamp = 0;
async function lib(force) {
  if (force || !libCache || Date.now() - libStamp > 30000) {
    libCache = await api("");
    libStamp = Date.now();
  }
  return libCache;
}
function libInvalidate() { libCache = null; }

// ───────── 词库 / 历史下拉列表（顶满浏览器上下，两种模式共用一套面板） ─────────
let libPanel = null;
let libOwner = null;   // 哪个节点打开的
let libMode = "lib";   // "lib" = 按用途筛词库，"hist" = 自动历史
const libState = { editId: null };

// 右键菜单（编辑 / 置顶 / 删除两步确认）
let menuEl = null;
function closeMenu() {
  if (!menuEl) return;
  const m = menuEl; menuEl = null;
  m.remove();
}
function openRowMenu(x, y, entry, onChanged) {
  closeMenu();
  menuEl = document.createElement("div");
  menuEl.className = "kd-menu";
  menuEl.innerHTML = `
    <button data-a="edit">✎ ${t("Edit")}</button>
    <button data-a="pin">${entry.pinned ? t("Unpin") : "★ " + t("Pin")}</button>
    <button data-a="del">🗑 ${t("Delete")}</button>`;
  menuEl.style.left = Math.min(x, window.innerWidth - 140) + "px";
  menuEl.style.top = Math.min(y, window.innerHeight - 130) + "px";
  document.body.appendChild(menuEl);
  void menuEl.offsetWidth;   // 强制回流提交初始态：rAF 在后台/节流标签页里可能永不触发，入场类不能挂在它上面
  menuEl.classList.add("kd-in");

  menuEl.querySelector("[data-a=edit]").onclick = () => {
    closeMenu();
    libState.editId = entry.id;
    if (libRepaint) libRepaint();
  };
  menuEl.querySelector("[data-a=pin]").onclick = async () => {
    closeMenu();
    try {
      const r = await api("/save", { id: entry.id, pinned: !entry.pinned });
      if (!r.ok) { toast(t("Save failed: {error}", { error: serverError(r.error) }), true); return; }
      toast(entry.pinned ? t("Unpinned") : t("Pinned"));
      onChanged();
    } catch (e) {
      toast(t("Save failed: {error}", { error: serverError(e.message) }), true);
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
    try {
      const r = await api("/delete", { id: entry.id });
      toast(r.ok ? t("Deleted (recoverable from .trash)") : t("Delete failed"), !r.ok);
      if (r.ok && libState.editId === entry.id) libState.editId = null;
      onChanged();
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

let libRepaint = null;   // paint() 的引用，供菜单触发重绘
let libRefresh = null;   // refresh() 的引用：节点上「存为预设」/自动历史写入后要立刻把面板拉新
let libTouchT = null;
function libTouch() {    // 一次出图会写好几条历史，合并成一次刷新
  libInvalidate();
  clearTimeout(libTouchT);
  libTouchT = setTimeout(() => {
    if (libRefresh) libRefresh();
    (app.graph && app.graph._nodes ? app.graph._nodes : []).forEach((n) => {
      if (n.__kdPbox && n.__kdPbox.paintChips) n.__kdPbox.paintChips();   // chips 里的「最近历史」也一起跟上
    });
  }, 300);
}

// 面板开着的时候让对应按钮亮住（mode 传 null 即熄灭）
function markPboxBtns(node, mode) {
  const pb = node && node.__kdPbox;
  if (!pb) return;
  [pb.libBtn, pb.histBtn].forEach((b) => { if (b) b.classList.remove("kd-on"); });
  const b = mode === "lib" ? pb.libBtn : mode === "hist" ? pb.histBtn : null;
  if (b) b.classList.add("kd-on");
}

function openLib(node, mode) {
  closeLib(true);
  libOwner = node;
  libMode = mode === "hist" ? "hist" : "lib";
  const hist = libMode === "hist";
  const pb = node.__kdPbox;
  if (!pb) return;
  const use = pb.useSel.value;

  libPanel = document.createElement("div");
  libPanel.className = "kd-plib";

  // 贴在节点旁边：节点在屏幕右半 → 面板放节点左侧；否则放右侧
  try {
    const r = node._kdCard && node._kdCard.getBoundingClientRect();
    const vw = window.innerWidth;
    if (r && r.right + 350 < vw) {
      libPanel.style.left = Math.min(r.right + 8, vw - 348) + "px";
    } else if (r && r.left > 356) {
      libPanel.style.left = Math.max(8, r.left - 348) + "px";
    } else {
      libPanel.style.left = Math.max(8, Math.min(vw - 348, (vw - 340) / 2)) + "px";
    }
  } catch (_) {
    libPanel.style.left = "50%";
    libPanel.style.transform = "translateX(-50%)";
  }

  libPanel.innerHTML = `
    <div class="kd-plib-head">
      <span class="kd-plib-title">${hist ? t("History") : t("Library")}</span>
      <span class="kd-plib-use">${esc(usageLabel(use))}</span>
      <button class="kd-plib-x" title="${t("Close")}">✕</button>
    </div>
    <input class="kd-plib-q" placeholder="${hist ? t("Search history…") : t("Search this usage…")}">
    <div class="kd-plib-list"></div>
    <div class="kd-plib-foot"><span>${t("Click to append · hover for more · right-click to edit/delete")}</span>
      <div class="kd-plib-loc"></div></div>`;

  document.body.appendChild(libPanel);
  void libPanel.offsetWidth;   // 同上：入场动画不依赖 rAF，后台标签页里也不会停在透明态
  libPanel.classList.add("kd-in");

  const listEl = libPanel.querySelector(".kd-plib-list");
  const qEl = libPanel.querySelector(".kd-plib-q");
  libPanel.querySelector(".kd-plib-x").onclick = () => closeLib();

  // ---- 库位置：显示后端实际在读哪个目录，并能就地改 ----
  const locEl = libPanel.querySelector(".kd-plib-loc");
  const SRC_LABEL = { env: "env var", config: "panel", setting: "settings file", default: "default" };
  let loc = { vault: "", source: "default", error: "" };
  let locEditing = false;
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
      await refresh();
      toast(v ? t("Library folder changed") : t("Back to the default folder"));
    };
    btns[0].onclick = commit;
    inp.onkeydown = (ev) => {
      ev.stopPropagation();                       // 别被节点的「输入即提示词」抢走
      if (ev.key === "Enter") commit();
      else if (ev.key === "Escape") showLoc();
    };
  }

  let all = [];
  async function refresh() {           // 重新拉全量再重绘（libInvalidate 只清缓存，必须重新 fetch 才有新数据）
    try {
      const d = await lib(true);
      all = d.items || [];
      loc = { vault: d.vault || "", source: d.vault_source || "default", error: d.error || "" };
      if (!locEditing) showLoc();
    } catch (_) { /* 保留旧数据重绘 */ }
    paint(qEl.value.trim());
    pb.paintChips();
  }
  function paint(q) {
    const ql = (q || "").toLowerCase();
    // 历史模式：同样按当前用途筛（记录时带的是当时的用途），只是不再要求 type=精选
    const pool = hist ? all.filter((e) => e.type === "历史") : all;
    const rows = pool.filter((e) =>
      e.use_for.indexOf(use) !== -1 &&
      (!ql || e.name.toLowerCase().indexOf(ql) !== -1 || (e.positive || "").toLowerCase().indexOf(ql) !== -1));
    // 空状态分两种：这一类本来就空（引导 + 显示在读哪个目录），还是只是被筛选条件筛干了
    const bare = pool.length === 0;
    listEl.innerHTML = rows.length ? rows.map((e) => `
      <div class="kd-row" data-id="${esc(e.id)}">
        <div class="kd-row-name">${e.pinned ? "★ " : ""}${esc(e.name)}<span class="kd-badge">${esc(hist ? (e.updated || t("History")) : typeLabel(e.type))} · ${t("{n} uses", { n: e.uses })}</span></div>
        <div class="kd-row-prev">${esc((e.positive || e.negative || "").slice(0, 40)) || t("(Body is in the Negative field)")}</div>
      </div>`).join("") : `<div class="kd-plib-empty">${bare
        ? t(hist ? "No history for this usage yet — prompts you run land here automatically" : 'No prompts here yet — write one and hit "Save as preset"')
        : t("Nothing matches this filter")}${bare ? `<div class="kd-plib-empty-where">${esc(loc.error || loc.vault)}</div>` : ""}</div>`;
    listEl.querySelectorAll(".kd-row").forEach((row, i) => {
      const e = rows[i];
      row.title = (e.positive || e.negative || "").slice(0, 400);
      row.onclick = () => {
        if (libState.editId === e.id) return;   // 编辑态不触发追加
        const add = e.positive || e.negative || "";
        if (!add) return;
        const cur = pb.ta.value.trim();
        pb.ta.value = cur ? cur + ", " + add : add;
        pb.sync();
        api("/use", { id: e.id }).catch(() => { /* 静默 */ });
        e.uses += 1;
        toast(t("Appended \"{name}\"", { name: e.name }));
      };
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openRowMenu(ev.clientX, ev.clientY, e, refresh);
      };
      if (libState.editId === e.id) renderRowEdit(row, e, refresh);
      const rm = reducedMotion();
      setTimeout(() => row.classList.add("kd-show"), rm ? 0 : 40 + Math.min(i, 10) * 30);
    });
  }

  lib().then((d) => {
    all = d.items || [];
    loc = { vault: d.vault || "", source: d.vault_source || "default", error: d.error || "" };
    showLoc();
    paint("");
  }).catch((e) => {
    locEl.innerHTML = `<span class="kd-plib-vault kd-bad">${esc(serverError(e.message))}</span>`;
    listEl.innerHTML = `<div class="kd-plib-empty">${t("Library failed to load: {error}", { error: esc(serverError(e.message)) })}</div>`;
  });
  libRepaint = () => paint(qEl.value.trim());
  libRefresh = refresh;
  markPboxBtns(node, libMode);

  let qt = null;
  qEl.oninput = () => { clearTimeout(qt); qt = setTimeout(() => paint(qEl.value.trim()), 200); };
  qEl.focus();
}

function closeLib(instant) {
  if (!libPanel) return;
  const root = libPanel;
  markPboxBtns(libOwner, null);
  libPanel = null; libOwner = null; libMode = "lib";
  libState.editId = null; libRepaint = null; libRefresh = null;
  closeMenu();
  if (instant || reducedMotion()) { root.remove(); return; }
  root.classList.remove("kd-in");
  root.classList.add("kd-out");
  setTimeout(() => root.remove(), 200);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && libPanel) closeLib();
});

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
  };
  useSel.onpointerdown = (e) => e.stopPropagation();

  const libBtn = document.createElement("button");
  libBtn.type = "button"; libBtn.className = "kd-pbox-btn kd-accent"; libBtn.textContent = t("Library");
  libBtn.title = t("Open the library list for this usage");
  const histBtn = document.createElement("button");
  histBtn.type = "button"; histBtn.className = "kd-pbox-btn kd-accent"; histBtn.textContent = t("History");
  histBtn.title = t("Open the history list for this usage");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button"; saveBtn.className = "kd-pbox-btn"; saveBtn.textContent = t("Save as preset");
  const clearBtn = document.createElement("button");
  clearBtn.type = "button"; clearBtn.className = "kd-pbox-btn"; clearBtn.textContent = t("Clear");
  clearBtn.style.marginLeft = "auto";   // 组整体靠右：清除 → 存为预设 → 词库 → 历史(最右)
  top.append(lab, useSel, clearBtn, saveBtn, libBtn, histBtn);

  const ta = document.createElement("textarea");
  ta.className = "kd-pbox-ta";
  ta.placeholder = t('Enter a prompt… ("Library" to append / "Save as preset" to store under the current usage)');
  ta.value = String(pw.value || "");

  function sync() {
    pw.value = ta.value;
    try { node.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }
  }
  ta.addEventListener("input", sync);
  ta.addEventListener("pointerdown", (e) => e.stopPropagation());
  ta.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  card.append(top, ta);

  // 快捷 chips：当前用途的 置顶★ + 最近历史
  const chips = document.createElement("div");
  chips.className = "kd-pbox-chips";
  card.append(chips);

  async function paintChips() {
    try {
      const d = await lib();
      const use = useSel.value;
      const items = (d.items || []).filter((e) => (e.use_for || []).indexOf(use) !== -1);
      const pinned = items.filter((e) => e.pinned).slice(0, 8);
      const recent = items.filter((e) => e.type === "历史").slice(0, 6);
      chips.innerHTML = "";
      const pool = pinned.concat(recent);
      if (!pool.length) {
        const s = document.createElement("span");
        s.className = "kd-pbox-chip"; s.style.opacity = ".5"; s.style.cursor = "default";
        s.textContent = t('Pinned and history items for "{usage}" will appear here', { usage: usageLabel(use) });
        chips.appendChild(s);
        return;
      }
      pool.forEach((e) => {
        const c = document.createElement("button");
        c.type = "button";
        c.className = "kd-pbox-chip" + (e.pinned ? " kd-pin" : "");
        c.title = (e.positive || e.negative || "").slice(0, 300);
        c.innerHTML = esc(e.name) + `<span class="kd-uses">${e.uses}</span>`;
        c.onclick = (ev) => {
          ev.stopPropagation();
          const add = e.positive || e.negative || "";
          if (!add) return;
          const cur = ta.value.trim();
          ta.value = cur ? cur + ", " + add : add;
          sync();
          api("/use", { id: e.id }).catch(() => { /* 静默 */ });
          toast(t("Appended \"{name}\"", { name: e.name }));
        };
        chips.appendChild(c);
      });
    } catch (_) { /* 静默 */ }
  }

  // 同一个面板两种内容：再点一次当前开着的那个就关，点另一个直接切过去
  function togglePanel(mode) {
    if (libOwner === node && libPanel && libMode === mode) { closeLib(); return; }
    openLib(node, mode);
  }
  libBtn.onclick = () => togglePanel("lib");
  histBtn.onclick = () => togglePanel("hist");
  saveBtn.onclick = async () => {
    const text = ta.value.trim();
    if (!text) { toast(t("The input box is empty"), true); return; }
    const r = await api("/save", { name: text.slice(0, 20), type: "精选", positive: text, usage: [useSel.value] });
    toast(r.ok ? (r.deduped ? t("Already in the library") : t("Saved as preset ({usage})", { usage: usageLabel(useSel.value) })) : t("Save failed"), !r.ok);
    if (r.ok) libTouch();
  };
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
      useSel.value = String((uw && uw.value) || USAGES[0]);
      paintChips();
    }, 0);
    return r;
  };

  node.__kdPbox = { ta, sync, pw, useSel, paintChips, libBtn, histBtn };
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
// 结论：节点侧的自动历史一条都没写过，00_History 里那批全是 PS 面板那边存进去的。
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

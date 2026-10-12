// 蝌蚪提示词库（轻量版 v4）—— 词库完全集成在「蝌蚪提示词输入框」节点上
// 后端：ComfyUI_KeDou/promptlib.py（GET /ps/prompts?use=…, POST save|delete|use|history）
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

const API = "/ps/prompts";
const PBOX_CLASS = "KedouPromptBox";
const USAGES = ["文生图", "图像编辑", "文生视频", "图生视频", "参考生视频"];

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
  font:inherit;font-size:11px;padding:4px 10px;border-radius:7px;cursor:pointer;margin-left:auto;
  transition:border-color .15s,color .15s,transform .12s;}
.kd-pbox-btn:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}
.kd-pbox-btn:active{transform:scale(.96);}
.kd-pbox-btn.kd-main{background:var(--p-primary-color,#4a7dff);border-color:var(--p-primary-color,#4a7dff);color:#fff;margin-left:0;}
.kd-pbox-btn.kd-main:hover{opacity:.88;color:#fff;}
.kd-pbox-ta{flex:1;min-height:110px;resize:none;background:var(--content-bg,#16161c);border:1px solid var(--interface-stroke,#3a3a44);
  border-radius:10px;color:var(--fg-color,#ddd);padding:9px 11px;font:inherit;font-size:13px;line-height:1.55;outline:none;
  width:100%;box-sizing:border-box;}
.kd-pbox-ta:focus{border-color:var(--p-primary-color,#4a7dff);}
.kd-pbox-chips{display:flex;flex-wrap:wrap;gap:5px;max-height:96px;overflow-y:auto;}
.kd-pbox-chip{border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#aaa);
  font:inherit;font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;max-width:150px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:border-color .15s,color .15s;}
.kd-pbox-chip:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}
.kd-pbox-chip.kd-pin{border-color:var(--p-primary-color,#4a7dff88);color:var(--fg-color,#ddd);}
.kd-pbox-chip .kd-uses{opacity:.55;margin-left:4px;}
/* ── 词库下拉列表（顶满浏览器上下） ── */
.kd-lib{position:fixed;top:0;bottom:0;z-index:99993;width:340px;display:flex;flex-direction:column;
  background:var(--interface-panel-surface,#232329);color:var(--fg-color,#ddd);
  border:1px solid var(--interface-stroke,#3a3a44);box-shadow:0 10px 40px rgba(0,0,0,.35);
  font:12.5px/1.5 system-ui,sans-serif;opacity:0;transform:translateY(8px);
  transition:opacity .22s ease-out,transform .26s cubic-bezier(.34,1.2,.64,1);}
.kd-lib.kd-in{opacity:1;transform:translateY(0);}
.kd-lib.kd-out{opacity:0;transform:translateY(8px);transition:opacity .16s ease-in,transform .16s ease-in;}
.kd-lib-head{display:flex;align-items:center;gap:8px;padding:12px 12px 8px;}
.kd-lib-title{font-size:13.5px;font-weight:600;flex:1;}
.kd-lib-use{font-size:11px;color:var(--p-primary-color,#6a9bff);border:1px solid var(--p-primary-color,#4a7dff66);
  border-radius:999px;padding:2px 9px;}
.kd-lib-x{border:none;background:none;color:var(--fg-color,#999);font-size:17px;cursor:pointer;padding:2px 7px;}
.kd-lib-x:hover{color:var(--error-text,#ffb3b3);}
.kd-lib-q{margin:0 12px 8px;background:var(--content-bg,#16161c);border:1px solid var(--interface-stroke,#3a3a44);
  border-radius:9px;color:var(--fg-color,#ccc);padding:7px 11px;font:inherit;font-size:12.5px;outline:none;}
.kd-lib-q:focus{border-color:var(--p-primary-color,#4a7dff);}
.kd-lib-list{flex:1;overflow-y:auto;padding:0 12px 12px;display:flex;flex-direction:column;gap:5px;}
.kd-row{border:1px solid var(--interface-stroke,#3a3a44);border-radius:9px;padding:7px 10px;cursor:pointer;
  opacity:0;transform:translateY(6px);transition:opacity .16s ease-out,transform .2s cubic-bezier(.34,1.3,.64,1),border-color .15s,background .15s;}
.kd-row.kd-show{opacity:1;transform:translateY(0);}
.kd-row:hover{border-color:var(--p-primary-color,#4a7dff);background:var(--content-bg,#16161c);}
.kd-row-name{font-size:12.5px;font-weight:600;color:var(--fg-color,#e0e0e0);display:flex;align-items:baseline;gap:6px;}
.kd-row-name .kd-badge{font-size:10px;font-weight:400;color:var(--fg-color,#888);border:1px solid var(--interface-stroke,#3a3a44);border-radius:5px;padding:0 5px;margin-left:auto;}
.kd-row-prev{font-size:11.5px;color:var(--fg-color,#9a9a9a);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.kd-row:hover .kd-row-prev{white-space:normal;overflow:visible;}
.kd-lib-empty{padding:22px 0;text-align:center;color:var(--fg-color,#777);font-size:12.5px;}
.kd-lib-foot{display:flex;gap:6px;align-items:center;padding:9px 12px;border-top:1px solid var(--interface-stroke,#3a3a44);font-size:11px;color:var(--fg-color,#888);}
.kd-lib-foot .kd-pbox-btn{margin-left:0;}
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
.kd-edit input,.kd-edit textarea{background:var(--content-bg,#16161c);border:1px solid var(--interface-stroke,#3a3a44);border-radius:8px;color:var(--fg-color,#ddd);padding:6px 9px;font:inherit;font-size:12px;outline:none;}
.kd-edit textarea{min-height:70px;resize:vertical;}
.kd-edit input:focus,.kd-edit textarea:focus{border-color:var(--p-primary-color,#4a7dff);}
.kd-use-row{display:flex;flex-wrap:wrap;gap:8px;}
.kd-use-c{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--fg-color,#aaa);cursor:pointer;}
.kd-edit-acts{display:flex;align-items:center;gap:6px;}
@media (prefers-reduced-motion: reduce){
  .kd-lib,.kd-row,.kd-menu,.kd-pbox-btn,.kd-pbox-chip{transition:opacity .15s ease-out !important;transform:none !important;}
  .kd-lib{opacity:1;}
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
  if (!r.ok) throw new Error("HTTP " + r.status);
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

// ───────── 词库下拉列表（顶满浏览器上下） ─────────
let libPanel = null;
let libOwner = null;   // 哪个节点打开的
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
    <button data-a="edit">✎ 编辑</button>
    <button data-a="pin">${entry.pinned ? "取消置顶" : "★ 置顶"}</button>
    <button data-a="del">🗑 删除</button>`;
  menuEl.style.left = Math.min(x, window.innerWidth - 140) + "px";
  menuEl.style.top = Math.min(y, window.innerHeight - 130) + "px";
  document.body.appendChild(menuEl);
  requestAnimationFrame(() => menuEl.classList.add("kd-in"));

  menuEl.querySelector("[data-a=edit]").onclick = () => {
    closeMenu();
    libState.editId = entry.id;
    if (libRepaint) libRepaint();
  };
  menuEl.querySelector("[data-a=pin]").onclick = async () => {
    closeMenu();
    await api("/save", { id: entry.id, pinned: !entry.pinned });
    toast(entry.pinned ? "已取消置顶" : "已置顶");
    onChanged();
  };
  const delBtn = menuEl.querySelector("[data-a=del]");
  delBtn.onclick = async () => {
    if (!delBtn.classList.contains("kd-armed")) {
      delBtn.classList.add("kd-armed");
      delBtn.textContent = "确认删除?";
      return;
    }
    closeMenu();
    const r = await api("/delete", { id: entry.id });
    toast(r.ok ? "已删除（进 .trash 可捞回）" : "删除失败", !r.ok);
    onChanged();
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
    <input data-f="name" value="${esc(entry.name)}" placeholder="短名">
    <textarea data-f="positive" placeholder="提示词正文">${esc(entry.positive)}</textarea>
    <textarea data-f="negative" placeholder="负面词（可选）" style="min-height:44px">${esc(entry.negative)}</textarea>
    <div class="kd-use-row">${USAGES.map((u) => `<label class="kd-use-c"><input type="checkbox" data-u="${esc(u)}" ${(entry.use_for || []).indexOf(u) !== -1 ? "checked" : ""}>${esc(u)}</label>`).join("")}</div>
    <div class="kd-edit-acts">
      <button class="kd-pbox-btn kd-main" data-a="save">保存</button>
      <button class="kd-pbox-btn" data-a="cancel">取消</button>
    </div>`;
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  box.addEventListener("click", (e) => e.stopPropagation());
  box.querySelector("[data-a=cancel]").onclick = () => { libState.editId = null; onSaved(); };
  box.querySelector("[data-a=save]").onclick = async () => {
    const g = (f) => box.querySelector(`[data-f=${f}]`);
    const usage = USAGES.filter((u) => box.querySelector(`[data-u="${u}"]`).checked);
    if (!usage.length) { toast("至少勾一个用途", true); return; }
    const body = {
      id: entry.id,
      name: g("name").value.trim(),
      positive: g("positive").value,
      negative: g("negative").value,
      usage,
    };
    if (!body.name) { toast("短名不能为空", true); return; }
    if (!body.positive.trim() && !body.negative.trim()) { toast("正文和负面词不能都空", true); return; }
    const r = await api("/save", body);
    toast(r.ok ? "已保存" : "保存失败：" + (r.error || ""), !r.ok);
    if (r.ok) onSaved();
  };
  row.appendChild(box);
  box.querySelector("[data-f=name]").focus();
}

let libRepaint = null;   // paint() 的引用，供菜单触发重绘

function openLib(node) {
  closeLib(true);
  libOwner = node;
  const pb = node.__kdPbox;
  if (!pb) return;
  const use = pb.useSel.value;

  libPanel = document.createElement("div");
  libPanel.className = "kd-lib";

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
    <div class="kd-lib-head">
      <span class="kd-lib-title">词库</span>
      <span class="kd-lib-use">${esc(use)}</span>
      <button class="kd-lib-x" title="关闭">✕</button>
    </div>
    <input class="kd-lib-q" placeholder="搜索本用途下的词…">
    <div class="kd-lib-list"></div>
    <div class="kd-lib-foot"><span>点击追加 · 悬停看更多 · 右键编辑/删除</span></div>`;

  document.body.appendChild(libPanel);
  requestAnimationFrame(() => libPanel.classList.add("kd-in"));

  const listEl = libPanel.querySelector(".kd-lib-list");
  const qEl = libPanel.querySelector(".kd-lib-q");
  libPanel.querySelector(".kd-lib-x").onclick = () => closeLib();

  let all = [];
  async function refresh() {           // 重新拉全量再重绘（libInvalidate 只清缓存，必须重新 fetch 才有新数据）
    try {
      const d = await lib(true);
      all = d.items || [];
    } catch (_) { /* 保留旧数据重绘 */ }
    paint(qEl.value.trim());
    pb.paintChips();
  }
  function paint(q) {
    const ql = (q || "").toLowerCase();
    const rows = all.filter((e) =>
      e.use_for.indexOf(use) !== -1 &&
      (!ql || e.name.toLowerCase().indexOf(ql) !== -1 || (e.positive || "").toLowerCase().indexOf(ql) !== -1));
    listEl.innerHTML = rows.length ? rows.map((e) => `
      <div class="kd-row" data-id="${esc(e.id)}">
        <div class="kd-row-name">${e.pinned ? "★ " : ""}${esc(e.name)}<span class="kd-badge">${esc(e.type)} · ${e.uses}次</span></div>
        <div class="kd-row-prev">${esc((e.positive || e.negative || "").slice(0, 40)) || "（正文在 Negative 段）"}</div>
      </div>`).join("") : `<div class="kd-lib-empty">这个用途下没有词——写一条然后「存为预设」</div>`;
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
        toast("已追加「" + e.name + "」");
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

  lib().then((d) => { all = d.items || []; paint(""); }).catch((e) => {
    listEl.innerHTML = `<div class="kd-lib-empty">词库加载失败：${esc(e.message)}</div>`;
  });
  libRepaint = () => paint(qEl.value.trim());

  let qt = null;
  qEl.oninput = () => { clearTimeout(qt); qt = setTimeout(() => paint(qEl.value.trim()), 200); };
  qEl.focus();
}

function closeLib(instant) {
  if (!libPanel) return;
  const root = libPanel;
  libPanel = null; libOwner = null;
  libState.editId = null; libRepaint = null;
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
  lab.textContent = "用途";
  const useSel = document.createElement("select");
  useSel.className = "kd-pbox-use";
  USAGES.forEach((u) => {
    const o = document.createElement("option");
    o.value = u; o.textContent = u;
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
  libBtn.type = "button"; libBtn.className = "kd-pbox-btn kd-main"; libBtn.textContent = "词库";
  libBtn.title = "打开本用途的词库下拉列表";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button"; saveBtn.className = "kd-pbox-btn"; saveBtn.textContent = "存为预设";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button"; clearBtn.className = "kd-pbox-btn"; clearBtn.textContent = "清除";
  clearBtn.style.marginLeft = "auto";   // 组整体靠右：清除 → 存为预设 → 词库(最右)
  top.append(lab, useSel, clearBtn, saveBtn, libBtn);

  const ta = document.createElement("textarea");
  ta.className = "kd-pbox-ta";
  ta.placeholder = "输入提示词…（「词库」追加 / 「存为预设」按当前用途存走）";
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
        s.textContent = "「" + use + "」的置顶/历史会出现在这里";
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
          toast("已追加「" + e.name + "」");
        };
        chips.appendChild(c);
      });
    } catch (_) { /* 静默 */ }
  }

  libBtn.onclick = () => (libOwner === node && libPanel ? closeLib() : openLib(node));
  saveBtn.onclick = async () => {
    const text = ta.value.trim();
    if (!text) { toast("输入框是空的", true); return; }
    const r = await api("/save", { name: text.slice(0, 20), type: "精选", positive: text, usage: [useSel.value] });
    toast(r.ok ? (r.deduped ? "库里已有相同内容" : "已存为预设（" + useSel.value + "）") : "保存失败", !r.ok);
    if (r.ok) { libInvalidate(); paintChips(); }
  };
  let clearArmed = 0;
  clearBtn.onclick = () => {
    if (!ta.value) return;
    if (Date.now() - clearArmed < 2500 && clearBtn.textContent.indexOf("确认") !== -1) {
      ta.value = ""; sync(); clearArmed = 0; clearBtn.textContent = "清除"; clearBtn.style.color = "";
    } else {
      clearArmed = Date.now();
      clearBtn.textContent = "确认清空?"; clearBtn.style.color = "var(--error-text,#ff6b6b)";
      setTimeout(() => {
        if (Date.now() - clearArmed >= 2500) { clearBtn.textContent = "清除"; clearBtn.style.color = ""; }
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

  node.__kdPbox = { ta, sync, pw, useSel, paintChips };
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

// ───────── 自动历史：executed 事件（带用途） ─────────
function hookHistory(apiObj) {
  const orig = apiObj.executed;
  apiObj.executed = (detail, full) => {
    try {
      if (localStorage.getItem("kedou_plib_hist") === "0") return orig && orig(detail, full);
      const g = app.graph.serialize().nodes;
      const seen = new Set();
      for (const n of g) {
        if (!n.widgets_values) continue;
        const node = app.graph.getNodeById(n.id);
        if (!node || !node.widgets) continue;
        const isPbox = (n.type === PBOX_CLASS);
        const usage = isPbox ? String(n.widgets_values[1] || "文生图") : "文生图";
        node.widgets.forEach((w, i) => {
          const v = n.widgets_values[i];
          if ((w.type === "textarea" || w.type === "string") && typeof v === "string" && v.trim().length >= 4) {
            const key = v.trim();
            if (seen.has(key)) return;
            seen.add(key);
            fetch(API + "/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ positive: key, usage }) })
              .catch(() => { /* 静默 */ });
          }
        });
      }
    } catch (_) { /* 静默：历史失败不影响出图 */ }
    return orig && orig(detail, full);
  };
}

// ───────── 挂载 ─────────
app.registerExtension({
  name: "kedou.promptlib",
  setup() {
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
  registerApiHandlers(apiObj) {
    try { hookHistory(apiObj); } catch (e) { console.error("[kedou] 历史 hook 失败", e); }
  },
});

window.__kedouLibInvalidate = () => { libInvalidate(); refreshAllPbox(); };

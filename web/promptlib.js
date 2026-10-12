// 蝌蚪提示词库（轻量版）前端 —— 右下角「词库」pill + 非模态右侧抽屉
// 后端：ComfyUI_KeDou/promptlib.py（GET /ps/prompts, POST /ps/prompts/save|delete|use|history）
// 交互原则（用户 2026-10-12 反馈"跷跷板"后定）：词库绝不盖画布、绝不抢节点选择——
//   抽屉贴右侧，画布照常点选；打开时快照选中节点作兜底目标；填入后把目标节点重新选中。
// 动效（ui-motion-design）：只动 transform/opacity；入场 spring ~300ms，离场 accelerate ~180ms；
//   stagger 只给首屏前 8 张；prefers-reduced-motion 只留 fade；颜色全走 ComfyUI 主题令牌 + 兜底。
import { app } from "../../scripts/app.js";

const API = "/ps/prompts";

// ───────── 样式 ─────────
const CSS = `
.kpl-pill{position:fixed;right:18px;bottom:64px;z-index:99991;padding:10px 16px;border:1px solid var(--interface-stroke,#3a3a44);border-radius:999px;
  background:var(--comfy-menu-bg,#232329);color:var(--descrip-text,#bbb);font-size:13px;cursor:pointer;
  transition:transform .28s cubic-bezier(.34,1.2,.64,1),border-color .15s,color .15s;}
.kpl-pill:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}
.kpl-pill.kpl-shift{transform:translateX(calc(-1 * min(430px, 94vw) - 18px));}
.kpl-pill.kpl-on{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}
.kpl-dock{position:fixed;top:0;right:0;bottom:0;z-index:99992;width:min(430px,94vw);display:flex;flex-direction:column;
  background:var(--comfy-menu-bg,#232329);border-left:1px solid var(--interface-stroke,#3a3a44);
  box-shadow:-12px 0 32px rgba(0,0,0,.28);
  transform:translateX(105%);transition:transform .3s cubic-bezier(.34,1.2,.64,1);}
.kpl-dock.kpl-in{transform:translateX(0);}
.kpl-dock.kpl-out{transform:translateX(105%);transition:transform .18s ease-in;}
.kpl-head{display:flex;align-items:center;gap:10px;padding:14px 14px 8px;}
.kpl-title{font-size:15px;font-weight:600;color:var(--descrip-text,#ddd);flex:1;}
.kpl-x{border:none;background:none;color:var(--descrip-text,#999);font-size:18px;cursor:pointer;padding:2px 8px;border-radius:8px;}
.kpl-x:hover{color:var(--error-text,#ffb3b3);}
.kpl-target{display:flex;align-items:center;gap:8px;padding:0 14px 8px;font-size:11.5px;color:var(--descrip-text,#888);}
.kpl-target b{color:var(--p-primary-color,#6a9bff);font-weight:600;}
.kpl-target .kpl-btn{padding:2px 9px;font-size:11px;}
.kpl-search{display:flex;gap:8px;padding:0 14px 10px;}
.kpl-q{flex:1;background:var(--comfy-input-bg,#16161c);border:1px solid var(--border-color,#3a3a44);border-radius:10px;
  color:var(--descrip-text,#ccc);padding:8px 12px;font-size:13px;outline:none;}
.kpl-q:focus{border-color:var(--p-primary-color,#4a7dff);}
.kpl-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px;}
.kpl-chip{padding:5px 12px;border-radius:999px;border:1px solid var(--border-color,#3a3a44);background:none;
  color:var(--descrip-text,#999);font-size:12px;cursor:pointer;transition:border-color .15s,color .15s;}
.kpl-chip:hover{color:var(--descrip-text,#ddd);}
.kpl-chip.kpl-on{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}
.kpl-list{flex:1;overflow-y:auto;padding:0 14px;display:flex;flex-direction:column;gap:8px;}
.kpl-card{border:1px solid var(--border-color,#3a3a44);border-radius:12px;padding:10px 12px;
  background:var(--comfy-input-bg,#1b1b22);opacity:0;transform:translateY(8px);
  transition:transform .22s cubic-bezier(.34,1.4,.64,1),opacity .18s ease-out,border-color .15s;}
.kpl-card.kpl-show{opacity:1;transform:translateY(0);}
.kpl-card:hover{border-color:var(--interface-stroke,#4a4a55);}
.kpl-card.kpl-pinned{border-color:var(--p-primary-color,#4a7dff44);}
.kpl-row1{display:flex;align-items:baseline;gap:8px;}
.kpl-name{font-size:13.5px;font-weight:600;color:var(--descrip-text,#e0e0e0);flex:1;}
.kpl-badge{font-size:11px;color:var(--descrip-text,#888);border:1px solid var(--border-color,#3a3a44);border-radius:6px;padding:1px 7px;}
.kpl-pri{font-size:11px;color:var(--descrip-text,#777);}
.kpl-text{font-size:12.5px;color:var(--descrip-text,#9a9a9a);margin:6px 0 8px;line-height:1.5;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
.kpl-meta{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-bottom:8px;}
.kpl-tag{font-size:11px;color:var(--p-primary-color,#6a9bff);opacity:.85;}
.kpl-uses{font-size:11px;color:var(--descrip-text,#666);margin-left:auto;}
.kpl-acts{display:flex;gap:6px;flex-wrap:wrap;}
.kpl-btn{padding:5px 12px;border-radius:9px;border:1px solid var(--border-color,#3a3a44);background:none;
  color:var(--descrip-text,#bbb);font-size:12px;cursor:pointer;transition:border-color .15s,color .15s,transform .12s;}
.kpl-btn:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}
.kpl-btn:active{transform:scale(.96);}
.kpl-btn.kpl-main{background:var(--p-primary-color,#4a7dff);border-color:var(--p-primary-color,#4a7dff);color:#fff;}
.kpl-btn.kpl-main:hover{opacity:.88;color:#fff;}
.kpl-btn.kpl-danger:hover{border-color:var(--error-text,#a33);color:var(--error-text,#ffb3b3);}
.kpl-btn.kpl-danger.kpl-armed{background:var(--error-text,#a33);border-color:var(--error-text,#a33);color:#fff;}
.kpl-edit{display:flex;flex-direction:column;gap:8px;margin-top:10px;}
.kpl-edit textarea,.kpl-edit input,.kpl-edit select{background:var(--comfy-input-bg,#16161c);border:1px solid var(--border-color,#3a3a44);
  border-radius:9px;color:var(--descrip-text,#ccc);padding:7px 10px;font-size:12.5px;outline:none;font-family:inherit;}
.kpl-edit textarea:focus,.kpl-edit input:focus{border-color:var(--p-primary-color,#4a7dff);}
.kpl-edit textarea{min-height:90px;resize:vertical;}
.kpl-editrow{display:flex;gap:8px;flex-wrap:wrap;}
.kpl-editrow > *{flex:1;min-width:110px;}
.kpl-foot{display:flex;gap:8px;align-items:center;padding:12px 14px;border-top:1px solid var(--border-color,#3a3a44);}
.kpl-foot input{flex:1;min-width:0;background:var(--comfy-input-bg,#16161c);border:1px solid var(--border-color,#3a3a44);border-radius:9px;
  color:var(--descrip-text,#ccc);padding:7px 10px;font-size:12.5px;outline:none;}
.kpl-foot input:focus{border-color:var(--p-primary-color,#4a7dff);}
.kpl-empty{padding:26px 0;text-align:center;color:var(--descrip-text,#777);font-size:13px;}
.kpl-hist{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--descrip-text,#888);cursor:pointer;user-select:none;white-space:nowrap;}
.kpl-hist input{width:auto;margin:0;}
@media (prefers-reduced-motion: reduce){
  .kpl-dock,.kpl-card,.kpl-pill,.kpl-btn{transition:opacity .15s ease-out !important;transform:none !important;}
  .kpl-dock{transform:translateX(0) !important;}
  .kpl-card{opacity:1;}
}
`;

// ───────── 小工具 ─────────
let toastEl = null;
function toast(msg, isErr) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "kp-toast";
    toastEl.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(12px);z-index:99999;padding:9px 16px;border-radius:10px;border:1px solid var(--interface-stroke,#3a3a44);background:var(--comfy-menu-bg,#232329);color:var(--descrip-text,#ccc);font-size:13px;opacity:0;transition:opacity .2s,transform .2s;";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.borderColor = isErr ? "var(--error-text,#a33)" : "var(--interface-stroke,#3a3a44)";
  toastEl.style.color = isErr ? "var(--error-text,#ffb3b3)" : "var(--descrip-text,#ccc)";
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

// ───────── 目标节点（跷跷板保险层） ─────────
// 优先：当前选中的带文本控件节点 → 打开词库时的快照节点 → 画布第一个 CLIPTextEncode
let openSnap = null;   // 打开抽屉瞬间的选中 widget 快照
let targetTimer = null;

function pickTextWidget(node) {
  if (!node || !node.widgets) return null;
  for (const w of node.widgets) {
    if (w.type === "textarea" || w.type === "string") {
      if (w.name === "text" || w.name === "prompt" || /prompt|text|提示/i.test(w.name)) return w;
    }
  }
  for (const w of node.widgets) {
    if (w.type === "textarea" || w.type === "string") return w;
  }
  return null;
}

function currentSelectionWidget() {
  try {
    const sel = app.canvas && app.canvas.selected_nodes;
    if (sel) {
      for (const id in sel) {
        const w = pickTextWidget(sel[id]);
        if (w) return w;
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

function firstClipWidget() {
  try {
    for (const n of app.graph._nodes) {
      if (n.type === "CLIPTextEncode") {
        const w = pickTextWidget(n);
        if (w) return w;
      }
    }
  } catch (_) { /* ignore */ }
  return null;
}

function targetWidget() {
  return currentSelectionWidget() || openSnap || firstClipWidget();
}

function setWidget(w, value) {
  w.value = value;
  try { w.callback && w.callback(value); } catch (_) { /* ignore */ }
  try { app.graph.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }
  // 填入后把目标节点重新选中——用户接着就能在原位继续手改
  try { if (w.node) app.canvas.selectNode(w.node, false); } catch (_) { /* ignore */ }
}

function targetLabel() {
  const w = targetWidget();
  if (!w || !w.node) return "目标：<b>无</b>（画布里没有带文本框的节点）";
  const sel = currentSelectionWidget();
  const tag = sel ? "已选中" : (openSnap === w ? "记住的" : "自动");
  return `目标：<b>${esc(w.node.title || w.node.type)} #${w.node.id}</b>（${tag}）`;
}

// ───────── 抽屉状态 ─────────
const state = { data: null, type: "", dir: "", q: "", openId: null, armed: null };
let dock = null;

async function loadList() {
  const qs = [];
  if (state.type) qs.push("type=" + encodeURIComponent(state.type));
  if (state.dir) qs.push("dir=" + encodeURIComponent(state.dir));
  if (state.q) qs.push("q=" + encodeURIComponent(state.q));
  state.data = await api(qs.length ? "/?" + qs.join("&") : "");
}

function renderDock(root) {
  const d = state.data || { items: [], dirs: [], types: [] };
  const histOn = localStorage.getItem("kedou_plib_hist") !== "0";

  const chips = [];
  chips.push({ label: "全部", on: !state.type && !state.dir, act: () => { state.type = ""; state.dir = ""; } });
  for (const t of d.types) chips.push({ label: t, on: state.type === t, act: () => { state.type = (state.type === t ? "" : t); state.dir = ""; } });
  chips.push({ label: "历史", on: state.type === "历史", act: () => { state.type = (state.type === "历史" ? "" : "历史"); state.dir = ""; } });
  for (const dd of d.dirs) chips.push({ label: dd, on: state.dir === dd, act: () => { state.dir = (state.dir === dd ? "" : dd); state.type = ""; } });

  root.innerHTML = `
    <div class="kpl-head"><div class="kpl-title">词库 <span style="font-size:11px;color:var(--descrip-text,#777)">${d.count || 0} 条</span></div>
      <button class="kpl-x" data-a="close" title="关闭">✕</button></div>
    <div class="kpl-target">${targetLabel()}<button class="kpl-btn" data-a="pick" title="在画布上选中并定位目标节点">定位</button></div>
    <div class="kpl-search"><input class="kpl-q" placeholder="搜索名称 / 标签 / 正文…" value="${esc(state.q)}"></div>
    <div class="kpl-chips">${chips.map((c, i) => `<button class="kpl-chip${c.on ? " kpl-on" : ""}" data-c="${i}">${esc(c.label)}</button>`).join("")}</div>
    <div class="kpl-list">${d.items.length ? d.items.map(cardHtml).join("") : `<div class="kpl-empty">${state.q || state.type || state.dir ? "没有匹配的条目" : "词库是空的——跑一次图或从下方存第一条"}</div>`}</div>
    <div class="kpl-foot">
      <input class="kpl-save-name" placeholder="存当前提示词：短名">
      <button class="kpl-btn kpl-main" data-a="savecur">保存</button>
      <label class="kpl-hist" title="运行一次自动存一条历史（去重，50 条封顶）"><input type="checkbox" data-a="hist" ${histOn ? "checked" : ""}>自动历史</label>
    </div>`;

  root.querySelector(".kpl-x").onclick = closeDock;
  const qEl = root.querySelector(".kpl-q");
  let qt = null;
  qEl.oninput = () => { clearTimeout(qt); qt = setTimeout(async () => { state.q = qEl.value.trim(); await loadList(); renderDock(root); }, 250); };
  root.querySelectorAll(".kpl-chip").forEach((el) => {
    el.onclick = () => { chips[+el.dataset.c].act(); state.openId = null; loadList().then(() => renderDock(root)); };
  });
  root.querySelector("[data-a=savecur]").onclick = () => saveCurrent(root);
  root.querySelector("[data-a=pick]").onclick = locateTarget;
  const histEl = root.querySelector("[data-a=hist]");
  histEl.onchange = () => localStorage.setItem("kedou_plib_hist", histEl.checked ? "1" : "0");
  bindCards(root);

  const cards = root.querySelectorAll(".kpl-card");
  const rm = reducedMotion();
  cards.forEach((c, i) => {
    const delay = rm ? 0 : 80 + Math.min(i, 8) * 40;
    setTimeout(() => c.classList.add("kpl-show"), delay);
  });
}

function cardHtml(e) {
  const preview = (e.positive || e.negative || "").slice(0, 160);
  const tags = e.tags.map((t) => `<span class="kpl-tag">#${esc(t)}</span>`).join("");
  const open = state.openId === e.id;
  return `
  <div class="kpl-card${e.pinned ? " kpl-pinned" : ""}" data-id="${esc(e.id)}">
    <div class="kpl-row1">
      <span class="kpl-name">${e.pinned ? "★ " : ""}${esc(e.name)}</span>
      <span class="kpl-badge">${esc(e.type)}</span>
      <span class="kpl-pri">${e.priority}</span>
    </div>
    <div class="kpl-text">${esc(preview) || "<i>（正文在 Negative 段）</i>"}</div>
    <div class="kpl-meta">${tags}<span class="kpl-uses">用过 ${e.uses} 次</span></div>
    <div class="kpl-acts">
      <button class="kpl-btn kpl-main" data-a="fill">填入</button>
      <button class="kpl-btn" data-a="append">追加</button>
      <button class="kpl-btn" data-a="edit">${open ? "收起" : "编辑"}</button>
      <button class="kpl-btn" data-a="pin">${e.pinned ? "取消置顶" : "置顶"}</button>
      <button class="kpl-btn kpl-danger${state.armed === e.id ? " kpl-armed" : ""}" data-a="del">${state.armed === e.id ? "确认删除?" : "删除"}</button>
    </div>
    ${open ? editHtml(e) : ""}
  </div>`;
}

function editHtml(e) {
  const dirOpts = (state.data.dirs.length ? state.data.dirs : ["99_未分类"])
    .map((dd) => `<option value="${esc(dd)}"${dd === e.dir ? " selected" : ""}>${esc(dd)}</option>`).join("");
  return `
  <div class="kpl-edit">
    <div class="kpl-editrow">
      <input data-f="name" value="${esc(e.name)}" placeholder="短名">
      <input data-f="tags" value="${esc(e.tags.join(", "))}" placeholder="标签，逗号分隔">
      <input data-f="priority" type="number" value="${e.priority}" placeholder="权重" style="max-width:80px">
    </div>
    <textarea data-f="positive" placeholder="提示词正文">${esc(e.positive)}</textarea>
    <textarea data-f="negative" placeholder="负面词（可选）" style="min-height:50px">${esc(e.negative)}</textarea>
    <div class="kpl-editrow">
      <select data-f="dir">${dirOpts}</select>
      <label class="kpl-hist"><input type="checkbox" data-f="pinned" ${e.pinned ? "checked" : ""}>置顶</label>
      <button class="kpl-btn kpl-main" data-a="saveedit">保存修改</button>
    </div>
  </div>`;
}

function bindCards(root) {
  root.querySelectorAll(".kpl-card").forEach((card) => {
    const id = card.dataset.id;
    const entry = state.data.items.find((e) => e.id === id);
    if (!entry) return;
    card.querySelector("[data-a=fill]").onclick = () => insert(entry, false);
    card.querySelector("[data-a=append]").onclick = () => insert(entry, true);
    card.querySelector("[data-a=edit]").onclick = () => {
      state.openId = state.openId === id ? null : id;
      renderDock(root);
    };
    card.querySelector("[data-a=pin]").onclick = async () => {
      entry.pinned = !entry.pinned;                       // 乐观更新
      card.classList.toggle("kpl-pinned", entry.pinned);
      await api("/save", { id, pinned: entry.pinned });
      await loadList(); renderDock(root);
    };
    const delBtn = card.querySelector("[data-a=del]");
    delBtn.onclick = async () => {
      if (state.armed !== id) { state.armed = id; renderDock(root); return; }
      state.armed = null;
      const r = await api("/delete", { id });
      toast(r.ok ? "已删除（进 .trash 可捞回）" : "删除失败", !r.ok);
      await loadList(); renderDock(root);
    };
    const saveBtn = card.querySelector("[data-a=saveedit]");
    if (saveBtn) saveBtn.onclick = async () => {
      const g = (f) => card.querySelector(`[data-f=${f}]`);
      const body = {
        id,
        name: g("name").value.trim(),
        tags: g("tags").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        priority: parseInt(g("priority").value || "0", 10),
        positive: g("positive").value,
        negative: g("negative").value,
        pinned: g("pinned").checked,
      };
      if (!body.name || !body.positive.trim()) { toast("短名和正文不能为空", true); return; }
      const r = await api("/save", body);
      toast(r.ok ? "已保存" : "保存失败：" + (r.error || ""), !r.ok);
      if (r.ok) { state.openId = null; await loadList(); renderDock(root); }
    };
  });
}

function locateTarget() {
  const w = targetWidget();
  if (!w || !w.node) { toast("画布里没有带文本框的节点", true); return; }
  try {
    app.canvas.selectNode(w.node, false);
    app.canvas.centerOnNode(w.node);
    toast("已定位：" + (w.node.title || w.node.type));
    if (dock) refreshTargetLine(dock);
  } catch (_) { /* ignore */ }
}

function refreshTargetLine(root) {
  const el = root.querySelector(".kpl-target");
  if (!el) return;
  el.innerHTML = targetLabel() + `<button class="kpl-btn" data-a="pick" title="在画布上选中并定位目标节点">定位</button>`;
  const b = root.querySelector("[data-a=pick]");
  if (b) b.onclick = locateTarget;
}

async function insert(entry, append) {
  const w = targetWidget();
  if (!w) { toast("画布里没有带文本框的节点", true); return; }
  const add = entry.positive || entry.negative || "";
  if (!add) { toast("这条目没有正文", true); return; }
  const cur = String(w.value || "").trim();
  setWidget(w, append && cur ? cur + ", " + add : add);
  api("/use", { id: entry.id }).catch(() => { /* 静默 */ });
  toast((append ? "已追加到 " : "已填入 ") + (w.node ? (w.node.title || w.node.type) : "节点"));
  if (dock) refreshTargetLine(dock);
}

async function saveCurrent(root) {
  const nameEl = root.querySelector(".kpl-save-name");
  const name = nameEl.value.trim();
  if (!name) { toast("先写短名", true); return; }
  const w = targetWidget();
  if (!w) { toast("找不到提示词节点", true); return; }
  const text = String(w.value || "").trim();
  if (!text) { toast("节点里的提示词是空的", true); return; }
  const r = await api("/save", { name, type: "精选", positive: text });
  toast(r.ok ? (r.deduped ? "已存在相同内容" : "已存入词库") : "保存失败", !r.ok);
  if (r.ok) { nameEl.value = ""; await loadList(); renderDock(root); }
}

// ───────── 开 / 关 ─────────
function openDock() {
  if (dock) return;
  openSnap = currentSelectionWidget();          // 跷跷板保险：先记住当前选中节点
  dock = document.createElement("div");
  dock.className = "kpl-dock";
  document.body.appendChild(dock);
  loadList().then(() => renderDock(dock)).catch((e) => { toast("词库加载失败：" + e.message, true); closeDock(); });
  requestAnimationFrame(() => dock.classList.add("kpl-in"));
  const pill = document.querySelector(".kpl-pill");
  if (pill) { pill.classList.add("kpl-shift", "kpl-on"); pill.textContent = "收起词库"; }
  // 抽屉开着时，画布选择一变就刷新目标行（400ms 轮询，够轻）
  targetTimer = setInterval(() => { if (dock) refreshTargetLine(dock); }, 400);
}

function closeDock() {
  if (!dock) return;
  const root = dock;
  root.classList.remove("kpl-in");
  root.classList.add("kpl-out");
  setTimeout(() => root.remove(), reducedMotion() ? 190 : 320);
  dock = null;
  openSnap = null;
  state.openId = null; state.armed = null;
  if (targetTimer) { clearInterval(targetTimer); targetTimer = null; }
  const pill = document.querySelector(".kpl-pill");
  if (pill) { pill.classList.remove("kpl-shift", "kpl-on"); pill.textContent = "词库"; }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && dock) closeDock();
});

// ───────── 自动历史：executed 事件 ─────────
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
        node.widgets.forEach((w, i) => {
          const v = n.widgets_values[i];
          if ((w.type === "textarea" || w.type === "string") && typeof v === "string" && v.trim().length >= 4) {
            const key = v.trim();
            if (seen.has(key)) return;
            seen.add(key);
            fetch(API + "/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ positive: key }) })
              .catch(() => { /* 静默 */ });
          }
        });
      }
    } catch (_) { /* 静默：历史失败不影响出图 */ }
    return orig && orig(detail, full);
  };
}

// ───────── 挂载 ─────────
function mountPill() {
  const pill = document.createElement("button");
  pill.className = "kpl-pill";
  pill.textContent = "词库";
  pill.title = "蝌蚪提示词库（vault 直读，右侧抽屉不挡画布）";
  pill.onclick = () => (dock ? closeDock() : openDock());
  document.body.appendChild(pill);
  // 防御：框架重渲染移除外挂按钮则 3 秒后重挂
  setTimeout(() => { if (!document.contains(pill)) document.body.appendChild(pill); }, 3000);
}

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
      mountPill();
    } catch (e) {
      console.error("[kedou] 词库 pill 挂载失败", e);
    }
  },
  registerApiHandlers(api) {
    try { hookHistory(api); } catch (e) { console.error("[kedou] 历史 hook 失败", e); }
  },
});

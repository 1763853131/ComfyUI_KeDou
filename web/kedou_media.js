// kedou_media.js —— 「蝌蚪图片加载器」节点的前端扩展（自绘多选面板）
//
// 不使用官方 image_upload 控件的原因（依据前端 WidgetSelect bundle 的实现）：
//   * 该控件仅支持单选，bundle 中未出现 multiselect；
//   * 它还附带「遮罩编辑器 / 下载」两个按钮，与本节点职责重叠。
// 因此参照 MiniMaxH3-Easy 媒体加载器的做法：唯一控件为隐藏的
// media_state(JSON)，媒体清单由本文件的自绘面板管理。
//
// 面板：图片 N + 上传图片 / 从库里选 + 图片缩略图网格（序号 + × 移除）；
//       点缩略图放大预览；底部输出槽按实际会出图的张数重建（后端声明满 50 个）。
//
// 注意：media_state 是位置型控件，只能隐藏、不可删除（computeSize = () => [0, -4]），
//    否则节点上的其它控件值会整体错位。

import { app } from "../../scripts/app.js";
import { t, initI18n, onLocaleChange, serverError } from "./i18n.js";

const NODE_CLASS = "KedouImageLoader";
// 输出槽上限。ComfyUI 的 RETURN_TYPES 必须静态声明，所以「不限制数量」只能体现为
// 给一个足够大的上限（原来是 10，2026-09-28 提到 50）。实际露出几个由 syncOutputs 控制：
// 槽数随实际会出图的张数增长（选择模式按 picked，批次模式 1 个），已连线的槽始终保留。
// 空槽运行时由后端在 /prompt 入口剔除，既不用重连，也不会把 None 送进下游。
const IMG_SLOTS = 50;
const IMG_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"];
const VID_EXTS = [".mp4", ".mov", ".webm", ".avi", ".mkv"];
const AUD_EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"];

const CSS = [
  // 2026-09-28 试过 flex:1 + align-self:stretch 撑满，**已撤回**：
  // 卡片高度会被计入节点尺寸 → 撑高卡片 → 节点变高 → 容器变高 → 卡片再变高（正反馈），
  // 最后节点被撑到拖不小。所以回到 height:100%（它不会引起这个循环）。
  // 注意：右侧输出槽栏不能碰，卡片宽度靠父容器留给它的空间，这里不设宽度。
  ".kd-card{border:1px solid var(--border-color,#3a3a44);border-radius:10px;overflow:hidden;",
  "background:var(--comfy-input-bg,rgba(0,0,0,.28));display:flex;flex-direction:column;height:100%;}",
  ".kd-top{display:flex;align-items:center;gap:8px;padding:7px 10px;flex:none;",
  "border-bottom:1px solid var(--border-color,#3a3a44);}",
  ".kd-top b{font-size:12px;font-weight:600;}",
  ".kd-top em{font-style:normal;font-size:11px;color:var(--descrip-text,#9a9aa6);}",
  // 开关（toggle switch）：批次 / 选择模式共用
  ".kd-sw{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--descrip-text,#9a9aa6);cursor:pointer;flex:none;user-select:none;}",
  ".kd-sw i{width:26px;height:14px;border-radius:999px;background:rgba(127,127,127,.35);position:relative;transition:background .15s;flex:none;}",
  ".kd-sw i::after{content:\"\";position:absolute;left:2px;top:2px;width:10px;height:10px;border-radius:50%;background:#fff;transition:transform .15s;}",
  ".kd-sw input{display:none;}",
  ".kd-sw input:checked + i{background:var(--p-primary-color,#4a7dff);}",
  ".kd-sw input:checked + i::after{transform:translateX(12px);}",
  // 选择模式下的格子状态：选中的主色描边 + 顺序徽标；未选中的序号变暗
  ".kd-cell.kd-picked{border-color:var(--p-primary-color,#4a7dff);box-shadow:0 0 0 1px var(--p-primary-color,#4a7dff);}",
  ".kd-cell.kd-picked .kd-no{background:var(--p-primary-color,#4a7dff);color:#fff;font-weight:600;}",
  // 框选：拖拽时画的临时选框
  ".kd-marquee{position:fixed;z-index:100002;border:1px solid var(--p-primary-color,#4a7dff);",
  "background:rgba(74,125,255,.12);pointer-events:none;}",
  // 媒体库分类按钮组（全部/已导入/已生成）
  ".kd-seg{display:flex;gap:2px;}",
  ".kd-segbtn{border:1px solid transparent;background:transparent;color:var(--descrip-text,#9a9aa6);font:inherit;font-size:11px;padding:2px 8px;border-radius:999px;cursor:pointer;}",
  ".kd-segbtn.on{background:var(--p-primary-color,#4a7dff);color:#fff;}",
  // 拖拽排序的目标高亮
  ".kd-cell.drag-over{outline:2px dashed var(--p-primary-color,#4a7dff);outline-offset:-2px;}",
  ".kd-cell.kd-skip .kd-no{opacity:.35;}",
  ".kd-btns{margin-left:auto;display:flex;gap:6px;}",
  ".kd-btn{border:1px solid var(--border-color,#3a3a44);background:transparent;color:var(--fg-color,#e7e7ea);",
  "font:inherit;font-size:11px;padding:3px 10px;border-radius:7px;cursor:pointer;}",
  ".kd-btn:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kd-btn.kd-p{border-color:transparent;background:var(--p-primary-color,#4a7dff);color:#fff;font-weight:600;}",
  ".kd-btn[disabled]{opacity:.45;cursor:default;}",
  ".kd-body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:9px;flex:1;overflow:auto;}",
  ".kd-sec{display:flex;flex-direction:column;gap:6px;}",
  ".kd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;}",
  ".kd-cell{position:relative;aspect-ratio:1/1;border-radius:10px;overflow:hidden;",
  "border:1px solid var(--border-color,#3a3a44);background:rgba(127,127,127,.14);",
  "transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease;}",
  // hover 反馈：描边高亮 + 图片由 cover 改 contain（完整显示，不再被方形裁掉）
  ".kd-cell:hover{border-color:var(--p-primary-color,#4a7dff);z-index:3;",
  "box-shadow:0 0 0 1px var(--p-primary-color,#4a7dff),0 4px 14px rgba(0,0,0,.35);}",
  ".kd-cell img{width:100%;height:100%;object-fit:cover;display:block;}",
  ".kd-cell:hover img{object-fit:contain;}",
  // 悬浮放大层：跟随鼠标显示完整大图。
  // 为什么不是给格子加 scale：格子在 .kd-libbody / .kd-body 这些 overflow:auto 的滚动容器里，
  // transform 放大的部分会被容器裁掉；所以用 fixed 定位的独立层。
  ".kd-zoom{position:fixed;z-index:100001;pointer-events:none;display:none;",
  "max-width:344px;border-radius:10px;overflow:hidden;",
  "border:2px solid var(--p-primary-color,#4a7dff);",
  "box-shadow:0 10px 30px rgba(0,0,0,.55);background:var(--comfy-menu-bg,#232329);}",
  ".kd-zoom img{display:block;max-width:340px;max-height:340px;width:auto;height:auto;object-fit:contain;}",
  ".kd-no{position:absolute;left:4px;bottom:4px;font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;",
  "background:rgba(0,0,0,.66);color:#fff;max-width:calc(100% - 8px);overflow:hidden;text-overflow:ellipsis;",
  "white-space:nowrap;}",
  ".kd-x{position:absolute;right:3px;top:3px;width:17px;height:17px;line-height:15px;padding:0;border:0;",
  "border-radius:50%;cursor:pointer;background:rgba(0,0,0,.6);color:#fff;font-size:11px;opacity:0;transition:opacity .12s;}",
  ".kd-cell:hover .kd-x{opacity:1;}",
  ".kd-empty{padding:12px 6px;text-align:center;font-size:11.5px;color:var(--descrip-text,#9a9aa6);}",
  ".kd-lib{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);",
  "display:flex;align-items:center;justify-content:center;}",
  ".kd-libwin{width:min(820px,92vw);height:min(600px,86vh);display:flex;flex-direction:column;",
  "background:var(--comfy-menu-bg,#232329);color:var(--fg-color,#e7e7ea);border:1px solid var(--border-color,#3a3a44);",
  "border-radius:12px;overflow:hidden;font:12.5px/1.6 system-ui,sans-serif;}",
  ".kd-libtop{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border-color,#3a3a44);}",
  ".kd-libtop b{font-size:13.5px;}",
  ".kd-libtop input{margin-left:auto;width:180px;padding:4px 10px;border-radius:999px;",
  "border:1px solid var(--border-color,#3a3a44);background:transparent;color:inherit;font:inherit;outline:none;}",
  ".kd-libbody{flex:1;overflow:auto;padding:12px;}",
  ".kd-libfoot{display:flex;align-items:center;gap:10px;padding:10px 12px;border-top:1px solid var(--border-color,#3a3a44);}",
  ".kd-libfoot i{font-style:normal;font-size:11px;opacity:.75;}",
  ".kd-big{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.82);",
  "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;",
  "padding:24px;cursor:zoom-out;}",
  ".kd-big img{max-width:92vw;max-height:84vh;object-fit:contain;border-radius:8px;display:block;}",
  ".kd-bigcap{font:12px/1.6 system-ui,sans-serif;color:#e8e8ee;opacity:.85;word-break:break-all;text-align:center;}",
].join("");

let cssDone = false;
function ensureCss() {
  if (cssDone || document.getElementById("kd-two-css")) {
    cssDone = true;
    return;
  }
  console.log("[kedou] 前端扩展已加载 · build 2026-09-28c");
  const s = document.createElement("style");
  s.id = "kd-two-css";
  s.textContent = CSS;
  document.head.appendChild(s);
  cssDone = true;
}

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wOf(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

function baseName(v) {
  const p = String(v || "").replace(/\\/g, "/").split("/");
  return p[p.length - 1] || String(v || "");
}

function subOf(v) {
  const s = String(v || "").replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(0, i) : "";
}

function viewUrl(name, sub) {
  return "/view?" + new URLSearchParams({ filename: name, subfolder: sub || "", type: "input" }).toString();
}

// 缩略图 URL：走我们自己的 /ps/thumb（真缩尺寸 + 落盘 webp 缓存）。
// 2026-10-15 实测：官方 /view?preview= 只重编码、不缩尺寸（server.py 的 preview 分支里
// 根本没有 resize），5120x8192 的图照样回 8.7MB，且全图解码同步跑在 async 处理函数里，
// 一屏几十格能把事件循环堵死；参数末尾的 ";0.0" 也不会被当成质量（后端只认最后一段
// 且要求纯数字），实际按 quality=90 出图。以前那套 "jpeg;50;0.0" 的写法两头都落空。
function thumbUrl(name, sub, w, tab) {
  return "/ps/thumb?" + new URLSearchParams(
    { filename: name, subfolder: sub || "", type: tab || "input", w: String(w || 256) }).toString();
}

// ---- 悬浮放大预览（媒体库网格 + 图片加载器面板共用） ----
// 鼠标移到格子上时，在鼠标旁边浮出一张完整大图（contain，不裁切，主色高亮边）。
// 用 dataset 记住当前 url，只在换图时才重设 src —— 否则 mousemove 每动一下都会重新发起请求。
let kdZoomEl = null;
function kdZoomBox() {
  if (kdZoomEl && document.contains(kdZoomEl)) return kdZoomEl;
  const d = document.createElement("div");
  d.className = "kd-zoom";
  d.appendChild(document.createElement("img"));
  document.body.appendChild(d);
  kdZoomEl = d;
  return d;
}
function kdZoomShow(url, x, y) {
  const d = kdZoomBox();
  if (d.dataset.url !== url) {
    d.firstElementChild.src = url;
    d.dataset.url = url;
  }
  d.style.display = "block";
  const W = 344, H = 344, pad = 16;
  let left = x + pad;
  let top = y + pad;
  if (left + W > window.innerWidth) left = Math.max(8, x - W - pad);
  if (top + H > window.innerHeight) top = Math.max(8, window.innerHeight - H - 8);
  d.style.left = left + "px";
  d.style.top = top + "px";
}
function kdZoomHide() { if (kdZoomEl) kdZoomEl.style.display = "none"; }
// url 可以是字符串，也可以是函数（图片加载器的 src 会在 input→output 回退时变化，需要现取）
function attachZoom(cell, urlOrFn) {
  if (!urlOrFn) return;
  const getUrl = typeof urlOrFn === "function" ? urlOrFn : () => urlOrFn;
  const at = (e) => { const u = getUrl(); if (u) kdZoomShow(u, e.clientX, e.clientY); };
  cell.addEventListener("mouseenter", at);
  cell.addEventListener("mousemove", at);
  cell.addEventListener("mouseleave", kdZoomHide);
}

// 统一手势：格子或空白按下 → 移动超阈值 = 框选（相交回调）；未拖动 = 点击（格子回调 / 空白回调）。
// 替代原先「格子上 click + 空白框选」两套逻辑——现在图片上也能直接起框。
function kdGesture(container, getCells, handlers) {
  container.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input")) return;
    if (handlers.enabled && !handlers.enabled()) return;
    e.preventDefault();                       // 抑制原生图片拖拽与文字选择
    const sx = e.clientX, sy = e.clientY;
    const startCell = e.target.closest(".kd-cell");
    const startIdx = startCell ? getCells().indexOf(startCell) : -1;
    const shift = e.shiftKey;
    let dragging = false, box = null;
    const move = (ev) => {
      if (!dragging && Math.abs(ev.clientX - sx) < 5 && Math.abs(ev.clientY - sy) < 5) return;
      dragging = true;
      if (!box) { box = document.createElement("div"); box.className = "kd-marquee"; document.body.appendChild(box); }
      box.style.left = Math.min(sx, ev.clientX) + "px";
      box.style.top = Math.min(sy, ev.clientY) + "px";
      box.style.width = Math.abs(ev.clientX - sx) + "px";
      box.style.height = Math.abs(ev.clientY - sy) + "px";
    };
    const up = (ev) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      if (box) box.remove();
      const cells = getCells();
      if (dragging) {
        const r = { l: Math.min(sx, ev.clientX), t: Math.min(sy, ev.clientY),
                    r: Math.max(sx, ev.clientX), b: Math.max(sy, ev.clientY) };
        const hit = [];
        cells.forEach((cell, i) => {
          const cr = cell.getBoundingClientRect();
          if (cr.left < r.r && cr.right > r.l && cr.top < r.b && cr.bottom > r.t) hit.push(i);
        });
        if (hit.length && handlers.onMarquee) handlers.onMarquee(hit);
        return;
      }
      if (startIdx >= 0 && handlers.onCellTap) handlers.onCellTap(startIdx, shift);
      else if (startIdx < 0 && handlers.onBlankTap) handlers.onBlankTap();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

function hideWidget(w, on) {
  if (!w) return;
  if (on) {
    if (w._kdHidden) {
      w._kdHidden = false;
      if (w._kdType) w.type = w._kdType;
      if (w._kdCompute) w.computeSize = w._kdCompute;
      if (w.inputEl) w.inputEl.style.display = "";
      if (w.element) w.element.style.display = "";
      if ("hidden" in w) w.hidden = false;
    }
    return;
  }
  if (w._kdHidden) return;
  w._kdHidden = true;
  if (!w._kdType) w._kdType = w.type;
  // 关键：光改 computeSize 在新前端（Vue 渲染控件）里藏不住 ——
  // 还得把类型标成 converted-widget，前端就跳过绘制；值仍照常随工作流序列化。
  w.type = "converted-widget";
  if (!w._kdCompute) w._kdCompute = w.computeSize;
  w.computeSize = () => [0, -4];
  if (w.inputEl) w.inputEl.style.display = "none";
  if (w.element) w.element.style.display = "none";
  if ("hidden" in w) w.hidden = true;
  if (!w._kdSerializeSaved) {
    w._kdSerializeSaved = w.serializeValue || null;
    w.serializeValue = async () => w.value;   // 值照常进工作流 / API 图
  }
}

function hookWidget(w, fn) {
  if (!w || w._kdHooked) return;
  w._kdHooked = true;
  const prev = w.callback;
  w.callback = function () {
    const r = typeof prev === "function" ? prev.apply(this, arguments) : undefined;
    setTimeout(fn, 0);
    return r;
  };
}

// ---------------------------------------------------------------- 状态
function readState(node) {
  const w = wOf(node, "media_state");
  let obj = null;
  try {
    obj = JSON.parse(w ? String(w.value == null ? "" : w.value) : "");
  } catch (e) {
    obj = null;
  }
  const list = obj && Array.isArray(obj.images) ? obj.images : [];
  return {
    images: list
      .map((it) => (it && typeof it === "object" ? it : { filename: it }))
      .filter((it) => it && typeof it.filename === "string" && it.filename.trim())
      .slice(0, IMG_SLOTS),
    // 批次 / 选择模式字段：批次循环与选择输出都靠它们驱动，读取入口必须带出来
    batch: !!(obj && obj.batch),
    cursor: (obj && Number(obj.cursor)) || 0,
    select: !!(obj && obj.select),
    picked: (obj && Array.isArray(obj.picked)) ? obj.picked.filter((f) => typeof f === "string") : [],
  };
}

function writeState(node, state) {
  const w = wOf(node, "media_state");
  if (!w) return;
  // batch/cursor/select/picked 必须一起写：批次循环与选择输出都靠它们驱动，
  // 上次就吃过「序列化只写一部分、其余字段被静默丢掉」的亏
  w.value = JSON.stringify({
    images: state.images.map((it) => ({ filename: it.filename })),
    batch: !!state.batch,
    cursor: Math.max(0, Number(state.cursor) || 0),
    select: !!state.select,
    picked: (state.picked || []).filter((f) => typeof f === "string"),
  });
  try {
    if (typeof w.callback === "function") w.callback(w.value);
  } catch (e) {
    /* callback 不是必须的 */
  }
  node.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------- 输出槽重建
function linksOf(node, index) {
  const out = node && node.outputs ? node.outputs[index] : null;
  return Array.isArray(out && out.links) ? out.links.slice() : (out && out.link != null ? [out.link] : []);
}

// 删槽/重排后需重指已有连线的起点槽号，否则连线会落到错误的输入槽。
// LiteGraph 用 origin_slot；Vue 图适配器用 originSlot / from_slot / fromSlot，四个都写。
function repointLinks(node) {
  const graph = (node && node.graph) || app.graph;
  if (!graph || !node || !Array.isArray(node.outputs)) return;
  node.outputs.forEach((_out, index) => {
    for (const id of linksOf(node, index)) {
      const link = typeof graph.getLink === "function" ? graph.getLink(id) : graph.links && graph.links[id];
      if (!link) continue;
      link.origin_slot = index;
      if ("originSlot" in link) link.originSlot = index;
      if ("from_slot" in link) link.from_slot = index;
      if ("fromSlot" in link) link.fromSlot = index;
    }
  });
}

function resizeToContent(node) {
  if (!node || typeof node.computeSize !== "function" || typeof node.setSize !== "function") return;
  const measured = node.computeSize();
  if (!Array.isArray(measured) || !Number.isFinite(Number(measured[1]))) return;
  const w = Math.max(300, Number(node.size && node.size[0]) || 0, Number(measured[0]) || 0);
  const h = Math.max(1, Math.ceil(Number(measured[1])));
  if (Math.abs((Number(node.size && node.size[1]) || 0) - h) > 1) node.setSize([w, h]);
}

// 兜底：直接把高度写给卡片。为什么需要它——ComfyUI 不一定把卡片直接放进宿主容器，
// 中间可能隔一层 wrapper，那样 height:100% / flex:1 都会失效，卡片退回内容高度并被居中
// （这就是输出槽一多、上下就留白的原因）。所以这里向上找若干层，取最高的那个祖先高度；
// 祖先高度都不可信时，再按节点高度推算（扣掉标题栏等固定开销），并夹住不让它超出节点。
function fitCard(node, quick) {
  const ui = node && node._kdUI;
  if (!ui || !ui.card) return;
  const card = ui.card;
  const host = card.parentElement;
  if (!host) return;
  // 拖拽节点边缘缩放不会触发 renderPanel —— 用 ResizeObserver 盯住容器，
  // 容器一变（拉大/缩小）就走 quick 模式实时跟随，卡片才能一直铺满。
  if (!node.__kdRO && typeof ResizeObserver === "function") {
    node.__kdRO = new ResizeObserver(function () { fitCard(node, true); });
    node.__kdRO.observe(host);
  }
  // 两条硬知识（都是实测教训）：
  // ① node.size[1] 是画布坐标，DOM 容器是 CSS 像素，两套坐标系不能互相换算，高度只能实测；
  // ② 卡片高度会被计入节点尺寸 —— 撑高卡片 → 节点变高 → 容器变高 → 卡片再变高是正反馈，
  //    所以「容器高 ≈ 上次设置的卡片高 + off」就是平衡态，此时必须停手，否则节点会自己长个不停。
  let contentH = Number(node.__kdContentH || 0);
  if (!quick) {
    // 完整测量（图片增删/连线变化时）：清掉拉伸回到内容布局，量真实的偏移与内容高度
    if (host.style.height) host.style.height = "";
    if (card.style.height) card.style.height = "";
    node.__kdOff = card.offsetTop;         // 卡片起始位置 = 输出槽区结束处
    contentH = card.scrollHeight;
    node.__kdContentH = contentH;
  }
  const off = Number(node.__kdOff || 0);
  const hostH = host.clientHeight;
  const prev = Number(node.__kdFitH || 0);
  if (prev && Math.abs(hostH - (prev + off)) < 12) return;   // 平衡态，动它只会爬升
  const target = hostH - off - 6;          // 从槽位区结束处一路撑到容器底部
  if (target > contentH + 20 && target > 150) {
    card.style.height = target + "px";
    node.__kdFitH = target;
  } else if (prev) {
    // 内容已经够高（图片多到自然占满）—— 去掉拉伸，让卡片回自然高度
    card.style.height = "";
    delete node.__kdFitH;
  }
}

function syncOutputs(node) {
  if (!node.outputs) node.outputs = [];
  // 槽数 = 实际会出图的张数（选择模式 = picked；批次模式固定 1 张；至少 1 个），
  // 但**已连线的槽一律保留**：连线是用户的接线资产，不能因为临时删图就断掉。
  // 空槽真正执行时由后端钩子剔除（/prompt 入口），下游不会收到 None，
  // 所以保留连线既不用重连，也不会再打挂 Batch Images。
  const state = readState(node);
  const effN = effectiveImages(state).length;
  const outN = state.batch ? (effN ? 1 : 0) : effN;
  let hi = -1;
  node.outputs.forEach((o, i) => {
    if (linksOf(node, i).length) hi = i;   // .links 之外也认旧版/适配器的 .link
  });
  let n = Math.max(1, Math.min(IMG_SLOTS, Math.max(outN, hi + 1)));
  // 工作流配置期间连线/控件可能还没恢复：只增不删，等下一次同步再收槽。
  if (node.__kdGrowOnly || app.configuringGraph) n = Math.max(n, node.outputs.length);
  let changed = false;
  while (node.outputs.length > n) {
    const idx = node.outputs.length - 1;
    // 正常不会删到有连线的槽（n 已覆盖最高连线）；适配器若漏报连线，先断开更安全。
    try {
      if (typeof node.disconnectOutput === "function" && linksOf(node, idx).length) {
        node.disconnectOutput(idx);
      }
    } catch (_) { /* 删槽入口还会再处理 */ }
    try {
      if (typeof node.removeOutput === "function") node.removeOutput(idx);
      else node.outputs.pop();
    } catch (_) {
      node.outputs.pop();   // 极端适配器下保住渲染，不让一次收槽把整个面板打断
    }
    changed = true;
  }
  while (node.outputs.length < n) {
    const i = node.outputs.length + 1;
    if (typeof node.addOutput === "function") node.addOutput("image_" + i, "IMAGE");
    else node.outputs.push({ name: "image_" + i, type: "IMAGE", links: [] });
    changed = true;
  }
  node.outputs.forEach((o, i) => {
    const label = t("Image {i}", { i: i + 1 });
    if (o.name !== "image_" + (i + 1)) o.name = "image_" + (i + 1);
    o.type = "IMAGE";
    o.display_name = label;
    if ("label" in o) o.label = label;
  });
  if (changed) repointLinks(node);
  return changed;
}

// ---------------------------------------------------------------- 放大预览
function openBig(name, sub) {
  const ov = document.createElement("div");
  ov.className = "kd-big";
  const img = document.createElement("img");
  let tried = false;
  img.onerror = () => {
    if (tried) {
      img.alt = t("Could not load this image");
      return;
    }
    tried = true;
    img.src = viewUrl(name, sub).replace("type=input", "type=output");
  };
  img.src = viewUrl(name, sub);
  const cap = document.createElement("div");
  cap.className = "kd-bigcap";
  cap.textContent = (sub ? sub + "/" : "") + name;
  ov.append(img, cap);

  function close() {
    ov.remove();
    document.removeEventListener("keydown", onKey, true);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  ov.onclick = close;
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(ov);
}

// ---------------------------------------------------------------- 媒体库弹窗（走桥接 /ps/media）
async function fetchLibrary(kind, q, tab) {
  const qs = new URLSearchParams({ type: kind, tab: tab || "all", q: q || "" }).toString();
  for (const p of ["/ps/media?", "/api/ps/media?"]) {
    try {
      const r = await fetch(p + qs);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.ok) return j.items || [];
    } catch (e) {
      /* 试下一个前缀 */
    }
  }
  return null;
}

function openLibrary(onPick) {
  ensureCss();   // 样式原本只在节点面板 build() 里注入；从这里单独打开时也得有，否则整个弹窗是裸的
  const picked = new Map();
  const ov = document.createElement("div");
  ov.className = "kd-lib";
  const win = document.createElement("div");
  win.className = "kd-libwin";
  const top = document.createElement("div");
  top.className = "kd-libtop";
  top.innerHTML = '<b>' + t("Media library") + '</b>';
  // 分类：全部 / 已导入（input 目录）/ 已生成（output 目录）
  let curTab = "all";
  const tabBar = document.createElement("div");
  tabBar.className = "kd-seg";
  [["all", t("All")], ["input", t("Imported")], ["output", t("Generated")]].forEach(([v, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kd-segbtn" + (v === curTab ? " on" : "");
    b.textContent = label;
    b.onclick = () => {
      curTab = v;
      tabBar.querySelectorAll(".kd-segbtn").forEach((x) => x.classList.toggle("on", x === b));
      render();
    };
    tabBar.appendChild(b);
  });
  top.appendChild(tabBar);
  const search = document.createElement("input");
  search.placeholder = t("Search file name…");
  top.appendChild(search);
  const body = document.createElement("div");
  body.className = "kd-libbody";
  const foot = document.createElement("div");
  foot.className = "kd-libfoot";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "kd-btn";
  cancelBtn.textContent = t("Cancel");
  cancelBtn.style.marginLeft = "auto";
  const tip = document.createElement("i");
  const okBtn = document.createElement("button");
  okBtn.className = "kd-btn kd-p";
  foot.append(cancelBtn, tip, okBtn);
  win.append(top, body, foot);
  ov.appendChild(win);
  ov.onclick = (e) => { if (e.target === ov) close(); };
  document.body.appendChild(ov);

  function close() { ov.remove(); }
  cancelBtn.onclick = close;
  okBtn.onclick = () => {
    const list = [...picked.values()];
    close();
    if (list.length) onPick(list);
  };
  // 防抖 300ms：否则每敲一个字符都重新请求后端并重建整个网格（400 张缩略图重来一遍）
  let searchTimer = null;
  search.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 300);
  };

  function syncFoot() {
    tip.textContent = picked.size ? t("Selected {n} items", { n: picked.size }) : "";
    okBtn.textContent = picked.size ? t("Add {n}", { n: picked.size }) : t("Add");
    okBtn.disabled = !picked.size;
  }

  // 分批渲染：一次只画 80 格（400 格即便都是缩略图，首屏也要等十几秒），
  // 滚到底部再增量追加 —— 追加而不是重建，已渲染的格子不会重新加载图片。
  const BATCH = 80;
  let curItems = [], shown = 0, gridEl = null;
  let renderSeq = 0;    // 搜索请求序号：晚到的旧响应直接丢掉
  let anchorIdx = -1;   // Shift 范围多选的锚点（上一次点击的格子序号）

  // 批量重画选中描边：点击单格只动一处，Shift/框选会改一整片，统一刷一遍
  function updateOutlines() {
    if (!gridEl) return;
    gridEl.querySelectorAll(".kd-cell").forEach((c) => {
      c.style.outline = picked.has(c.dataset.kdKey) ? "2px solid var(--p-primary-color,#4a7dff)" : "none";
    });
  }


  // 统一手势：图片上按下直接可拖框；未拖动的点击 = 单格切换；Shift+点击 = 范围；
  // 点击空白 = 清空全部选择（替代「一张张点掉」）
  kdGesture(body, () => gridEl ? Array.from(gridEl.querySelectorAll(".kd-cell")) : [], {
    onCellTap(idx, shift) {
      if (shift && anchorIdx >= 0) {
        const lo = Math.min(anchorIdx, idx), hi = Math.max(anchorIdx, idx);
        for (let k = lo; k <= hi; k++) {
          const it2 = curItems[k];
          if (!it2) continue;
          const kk = (it2.subfolder ? it2.subfolder + "/" : "") + it2.name;
          if (!picked.has(kk)) picked.set(kk, { filename: kk });
        }
      } else {
        const it2 = curItems[idx];
        if (!it2) return;
        const kk = (it2.subfolder ? it2.subfolder + "/" : "") + it2.name;
        if (picked.has(kk)) picked.delete(kk);
        else picked.set(kk, { filename: kk });
      }
      anchorIdx = idx;
      updateOutlines();
      syncFoot();
    },
    onBlankTap() {
      if (!picked.size) return;
      picked.clear();
      updateOutlines();
      syncFoot();
    },
    onMarquee(idxs) {
      for (const i of idxs) {
        const it = curItems[i];
        if (!it) continue;
        const kk = (it.subfolder ? it.subfolder + "/" : "") + it.name;
        if (!picked.has(kk)) picked.set(kk, { filename: kk });
      }
      anchorIdx = -1;
      updateOutlines();
      syncFoot();
    },
  });

  function mkCell(it, idx) {
    const key = (it.subfolder ? it.subfolder + "/" : "") + it.name;
    const cell = document.createElement("div");
    cell.className = "kd-cell";
    cell.dataset.kdKey = key;
    cell.style.outline = picked.has(key) ? "2px solid var(--p-primary-color,#4a7dff)" : "none";
    const src = thumbUrl(it.name, it.subfolder, 256, it.tab);
    const img = document.createElement("img");
    img.loading = "lazy";
    img.draggable = false;                  // 禁原生图片拖拽（拖出去没意义还干扰框选）
    img.src = src;
    img.onerror = () => { img.style.visibility = "hidden"; };
    cell.appendChild(img);
    const no = document.createElement("span");
    no.className = "kd-no";
    no.textContent = it.name;
    cell.appendChild(no);
    // 悬浮层是 344px 见方，格子只有 ~100px：两者不能共用一张图，否则悬浮必糊
    attachZoom(cell, thumbUrl(it.name, it.subfolder, 512, it.tab));
    // 点击逻辑统一由 kdGesture 手势接管（tap 切换/Shift 范围），这里不再挂 onclick
    return cell;
  }

  function appendBatch() {
    if (!gridEl) return;
    const next = curItems.slice(shown, shown + BATCH);
    let k = shown;
    for (const it of next) gridEl.appendChild(mkCell(it, k++));
    shown = k;
  }

  function render() {
    const seq = ++renderSeq;           // 搜索防抖后仍可能乱序返回，只认最后一次
    kdZoomHide();
    syncFoot();
    body.style.color = "";
    body.textContent = t("Loading…");
    body.onscroll = null;
    fetchLibrary("image", search.value, curTab).then((items) => {
      if (seq !== renderSeq) return;   // 过期响应：别把旧结果盖到新搜索上
      body.innerHTML = "";
      if (items === null) {
        body.textContent = t("Bridge plugin not loaded: restart ComfyUI once (/ps/media unavailable).");
        body.style.color = "var(--descrip-text,#9a9aa6)";
        return;
      }
      if (!items.length) {
        body.textContent = t("No matching images.");
        body.style.color = "var(--descrip-text,#9a9aa6)";
        return;
      }
      curItems = items; shown = 0; anchorIdx = -1;
      gridEl = document.createElement("div");
      gridEl.className = "kd-grid";
      body.appendChild(gridEl);
      appendBatch();          // 先渲染第一批，剩下的滚动到底再追加
      body.onscroll = () => {
        if (shown >= curItems.length) return;
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 140) appendBatch();
      };
    });
  }
  render();
}

async function uploadFiles(files) {
  const added = [];
  let failed = 0;
  for (const f of files) {
    const low = String(f.name).toLowerCase();
    if (!IMG_EXTS.some((e) => low.endsWith(e))) continue;
    const fd = new FormData();
    fd.append("image", f);
    fd.append("overwrite", "true");
    let ok = false;
    for (const p of ["/upload/image", "/api/upload/image"]) {
      try {
        const r = await fetch(p, { method: "POST", body: fd });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.name) {
          added.push({ filename: (j.subfolder ? j.subfolder + "/" : "") + j.name });
          ok = true;
          break;
        }
      } catch (e) {
        /* 试下一个前缀 */
      }
    }
    if (!ok) failed += 1;
  }
  return { added, failed };
}

// ---------------------------------------------------------------- 面板
function renderPanel(node) {
  const ui = node._kdUI;
  if (!ui) return;
  kdZoomHide();        // 重绘会销毁当前格子的 mouseleave 宿主，悬浮层必须一起收掉
  const state = readState(node);
  syncOutputs(node);   // 输出槽按实际张数增长；已连线的槽保留，空槽由后端在运行时剔除
  ui.count.textContent = String(state.images.length);
  // 两个开关与按钮的状态跟随（赋值 checked 不会触发 onchange，安全）
  if (ui.swBatchCb) ui.swBatchCb.checked = !!state.batch;
  if (ui.swSelCb) ui.swSelCb.checked = !!state.select;
  const effN = effectiveImages(state).length;
  if (ui.runBtn) {
    ui.runBtn.style.display = state.batch ? "" : "none";
    ui.runBtn.textContent = t("▶ Run {n}", { n: effN });
    ui.runBtn.disabled = !effN;
  }
  ui.body.innerHTML = "";

  const sec = document.createElement("div");
  sec.className = "kd-sec";

  if (!state.images.length) {
    const d = document.createElement("div");
    d.className = "kd-empty";
    d.textContent = t("No images yet — use \"Upload image\" or \"From library\" to add.");
    sec.appendChild(d);
    ui.body.appendChild(sec);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "kd-grid";
  // 选择模式：点击 = 按顺序选中/取消（选中顺序即输出顺序），不放大预览；
  // 普通模式：点击 = 放大预览，hover 跟随。
  const selMode = !!state.select;
  const pickOrder = {};
  (state.picked || []).forEach((f, idx) => { if (!(f in pickOrder)) pickOrder[f] = idx + 1; });
  state.images.forEach((it, i) => {
    const cell = document.createElement("div");
    cell.className = "kd-cell";
    cell.title = it.filename;
    const img = document.createElement("img");
    img.loading = "lazy";
    img.draggable = false;                  // 禁原生拖拽：拖图片出去会在画布创建官方 LoadImage 节点，没用还干扰
    // 先按 input 找，找不到再退到 output；悬浮预览要跟着用最终那个地址
    const fn = baseName(it.filename), sd = subOf(it.filename);
    let tab = "input";
    const cellSrc = () => thumbUrl(fn, sd, 256, tab);
    img.onerror = () => {
      if (tab === "output") {
        img.style.visibility = "hidden";
        return;
      }
      tab = "output";
      img.src = cellSrc();
    };
    img.src = cellSrc();
    cell.appendChild(img);
    if (!selMode) attachZoom(cell, () => thumbUrl(fn, sd, 512, tab));
    // 序号：普通模式 = 面板顺序；选择模式下选中的显示选择顺序号（主色徽标），未选中的变暗
    const pk = selMode ? (pickOrder[it.filename] || 0) : 0;
    const no = document.createElement("span");
    no.className = "kd-no";
    no.textContent = selMode && pk ? String(pk) : String(i + 1);
    if (selMode) {
      no.style.background = pk ? "var(--p-primary-color,#4a7dff)" : "";
      no.style.opacity = pk ? "" : ".35";
    }
    cell.appendChild(no);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "kd-x";
    x.textContent = "×";
    x.onclick = (e) => {
      e.stopPropagation();
      const st2 = readState(node);
      st2.images.splice(i, 1);
      if (st2.picked) st2.picked = st2.picked.filter((f) => f !== it.filename);   // 同步清理选择集
      writeState(node, st2);
      renderPanel(node);
    };
    cell.appendChild(x);
    if (selMode) {
      cell.classList.toggle("kd-picked", !!pk);
      cell.onclick = (e) => {
        const st2 = readState(node);
        st2.picked = st2.picked || [];
        if (e.shiftKey && typeof node.__kdAnchor === "number" && node.__kdAnchor >= 0
            && node.__kdAnchor < state.images.length) {
          // Shift 范围多选：从上次点击到本次，整段按面板顺序加入选择
          const lo = Math.min(node.__kdAnchor, i), hi = Math.max(node.__kdAnchor, i);
          for (let k = lo; k <= hi; k++) {
            const fn = state.images[k].filename;
            if (st2.picked.indexOf(fn) < 0) st2.picked.push(fn);
          }
        } else {
          const at = st2.picked.indexOf(it.filename);
          if (at >= 0) st2.picked.splice(at, 1);
          else st2.picked.push(it.filename);
        }
        node.__kdAnchor = i;
        writeState(node, st2);
        renderPanel(node);
      };
    } else {
      cell.onclick = () => openBig(baseName(it.filename), subOf(it.filename));
    }
    grid.appendChild(cell);
  });
  sec.appendChild(grid);
  ui.body.appendChild(sec);
  // 先把卡片顶满，再算节点高度，最后再顶一次（节点高度变了，容器高度也跟着变）
  fitCard(node);
  setTimeout(() => { resizeToContent(node); fitCard(node); }, 0);
}

async function uploadFilesWrapper(node, files) {
  uiSetBusy(node, true);
  let res;
  try {
    res = await uploadFiles(files);
  } finally {
    uiSetBusy(node, false);
  }
  const { added, failed } = res || { added: [], failed: 0 };
  const state = readState(node);
  const have = new Set(state.images.map((it) => it.filename));
  for (const it of added) {
    // overwrite=true 下重传同名文件很常见；后端按文件名去重，
    // 面板这里不去重就会出现“面板 N 张、实际输出 M 张”的槽位错位。
    if (have.has(it.filename)) continue;
    have.add(it.filename);
    state.images.push(it);
  }
  state.images = state.images.slice(0, IMG_SLOTS);
  writeState(node, state);
  renderPanel(node);
  if (failed) kpToast(t("Upload failed: {n} file(s)", { n: failed }), true);
}

// 当前「生效」的图片列表：选择模式开且有选中 → 选中的（按选择顺序）；否则全部照片。
// 批次循环的次数、输出槽的启用数都以它为准。
function effectiveImages(state) {
  if (state.select && state.picked && state.picked.length) {
    const map = {};
    state.images.forEach((it) => { map[it.filename] = it; });
    const list = state.picked.filter((f) => map[f]).map((f) => map[f]);
    if (list.length) return list;
  }
  return state.images;
}

function uiSetBusy(node, busy) {
  const ui = node._kdUI;
  if (!ui) return;
  if (ui.upBtn) {
    ui.upBtn.disabled = busy;
    ui.upBtn.textContent = busy ? t("Uploading…") : t("Upload image");
  }
  if (ui.libBtn) ui.libBtn.disabled = busy;
  if (ui.runBtn) {
    const st = readState(node);
    ui.runBtn.disabled = !!busy || !(st.images || []).length;
  }
}

// 批次运行：把当前选的 N 张图逐张排队 —— 每次改 media_state 的游标再提交，
// ComfyUI 队列按顺序一张张跑完整条链路。每次下游只吃 1 张，显存恒定，
// 各张尺寸也可以不同。跑完游标停在最后，下次点批次按钮照常从第 1 张开始。
async function runBatch(node) {
  const state = readState(node);
  const n = effectiveImages(state).length;
  if (!n) { kpToast(t("No images to run"), true); return; }
  uiSetBusy(node, true);
  try {
    for (let i = 0; i < n; i++) {
      const st = readState(node);
      st.batch = true;
      st.cursor = i;
      writeState(node, st);
      console.log("[kedou] 批次提交 " + (i + 1) + "/" + n + " cursor=" + i
        + " widget=" + (wOf(node, "media_state") || {}).value);
      await app.queuePrompt(0);        // 内部会 graphToPrompt，cursor=i 随图一起进队列
      kpToast(t("Batch {i}/{n} queued", { i: i + 1, n }));
    }
    kpToast(t("Batch submitted: {n} images queued, ComfyUI will run them in order", { n }));
  } catch (e) {
    kpToast(t("Batch submit failed: {msg}", { msg: e && e.message ? e.message : String(e) }), true);
  } finally {
    uiSetBusy(node, false);
  }
}

function build(node) {
  ensureCss();
  hideWidget(wOf(node, "media_state"), false);

  const card = document.createElement("div");
  card.className = "kd-card";
  const top = document.createElement("div");
  top.className = "kd-top";
  const title = document.createElement("b");
  title.textContent = t("Images");
  const count = document.createElement("em");
  const btns = document.createElement("div");
  btns.className = "kd-btns";
  const libBtn = document.createElement("button");
  libBtn.className = "kd-btn";
  libBtn.textContent = t("Media library");
  // 一键清除全部已加载图片：二次确认态（2.5 秒内再点才执行），防止误触
  const clearBtn = document.createElement("button");
  clearBtn.className = "kd-btn";
  clearBtn.textContent = t("Clear");
  let clearArmed = 0;
  clearBtn.onclick = () => {
    const st = readState(node);
    if (!(st.images || []).length) return;
    if (Date.now() - clearArmed < 2500 && clearBtn.textContent.indexOf(t("Confirm clear?")) !== -1) {
      st.images = [];
      st.picked = [];
      st.cursor = 0;
      writeState(node, st);
      clearArmed = 0;
      clearBtn.textContent = t("Clear");
      clearBtn.style.color = "";
      renderPanel(node);
    } else {
      clearArmed = Date.now();
      clearBtn.textContent = t("Confirm clear?");
      clearBtn.style.color = "var(--error-text,#ff6b6b)";
      setTimeout(() => {
        if (Date.now() - clearArmed >= 2500) {
          clearBtn.textContent = t("Clear");
          clearBtn.style.color = "";
        }
      }, 2600);
    }
  };
  const upBtn = document.createElement("button");
  upBtn.className = "kd-btn kd-p";
  upBtn.textContent = t("Upload image");
  const fileEl = document.createElement("input");
  fileEl.type = "file";
  fileEl.multiple = true;
  fileEl.accept = IMG_EXTS.join(",");
  fileEl.style.display = "none";
  // 批次模式开关：打开后「跑 N 张」按钮出现，点一下把所有图片逐张排队（每次从图片1 出一张）
  const runBtn = document.createElement("button");
  runBtn.className = "kd-btn kd-p";
  runBtn.style.display = "none";
  runBtn.onclick = () => runBatch(node);
  btns.append(libBtn, clearBtn, upBtn, runBtn, fileEl);
  // 批次 / 选择两个开关（toggle 样式）
  const mkSwitch = (label, title) => {
    const lab = document.createElement("label");
    lab.className = "kd-sw";
    lab.title = title;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    lab.append(cb, document.createElement("i"), document.createTextNode(label));
    return { lab, cb };
  };
  const swBatch = mkSwitch(t("Batch"), t("Batch mode: when on, click \"Run N\" to queue each effective image one by one, running the workflow once per image and outputting from image 1 in turn"));
  const swSel = mkSwitch(t("Select"), t("Select mode: when on, clicking a panel image selects it (numbered in click order), click again to deselect; only selected images are output and clicking no longer opens the zoom preview"));
  swBatch.cb.onchange = function () {
    const st = readState(node);
    st.batch = swBatch.cb.checked;
    writeState(node, st);
    renderPanel(node);
  };
  swSel.cb.onchange = function () {
    const st = readState(node);
    st.select = swSel.cb.checked;
    if (!st.select) st.picked = [];   // 关掉选择模式 = 回到全部输出，选择集清空
    writeState(node, st);
    renderPanel(node);
  };
  top.append(title, count, swBatch.lab, swSel.lab, btns);
  const body = document.createElement("div");
  body.className = "kd-body";
  card.append(top, body);

  node._kdUI = { card, body, count, libBtn, upBtn, fileEl, runBtn, swBatchCb: swBatch.cb, swSelCb: swSel.cb };
  // 选择/框选手势（仅选择模式生效）：点击切换、Shift 范围、点击空白清空、拖框多选
  kdGesture(body, () => Array.from(body.querySelectorAll(".kd-cell")), {
    enabled: () => !!readState(node).select,
    onCellTap(idx, shift) {
      const st = readState(node);
      st.picked = st.picked || [];
      if (shift && typeof node.__kdAnchor === "number" && node.__kdAnchor >= 0 && node.__kdAnchor < st.images.length) {
        const lo = Math.min(node.__kdAnchor, idx), hi = Math.max(node.__kdAnchor, idx);
        for (let k = lo; k <= hi; k++) {
          const fn = (st.images[k] || {}).filename;
          if (fn && st.picked.indexOf(fn) < 0) st.picked.push(fn);
        }
      } else {
        const fn = (st.images[idx] || {}).filename;
        if (fn) {
          const at = st.picked.indexOf(fn);
          if (at >= 0) st.picked.splice(at, 1); else st.picked.push(fn);
        }
      }
      node.__kdAnchor = idx;
      writeState(node, st);
      renderPanel(node);
    },
    onBlankTap() {
      const st = readState(node);
      if (!st.select || !(st.picked || []).length) return;
      st.picked = [];
      writeState(node, st);
      renderPanel(node);
    },
    onMarquee(idxs) {
      const st = readState(node);
      if (!st.select) return;
      st.picked = st.picked || [];
      for (const i of idxs) {
        const fn = (st.images[i] || {}).filename;
        if (fn && st.picked.indexOf(fn) < 0) st.picked.push(fn);
      }
      writeState(node, st);
      renderPanel(node);
    },
  });
  // 拖拽排序（普通模式）：拖格子换位置，顺序 = 输出槽顺序；选择模式禁拖（顺序由点击决定）
  let kdSort = null;
  body.addEventListener("mousedown", (e) => {
    const slot = e.target.closest(".kd-cell");
    if (!slot || e.target.closest(".kd-x")) return;
    slot.draggable = !readState(node).select;
  });
  body.addEventListener("dragstart", (e) => {
    const slot = e.target.closest(".kd-cell");
    if (!slot) return;
    if (readState(node).select) { slot.draggable = false; e.preventDefault(); return; }
    const cells = Array.from(body.querySelectorAll(".kd-cell"));
    kdSort = { el: slot, idx: cells.indexOf(slot) };
    slot.style.opacity = "0.45";
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", "kd-cell"); } catch (err) { /* 忽略 */ }
    }
  });
  body.addEventListener("dragover", (e) => {
    if (!kdSort) return;
    const slot = e.target.closest(".kd-cell");
    if (!slot || slot === kdSort.el || !body.contains(slot)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    body.querySelectorAll(".kd-cell").forEach((c) => c.classList.remove("drag-over"));
    slot.classList.add("drag-over");
  });
  body.addEventListener("drop", (e) => {
    if (!kdSort) return;
    e.preventDefault();
    const slot = e.target.closest(".kd-cell");
    const cells = Array.from(body.querySelectorAll(".kd-cell"));
    const from = kdSort.idx;
    const to = slot ? cells.indexOf(slot) : -1;
    const st = readState(node);
    if (to >= 0 && from !== to && from < st.images.length && to < st.images.length) {
      const moved = st.images.splice(from, 1)[0];
      st.images.splice(to, 0, moved);
      writeState(node, st);
    }
    body.querySelectorAll(".kd-cell").forEach((c) => c.classList.remove("drag-over"));
    kdSort = null;
    renderPanel(node);
  });
  body.addEventListener("dragend", () => {
    if (kdSort) {
      kdSort = null;
      body.querySelectorAll(".kd-cell").forEach((c) => c.classList.remove("drag-over"));
    }
  });
  node.addDOMWidget("kedou_media", "div", card, {
    getMinHeight: () => 200,
    hideOnZoom: false,
    serialize: false,
  });

  // 语言切换时面板文案要即时跟着变（库弹窗是临时 DOM，下次打开自然用新语言）
  node.__kdLocaleUnsub = onLocaleChange(() => {
    try { renderPanel(node); } catch (_) { /* 单个面板重绘失败不牵连其它 */ }
  });

  upBtn.onclick = () => fileEl.click();
  fileEl.onchange = () => {
    const files = [...(fileEl.files || [])];
    fileEl.value = "";
    if (files.length) uploadFilesWrapper(node, files);
  };
  libBtn.onclick = () => {
    openLibrary((list) => {
      const state = readState(node);
      const have = new Set(state.images.map((it) => it.filename));
      for (const it of list) if (!have.has(it.filename)) state.images.push({ filename: it.filename });
      state.images = state.images.slice(0, IMG_SLOTS);
      writeState(node, state);
      renderPanel(node);
    });
  };

  hookWidget(wOf(node, "media_state"), () => renderPanel(node));
  const onConn = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const r = typeof onConn === "function" ? onConn.apply(this, arguments) : undefined;
    setTimeout(() => { syncOutputs(node); resizeToContent(node); }, 0);
    return r;
  };
  const onCfg = node.onConfigure;
  node.onConfigure = function () {
    const r = typeof onCfg === "function" ? onCfg.apply(this, arguments) : undefined;
    // 配置同步阶段先只增不删（连线/控件可能还没恢复）；deferred 的这次 render
    // 发生在整张图 configure 之后，此时再按实际图片数收槽、断开多余连线。
    node.__kdGrowOnly = true;
    setTimeout(() => {
      node.__kdGrowOnly = false;
      renderPanel(node);
    }, 0);
    return r;
  };
  // 节点被删除时断开 ResizeObserver，否则观察着一个已移除的容器属于白占内存
  const onRm = node.onRemoved;
  node.onRemoved = function () {
    if (node.__kdRO) { node.__kdRO.disconnect(); node.__kdRO = null; }
    if (node.__kdLocaleUnsub) { node.__kdLocaleUnsub(); node.__kdLocaleUnsub = null; }
    return typeof onRm === "function" ? onRm.apply(this, arguments) : undefined;
  };
  const size = node.size || [360, 320];
  node.setSize([Math.max(Number(size[0]) || 0, 360), Math.max(Number(size[1]) || 0, 320)]);
  renderPanel(node);
}

app.registerExtension({
  name: "kedou.imageLoader",
  async nodeCreated(node) {
    const cls = (node.constructor && node.constructor.comfyClass) || node.comfyClass || "";
    if (cls !== NODE_CLASS) return;
    await initI18n(app);   // 语言包就绪后再构建界面（重复调用只生效一次）
    try {
      build(node);
    } catch (e) {
      console.error("[kedou] 图片加载器界面构建失败", e);
    }
  },
});

// ====================================================================
// 「打包应用」内嵌面板（kapp 打包面板专用）
// --------------------------------------------------------------------
// 入口按钮：优先挂 ComfyUI 顶层菜单（app.ui.menuContainer / 旧版 .comfy-menu），
// 都失败则右下角悬浮 pill。点击弹侧面板：从 app.graph._nodes 收集启用节点的
// widget 候选，勾选 + 改名 + 改控件类型，点「生成应用包」把 graph（app.graphToPrompt()
// 的 output 即 API 格式）与勾选参数 POST 到 /ps/pack/save。不依赖工作流先保存。
// 这套逻辑与上面的 KedouImageLoader 面板完全独立，互不影响。

const KP_WIDGETS = ["text", "number", "toggle", "combo", "image", "kedou_media", "prompt"];
// 下拉里显示的名字：值是落进 kapp 的协议字段，不能翻；只有显示名走 t()。
// 说明：toggle 在 PS 面板里渲染成真开关（spec.type == BOOLEAN → .sw），所以叫「开关」；
// prompt 是「提示词 + 用途」复合控件，启动器里渲染成带词库/历史的完整提示词框。
const KP_WIDGET_LABEL = {
  text: "Text", number: "Number", toggle: "Switch",
  combo: "Dropdown", image: "Image", kedou_media: "Kedou image set",
  prompt: "Prompt box",
};
// 主题适配（2026-09-28）：全部颜色改走 ComfyUI 主题变量，白/黑主题自动切换。
// 实测取自本机 comfyui_frontend_package 的 main-*.css：
//   随主题变（可用）：--fg-color(黑#fff/白#000) --bg-color --content-bg(#4e4e4e/#e0e0e0)
//                    --interface-panel-surface(charcoal-800/white) --interface-stroke
//                    --error-text --backdrop
//   恒定深色（不可用，白主题下仍是黑块）：--comfy-menu-bg --comfy-input-bg
//                    --border-color --descrip-text --input-text
// 所有 var() 都带一份深色回退值，老前端没有这些变量时保持原外观。
const KPCSS = [
  ".kp-ov{position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.45);display:flex;justify-content:flex-end;}",
  ".kp-panel{width:min(400px,94vw);height:100vh;background:var(--interface-panel-surface,rgba(28,28,34,.98));color:var(--fg-color,#e7e7ea);",
  "border-left:1px solid var(--interface-stroke,#3a3a44);display:flex;flex-direction:column;font:12.5px/1.5 system-ui,sans-serif;",
  "box-shadow:-8px 0 30px rgba(0,0,0,.4);}",
  ".kp-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:move;",
  "border-bottom:1px solid var(--interface-stroke,#3a3a44);user-select:none;}",
  ".kp-hd b{font-size:13.5px;}",
  ".kp-hd .kp-x{margin-left:auto;width:22px;height:22px;border:0;border-radius:6px;cursor:pointer;",
  "background:transparent;color:var(--fg-color,#e7e7ea);opacity:.7;font-size:15px;}",
  ".kp-hd .kp-x:hover{background:var(--content-bg,#e0e0e0);opacity:1;}",
  ".kp-body{padding:12px;display:flex;flex-direction:column;gap:10px;flex:1;overflow:auto;}",
  ".kp-field{display:flex;flex-direction:column;gap:4px;}",
  ".kp-field label{font-size:11px;color:var(--fg-color,#e7e7ea);opacity:.62;}",
  ".kp-field input,.kp-field textarea{background:var(--content-bg,#e0e0e0);border:1px solid var(--interface-stroke,#3a3a44);",
  "color:var(--fg-color,#e7e7ea);font:inherit;padding:6px 8px;border-radius:7px;outline:none;width:100%;box-sizing:border-box;}",
  ".kp-field select{background:var(--content-bg,#e0e0e0);border:1px solid var(--interface-stroke,#3a3a44);",
  "color:var(--fg-color,#e7e7ea);font:inherit;padding:6px 8px;border-radius:7px;outline:none;width:100%;box-sizing:border-box;}",
  ".kp-field input:focus,.kp-field textarea:focus,.kp-field select:focus{border-color:var(--p-primary-color,#4a7dff);}",
  ".kp-chk{display:flex;align-items:center;gap:6px;font-size:11.5px;cursor:pointer;user-select:none;opacity:.9;}",
  ".kp-chk input{width:14px;height:14px;accent-color:var(--p-primary-color,#4a7dff);cursor:pointer;flex:none;}",
  ".kp-toolbar{display:flex;align-items:center;gap:8px;}",
  ".kp-tbtn{border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#e7e7ea);font:inherit;font-size:11px;",
  "padding:4px 10px;border-radius:7px;cursor:pointer;}",
  ".kp-tbtn:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kp-count{margin-left:auto;font-size:11px;color:var(--fg-color,#e7e7ea);opacity:.62;}",
  ".kp-row{display:flex;align-items:flex-start;gap:7px;padding:7px 8px;border:1px solid var(--interface-stroke,#3a3a44);border-radius:8px;",
  "background:transparent;}",
  ".kp-row input[type=checkbox]{width:15px;height:15px;accent-color:var(--p-primary-color,#4a7dff);cursor:pointer;margin-top:5px;flex:none;}",
  ".kp-box{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}",
  ".kp-lab{background:var(--content-bg,#e0e0e0);border:1px solid var(--interface-stroke,#3a3a44);color:inherit;font:inherit;font-size:11.5px;",
  "padding:4px 6px;border-radius:6px;outline:none;width:100%;box-sizing:border-box;}",
  ".kp-lab:focus{border-color:var(--p-primary-color,#4a7dff);}",
  ".kp-sel{width:84px;flex:none;font-size:11px;padding:4px;background:var(--content-bg,#e0e0e0);border:1px solid var(--interface-stroke,#3a3a44);",
  "color:inherit;border-radius:6px;outline:none;align-self:center;}",
  ".kp-sub{font-size:10.5px;color:var(--fg-color,#e7e7ea);opacity:.58;}",
  ".kp-val{font-size:10.5px;color:var(--fg-color,#e7e7ea);opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".kp-err{color:var(--error-text,#ff7a7a);font-size:11.5px;min-height:14px;}",
  ".kp-ft{padding:10px 12px;border-top:1px solid var(--interface-stroke,#3a3a44);}",
  ".kp-gen{width:100%;border:0;background:var(--p-primary-color,#4a7dff);color:#fff;font:inherit;font-weight:600;font-size:13px;",
  "padding:9px;border-radius:8px;cursor:pointer;}",
  ".kp-gen:hover{filter:brightness(1.1);}",
  ".kp-gen[disabled]{opacity:.5;cursor:default;}",
  ".kp-menu-btn{margin-left:8px;padding:4px 10px;border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#e7e7ea);",
  "font:inherit;font-size:12px;border-radius:7px;cursor:pointer;}",
  ".kp-menu-btn:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kp-pill{position:fixed;right:18px;bottom:18px;z-index:99990;padding:10px 16px;border:1px solid var(--interface-stroke,#3a3a44);border-radius:999px;",
  "background:var(--interface-panel-surface,rgba(20,20,26,.85));color:var(--fg-color,#e7e7ea);font:inherit;font-size:13px;cursor:pointer;",
  "box-shadow:0 6px 20px rgba(0,0,0,.45);backdrop-filter:blur(6px);}",
  ".kp-pill:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kp-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(12px);",
  "z-index:99999;padding:10px 18px;border-radius:9px;border:1px solid var(--interface-stroke,#3a3a44);",
  "background:var(--interface-panel-surface,rgba(30,30,38,.96));color:var(--fg-color,#e7e7ea);",
  "font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 26px rgba(0,0,0,.5);opacity:0;transition:.3s;pointer-events:none;}",
  ".kp-toast.kp-show{opacity:1;transform:translateX(-50%) translateY(0);}",
  ".kp-toast.kp-err{border-color:var(--error-text,#a33);color:var(--error-text,#ffb3b3);}",
  // 侧栏内嵌模式覆盖（挂进 ComfyUI 左侧栏页签时用）
  // 2026-09-28：底色改为随主题。原来是写死的深色 rgba(28,28,34,.98)——当初是怕
  // 「白底 + 浅字」隐形才涂黑，结果白色主题下变成一块黑砖；正解是底和字都跟着主题走。
  // 高度 auto —— 超长内容由页签容器滚动（openPackPanel 里会给宿主开 overflowY）
  ".kp-inset{position:static;width:auto;height:auto;max-height:none;border:0;border-radius:10px;box-shadow:none;background:var(--interface-panel-surface,rgba(28,28,34,.98));color:var(--fg-color,#e7e7ea);}",
  // 参数按节点分组的折叠组
  ".kp-grp{border:1px solid var(--interface-stroke,#3a3a44);border-radius:8px;background:transparent;overflow:hidden;}",
  ".kp-ghead{display:flex;align-items:center;gap:6px;padding:7px 8px;cursor:pointer;user-select:none;}",
  ".kp-ghead:hover{background:var(--content-bg,#e0e0e0);}",
  ".kp-gcaret{font-size:9px;color:var(--fg-color,#e7e7ea);opacity:.6;transition:transform .15s;flex:none;}",
  ".kp-gtitle{font-size:12px;font-weight:600;color:var(--fg-color,#e7e7ea);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  // 计数左、按钮右：计数靠 margin-left:auto 顶到右边，按钮跟在它后面贴最右。
  // 按钮定宽 + 居中 —— 「全选」和「取消全选」字数不同，不定宽会让各行按钮左右参差。
  ".kp-gcnt{margin-left:auto;font-size:10.5px;color:var(--fg-color,#e7e7ea);opacity:.6;flex:none;}",
  ".kp-gsel{border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#e7e7ea);font:inherit;font-size:10.5px;padding:2px 7px;border-radius:6px;cursor:pointer;flex:none;min-width:60px;text-align:center;}",
  // 顶部「全选/取消全选」同理定宽，切换时不挤动右邻居
  ".kp-tbtn.kp-tall{min-width:66px;text-align:center;}",
  ".kp-gsel:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kp-gbody{display:flex;flex-direction:column;gap:7px;padding:8px;}",
  ".kp-syncbtn.kp-on,.kp-tbtn.kp-on{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);background:rgba(74,125,255,.12);}",
].join("");

let kpCssDone = false;
function ensurePackCss() {
  if (kpCssDone || document.getElementById("kp-css")) {
    kpCssDone = true;
    return;
  }
  const s = document.createElement("style");
  s.id = "kp-css";
  s.textContent = KPCSS;
  document.head.appendChild(s);
  kpCssDone = true;
}

let kpOverlay = null;
let kpUnsubRepaint = null;   // 面板常驻/浮层共用：关闭或重建时注销语言订阅
let kpSyncTimer = null;      // 「画布点选」定时器（关闭/重建时必须清，否则泄漏累积）
let kpRefreshTimer = null;   // 侧栏面板的工作流切换监视器
let kpOpenGraph = "";        // 打开面板时的工作流 id；生成前复核，防止拿着旧候选打包
function kpOnKey(e) { if (e.key === "Escape") closePackPanel(); }

function kpGraphKey() {
  const g = app.graph;
  return String((g && g.id) || "none");
}

function stopPackPanelRuntime() {
  if (kpSyncTimer) { clearInterval(kpSyncTimer); kpSyncTimer = null; }
  if (kpRefreshTimer) { clearInterval(kpRefreshTimer); kpRefreshTimer = null; }
  if (kpUnsubRepaint) { kpUnsubRepaint(); kpUnsubRepaint = null; }
}

function closePackPanel() {
  // 侧栏面板由 ComfyUI 页签托管，这里只负责关闭浮层
  if (!kpOverlay) return;
  stopPackPanelRuntime();
  kpOverlay.remove();
  kpOverlay = null;
  kpOpenGraph = "";
  document.removeEventListener("keydown", kpOnKey, true);
}

function kpToast(msg, isErr) {
  const el = document.createElement("div");
  el.className = "kp-toast" + (isErr ? " kp-err" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.classList.add("kp-show"); }, 10);
  setTimeout(() => { el.classList.remove("kp-show"); setTimeout(() => el.remove(), 300); }, 2800);
}

function kpPreview(v, widget) {
  if (widget === "image" || widget === "kedou_media") {
    const s = String(v == null ? "" : v);
    return (s.split("/").pop() || t("(not selected)")).slice(0, 40);
  }
  if (v === true || v === false) return String(v);
  if (v == null) return t("(empty)");
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

// 「提示词框」复合控件：提示词主体输入 -> 同节点里承载用途的输入名（没有则空串）。
// 与 KedouImageLoader / LoadImage 两处品牌特判同性质：只认本家节点，不按应用推断。
function promptUsageOf(ntype, name) {
  return (ntype === "KedouPromptBox" && name === "prompt_state") ? "usage" : "";
}

function suggestWidget(node, w) {
  const ntype = node.type || node.comfyClass || "";
  if (ntype === "KedouImageLoader" && w.name === "media_state") return "kedou_media";
  if (ntype === "LoadImage" && w.name === "image") return "image";
  if (promptUsageOf(ntype, w.name)) return "prompt";
  if (w.type === "INT" || w.type === "FLOAT") return "number";
  if (w.type === "BOOLEAN") return "toggle";
  if (w.type === "COMBO") return "combo";
  // 自定义类型名（如 ResolutionSelector 的 aspect_ratio）：控件对象里有选项列表就是下拉，
  // 不应按类型名推断：判为 text 会使应用中的下拉退化为输入框
  const vals = comboValuesOf(w);
  if (vals && vals.length) return "combo";
  return "text";
}

// 真机 combo 选项列表：标准在 w.options.values；个别插件给函数（动态生成），调用一次取回
function comboValuesOf(w) {
  const o = w && w.options;
  if (!o) return null;
  let v = o.values;
  if (typeof v === "function") {
    try { v = v(); } catch (_e) { return null; }
  }
  return Array.isArray(v) ? v : null;
}

function collectCandidates() {
  const nodes = (app.graph && app.graph._nodes) || [];
  const out = [];
  for (const node of nodes) {
    if (node.mode !== 0) continue;                 // 跳过被静音（NEVER / bypass）的节点
    const ntype = node.type || node.comfyClass || "";
    const title = (node.title || "").trim();
    const widgets = node.widgets || [];
    // 被「提示词框」吸收的输入不再单独列为候选（否则应用里会出现两个用途下拉）
    const absorbed = new Set();
    for (const w of widgets) {
      const u = promptUsageOf(ntype, w && w.name);
      if (u) absorbed.add(u);
    }
    for (const w of widgets) {
      if (w.name === "control_after_generate" || w.type === "control_after_generate") continue;
      if (absorbed.has(w.name)) continue;
      // DOM 控件是节点自绘的面板 UI 本身（图片选择器 / 提示词输入框），没有值，不能当参数
      if (w.type === "div" || w.name === "kedou_media" || w.name === "kedou_promptbox") continue;
      if (w.type === "converted-widget" &&
          !(ntype === "KedouImageLoader" && w.name === "media_state")) continue;  // 隐藏格
      // 已转换为输入且连着上游的 widget：值由上游驱动，打包成可调参数会在运行时破坏连线，故不提供勾选
      if (w.type === "converted-widget" && Array.isArray(node.inputs)
          && node.inputs.some((inp) => inp && inp.name === w.name && inp.link != null)) continue;
      const widget = suggestWidget(node, w);
      // 能力采集与建议类型解耦：选项/范围/多行一律从真机控件对象取下来存进候选，
      // 用户手动改控件类型（如文本→下拉）时能力不丢：仅按建议类型采集时，
      // 自定义类型名的下拉（ResolutionSelector 的 aspect_ratio）会落为空输入框
      const opt = w.options && typeof w.options === "object" ? w.options : {};
      let min, max, step;
      if (typeof opt.min === "number") min = opt.min;
      if (typeof opt.max === "number") max = opt.max;
      if (typeof opt.step === "number") step = opt.step;
      const options = comboValuesOf(w) ? comboValuesOf(w).slice() : null;
      const multiline = !!opt.multiline;
      // 复合控件的能力项一起存进候选：用户把建议类型改掉再改回来时不丢用途信息
      const usage = promptUsageOf(ntype, w.name);
      let usageInput, usageOptions, usageDefault;
      if (usage) {
        const uw = widgets.find((x) => x && x.name === usage);
        usageInput = usage;
        const uv = uw ? comboValuesOf(uw) : null;
        if (uv && uv.length) usageOptions = uv.slice();
        usageDefault = uw ? uw.value : undefined;
      }
      out.push({
        node: String(node.id), input: w.name, widget, default: w.value,
        node_type: ntype, node_title: title,
        min, max, step, options, multiline,
        usage_input: usageInput, usage_options: usageOptions, usage_default: usageDefault,
        label: title || w.name,
        valuePreview: kpPreview(w.value, widget),
      });
    }
  }
  return out;
}

function defaultAppName() {
  try {
    const g = app.graph;
    if (g && g.title) return g.title;
  } catch (_) { /* ignore */ }
  try {
    const wf = app.workflowManager && app.workflowManager.activeWorkflow;
    if (wf && wf.name) return wf.name;
  } catch (_) { /* ignore */ }
  return "untitled";
}

function openPackPanel(hostEl) {
  ensurePackCss();
  const sidebar = !!hostEl;                         // 侧栏模式：内容直接挂进页签元素
  const gkey = kpGraphKey();
  if (sidebar) {
    if (hostEl.dataset.kpMounted && hostEl.dataset.kpGraph === gkey) return;
    // 工作流切了：清掉旧候选，按新图重建
    hostEl.dataset.kpMounted = "1";
    hostEl.dataset.kpGraph = gkey;
    hostEl.innerHTML = "";
  } else if (kpOverlay) return;                     // 面板已开，不叠加
  stopPackPanelRuntime();
  kpOpenGraph = gkey;

  const ov = sidebar ? null : document.createElement("div");
  if (ov) ov.className = "kp-ov";
  const panel = document.createElement("div");
  panel.className = "kp-panel" + (sidebar ? " kp-inset" : "");

  const hd = document.createElement("div");
  hd.className = "kp-hd";
  const titleEl = document.createElement("b");
  titleEl.textContent = t("Pack app");
  const x = document.createElement("button");
  x.className = "kp-x";
  x.textContent = "×";
  x.onclick = closePackPanel;
  hd.append(titleEl, x);

  const body = document.createElement("div");
  body.className = "kp-body";

  const editField = document.createElement("div");
  editField.className = "kp-field";
  const editLab = document.createElement("label");
  editLab.textContent = t("Edit packaged app");
  const editSel = document.createElement("select");
  editSel.appendChild(new Option(t("New app"), ""));
  editField.append(editLab, editSel);

  const nameField = document.createElement("div");
  nameField.className = "kp-field";
  const nameLab = document.createElement("label");
  nameLab.textContent = t("App name");
  const nameInput = document.createElement("input");
  nameInput.value = defaultAppName();
  nameField.append(nameLab, nameInput);

  const descField = document.createElement("div");
  descField.className = "kp-field";
  const descLab = document.createElement("label");
  descLab.textContent = t("Description (optional)");
  const descInput = document.createElement("input");
  descInput.placeholder = t("One sentence describing what this app does");
  descField.append(descLab, descInput);

  const graphField = document.createElement("label");
  graphField.className = "kp-chk";
  graphField.style.display = "none";
  const graphCb = document.createElement("input");
  graphCb.type = "checkbox";
  const graphSpan = document.createElement("span");
  graphSpan.textContent = t("Update graph from current workflow");
  graphField.append(graphCb, graphSpan);

  const toolbar = document.createElement("div");
  toolbar.className = "kp-toolbar";
  const allBtn = document.createElement("button");
  allBtn.className = "kp-tbtn kp-tall";
  allBtn.textContent = t("Select all");
  allBtn.title = t("Check all / uncheck all");
  const cnt = document.createElement("span");
  cnt.className = "kp-count";
  cnt.textContent = t("Selected {n}", { n: 0 });
  const syncBtn = document.createElement("button");
  syncBtn.className = "kp-tbtn kp-syncbtn";
  syncBtn.textContent = t("Pick on canvas");
  syncBtn.title = t("When active, clicking a node on the canvas expands its parameters here");
  const selOnlyBtn = document.createElement("button");
  selOnlyBtn.className = "kp-tbtn";
  selOnlyBtn.textContent = t("Selected only");
  selOnlyBtn.title = t("Show only checked parameters");
  toolbar.append(allBtn, syncBtn, selOnlyBtn, cnt);

  const rowsWrap = document.createElement("div");
  rowsWrap.style.display = "flex";
  rowsWrap.style.flexDirection = "column";
  rowsWrap.style.gap = "7px";

  const err = document.createElement("div");
  err.className = "kp-err";

  const ft = document.createElement("div");
  ft.className = "kp-ft";
  const gen = document.createElement("button");
  gen.className = "kp-gen";
  gen.textContent = t("Generate app package");
  ft.appendChild(gen);

  body.append(editField, nameField, descField, graphField, toolbar, rowsWrap, err);
  if (sidebar) {
    // 侧栏模式：无标题栏/遮罩/Esc，内容直接挂进页签
    panel.append(body, ft);
    try {
      // 面板自然高度常超页签可视区 —— 让页签容器自行滚动，否则「生成应用包」按钮会超出可视范围
      hostEl.style.overflowY = "auto";
      hostEl.style.maxHeight = "100%";
      hostEl.style.boxSizing = "border-box";
    } catch (_) { /* ignore */ }
    hostEl.appendChild(panel);
  } else {
    panel.append(hd, body, ft);
    ov.appendChild(panel);

    ov.onclick = (e) => { if (e.target === ov) closePackPanel(); };
    document.body.appendChild(ov);
    kpOverlay = ov;
    document.addEventListener("keydown", kpOnKey, true);
  }

  // ---- 收集候选并渲染（按节点分组；官方构建模式同款节奏：点画布节点 -> 面板展开该组） ----
  const candidates = collectCandidates();
  const rows = [];
  const groups = [];
  let onlySel = false;

  // 「全选 / 取消全选」是同一个按钮的两态：全勾满了显示「取消全选」，否则显示「全选」。
  // 任何勾选变化（单条、组全选、顶部全选）都会走 updateCount -> 这里，保持一致。
  const syncToggleLabels = () => {
    allBtn.textContent = (rows.length && rows.every((r) => r.cb.checked)) ? t("Unselect all") : t("Select all");
    for (const g of groups) {
      if (!g.selAllEl) continue;
      g.selAllEl.textContent = (g.rows.length && g.rows.every((r) => r.cb.checked)) ? t("Unselect all") : t("Select all");
    }
  };
  const updateCount = () => {
    cnt.textContent = t("Selected {n}", { n: rows.filter((r) => r.cb.checked).length });
    for (const g of groups) {
      const sel = g.rows.filter((r) => r.cb.checked).length;
      g.cntEl.textContent = sel ? sel + "/" + g.rows.length : t("{n} items", { n: g.rows.length });
    }
    syncToggleLabels();
  };
  const applyFilter = () => {
    for (const g of groups) {
      const anyChecked = g.rows.some((r) => r.cb.checked);
      g.grpEl.style.display = (!onlySel || anyChecked) ? "" : "none";
      if (onlySel) {
        if (anyChecked) g.open = true;
        for (const r of g.rows) r.el.style.display = r.cb.checked ? "" : "none";
      } else {
        for (const r of g.rows) r.el.style.display = "";
      }
      g.bodyEl.style.display = (g.open && (!onlySel || anyChecked)) ? "" : "none";
      g.caretEl.style.transform = g.open ? "rotate(90deg)" : "";
    }
  };

  let emptyEl = null;
  if (!candidates.length) {
    const empty = document.createElement("div");
    empty.style.color = "var(--fg-color,#9a9aa6)";
    empty.style.opacity = ".62";
    empty.style.fontSize = "11.5px";
    empty.textContent = t("No exposeable widgets in the current workflow (all nodes are connection-type?).");
    rowsWrap.appendChild(empty);
    emptyEl = empty;
  }

  // 按节点分组（保持画布顺序）；默认全部收起 —— 用「点画布选」或点组标题展开
  const byNode = new Map();
  for (const c of candidates) {
    if (!byNode.has(c.node)) byNode.set(c.node, []);
    byNode.get(c.node).push(c);
  }
  const groupNames = {};   // 记住分组标题原文（非译文），语言切换时可重设

  const openGroup = (g, scroll) => {
    g.open = true;
    g.bodyEl.style.display = "";
    g.caretEl.style.transform = "rotate(90deg)";
    if (scroll) {
      try {
        const scroller = sidebar ? hostEl : (rowsWrap.closest(".kp-ov") || rowsWrap.parentElement);
        const top = g.headEl.getBoundingClientRect().top
          - scroller.getBoundingClientRect().top + scroller.scrollTop - 6;
        scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      } catch (_) { /* ignore */ }
    }
  };
  const closeGroup = (g) => {
    g.open = false;
    g.bodyEl.style.display = "none";
    g.caretEl.style.transform = "";
  };

  // 建一行参数（画布候选 / 已打包应用里的孤立参数共用）
  const addRow = (c, g) => {
    const row = document.createElement("div");
    row.className = "kp-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const box = document.createElement("div");
    box.className = "kp-box";
    const lab = document.createElement("input");
    lab.className = "kp-lab";
    lab.value = c.label;
    const sub = document.createElement("div");
    sub.className = "kp-sub";
    sub.textContent = "#" + c.node + " · " + c.input;
    const val = document.createElement("div");
    val.className = "kp-val";
    val.textContent = t("Current value: {v}", { v: c.valuePreview });
    box.append(lab, sub, val);
    const sel = document.createElement("select");
    sel.className = "kp-sel";
    for (const opt of KP_WIDGETS) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = t(KP_WIDGET_LABEL[opt] || opt);
      if (opt === c.widget) o.selected = true;
      sel.appendChild(o);
    }
    if (KP_WIDGETS.indexOf(c.widget) < 0) sel.value = "text";
    row.append(cb, box, sel);
    g.bodyEl.appendChild(row);
    const entry = { cb, lab, sel, c, el: row, valEl: val, existingParam: null };
    rows.push(entry);
    g.rows.push(entry);
    cb.onchange = () => { updateCount(); if (onlySel) applyFilter(); };
    return entry;
  };

  for (const [nodeId, list] of byNode) {
    const g = { node: nodeId, rows: [], open: false };
    const grp = document.createElement("div");
    grp.className = "kp-grp";
    const head = document.createElement("div");
    head.className = "kp-ghead";
    const caret = document.createElement("span");
    caret.className = "kp-gcaret";
    caret.textContent = "▶";
    const ttl = document.createElement("span");
    ttl.className = "kp-gtitle";
    const gName = list[0].node_title || list[0].node_type || t("Node {id}", { id: nodeId });
    groupNames[nodeId] = gName;
    ttl.textContent = gName;
    ttl.title = ttl.textContent;
    const selAll = document.createElement("button");
    selAll.className = "kp-gsel";
    selAll.textContent = t("Select all");
    selAll.title = t("Select all / none for this node");
    selAll.onclick = (e) => {
      e.stopPropagation();
      const all = g.rows.length > 0 && g.rows.every((r) => r.cb.checked);
      g.rows.forEach((r) => { r.cb.checked = !all; });
      updateCount(); applyFilter();
    };
    const gcnt = document.createElement("span");
    gcnt.className = "kp-gcnt";
    head.append(caret, ttl, gcnt, selAll);   // 计数在左、按钮贴最右，各行按钮才对齐
    head.onclick = () => { g.open ? closeGroup(g) : openGroup(g, false); };
    const bodyEl = document.createElement("div");
    bodyEl.className = "kp-gbody";
    bodyEl.style.display = "none";
    grp.append(head, bodyEl);
    rowsWrap.appendChild(grp);
    Object.assign(g, { headEl: head, bodyEl, caretEl: caret, cntEl: gcnt, selAllEl: selAll, grpEl: grp, ttlEl: ttl });

    for (const c of list) addRow(c, g);
    groups.push(g);
  }
  updateCount();

  // ---- 编辑已打包应用 ----
  // 选一个 .kapp.json 后，把它的参数映射回当前画布的候选行；当前画布不存在的
  // 参数放进「Not in current workflow」组，仍可改标签/控件或取消勾选。
  let editing = null;        // {file, kapp}
  let orphanGroup = null;

  const setPrimaryLabel = () => {
    gen.textContent = editing ? t("Save changes") : t("Generate app package");
  };
  const removeOrphanGroup = () => {
    if (!orphanGroup) return;
    const gi = groups.indexOf(orphanGroup);
    if (gi >= 0) groups.splice(gi, 1);
    orphanGroup.grpEl.remove();
    for (const r of orphanGroup.rows) {
      const ri = rows.indexOf(r);
      if (ri >= 0) rows.splice(ri, 1);
    }
    orphanGroup = null;
    if (emptyEl) emptyEl.style.display = "";
  };
  const resetRows = () => {
    for (const r of rows) {
      r.cb.checked = false;
      r.lab.value = r.c.label;
      r.sel.value = KP_WIDGETS.indexOf(r.c.widget) >= 0 ? r.c.widget : "text";
      r.valEl.textContent = t("Current value: {v}", { v: kpPreview(r.c.default, r.sel.value) });
      r.existingParam = null;
    }
  };
  const ensureOrphanGroup = () => {
    if (orphanGroup) return orphanGroup;
    const g = { node: "__orphan__", rows: [], open: true };
    const grp = document.createElement("div");
    grp.className = "kp-grp";
    const head = document.createElement("div");
    head.className = "kp-ghead";
    const caret = document.createElement("span");
    caret.className = "kp-gcaret";
    caret.textContent = "▶";
    caret.style.transform = "rotate(90deg)";
    const ttl = document.createElement("span");
    ttl.className = "kp-gtitle";
    ttl.textContent = t("Not in current workflow");
    const gcnt = document.createElement("span");
    gcnt.className = "kp-gcnt";
    const selAll = document.createElement("button");
    selAll.className = "kp-gsel";
    selAll.textContent = t("Unselect all");
    selAll.title = t("Select all / none for this node");
    selAll.onclick = (e) => {
      e.stopPropagation();
      const all = g.rows.length > 0 && g.rows.every((r) => r.cb.checked);
      g.rows.forEach((r) => { r.cb.checked = !all; });
      updateCount(); applyFilter();
    };
    head.append(caret, ttl, gcnt, selAll);
    head.onclick = () => { g.open ? closeGroup(g) : openGroup(g, false); };
    const bodyEl = document.createElement("div");
    bodyEl.className = "kp-gbody";
    grp.append(head, bodyEl);
    rowsWrap.appendChild(grp);
    Object.assign(g, { headEl: head, bodyEl, caretEl: caret, cntEl: gcnt, selAllEl: selAll, grpEl: grp, ttlEl: ttl });
    groups.push(g);
    orphanGroup = g;
    if (emptyEl) emptyEl.style.display = "none";
    return g;
  };
  const applyEditing = (file, kapp) => {
    editing = { file, kapp: kapp || {} };
    removeOrphanGroup();
    resetRows();
    nameInput.value = String(editing.kapp.name || "");
    nameInput.title = t("For an existing app, this only changes the display name; the file name stays.");
    descInput.value = String(editing.kapp.desc || "");
    graphCb.checked = false;
    graphField.style.display = "";
    const params = Array.isArray(editing.kapp.params) ? editing.kapp.params : [];
    for (const p of params) {
      if (!p || typeof p !== "object") continue;
      const nodeId = String(p.node == null ? "" : p.node);
      const input = String(p.input == null ? "" : p.input);
      const widget = KP_WIDGETS.indexOf(p.widget) >= 0 ? p.widget : "text";
      let r = rows.find((x) => x.c.node === nodeId && x.c.input === input);
      if (!r) {
        r = addRow({
          node: nodeId, input, widget,
          default: p.default,
          node_type: p.node_type || "", node_title: p.node_title || "",
          label: p.label || input,
          valuePreview: kpPreview(p.default, widget),
          min: p.min, max: p.max, step: p.step,
          options: Array.isArray(p.options) ? p.options : null,
          multiline: !!p.multiline,
          usage_input: p.usage_input,
          usage_options: p.usage_options,
          usage_default: p.usage_default,
        }, ensureOrphanGroup());
      }
      r.cb.checked = true;
      r.lab.value = String(p.label || input);
      r.sel.value = widget;
      r.valEl.textContent = t("Current value: {v}", { v: kpPreview(p.default, widget) });
      r.existingParam = p;
    }
    updateCount();
    applyFilter();
    setPrimaryLabel();
    for (const g of groups) if (g.rows.some((r) => r.cb.checked)) openGroup(g, false);
    err.textContent = "";
  };
  const resetEditor = () => {
    editing = null;
    removeOrphanGroup();
    resetRows();
    nameInput.value = defaultAppName();
    nameInput.title = "";
    descInput.value = "";
    graphCb.checked = false;
    graphField.style.display = "none";
    updateCount();
    applyFilter();
    setPrimaryLabel();
    err.textContent = "";
  };

  const loadApps = async () => {
    try {
      const r = await fetch("/ps/pack/apps");
      let j = null;
      try { j = await r.json(); } catch (_) { /* ignore */ }
      if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
      const cur = editSel.value;
      while (editSel.options.length > 1) editSel.remove(1);
      for (const a of (j.apps || [])) {
        if (!a || a.error || !a.id) continue;
        const o = document.createElement("option");
        o.value = a.id;
        o.textContent = String(a.name || a.id) + (a.param_count ? " · " + a.param_count : "");
        editSel.appendChild(o);
      }
      if (cur) editSel.value = cur;
    } catch (e) {
      console.warn("[kedou] 打包应用列表加载失败", e);
    }
  };
  loadApps();

  let editReq = 0;            // 快速切换下拉时，丢弃过期的读取结果
  editSel.onchange = async () => {
    const id = editSel.value;
    const seq = ++editReq;
    if (!id) { resetEditor(); return; }
    err.textContent = "";
    try {
      const r = await fetch("/ps/apps/" + encodeURIComponent(id) + "/package");
      let j = null;
      try { j = await r.json(); } catch (_) { /* ignore */ }
      if (seq !== editReq) return;
      if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
      // target 相对工作流目录，回写时原样传回；file 只是展示路径（相对 ComfyUI 根）
      applyEditing(j.target || j.file, j.kapp);
    } catch (e) {
      if (seq !== editReq) return;
      const msg = serverError(e && e.message ? e.message : String(e));
      editSel.value = "";
      resetEditor();
      err.textContent = t("Failed to load app: {msg}", { msg });
    }
  };
  let syncOn = false, lastSel = null;
  syncBtn.onclick = () => {
    syncOn = !syncOn;
    syncBtn.classList.toggle("kp-on", syncOn);
    syncBtn.textContent = syncOn ? t("Syncing…") : t("Pick on canvas");
    if (syncOn) {
      lastSel = null;
      kpSyncTimer = setInterval(() => {
        try {
          const sel = app.canvas && app.canvas.selected_nodes;
          const ids = sel ? Object.keys(sel) : [];
          if (ids.length !== 1 || ids[0] === lastSel) return;
          lastSel = ids[0];
          const g = groups.find((x) => x.node === ids[0]);
          if (g) {
            // 手风琴：展开选中的这组时顺手收起其他组，不然一眼看不出打开的是哪一个。
            // 先收再开——收完布局定了，openGroup 的滚动定位才算得准。
            for (const x of groups) if (x !== g && x.open) closeGroup(x);
            openGroup(g, true);
          }
        } catch (_) { /* ignore */ }
      }, 350);
    } else {
      if (kpSyncTimer) { clearInterval(kpSyncTimer); kpSyncTimer = null; }
    }
  };

  // 只看已选
  selOnlyBtn.onclick = () => {
    onlySel = !onlySel;
    selOnlyBtn.classList.toggle("kp-on", onlySel);
    if (onlySel) groups.forEach((g) => { if (g.rows.some((r) => r.cb.checked)) g.open = true; });
    applyFilter();
  };

  // 顶部「全选 / 取消全选」：同一个按钮的两态（已全勾 -> 再点就是取消全选）
  allBtn.onclick = () => {
    const all = rows.length > 0 && rows.every((r) => r.cb.checked);
    rows.forEach((r) => { r.cb.checked = !all; });
    updateCount(); applyFilter();
  };

  // ---- 语言切换重绘：面板内的固定文案整体再 paint 一次（浮层关闭时注销订阅） ----
  // 行下方的「当前值」：编辑已有应用且不更新图时，以应用里存的 default 为准，
  // 否则显示画布上的值。控件类型被改过时按改后的类型预览。
  const rowPreview = (r) => {
    const src = (r.existingParam && !graphCb.checked) ? r.existingParam : null;
    const v = (src && Object.prototype.hasOwnProperty.call(src, "default")) ? src.default : r.c.default;
    return kpPreview(v, r.sel.value);
  };

  // 切「用当前工作流更新图」时，值预览的来源跟着切换（应用里存的 default ↔ 画布当前值）
  graphCb.onchange = () => {
    for (const r of rows) r.valEl.textContent = t("Current value: {v}", { v: rowPreview(r) });
  };

  const repaint = () => {
    titleEl.textContent = t("Pack app");
    editLab.textContent = t("Edit packaged app");
    editSel.options[0].textContent = t("New app");
    nameLab.textContent = t("App name");
    descLab.textContent = t("Description (optional)");
    descInput.placeholder = t("One sentence describing what this app does");
    nameInput.title = editing ? t("For an existing app, this only changes the display name; the file name stays.") : "";
    graphSpan.textContent = t("Update graph from current workflow");
    allBtn.title = t("Check all / uncheck all");
    syncBtn.textContent = syncOn ? t("Syncing…") : t("Pick on canvas");
    syncBtn.title = t("When active, clicking a node on the canvas expands its parameters here");
    selOnlyBtn.textContent = t("Selected only");
    selOnlyBtn.title = t("Show only checked parameters");
    if (!gen.disabled) setPrimaryLabel();
    for (const g of groups) {
      g.ttlEl.textContent = (g === orphanGroup) ? t("Not in current workflow") : groupNames[g.node];
      g.ttlEl.title = g.ttlEl.textContent;
      g.selAllEl.title = t("Select all / none for this node");
    }
    for (const r of rows) {
      r.valEl.textContent = t("Current value: {v}", { v: rowPreview(r) });
    }
    if (emptyEl) emptyEl.textContent = t("No exposeable widgets in the current workflow (all nodes are connection-type?).");
    updateCount();   // 计数与「全选/取消全选」两态文案随之刷新
  };
  kpUnsubRepaint = onLocaleChange(repaint);   // 侧栏常驻也要能注销，否则重建一次泄漏一个监听

  gen.onclick = () => doGenerate({
    nameInput, descInput, rows, err, gen, graphCb,
    editing: () => editing,
  });

  if (sidebar) {
    // 侧栏页签只挂载一次；用户切工作流后候选会全部指向旧节点 id。
    // 图 id 变了就重建面板（只看 id，不看 _version，避免拖节点也触发）。
    kpRefreshTimer = setInterval(() => {
      if (!document.contains(hostEl)) { stopPackPanelRuntime(); return; }
      if (kpGraphKey() !== hostEl.dataset.kpGraph) {
        stopPackPanelRuntime();
        hostEl.innerHTML = "";
        delete hostEl.dataset.kpMounted;
        openPackPanel(hostEl);
      }
    }, 800);
  }

  // ---- 标题栏拖拽 + 视口夹持（仅浮层模式；侧栏模式由 ComfyUI 管布局） ----
  if (sidebar) return;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  hd.addEventListener("pointerdown", (e) => {
    if (e.target === x) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    const r = panel.getBoundingClientRect();
    ox = r.left;
    oy = r.top;
    try { hd.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });
  hd.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    let nx = ox + (e.clientX - sx);
    let ny = oy + (e.clientY - sy);
    nx = Math.max(-w + 40, Math.min(window.innerWidth - 40, nx));
    ny = Math.max(0, Math.min(window.innerHeight - h, ny));
    panel.style.position = "fixed";
    panel.style.left = nx + "px";
    panel.style.top = ny + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  });
  hd.addEventListener("pointerup", (e) => {
    dragging = false;
    try { hd.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });
}

async function doGenerate(ctx) {
  if (kpOpenGraph && kpGraphKey() !== kpOpenGraph) {
    // 候选快照来自另一张图：宁可拒绝，也不要生成一个绑错节点的包
    ctx.err.textContent = t("Workflow changed; reopen the pack panel and try again.");
    return;
  }
  const editing = typeof ctx.editing === "function" ? ctx.editing() : null;
  // 编辑已有应用时默认保留原 graph / outputs，只改参数声明；
  // 勾了「用当前工作流更新图」才重新抓图（参数也得能在新图里找到）。
  const updateGraph = !editing || !!(ctx.graphCb && ctx.graphCb.checked);
  const primary = () => editing ? t("Save changes") : t("Generate app package");
  const checked = ctx.rows.filter((r) => r.cb.checked);
  if (!checked.length) {
    ctx.err.textContent = t("Select at least one parameter");
    return;
  }
  ctx.gen.disabled = true;
  ctx.gen.textContent = editing ? t("Saving…") : t("Generating…");
  ctx.err.textContent = "";
  let output;
  if (updateGraph) {
    try {
      const pr = await app.graphToPrompt();
      output = (pr && pr.output) || {};
    } catch (e) {
      ctx.err.textContent = t("Failed to get workflow: {msg}", { msg: e && e.message ? e.message : e });
      ctx.gen.disabled = false;
      ctx.gen.textContent = primary();
      return;
    }
  } else {
    output = editing.kapp.graph || {};
  }
  const params = checked.map((r) => {
    const c = r.c;
    // 保留原声明里的 default / 能力项等，只覆盖面板上能改的字段；
    // 更新图时以画布当前值为准（图换了，旧默认值可能已无意义）。
    const p = updateGraph ? {} : Object.assign({}, r.existingParam || {});
    p.node = c.node;
    p.input = c.input;
    p.label = r.lab.value.trim() || c.label || p.label || c.input;
    p.widget = r.sel.value;
    if (updateGraph || !Object.prototype.hasOwnProperty.call(p, "default")) p.default = c.default;
    if (updateGraph || !p.node_type) p.node_type = c.node_type || "";
    if (updateGraph || !p.node_title) p.node_title = c.node_title || "";
    if (p.widget === "number") {
      if (updateGraph || p.min == null) { if (c.min != null) p.min = c.min; }
      if (updateGraph || p.max == null) { if (c.max != null) p.max = c.max; }
      if (updateGraph || p.step == null) { if (c.step != null) p.step = c.step; }
    }
    if (p.widget === "combo" && (!p.options || !p.options.length) && c.options) p.options = c.options;
    if (p.widget === "text" && c.multiline) p.multiline = true;
    if (p.widget === "prompt") {
      if (!p.usage_input && c.usage_input) p.usage_input = c.usage_input;
      if (!p.usage_options && c.usage_options) p.usage_options = c.usage_options;
      if (p.usage_default === undefined && c.usage_default !== undefined) p.usage_default = c.usage_default;
    }
    return p;
  });
  // 保留原图时，新勾的参数必须真的存在于那张图里（后端也会拦，这里先给可读的提示）
  if (!updateGraph) {
    for (const p of params) {
      const node = output[p.node];
      const val = node && node.inputs ? node.inputs[p.input] : undefined;
      if (!node) {
        ctx.err.textContent = t("Parameter \"{label}\" points to node {node}, which is not in this app's graph. Uncheck it or update the graph from the current workflow.", { label: p.label, node: p.node });
        ctx.gen.disabled = false;
        ctx.gen.textContent = primary();
        return;
      }
      if (val === undefined) {
        ctx.err.textContent = t("Parameter \"{label}\" ({node}:{input}) does not exist in this app's graph. Uncheck it or update the graph from the current workflow.", { label: p.label, node: p.node, input: p.input });
        ctx.gen.disabled = false;
        ctx.gen.textContent = primary();
        return;
      }
      if (Array.isArray(val) && val.length === 2) {
        ctx.err.textContent = t("Parameter \"{label}\" ({node}:{input}) is a linked input in this app's graph and cannot be edited.", { label: p.label, node: p.node, input: p.input });
        ctx.gen.disabled = false;
        ctx.gen.textContent = primary();
        return;
      }
    }
  }
  let outputs;
  if (updateGraph) {
    outputs = [];
    for (const id of Object.keys(output)) {
      const ct = output[id] && output[id].class_type;
      if (String(ct || "").toLowerCase().includes("save")) outputs.push(id);
    }
  } else if (Array.isArray(editing.kapp.outputs)) {
    outputs = editing.kapp.outputs;
  } else {
    // 老包没声明 outputs：从保留的图里按 Save 节点补齐，别越存越空
    outputs = [];
    for (const id of Object.keys(output)) {
      const ct = output[id] && output[id].class_type;
      if (String(ct || "").toLowerCase().includes("save")) outputs.push(id);
    }
  }
  const kapp = Object.assign({}, editing ? editing.kapp : {}, {
    kedou_app: 1,
    name: ctx.nameInput.value.trim() || (editing && editing.kapp.name) || defaultAppName(),
    desc: ctx.descInput.value.trim(),
    graph: output,
    params,
    outputs,
  });
  const payload = { name: kapp.name, desc: kapp.desc, kapp };
  if (editing) payload.target = editing.file;
  try {
    const resp = await fetch("/ps/pack/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let j = null;
    try { j = await resp.json(); } catch (_) { /* ignore */ }
    if (!resp.ok || !j || !j.ok) {
      const msg = serverError((j && j.error) ? j.error : ("HTTP " + resp.status));
      ctx.err.textContent = t(editing ? "Saving failed: {msg}" : "Generation failed: {msg}", { msg });
      kpToast(t(editing ? "Saving failed: {msg}" : "Generation failed: {msg}", { msg }), true);
    } else {
      const warns = (j.warnings && j.warnings.length) ? j.warnings : [];
      if (warns.length) {
        // 有提醒（如缺输入但不影响打包）时留着面板，用户看完错误行再手动关
        ctx.err.style.color = "";
        const list = warns.slice(0, 4).join(t("; ")) + (warns.length > 4 ? "…" : "");
        ctx.err.textContent = t(editing ? "Saved {file} with {w} warnings: {list}" : "Generated {file}, {w} warnings: {list}", { file: j.file || "", w: warns.length, list });
        kpToast(t(editing ? "Saved with {w} warnings — see details in the panel" : "Generated with {w} warnings — see details in the panel", { w: warns.length }), true);
      } else {
        kpToast(t(editing ? "Saved changes to {file}" : "Generated {file}; refresh the launcher to see it", { file: j.file || kapp.name }));
        closePackPanel();
      }
    }
  } catch (e) {
    const msg = serverError(e && e.message ? e.message : String(e));
    ctx.err.textContent = t("Request failed: {msg}", { msg });
    kpToast(t("Request failed: {msg}", { msg }), true);
  } finally {
    ctx.gen.disabled = false;
    ctx.gen.textContent = primary();
  }
}

const kpBtnEls = [];      // 入口按钮/悬浮球，语言切换时统一重刷文案
let kpBtnSubDone = false;
function kpEntryLabel(btn) {
  btn.textContent = t("Pack app");
  btn.title = t("Package the current workflow as a kapp app");
}
function mountPackButton() {
  ensurePackCss();   // 必须先注样式：无样式按钮落在 body 末尾，会被 100vh 画布挤出屏幕外
  if (!kpBtnSubDone) {
    kpBtnSubDone = true;
    onLocaleChange(() => { kpBtnEls.forEach((b) => { if (document.contains(b)) kpEntryLabel(b); }); });
  }
  // 入口挂载在左侧栏：新版前端的官方侧栏页签接口
  try {
    if (app.extensionManager && typeof app.extensionManager.registerSidebarTab === "function") {
      // 注意：挂载使用 e.render(el)，旧文档记载的 content 字段会被忽略，导致页签空白。
      // 两个字段都传，新旧版本通吃。
      const packTabContent = (el) => {
        try { openPackPanel(el); }
        catch (e) { console.error("[kedou] 侧栏面板挂载失败", e); }
      };
      app.extensionManager.registerSidebarTab({
        id: "kedou-pack",
        icon: "pi pi-box",
        title: t("Pack app"),
        tooltip: t("Package the current workflow as a kapp app"),
        content: packTabContent,
        render: packTabContent,
      });
      return;                       // 侧栏挂载成功，不再需要悬浮球/菜单按钮
    }
  } catch (e) { console.warn("[kedou] 侧栏页签挂载失败，退回悬浮球/菜单", e); }
  // 新版 ComfyUI 前端里 app.ui.menuContainer 是隐藏的遗留兼容壳（按钮挂进去不会显示）。
  // 规矩：只挂进「真实可见」的容器；都不行就退到永远可见的悬浮 pill。
  function visible(el) {
    if (!el || !el.appendChild) return false;
    const r = el.getBoundingClientRect();
    return !!(el.offsetParent || r.width > 0) && r.width > 0 && r.height > 0;
  }
  let target = null;
  try {
    if (app.ui && app.ui.menuContainer && visible(app.ui.menuContainer)) target = app.ui.menuContainer;
  } catch (_) { /* ignore */ }
  if (!target) {
    const m = document.querySelector(".comfyui-menu");        // 新版顶部菜单栏
    if (visible(m)) target = m;
  }
  if (!target) {
    const m = document.querySelector(".comfy-menu");          // 旧版底部菜单
    if (visible(m)) target = m;
  }
  const btn = document.createElement("button");
  if (target) {
    btn.className = "kp-menu-btn";
    target.appendChild(btn);
  } else {
    btn.className = "kp-pill";
    document.body.appendChild(btn);
  }
  kpEntryLabel(btn);
  kpBtnEls.push(btn);
  btn.onclick = openPackPanel;
  // 防御：前端框架重渲染可能移除外挂按钮，3 秒后若不在文档中则重挂为悬浮 pill
  setTimeout(function () {
    if (!document.contains(btn)) {
      const pill = document.createElement("button");
      pill.className = "kp-pill";
      kpEntryLabel(pill);
      kpBtnEls.push(pill);
      pill.onclick = openPackPanel;
      document.body.appendChild(pill);
    }
  }, 3000);
}

app.registerExtension({
  name: "kedou.packPanel",
  async setup() {
    await initI18n(app);   // 语言包就绪后再挂载入口（重复调用只生效一次）
    try {
      mountPackButton();
    } catch (e) {
      console.error("[kedou] 打包按钮挂载失败", e);
    }
  },
});

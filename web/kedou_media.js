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
import { t, locale, initI18n, onLocaleChange, serverError } from "./i18n.js";

const NODE_CLASS = "KedouImageLoader";
// 输出槽上限。ComfyUI 的 RETURN_TYPES 必须静态声明，所以「不限制数量」只能体现为
// 给一个足够大的上限（原来是 10，2026-09-28 提到 50）。实际露出几个由 syncOutputs 控制：
// 槽数随实际会出图的张数增长（选择模式按 picked，批次模式 1 个），已连线的槽始终保留。
// 空槽运行时由后端在 /prompt 入口剔除，既不用重连，也不会把 None 送进下游。
const IMG_SLOTS = 50;
// 输出长边上限允许范围；0 = 原尺寸（与后端 nodes.py 的 MAX_SIDE_LIMIT 保持一致）
const MAX_SIDE_LIMIT = 16384;
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
  // 输出长边缩放：嵌在节点底栏（与 KeDou 同一行），不额外占内容高度
  ".kd-limitbar{margin-left:auto;display:flex;align-items:center;gap:4px;min-width:0;}",
  ".kd-limitbar span{font-size:10px;white-space:nowrap;opacity:.85;flex:none;}",
  ".kd-limitbar select{height:16px;font:inherit;font-size:10px;line-height:1;color:inherit;",
  "background:transparent;border:1px solid var(--border-color,#3a3a44);border-radius:4px;",
  "padding:0 2px;outline:none;cursor:pointer;flex:none;}",
  ".kd-limitbar select:focus{border-color:var(--p-primary-color,#4a7dff);}",
  ".kd-limitbar select option{background:var(--comfy-input-bg,#1b1b21);color:var(--fg-color,#ddd);}",
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
  // 图片排列预设：浮在按钮下方的小面板
  ".kd-setsmenu{position:fixed;z-index:100003;width:min(330px,calc(100vw - 24px));max-height:min(440px,72vh);",
  "display:flex;flex-direction:column;gap:7px;padding:10px;border-radius:12px;",
  "background:var(--comfy-menu-bg,#232329);color:var(--fg-color,#e7e7ea);",
  "border:1px solid var(--border-color,#3a3a44);box-shadow:0 14px 40px rgba(0,0,0,.45);",
  "font:12px/1.5 system-ui,sans-serif;}",
  ".kd-sets-head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:12.5px;}",
  ".kd-sets-head button{margin-left:auto;border:none;background:none;color:var(--descrip-text,#9a9aa6);",
  "font:inherit;font-size:16px;line-height:1;cursor:pointer;padding:0 4px;}",
  ".kd-sets-head button:hover{color:var(--error-text,#ffb3b3);}",
  ".kd-sets-save{display:flex;gap:6px;}",
  ".kd-sets-save input{flex:1;min-width:0;border:1px solid var(--border-color,#3a3a44);background:transparent;",
  "color:inherit;font:inherit;font-size:11.5px;padding:5px 9px;border-radius:7px;outline:none;}",
  ".kd-sets-save input:focus{border-color:var(--p-primary-color,#4a7dff);}",
  ".kd-sets-list{display:flex;flex-direction:column;gap:3px;overflow-y:auto;scrollbar-width:thin;min-height:34px;}",
  ".kd-setsrow{display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:8px;cursor:pointer;",
  "border:1px solid transparent;}",
  ".kd-setsrow:hover{background:var(--content-bg,#16161c);border-color:var(--border-color,#3a3a44);}",
  ".kd-setsrow .kd-sets-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;}",
  ".kd-setsrow .kd-sets-meta{flex:none;font-size:10px;color:var(--descrip-text,#9a9aa6);white-space:nowrap;}",
  ".kd-setsrow .kd-sets-del{flex:none;border:none;background:none;color:var(--descrip-text,#9a9aa6);",
  "font:inherit;font-size:13px;line-height:1;padding:2px 5px;cursor:pointer;border-radius:5px;}",
  ".kd-setsrow .kd-sets-del:hover{color:var(--error-text,#ffb3b3);background:var(--content-bg,#16161c);}",
  ".kd-setsrow .kd-sets-del.kd-armed{color:#fff;background:var(--error-text,#a33);}",
  ".kd-sets-empty{padding:8px 4px;font-size:11px;color:var(--descrip-text,#9a9aa6);text-align:center;}",
  ".kd-sets-hint{font-size:10px;line-height:1.45;color:var(--descrip-text,#9a9aa6);",
  "border-top:1px solid var(--border-color,#3a3a44);padding-top:6px;}",
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
  console.log("[kedou] 前端扩展已加载 · build 2026-10-22");
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
function thumbUrl(name, sub, w, tab, mode) {
  // mode="raw"：要原比例、不补边的图 —— 格子靠 CSS object-fit 决定裁切/完整。
  // 后端默认出的是「补边成正方形」的版本（PS 面板要，UXP 会把 max-* 各自钳位拽变形），
  // 那张图喂给 ComfyUI 会让 cover 失效、所有图看起来都变成全图显示。
  const p = { filename: name, subfolder: sub || "", type: tab || "input", w: String(w || 256) };
  if (mode) p.mode = mode;
  return "/ps/thumb?" + new URLSearchParams(p).toString();
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
    // 输出长边上限（0 = 原尺寸）；旧工作流没有该字段时按 0 处理
    max_side: Math.max(0, Math.min(MAX_SIDE_LIMIT, Math.round(Number(obj && obj.max_side) || 0))),
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
    max_side: Math.max(0, Math.min(MAX_SIDE_LIMIT, Math.round(Number(state.max_side) || 0))),
  });
  try {
    if (typeof w.callback === "function") w.callback(w.value);
  } catch (e) {
    /* callback 不是必须的 */
  }
  node.setDirtyCanvas(true, true);
  // 提示词框里的引用缩略图靠这个事件跟着换图/换序（promptlib.js 监听）
  try {
    window.dispatchEvent(new CustomEvent("kedou:media-changed", { detail: { nodeId: node.id } }));
  } catch (e) {
    /* ignore */
  }
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
  // 选择模式**已经选了**几张 = 这次真要输出的张数，必须有对应槽位（选 5 张就得有 5 个口）。
  // 非选择模式、或选了但还没点任何图时不预铺 —— 否则面板里几十张图会一次性铺出几十个
  // 空槽，用户看到的就是「刚打开多出来一堆」，点一下又缩回去。
  // picked 里可能残留已删掉的文件名（删图时同步清理了，但旧工作流/外部写入不一定），
  // 所以按 effectiveImages 过滤后的真实张数算，否则会照着一堆死名字多铺空槽。
  const effList = effectiveImages(state);
  const pickedN = (state.select && (state.picked || []).length) ? effList.length : 0;
  let hi = -1;
  node.outputs.forEach((o, i) => {
    if (linksOf(node, i).length) hi = i;   // .links 之外也认旧版/适配器的 .link
  });
  // 槽数 = 已连线数 + 1（永远给下一个留位，连一个才长一个），选图后至少铺到选中张数。
  // 注意这里**不用图片总数**：面板有 24 张图但只连了 16 个口时，槽数就是 17，
  // 而不是 25 —— 否则每次打开工作流槽数都会「长」回图片数。
  let n = Math.max(1, Math.min(IMG_SLOTS, Math.max(hi + 2, pickedN)));
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
    const src = thumbUrl(it.name, it.subfolder, 256, it.tab, "raw");
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
    attachZoom(cell, thumbUrl(it.name, it.subfolder, 512, it.tab, "raw"));
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
  const state = readState(node);
  // 内容指纹：只有「图片列表 / 选择模式」变了才需要重建 DOM。
  // 单纯改 picked（点选一张图）绝不该重建 —— 否则每格 <img> 都要重新创建、重新解码，
  // 滚动位置还会归零，看起来就像整块面板被刷新了一遍。
  // 这个短路是必须的：writeState 里的 w.callback() 会被 hookWidget 再排一次
  // renderPanel（setTimeout 0），不挡住就是「点一次图、整块重建两遍」。
  // 指纹要带上语言：切语言时 onLocaleChange 会调 renderPanel，若指纹只看图片和 select，
  // 空面板时就会走短路分支直接返回，「No images yet…」永远停在旧语言。
  const sig = JSON.stringify([state.images.map((it) => it.filename), !!state.select, locale()]);
  const sameShape = node.__kdSig === sig && Array.isArray(node.__kdCells);
  kdZoomHide();        // 重绘会销毁当前格子的 mouseleave 宿主，悬浮层必须一起收掉
  const changed = syncOutputs(node);   // 输出槽按实际张数增长；已连线的槽保留，空槽由后端在运行时剔除
  ui.count.textContent = String(state.images.length);
  // 两个开关与按钮的状态跟随（赋值 checked 不会触发 onchange，安全）
  if (ui.swBatchCb) ui.swBatchCb.checked = !!state.batch;
  if (ui.swSelCb) ui.swSelCb.checked = !!state.select;
  try { if (ensureLimitBar(node)) node.__kdLimitDone = true; } catch (_) { /* 底栏还没挂好时看门狗会补 */ }
  const effN = effectiveImages(state).length;
  if (ui.runBtn) {
    ui.runBtn.style.display = state.batch ? "" : "none";
    ui.runBtn.textContent = t("▶ Run {n}", { n: effN });
    ui.runBtn.disabled = !effN;
  }
  if (sameShape) {
    // 结构没变：只刷徽标 / 描边 / 按钮，DOM 一个都不动
    paintPicked(node);
    if (changed) setTimeout(() => { resizeToContent(node); fitCard(node); }, 0);
    return;
  }
  node.__kdSig = sig;
  // 全量重建前记住滚动位置：否则图片一多，任何一次重绘（删图 / 上传 / 切开关）
  // 都会把面板弹回顶部，看起来就像「整个刷新了一下」。
  const keepScroll = ui.body.scrollTop || 0;
  ui.body.innerHTML = "";

  const sec = document.createElement("div");
  sec.className = "kd-sec";

  if (!state.images.length) {
    const d = document.createElement("div");
    d.className = "kd-empty";
    d.textContent = t("No images yet — use \"Upload image\" or \"From library\" to add.");
    sec.appendChild(d);
    ui.body.appendChild(sec);
    node.__kdCells = [];   // 清空引用，别让 paintPicked 摸到已销毁的旧格子
    // 空态也要收一次高度：删掉最后一张图/点 Clear 后节点若保持原高度，下方会留一大片空白
    fitCard(node);
    setTimeout(() => { resizeToContent(node); fitCard(node); }, 0);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "kd-grid";
  // 选择模式：点击 = 按顺序选中/取消（选中顺序即输出顺序），不放大预览；
  // 普通模式：点击 = 放大预览，hover 跟随。
  const selMode = !!state.select;
  const pickOrder = {};
  (state.picked || []).forEach((f, idx) => { if (!(f in pickOrder)) pickOrder[f] = idx + 1; });
  const cellRecs = [];   // 选择模式：{cell, no} 供 paintPicked 局部刷新用，避免整面板重建
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
    const cellSrc = () => thumbUrl(fn, sd, 256, tab, "raw");
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
    if (!selMode) attachZoom(cell, () => thumbUrl(fn, sd, 512, tab, "raw"));
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
      // 选择模式的点击统一由 kdGesture 接管（支持 Shift 范围 / 框选 / 点空白清空）。
      // 这里**不再**单独挂 onclick —— 两套逻辑并存时一次点击会被 toggle 两回，
      // 而且每回都走 renderPanel 全量重建，这正是「点一张图整块闪一下」的来源。
      cellRecs.push({ cell, no });
    } else {
      cell.onclick = () => openBig(baseName(it.filename), subOf(it.filename));
    }
    grid.appendChild(cell);
  });
  sec.appendChild(grid);
  ui.body.appendChild(sec);
  node.__kdCells = cellRecs;   // 点选走局部刷新，靠这份引用找格子（非选择模式为空数组）
  // 先把卡片顶满，再算节点高度，最后再顶一次（节点高度变了，容器高度也跟着变）
  fitCard(node);
  setTimeout(() => {
    resizeToContent(node); fitCard(node);
    if (keepScroll) ui.body.scrollTop = keepScroll;   // 布局定稳后再还原，否则会被 clamp
  }, 0);
}

// 点选后的局部刷新：只改序号徽标 / 选中描边 / 运行按钮，**绝不重建 DOM**。
// 走全量重建的话每格 <img> 都会重新创建、重新解码，滚动位置还会归零 ——
// 那就是「点一张图整块闪一下」的真正原因。媒体库弹窗一直是这么做的，面板这边之前漏了。
function paintPicked(node) {
  const ui = node && node._kdUI;
  const recs = node && node.__kdCells;
  if (!ui || !Array.isArray(recs) || !recs.length) return;
  const state = readState(node);
  const pickOrder = {};
  (state.picked || []).forEach((f, idx) => { if (!(f in pickOrder)) pickOrder[f] = idx + 1; });
  recs.forEach((rec, i) => {
    const it = state.images[i];
    if (!rec || !rec.cell || !rec.no || !it) return;
    const pk = pickOrder[it.filename] || 0;
    rec.cell.classList.toggle("kd-picked", !!pk);
    rec.no.textContent = pk ? String(pk) : String(i + 1);
    rec.no.style.background = pk ? "var(--p-primary-color,#4a7dff)" : "";
    rec.no.style.opacity = pk ? "" : ".35";
  });
  const effN = effectiveImages(state).length;
  if (ui.runBtn) {
    ui.runBtn.textContent = t("▶ Run {n}", { n: effN });
    ui.runBtn.disabled = !effN;
  }
}

// 一次点选的收尾：renderPanel 会按内容指纹自动短路成局部刷新，
// 所以这里不用再单独维护一条「只刷局部」的路径 —— 单一入口不容易走岔。
function afterPick(node) {
  renderPanel(node);
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

// ---------------------------------------------------------------- 图片排列预设
// 一条记录只存文件名/顺序/选择状态；图片本身仍在 input/output，加载时逐张检查。
const SETS_API = "/ps/image-sets";
let setsMenu = null;
let setsOwner = null;

function closeSetsMenu() {
  if (!setsMenu) return;
  if (setsMenu.__kdCleanup) setsMenu.__kdCleanup();
  setsMenu.remove();
  setsMenu = null;
  setsOwner = null;
}

// 排列在「排列」菜单里增删后，提示词库面板（词库 → 图片排列）要能立刻看到
function notifySetsChanged() {
  try { window.dispatchEvent(new CustomEvent("kedou:sets-changed")); } catch (e) { /* ignore */ }
}

async function setsApi(path, body) {
  const r = await fetch(SETS_API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let d = null;
  try { d = await r.json(); } catch (e) { /* 非 JSON 错误 */ }
  if (!r.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
  return d || {};
}

async function openSetsMenu(node, anchor) {
  closeSetsMenu();
  const menu = document.createElement("div");
  menu.className = "kd-setsmenu";
  setsMenu = menu;
  setsOwner = node;

  const head = document.createElement("div");
  head.className = "kd-sets-head";
  const title = document.createElement("span");
  title.textContent = t("Image arrangements");
  const x = document.createElement("button");
  x.type = "button";
  x.textContent = "×";
  x.title = t("Close");
  x.onclick = closeSetsMenu;
  head.append(title, x);

  const saveRow = document.createElement("div");
  saveRow.className = "kd-sets-save";
  const nameEl = document.createElement("input");
  nameEl.type = "text";
  nameEl.placeholder = t("Name this arrangement (optional)");
  nameEl.maxLength = 60;
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "kd-btn kd-p";
  saveBtn.textContent = t("Save");
  saveRow.append(nameEl, saveBtn);

  const list = document.createElement("div");
  list.className = "kd-sets-list";

  const hint = document.createElement("div");
  hint.className = "kd-sets-hint";
  hint.textContent = t("Only names and order are saved. Images must still be in the input/output folders.");

  menu.append(head, saveRow, list, hint);
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 330;
  const mh = Math.min(menu.offsetHeight || 260, Math.round((window.innerHeight || 800) * 0.72));
  menu.style.left = Math.max(6, Math.min(r.left, (window.innerWidth || 1280) - mw - 6)) + "px";
  const below = r.bottom + 6;
  menu.style.top = (below + mh <= (window.innerHeight || 800) - 6)
    ? below + "px"
    : Math.max(6, r.top - mh - 6) + "px";

  // 点面板外 / Escape 收掉；点按钮本身由按钮的 onclick 负责切换
  const onDoc = (e) => {
    if (menu.contains(e.target) || anchor.contains(e.target)) return;
    closeSetsMenu();
  };
  const onKey = (e) => { if (e.key === "Escape") closeSetsMenu(); };
  document.addEventListener("pointerdown", onDoc, true);
  document.addEventListener("keydown", onKey);
  menu.__kdCleanup = () => {
    document.removeEventListener("pointerdown", onDoc, true);
    document.removeEventListener("keydown", onKey);
  };

  async function paintList() {
    list.innerHTML = "";
    let items = [];
    try {
      const r = await fetch(SETS_API);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      items = (d && d.items) || [];
    } catch (e) {
      const err = document.createElement("div");
      err.className = "kd-sets-empty";
      err.textContent = t("Load failed: {error}", { error: serverError(e.message) });
      list.appendChild(err);
      return;
    }
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "kd-sets-empty";
      empty.textContent = t("No saved arrangements yet");
      list.appendChild(empty);
      return;
    }
    let armed = { id: "", at: 0 };
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "kd-setsrow";
      const nm = document.createElement("span");
      nm.className = "kd-sets-name";
      nm.textContent = item.name || t("(unnamed)");
      nm.title = item.name || "";
      const meta = document.createElement("span");
      meta.className = "kd-sets-meta";
      meta.textContent = t("{n} images", { n: (item.images || []).length });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "kd-sets-del";
      del.textContent = "×";
      del.title = t("Delete");
      row.append(nm, meta, del);

      row.onclick = async () => {
        try {
          const res = await setsApi("/load", { id: item.id });
          const found = res.found || [];
          if (!found.length) {
            kpToast(t("No images in this arrangement are still available"), true);
            return;
          }
          const st = readState(node);
          st.images = found.map((f) => ({ filename: f.filename }));
          st.picked = (res.item.picked || []).filter(
            (f) => found.some((x) => x.filename === f));
          st.select = !!res.item.select;
          st.batch = !!res.item.batch;
          st.cursor = 0;
          writeState(node, st);
          renderPanel(node);
          let msg = t("Arrangement loaded: {name} ({n} images)",
            { name: res.item.name, n: found.length });
          const missing = res.missing || [];
          if (missing.length) {
            msg += " · " + t("Missing {n}: {names}", {
              n: missing.length,
              names: missing.slice(0, 3).join(", ") + (missing.length > 3 ? "…" : ""),
            });
          }
          kpToast(msg, missing.length > 0);
          closeSetsMenu();
        } catch (e) {
          kpToast(t("Load failed: {error}", { error: serverError(e.message) }), true);
        }
      };

      del.onclick = async (e) => {
        e.stopPropagation();
        if (armed.id !== item.id || Date.now() - armed.at > 2500) {
          armed = { id: item.id, at: Date.now() };
          del.textContent = t("Confirm");
          del.classList.add("kd-armed");
          setTimeout(() => {
            if (Date.now() - armed.at >= 2500) {
              del.textContent = "×";
              del.classList.remove("kd-armed");
            }
          }, 2600);
          return;
        }
        try {
          await setsApi("/delete", { id: item.id });
          armed = { id: "", at: 0 };
          notifySetsChanged();
          await paintList();
        } catch (e) {
          kpToast(t("Delete failed: {error}", { error: serverError(e.message) }), true);
        }
      };
      list.appendChild(row);
    });
  }

  saveBtn.onclick = async () => {
    const st = readState(node);
    if (!(st.images || []).length) {
      kpToast(t("No images to save"), true);
      return;
    }
    saveBtn.disabled = true;
    try {
      const res = await setsApi("/save", {
        name: nameEl.value.trim(),
        images: st.images.map((x) => x.filename),
        batch: st.batch,
        select: st.select,
        picked: st.picked,
      });
      kpToast(t("Arrangement saved: {name}", { name: res.item.name }));
      nameEl.value = "";
      notifySetsChanged();
      await paintList();
    } catch (e) {
      kpToast(t("Save failed: {error}", { error: serverError(e.message) }), true);
    } finally {
      saveBtn.disabled = false;
    }
  };

  await paintList();
}

// ---------------------------------------------------------------- 底栏：长边缩放
// 放在节点原生底栏（与 KeDou 同一行），不额外占图片区域高度。
// 常用尺寸 + 「原尺寸」；旧工作流里的非预设值也会临时列进下拉，不会被悄悄改掉。
const MAX_SIDE_PRESETS = [0, 1024, 1280, 1536, 2048, 2560, 3072, 4096];

function nodeFooterEl(node) {
  const card = node._kdUI && node._kdUI.card;
  if (!card) return null;
  let el = card;
  for (let i = 0; i < 6 && el; i++) {
    el = el.parentElement;
    if (!el) break;
    for (const child of el.children) {
      if (child.classList && child.classList.contains("mt-auto") && child.classList.contains("h-5")) {
        return child;
      }
    }
  }
  return null;
}

function fillLimitOptions(node) {
  const sel = node.__kdLimitSel;
  if (!sel) return;
  const cur = readState(node).max_side || 0;
  const values = MAX_SIDE_PRESETS.slice();
  if (cur > 0 && values.indexOf(cur) < 0) values.push(cur);
  values.sort((a, b) => a - b);
  sel.innerHTML = "";
  values.forEach((v) => {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = v ? String(v) : t("Original");
    sel.appendChild(o);
  });
  sel.value = String(cur);
}

function ensureLimitBar(node) {
  const ui = node._kdUI;
  if (!ui) return false;
  let bar = node.__kdLimitBar;
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "kd-limitbar";
    const name = document.createElement("span");
    const sel = document.createElement("select");
    sel.onpointerdown = (e) => e.stopPropagation();
    sel.onclick = (e) => e.stopPropagation();
    sel.onkeydown = (e) => e.stopPropagation();
    sel.onwheel = (e) => e.stopPropagation();
    sel.onchange = () => {
      const v = Math.max(0, Math.min(MAX_SIDE_LIMIT, Math.round(Number(sel.value) || 0)));
      const st = readState(node);
      if (st.max_side === v) return;
      st.max_side = v;
      writeState(node, st);       // 只写状态，不重绘面板
    };
    bar.append(name, sel);
    node.__kdLimitBar = bar;
    node.__kdLimitName = name;
    node.__kdLimitSel = sel;
  }
  const foot = nodeFooterEl(node);
  if (!foot) return false;
  if (bar.parentElement !== foot) foot.appendChild(bar);

  // 语言切换 / 外部改状态后同步文案和当前值
  if (node.__kdLimitName) node.__kdLimitName.textContent = t("Long side scale");
  const sel = node.__kdLimitSel;
  if (sel) {
    sel.title = t("Resize each output image so its longest side does not exceed this value. Aspect ratio is kept; images are never enlarged. Choose \"Original\" for no limit.");
    const cur = String(readState(node).max_side || 0);
    if (!Array.from(sel.options).some((o) => o.value === cur)) fillLimitOptions(node);
    else sel.value = cur;
  }
  return true;
}

// 原生底栏由前端组件渲染，可能比卡片晚几帧才出现；前 1 秒每 100ms 试一次，
// 之后每 500ms 再试到约 6 秒（大工作流加载慢时 1 秒窗口根本等不到底栏）。
function attachLimitBar(node) {
  let tries = 0;
  const step = () => {
    if (node.__kdLimitDone) return;                 // 已挂上（或被看门狗挂上）就不再重试
    if (ensureLimitBar(node)) { node.__kdLimitDone = true; return; }
    if (tries++ >= 20) return;
    setTimeout(step, tries < 10 ? 100 : 500);
  };
  setTimeout(step, 0);
}

// 模块级看门狗（全页只有一个定时器）：只查"下拉框是否还挂在文档里"，
// 正常情况一次布尔判断就跳过，不动 DOM。用于两类会导致下拉框悄悄消失的情形：
//   * 节点在视口外，底栏当时还没被渲染出来（前端按可见性挂载 DOM）；
//   * 前端重挂节点组件时把底栏整个换掉，我们的下拉框跟着旧节点一起掉出文档。
let kdLimitWatchdog = null;
function startLimitWatchdog() {
  if (kdLimitWatchdog) return;
  kdLimitWatchdog = setInterval(() => {
    const nodes = (app.graph && app.graph._nodes) || [];
    for (const n of nodes) {
      if (n.comfyClass !== NODE_CLASS || !n._kdUI) continue;
      const bar = n.__kdLimitBar;
      if (bar && bar.isConnected) { n.__kdLimitDone = true; continue; }
      if (!n._kdUI.card.isConnected) continue;      // 卡片本身还没上屏，等它出现再看
      try { if (ensureLimitBar(n)) n.__kdLimitDone = true; } catch (_) { /* 单节点失败不影响其它 */ }
    }
  }, 2000);
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
  // 图片排列预设：存文件名+顺序，换工作流也能一键还原（不复制图片）
  const setsBtn = document.createElement("button");
  setsBtn.className = "kd-btn";
  setsBtn.textContent = t("Sets");
  setsBtn.title = t("Save or load an image arrangement");
  setsBtn.onclick = (e) => {
    e.stopPropagation();
    if (setsMenu && setsOwner === node) {
      closeSetsMenu();
      return;
    }
    openSetsMenu(node, setsBtn).catch((err) => {
      kpToast(t("Load failed: {error}", { error: serverError(err && err.message) }), true);
    });
  };
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
  btns.append(libBtn, setsBtn, clearBtn, upBtn, runBtn, fileEl);
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

  node._kdUI = { card, body, count, libBtn, setsBtn, upBtn, fileEl, runBtn,
    swBatchCb: swBatch.cb, swSelCb: swSel.cb };
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
      afterPick(node);          // 局部刷新：只改徽标/描边，不重建整块面板
    },
    onBlankTap() {
      const st = readState(node);
      if (!st.select || !(st.picked || []).length) return;
      st.picked = [];
      writeState(node, st);
      afterPick(node);
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
      afterPick(node);
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
    setTimeout(() => {
      // 配置过程中连线是一条条恢复的，此时收槽会把「还没恢复的连线」当成没连线而删掉，
      // 下游直接断。所以只有确认配置结束才允许收；否则只重绘不收槽。
      if (node.__kdGrowOnly && !app.configuringGraph) {
        node.__kdGrowOnly = false;
        node.__kdCfgToken = (node.__kdCfgToken || 0) + 1;   // 作废还在轮询的那条链
      }
      if (!node.__kdGrowOnly) syncOutputs(node);
      resizeToContent(node);
    }, 0);
    return r;
  };
  const onCfg = node.onConfigure;
  node.onConfigure = function () {
    const r = typeof onCfg === "function" ? onCfg.apply(this, arguments) : undefined;
    // 配置同步阶段先只增不删（连线/控件可能还没恢复）；等整张图 configure 完再收槽。
    // app.configuringGraph 在 setTimeout(0) 时**往往还没落回 false**（整图 configure 跨好几个
    // tick），所以轮询到它结束。到上限仍没结束就**保持只增不删**——宁可槽多，也绝不能
    // 因为「连线还没恢复」而删掉有连线的槽（那会直接把下游断开）。
    // 收尾交给 onConnectionsChange：连线恢复时它一定会触发，那时 configuringGraph 已为 false。
    node.__kdGrowOnly = true;
    const token = (node.__kdCfgToken = (node.__kdCfgToken || 0) + 1);   // 新一轮加载作废旧轮询
    let tries = 0;
    const settle = () => {
      if (node.__kdCfgToken !== token) return;          // 已被新一轮加载取代
      if (app.configuringGraph) {
        if (tries++ < 200) setTimeout(settle, 50);      // 最多等 10 秒
        return;                                         // 还在配置：保持 growOnly，不冒险收槽
      }
      node.__kdGrowOnly = false;
      renderPanel(node);
    };
    setTimeout(settle, 0);
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
  attachLimitBar(node);      // 原生底栏可能比卡片晚几帧挂上，用退避重试补上
  startLimitWatchdog();      // 大工作流/节点在视口外时底栏可能还没渲染，看门狗兜底
}

// 词库面板的「图片排列」点加载时走这里：由媒体模块自己写 media_state 并重绘，
// 两个扩展只通过事件通信，不各自维护一份序列化逻辑。
window.addEventListener("kedou:media-apply", (ev) => {
  const d = ev.detail || {};
  const node = (app.graph && d.nodeId != null) ? app.graph.getNodeById(d.nodeId) : null;
  if (!node) return;
  const cur = readState(node);
  writeState(node, {
    images: (d.images || []).map((f) => ({ filename: String(f) })),
    batch: !!d.batch,
    select: !!d.select,
    picked: Array.isArray(d.picked) ? d.picked : [],
    cursor: 0,
    // 排列只还原图片和输出顺序；长边上限是节点设置，保持用户当前值
    max_side: cur.max_side,
  });
  renderPanel(node);
});

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

const KP_WIDGETS = ["text", "number", "toggle", "combo", "image", "kedou_media", "prompt", "bbox"];
// 下拉里显示的名字：值是落进 kapp 的协议字段，不能翻；只有显示名走 t()。
// 说明：toggle 在 PS 面板里渲染成真开关（spec.type == BOOLEAN → .sw），所以叫「开关」；
// prompt 是「提示词 + 用途」复合控件，启动器里渲染成带词库/历史的完整提示词框；
// bbox 是「创建边界框」节点那套框选数据，启动器里渲染成能直接拖框的画布。
const KP_WIDGET_LABEL = {
  text: "Text", number: "Number", toggle: "Switch",
  combo: "Dropdown", image: "Image", kedou_media: "Kedou image loader",
  prompt: "Kedou prompt", bbox: "Bounding boxes",
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
  // 「已打包的应用」列表：一行一个包，左边名字+规模，右边三个动作
  ".kp-applist-hd{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--fg-color,#e7e7ea);opacity:.62;}",
  ".kp-applist-hd .kp-tbtn{margin-left:auto;flex:none;opacity:1;}",
  // 列表限高自己滚：11 个包就有 11 行，不限高会把下面的表单和清单全挤出可视区
  ".kp-applist{display:flex;flex-direction:column;gap:6px;max-height:34vh;overflow-y:auto;padding-right:2px;}",
  ".kp-approw{display:flex;align-items:center;gap:7px;padding:6px 8px;border:1px solid var(--interface-stroke,#3a3a44);",
  "border-radius:8px;background:transparent;}",
  ".kp-approw.kp-on{border-color:var(--p-primary-color,#4a7dff);background:rgba(74,125,255,.10);}",
  ".kp-appinfo{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}",
  ".kp-appname{font-size:12px;color:var(--fg-color,#e7e7ea);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".kp-appmeta{font-size:10.5px;color:var(--fg-color,#e7e7ea);opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".kp-appacts{display:flex;gap:4px;flex:none;}",
  ".kp-appacts .kp-tbtn{padding:3px 7px;font-size:10.5px;opacity:.9;}",
  ".kp-appacts .kp-tbtn[disabled]{opacity:.35;cursor:default;}",
  ".kp-appacts .kp-tbtn[disabled]:hover{border-color:var(--interface-stroke,#3a3a44);color:var(--fg-color,#e7e7ea);}",
  ".kp-appacts .kp-danger:hover{border-color:var(--error-text,#ff7a7a);color:var(--error-text,#ff7a7a);}",
  ".kp-empty{font-size:11px;color:var(--fg-color,#e7e7ea);opacity:.55;padding:2px 0;}",
  ".kp-edithint{color:var(--p-primary-color,#4a7dff);opacity:.85;}",
  ".kp-chk{display:flex;align-items:center;gap:6px;font-size:11.5px;cursor:pointer;user-select:none;opacity:.9;}",
  ".kp-chk input{width:14px;height:14px;accent-color:var(--p-primary-color,#4a7dff);cursor:pointer;flex:none;}",
  ".kp-tbtn{border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#e7e7ea);font:inherit;font-size:11px;",
  "padding:4px 10px;border-radius:7px;cursor:pointer;}",
  ".kp-tbtn:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kp-lab{background:var(--content-bg,#e0e0e0);border:1px solid var(--interface-stroke,#3a3a44);color:inherit;font:inherit;font-size:11.5px;",
  "padding:4px 6px;border-radius:6px;outline:none;width:100%;box-sizing:border-box;}",
  ".kp-lab:focus{border-color:var(--p-primary-color,#4a7dff);}",
  ".kp-sel{width:84px;flex:none;font-size:11px;padding:4px;background:var(--content-bg,#e0e0e0);border:1px solid var(--interface-stroke,#3a3a44);",
  "color:inherit;border-radius:6px;outline:none;align-self:center;}",
  ".kp-err{color:var(--error-text,#ff7a7a);font-size:11.5px;min-height:14px;}",
  ".kp-ft{padding:10px 12px;border-top:1px solid var(--interface-stroke,#3a3a44);}",
  ".kp-gen.kp-gen-off{opacity:.45;cursor:not-allowed;}",
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
  ".kp-pane{display:flex;flex-direction:column;gap:8px;}",
  ".kp-pickhint{font-size:11px;line-height:1.5;color:var(--fg-color,#e7e7ea);opacity:.62;}",
  ".kp-picklist{display:flex;flex-direction:column;gap:6px;}",
  ".kp-pickrow{display:flex;align-items:center;gap:6px;padding:6px 7px;border:1px solid var(--interface-stroke,#3a3a44);border-radius:8px;}",
  ".kp-pickrow .kp-lab{flex:1;min-width:0;}",
  ".kp-pickrow .kp-sel{width:74px;}",
  ".kp-pmove{border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:var(--fg-color,#e7e7ea);",
  "font:inherit;font-size:10px;line-height:1;padding:4px 5px;border-radius:5px;cursor:pointer;flex:none;opacity:.7;}",
  ".kp-pmove:hover{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);opacity:1;}",
  ".kp-pdel{border:0;background:transparent;color:var(--fg-color,#e7e7ea);font:inherit;font-size:14px;line-height:1;",
  "padding:2px 4px;cursor:pointer;opacity:.5;flex:none;}",
  ".kp-pdel:hover{color:var(--error-text,#ff7a7a);opacity:1;}",
  ".kp-drag{cursor:grab;flex:none;opacity:.4;font-size:11px;line-height:1;user-select:none;padding:2px 1px;}",
  ".kp-drag:hover{opacity:.85;}",
  ".kp-pickrow.kp-dragging{opacity:.55;border-style:dashed;}",
  ".kp-pickrow.kp-orphan{border-style:dashed;}",
  ".kp-orbadge{flex:none;width:13px;height:13px;border-radius:50%;font-size:9px;line-height:13px;text-align:center;",
  "background:rgba(255,170,60,.22);color:#ffb454;font-weight:700;}",
  ".kp-pickfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;opacity:.62;}",
  ".kp-pclear{border:1px solid var(--interface-stroke,#3a3a44);background:transparent;color:inherit;",
  "font:inherit;font-size:11px;padding:3px 7px;border-radius:6px;cursor:pointer;opacity:.8;}",
  ".kp-pclear:hover{border-color:var(--error-text,#ff7a7a);color:var(--error-text,#ff7a7a);opacity:1;}",
  // 「用户看到的样子」预览：照着应用界面的样子摆一遍，纯展示，不能操作
  ".kp-pv{border:1px solid var(--interface-stroke,#3a3a44);border-radius:10px;padding:0 10px;",
  "background:var(--comfy-menu-bg,#23232b);margin-top:2px;}",
  ".kp-pv>summary{cursor:pointer;font-size:11.5px;padding:8px 0;opacity:.8;list-style:none;}",
  ".kp-pv>summary::-webkit-details-marker{display:none;}",
  ".kp-pv>summary:before{content:'▸ ';opacity:.7;}",
  ".kp-pv[open]>summary:before{content:'▾ ';}",
  ".kp-pv-body{display:flex;flex-direction:column;gap:9px;padding:2px 0 11px;}",
  ".kp-pv-name{font-size:12.5px;font-weight:600;}",
  ".kp-pv-desc{font-size:11px;opacity:.6;margin-top:2px;}",
  ".kp-pv-field{display:flex;flex-direction:column;gap:3px;}",
  ".kp-pv-lab{font-size:11px;opacity:.85;}",
  ".kp-pv-in{border:1px solid var(--interface-stroke,#3a3a44);border-radius:7px;padding:6px 8px;",
  "font-size:11px;opacity:.72;background:var(--content-bg,#1b1b22);min-height:14px;overflow:hidden;",
  "text-overflow:ellipsis;white-space:nowrap;}",
  ".kp-pv-area{min-height:52px;white-space:pre-wrap;line-height:1.45;max-height:96px;}",
  ".kp-pv-sw{width:34px;height:18px;border-radius:9px;background:var(--interface-stroke,#3a3a44);position:relative;}",
  ".kp-pv-sw:after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;",
  "background:var(--fg-color,#e7e7ea);opacity:.75;}",
  ".kp-pv-up{border:1px dashed var(--interface-stroke,#3a3a44);border-radius:8px;padding:14px 8px;",
  "text-align:center;font-size:11px;opacity:.6;}",
  ".kp-pv-run{border:1px solid var(--p-primary-color,#4a7dff);background:var(--p-primary-color,#4a7dff);",
  "color:#fff;border-radius:8px;padding:7px;text-align:center;font-size:11.5px;opacity:.85;margin-top:2px;}",
  ".kp-pv-empty{font-size:11px;opacity:.55;}",
  // 画布上的勾选框层（照官方 App Builder 的样子）：一层透明蒙层，里面每个参数一格小方框
  ".kp-layer{position:fixed;inset:0;pointer-events:none;z-index:40;}",
  // 点选时给每个参数行让出左侧一条：方框落在这条里，参数名整体右移，和官方构建器一致
  "body.kp-picking .lg-node-widgets .lg-node-widget{padding-left:24px;}",
  "body.kp-picking .lg-node-widgets .kp-indent{padding-left:24px;}",
  ".kp-hit{position:absolute;box-sizing:border-box;border-radius:3px;border:1.5px solid rgba(255,255,255,.5);",
  "background:rgba(18,18,26,.72);pointer-events:auto;cursor:pointer;display:flex;align-items:center;justify-content:center;",
  "transition:background .08s,border-color .08s;}",
  ".kp-hit:hover{border-color:#7aa2ff;background:rgba(59,130,246,.28);}",
  ".kp-hit.kp-hi{border-color:#fff;box-shadow:0 0 0 3px rgba(122,162,255,.55);}",
  ".kp-hit.kp-on{background:#3579f6;border-color:#3579f6;}",
  ".kp-hit.kp-on::after{content:'';width:50%;height:26%;border-left:2px solid #fff;border-bottom:2px solid #fff;",
  "transform:rotate(-45deg) translateY(-15%);}",
  ".kp-selbox{position:absolute;box-sizing:border-box;border:2px solid #3579f6;border-radius:7px;",
  "background:rgba(53,121,246,.10);pointer-events:none;}",
  ".kp-selbox.kp-sel-hi{border-style:dashed;border-width:1.5px;border-color:rgba(140,180,255,.85);background:rgba(53,121,246,.05);}",
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
let kpUnhookPick = null;     // 点选模式挂在 window 上的监听器（关面板时必须摘掉）
let kpRefreshTimer = null;   // 侧栏面板的工作流切换监视器
let kpOpenGraph = "";        // 打开面板时的工作流 id；生成前复核，防止拿着旧候选打包
// 切完源工作流后面板会整块重建（候选必须按新画布重新收集），重建完要自动回到原来那个应用。
// 这里存一下它的 id，由 loadApps 消费一次就清空。
let kpRestoreApp = "";
function kpOnKey(e) { if (e.key === "Escape") closePackPanel(); }

function kpGraphKey() {
  const g = app.graph;
  return String((g && g.id) || "none");
}

function stopPackPanelRuntime() {
  if (kpRefreshTimer) { clearInterval(kpRefreshTimer); kpRefreshTimer = null; }
  if (kpUnsubRepaint) { kpUnsubRepaint(); kpUnsubRepaint = null; }
  if (kpUnhookPick) { kpUnhookPick(); kpUnhookPick = null; }
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
  // 边界框：值是一串框对象，直接 JSON 出来是一屏括号，看不出有几个框
  if (widget === "bbox") {
    const n = Array.isArray(v) ? v.length : 0;
    return n ? t("{n} box(es)", { n }) : t("(empty)");
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

// ComfyUI 1.55 的控件 canonical 类型与别名（前端 vA 注册表）。
// 真机 widget.type 是 "number"/"combo"/"toggle"/"customtext" 这类小写名，
// 不是 INPUT_TYPES 里的 "INT"/"FLOAT"；旧版只认大写，数值框就会退化成文本。
// 值为 null 的：按钮、预览、曲线、3D 等专用控件，不适合打包成参数。
const KP_WIDGET_KIND = {
  int: "number", float: "number", number: "number", slider: "number", gradientslider: "number",
  boolean: "toggle", toggle: "toggle",
  combo: "combo", asset: "combo",
  string: "text", text: "text", textarea: "text", multiline: "text", customtext: "text",
  color: "text",
  button: null, chart: null, imagecompare: null, galleria: null, markdown: null,
  progresstext: null, textpreview: null, text_preview: null,
  audiorecord: null, audioui: null, audio_ui: null,
  load3d: null, load3dadvanced: null, camerainfo: null, cameraangle: null,
  imagecrop: null,
  // 「创建边界框」节点的框选控件：值是 [{x,y,width,height,metadata}]。
  // 它既不是数字也不是文本，打包时给独立类型 bbox，应用里渲染成能拖框的画布。
  boundingbox: "bbox", boundingboxes: "bbox",
  curve: null, painter: null, compositor: null, range: null, videoedit: null,
  colors: null, resolutionpreview: null,
  legacy: "",                    // 未知的旧控件：交给值/选项兜底
};

function widgetKind(type) {
  const t = String(type || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(KP_WIDGET_KIND, t)
    ? KP_WIDGET_KIND[t] : undefined;
}

function suggestWidget(node, w) {
  const ntype = node.type || node.comfyClass || "";
  if (ntype === "KedouImageLoader" && w.name === "media_state") return "kedou_media";
  if (ntype === "LoadImage" && w.name === "image") return "image";
  if (promptUsageOf(ntype, w.name)) return "prompt";
  const kind = widgetKind(w.type);
  if (kind) return kind;         // null/""/undefined 继续往下兜底
  // 自定义类型名（如 ResolutionSelector 的 aspect_ratio）：控件对象里有选项列表就是下拉，
  // 不应按类型名推断：判为 text 会使应用中的下拉退化为输入框
  const vals = comboValuesOf(w);
  if (vals && vals.length) return "combo";
  // 有些插件把数值/布尔塞进自定义控件，类型名认不出时按值兜底
  if (typeof w.value === "boolean") return "toggle";
  if (typeof w.value === "number") return "number";
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
      if (!w || !w.name) continue;
      if (w.name === "control_after_generate" || w.type === "control_after_generate") continue;
      // 「创建边界框」画布的内部状态：记录上一次从上游吃到什么，用来判断要不要重新初始化画布。
      // 它跟着框数据一起序列化，但露到应用面板上就是个纯噪音参数（而且改了会让画布重置）。
      if (w.name === "last_incoming") continue;
      if (absorbed.has(w.name)) continue;
      // DOM 控件是节点自绘的面板 UI 本身（图片选择器 / 提示词输入框），没有值，不能当参数
      if (w.type === "div" || w.name === "kedou_media" || w.name === "kedou_promptbox") continue;
      const special = ntype === "KedouImageLoader" && w.name === "media_state";
      if (w.type === "converted-widget" && !special) continue;  // 隐藏格
      // 已转换为输入且连着上游的 widget：值由上游驱动，打包成可调参数会在运行时破坏连线，故不提供勾选
      if (w.type === "converted-widget" && Array.isArray(node.inputs)
          && node.inputs.some((inp) => inp && inp.name === w.name && inp.link != null)) continue;
      const opt = w.options && typeof w.options === "object" ? w.options : {};
      if (!special) {
        // 按钮 / 预览 / 曲线 / 3D 等专用控件不是参数；不进应用面板
        if (widgetKind(w.type) === null) continue;
        // 不随工作流序列化、只在画布或属性面板展示的控件也不适合打包
        if (opt.serialize === false || opt.canvasOnly || opt.hideInPanel) continue;
      }
      const widget = suggestWidget(node, w);
      // 能力采集与建议类型解耦：选项/范围/多行一律从真机控件对象取下来存进候选，
      // 用户手动改控件类型（如文本→下拉）时能力不丢：仅按建议类型采集时，
      // 自定义类型名的下拉（ResolutionSelector 的 aspect_ratio）会落为空输入框
      let min, max, step;
      if (typeof opt.min === "number") min = opt.min;
      if (typeof opt.max === "number") max = opt.max;
      if (typeof opt.step === "number") step = opt.step;
      const options = comboValuesOf(w) ? comboValuesOf(w).slice() : null;
      const rawType = String(w.type || "").toLowerCase();
      // customtext / multiline / textarea 没带 options.multiline，但它们在应用里应是多行文本框
      const multiline = !!opt.multiline || rawType === "customtext"
        || rawType === "multiline" || rawType === "textarea";
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
      // 控件自己的标题（本地化 label），不是节点标题；没有就用控件名
      const label = String(w.label || w.displayName || w.name || "").trim() || w.name;
      // 边界框要连带画布尺寸：框是像素坐标，应用里按别的比例画完再交给节点，
      // 坐标就全歪了。width/height 就在同一个节点上，顺手取。
      let canvasW, canvasH;
      if (widget === "bbox") {
        const ww = widgets.find((x) => x && x.name === "width");
        const wh = widgets.find((x) => x && x.name === "height");
        if (ww && typeof ww.value === "number") canvasW = ww.value;
        if (wh && typeof wh.value === "number") canvasH = wh.value;
      }
      out.push({
        node: String(node.id), input: w.name, widget, default: w.value,
        node_type: ntype, node_title: title,
        min, max, step, options, multiline,
        usage_input: usageInput, usage_options: usageOptions, usage_default: usageDefault,
        canvas_w: canvasW, canvas_h: canvasH,
        label,
        valuePreview: kpPreview(w.value, widget),
      });
    }
  }
  return out;
}

// 应用名默认取工作流名字：新建/未保存的占位名不算，退回 untitled。
// 顺序：页签上的名字 → 文件名 → 图标题（官方 .app.json 里有）。
function defaultAppName() {
  const strip = (s) => String(s == null ? "" : s).trim()
    .replace(/\.kapp\.json$/i, "")
    .replace(/\.app\.json$/i, "")
    .replace(/\.json$/i, "")
    .replace(/\.kapp$/i, "");
  const placeholder = (s) => !s || /^unsaved/i.test(s) || /^untitled$/i.test(s)
    || /^未保存/.test(s) || /^未命名/.test(s);
  const pick = (s) => { const v = strip(s); return placeholder(v) ? "" : v; };
  try {
    const mgr = app.extensionManager && app.extensionManager.workflow;
    const wf = (mgr && mgr.activeWorkflow) || (app.workflowManager && app.workflowManager.activeWorkflow);
    if (wf) {
      const base = wf.path ? String(wf.path).split("/").pop() : "";
      const v = pick(wf.name) || pick(wf.filename) || pick(wf.fullFilename) || pick(base);
      if (v) return v;
    }
  } catch (_) { /* ignore */ }
  try {
    const g = app.graph;
    if (g) { const v = pick(g.title); if (v) return v; }
  } catch (_) { /* ignore */ }
  return "untitled";
}

// 当前工作流文件相对「工作流目录」的路径 —— 写进 kapp 的 source，以后靠它切回画布。
// ComfyUI 给的 path 形如 workflows/sub/x.json 或绝对路径，统一截掉 workflows/ 前缀，
// 让后端能直接 join 到 WORKFLOW_DIR。未保存的新工作流没有路径，返回空串（就不写 source）。
function currentWorkflowRel() {
  try {
    const mgr = app.extensionManager && app.extensionManager.workflow;
    const wf = (mgr && mgr.activeWorkflow) || (app.workflowManager && app.workflowManager.activeWorkflow);
    if (!wf) return "";
    let p = String(wf.path || wf.fullFilename || wf.filename || "").replace(/\\/g, "/");
    if (!p) return "";
    const i = p.indexOf("workflows/");
    if (i >= 0) p = p.slice(i + "workflows/".length);
    return /^unsaved/i.test(p) ? "" : p;
  } catch (_) {
    return "";
  }
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

  // ---- 已打包的应用列表 ----
  // 原来是一个「编辑已有应用」下拉：看得到名字，看不到有几个参数，也没法删。
  // 现在铺成列表，一行一个包，右边三个动作：工作流（在新页签打开它的来源图）、编辑、删除。
  const listField = document.createElement("div");
  listField.className = "kp-field";
  const listHd = document.createElement("div");
  listHd.className = "kp-applist-hd";
  const appCount = document.createElement("span");
  const newBtn = document.createElement("button");
  newBtn.className = "kp-tbtn";
  newBtn.textContent = t("New");
  newBtn.title = t("Start a new app from the current workflow");
  listHd.append(appCount, newBtn);
  const appListEl = document.createElement("div");
  appListEl.className = "kp-applist";
  listField.append(listHd, appListEl);

  // 编辑态提示：保存会写回原文件，跟「生成新包」是两回事，得说清楚
  const editHint = document.createElement("div");
  editHint.className = "kp-pickhint kp-edithint";
  editHint.style.display = "none";

  const nameField = document.createElement("div");
  nameField.className = "kp-field";
  const nameLab = document.createElement("label");
  nameLab.textContent = t("App name");
  const nameInput = document.createElement("input");
  nameInput.value = defaultAppName();
  // 名字还没被用户改过时跟着工作流走：换工作流后面板自动换成新名字
  let nameAuto = true;
  nameInput.addEventListener("input", () => { nameAuto = false; });
  nameField.append(nameLab, nameInput);

  const descField = document.createElement("div");
  descField.className = "kp-field";
  const descLab = document.createElement("label");
  descLab.textContent = t("Description (optional)");
  const descInput = document.createElement("input");
  descInput.placeholder = t("One sentence describing what this app does");
  descField.append(descLab, descInput);

  // 输出格式：本插件 kapp（API 图，稳定）/ 官方 .app.json（UI 图，ComfyUI 自己的 Apps 侧栏也能打开）。
  // 官方格式没有「应用描述」字段，选中时把描述行收起来。
  const fmtField = document.createElement("div");
  fmtField.className = "kp-field";
  const fmtLab = document.createElement("label");
  fmtLab.textContent = t("Output format");
  const fmtSel = document.createElement("select");
  fmtSel.appendChild(new Option(t("Kedou app package (.kapp.json)"), "kapp"));
  fmtSel.appendChild(new Option(t("Official app (.app.json) - opens in ComfyUI's Apps sidebar"), "official"));
  fmtField.append(fmtLab, fmtSel);

  const graphField = document.createElement("label");
  graphField.className = "kp-chk";
  graphField.style.display = "none";
  const graphCb = document.createElement("input");
  graphCb.type = "checkbox";
  const graphSpan = document.createElement("span");
  graphSpan.textContent = t("Update graph from current workflow");
  graphField.append(graphCb, graphSpan);

  const err = document.createElement("div");
  err.className = "kp-err";

  const ft = document.createElement("div");
  ft.className = "kp-ft";
  const gen = document.createElement("button");
  gen.className = "kp-gen";
  gen.textContent = t("Generate app package");
  ft.appendChild(gen);

  const pickPane = document.createElement("div");
  pickPane.className = "kp-pane";
  const pickSwitch = document.createElement("button");
  pickSwitch.className = "kp-tbtn";
  pickSwitch.textContent = t("Picking is on");
  pickSwitch.title = t("While on, clicking a parameter on the canvas adds or removes it");
  const pickHint = document.createElement("div");
  pickHint.className = "kp-pickhint";
  pickHint.textContent = t("Click a parameter on the canvas to add it; click again to remove it. Or tick the little box on its left.");
  const pickList = document.createElement("div");
  pickList.className = "kp-picklist";
  // 清单底下：几条 + 一键清空
  const pickFoot = document.createElement("div");
  pickFoot.className = "kp-pickfoot";
  const pickCount = document.createElement("span");
  const pickClear = document.createElement("button");
  pickClear.className = "kp-pclear";
  pickClear.textContent = t("Clear all");
  pickClear.title = t("Remove every picked parameter; the canvas is untouched");
  pickFoot.append(pickCount, pickClear);
  // 「用户看到的样子」：照应用的样子把清单摆一遍，纯预览，点不动
  const previewEl = document.createElement("details");
  previewEl.className = "kp-pv";
  const previewSum = document.createElement("summary");
  const previewBody = document.createElement("div");
  previewBody.className = "kp-pv-body";
  previewEl.append(previewSum, previewBody);
  try { previewEl.open = localStorage.getItem("kedou.pack.pv") !== "0"; } catch (_) { /* ignore */ }
  previewEl.addEventListener("toggle", () => {
    try { localStorage.setItem("kedou.pack.pv", previewEl.open ? "1" : "0"); } catch (_) { /* ignore */ }
  });
  pickPane.append(pickSwitch, pickHint, pickList, pickFoot, previewEl);

  body.append(listField, editHint, fmtField, nameField, descField, graphField,
              pickPane, err);
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

  // ---- 收集候选 ----
  // 「全部选项」那张分组勾选表已经删掉了：能力全在「点选」里（画布上点参数即加减，
  // 清单里能改名 / 改控件 / 排序 / 删除）。那页只是同一批数据的第二份视图，纯负担。
  const candidates = collectCandidates();
  const rows = [];

  // 点选状态：pickOrder = 用户点选的先后顺序，kapp 里的参数就按它排。
  // syncPick / renderPick 在下面点选模块里赋值；updateCount 每变一次就刷新一遍。
  let pickOrder = [];
  let syncPick = () => {};
  let renderPick = () => {};
  let renderPreview = () => {};

  const updateCount = () => {
    syncPick();
    renderPick();
    // 一个参数都没勾时「生成」按钮变灰：省得点了才发现空清单
    gen.disabled = !rows.some((r) => r.cb.checked);
    gen.classList.toggle("kp-gen-off", gen.disabled);
  };

  // 一行参数的数据载体。删掉列表页后不再有行 DOM —— lab / sel 只当状态容器，
  // 用户看到的输入框由 renderPick 每次重建（它会把值写回这里）。
  const addRow = (c) => {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const lab = document.createElement("input");
    lab.className = "kp-lab";
    lab.value = c.label;
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
    const entry = { cb, lab, sel, c, orphan: false, existingParam: null };
    rows.push(entry);
    cb.onchange = () => updateCount();
    return entry;
  };
  for (const c of candidates) addRow(c);
  updateCount();

  // ---- 点选：在画布上点参数即加/减，不用在列表里逐个比对 ----
  //
  // 命中靠 litegraph 自己的命中测试：调整鼠标坐标后 graph.getNodeOnPos + node.getWidgetOnPos，
  // 和 ComfyUI 构建器判断“鼠标悬停在哪一项”用的是同一套，缩放/滚动都自动正确。
  // 监听挂在 window 的捕获阶段：命中就拦下这次按下，litegraph 不会再当成拖控件/连线。
  // 自绘控件（图片框/提示词框）是 DOM 元素，canvas 上收不到，用 DOM 反查补上。
  const keyOf = (r) => String(r.c.node) + "|" + String(r.c.input);
  const rowMap = () => {
    const m = new Map();
    for (const r of rows) m.set(keyOf(r), r);
    return m;
  };
  syncPick = () => {
    const keys = rows.filter((r) => r.cb.checked).map(keyOf);
    for (let i = pickOrder.length - 1; i >= 0; i--) {
      if (keys.indexOf(pickOrder[i]) < 0) pickOrder.splice(i, 1);
    }
    for (const k of keys) if (pickOrder.indexOf(k) < 0) pickOrder.push(k);
  };

  let pickOn = true;
  let pickHooked = false;

  const toggleRow = (r) => {
    r.cb.checked = !r.cb.checked;
    updateCount();
    setTimeout(dropRowFocus, 0);
  };

  const findRowByIds = (nodeId, names) => {
    const list = Array.isArray(names) ? names : [names];
    for (const r of rows) {
      if (String(r.c.node) !== String(nodeId)) continue;
      for (const n of list) {
        if (n && (r.c.input === n || r.c.widget === n)) return r;
      }
    }
    return null;
  };

  const domWidgetAt = (t) => {
    for (const n of (app.graph && app.graph.nodes) || []) {
      for (const w of n.widgets || []) {
        const el = w && w.element;
        if (el && (el === t || (el.contains && el.contains(t)))) return { node: n, widget: w };
      }
    }
    return null;
  };

  const rowH = (w) => {
    const ch = w && w.computedHeight;
    if (typeof ch === "number" && ch > 0) return ch;
    return (w && w.height) || 20;
  };

  // 新版 Vue 节点渲染里，节点卡片是真 DOM：每个画出来的参数行是一个 .lg-node-widget 元素，
  // 但控件对象上没有行坐标（.y / computedHeight 是老布局的估算值，行高、多行框、折叠高级输入
  // 一改就错位），所以位置和命中一律以行元素为准。
  // 行元素上没有名字，只有显示名；按「显示名 + 顺序」和面板里的候选行做一次序列对齐，
  // 就知道每行对应哪个参数（有控件被折叠/被连线顶掉时顺序会对不上，靠对齐一次补上）。
  const rowLabelText = (rowEl) => {
    try {
      for (const e of rowEl.querySelectorAll("*")) {
        if (e.childElementCount === 0) {
          const s = (e.textContent || "").trim();
          if (s) return s;
        }
      }
    } catch (_) { /* ignore */ }
    return "";
  };

  const alignRows = (els, cands) => {
    const n = els.length, m = cands.length;
    if (!n || !m) return null;
    const le = els.map(rowLabelText);
    const lc = cands.map((c) => String(c.lab.value || c.c.label || "").trim());
    const NEG = -1e9;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(NEG));
    dp[0][0] = 0;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        if (!i && !j) continue;
        let best = NEG;
        if (j > 0) best = Math.max(best, dp[i][j - 1]);          // 这个控件没画出来（跳过）
        if (i > 0 && j > 0 && dp[i - 1][j - 1] > NEG / 2) {
          const same = le[i - 1] && lc[j - 1] && le[i - 1] === lc[j - 1] ? 4 : 0;
          best = Math.max(best, dp[i - 1][j - 1] + same);
        }
        dp[i][j] = best;
      }
    }
    if (dp[n][m] <= NEG / 2) return null;
    const pairs = [];
    let i = n, j = m;
    while (i > 0 && j > 0) {
      const same = le[i - 1] && lc[j - 1] && le[i - 1] === lc[j - 1] ? 4 : 0;
      if (dp[i][j] === dp[i - 1][j - 1] + same) { pairs.push([cands[j - 1], els[i - 1]]); i--; j--; }
      else j--;
    }
    return pairs;
  };

  // 圆点（被连线占用的参数只剩一个输入点）所在的行：往上找到直接挂在控件网格下面的那一层。
  // 节点顶部那排纯连线口不在控件网格里，返回 null（那些本来也不该勾）。
  const dotRowEl = (dot) => {
    let e = dot;
    while (e && e.parentElement) {
      const p = e.parentElement;
      if (p.classList && p.classList.contains("lg-node-widgets")) return e;
      if (p.getAttribute && p.getAttribute("data-node-id")) return null;
      e = p;
    }
    return null;
  };

  // 节点 -> { byRow: rowKey -> 行元素, byEl: 行元素 -> row }
  // 先按输入点自带的序号（data-slot-key = 节点-输入下标）一对一认，认不出的再按显示名对齐。
  // 这样连上线的参数（只剩圆点、行高变了）也能对上，纯连线的口没有 widget 就不给它方框。
  const nodeRows = (node) => {
    if (!node) return null;
    let card = null;
    try { card = document.querySelector('[data-node-id="' + node.id + '"]'); } catch (_) { card = null; }
    if (!card) return null;
    const byRow = new Map(), byEl = new Map();
    const used = new Set();
    const pre = node.id + "-in-";
    let dots = [];
    try { dots = Array.from(card.querySelectorAll("[data-slot-key]")); } catch (_) { dots = []; }
    for (const d of dots) {
      const k = String(d.getAttribute("data-slot-key") || "");
      if (k.indexOf(pre) !== 0) continue;
      const idx = Number(k.slice(pre.length));
      if (!(idx >= 0)) continue;
      const inp = node.inputs && node.inputs[idx];
      const name = inp && inp.widget && inp.widget.name;
      if (!name) continue;                       // 纯连线的口：官方也不让勾
      const el = dotRowEl(d);
      if (!el || used.has(el)) continue;
      const row = findRowByIds(node.id, name);
      if (!row) continue;
      byRow.set(keyOf(row), el); byEl.set(el, row); used.add(el);
    }
    const els = Array.from(card.querySelectorAll(".lg-node-widget")).filter((e) => !used.has(e));
    const cands = rows.filter((r) => String(r.c.node) === String(node.id) && !byRow.has(keyOf(r)));
    const pairs = alignRows(els, cands);
    if (pairs) for (const [c, e] of pairs) { byRow.set(keyOf(c), e); byEl.set(e, c); }
    if (!byRow.size) return null;
    return { byRow, byEl };
  };

  // 元素 -> {node, widget:{name}}：行元素就是参数本身
  const rowElFromTarget = (el) => {
    if (!el || !el.closest) return null;
    const card = el.closest("[data-node-id]");
    if (!card) return null;
    const id = Number(card.getAttribute("data-node-id"));
    const node = app.canvas && app.canvas.graph ? app.canvas.graph.getNodeById(id) : null;
    const nr = nodeRows(node);
    if (!nr) return null;
    let e = el;
    while (e && e !== card) {
      const row = nr.byEl.get(e);
      if (row) return { node, widget: { name: row.c.input } };
      e = e.parentElement;
    }
    return null;
  };

  // 鼠标位置 -> {node, widget}（老渲染兜底用）
  const widgetUnder = (cv, e) => {
    try { cv.adjustMouseEvent(e); } catch (_) { return null; }
    const gx = e.canvasX, gy = e.canvasY;
    if (typeof gx !== "number" || typeof gy !== "number") return null;
    const node = cv.graph.getNodeOnPos(gx, gy);
    if (!node) return null;
    let w = null;
    try { if (node.getWidgetOnPos) w = node.getWidgetOnPos(gx, gy, false); } catch (_) { w = null; }
    if (w) return { node, widget: w };
    const local = gy - (node.pos ? node.pos[1] : 0);
    for (const cand of node.widgets || []) {
      const y = cand.y;
      if (typeof y !== "number") continue;
      const h = rowH(cand);
      if (local < y || local > y + h) continue;
      return { node, widget: cand };
    }
    return { node, widget: null };
  };

  const onPickDown = (e) => {
    if (!pickOn || (e.button !== undefined && e.button !== 0)) return;
    const cv = app.canvas;
    if (!cv || !cv.graph || !cv.canvas) return;
    const tgt = e.target;
    if (!tgt) return;
    if (tgt.closest && tgt.closest(".kp-layer")) return;   // 画布蒙层上的小方框有自己的处理

    // 0) Vue 节点卡片里的参数行：一个行元素就是一个参数，按元素认最准
    const rowHit0 = rowElFromTarget(tgt);
    if (rowHit0) {
      const r = findRowByIds(rowHit0.node.id, [rowHit0.widget.name]);
      if (r) {
        e.preventDefault();
        e.stopPropagation();
        swallowMouse();
        toggleRow(r);
      }
      return;
    }

    // 1) 自绘控件（图片框 / 提示词框）：它们是真实 DOM 元素，优先按元素认
    const dom = domWidgetAt(tgt);
    if (dom && dom.widget && dom.widget.name) {
      const r = findRowByIds(dom.node.id, [dom.widget.name]);
      if (r) {
        e.preventDefault();
        e.stopPropagation();
        swallowMouse();
        toggleRow(r);
      }
      return;
    }

    // 2) 落在节点卡片上但没落到参数行/自绘控件上（标题、连线口、折叠按钮……）：
    //    Vue 卡片里行元素就是唯一依据，不再用老坐标猜，免得把纯连线的口认成某个参数。
    if (tgt.closest && tgt.closest("[data-node-id]")) return;

    // 3) 老渲染器（关掉 Vue 节点）没有卡片 DOM，退回按坐标估
    const host = cv.canvas.parentElement;
    const inGraph = tgt === cv.canvas
      || (host && host.contains && host.contains(tgt));
    if (!inGraph) return;

    const hit = widgetUnder(cv, e);
    if (!hit || !hit.widget || !hit.widget.name) return;   // 空白处 / 连线 / 非控件位置：不打扰
    const r = findRowByIds(hit.node.id, [hit.widget.name]);
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    swallowMouse();
    toggleRow(r);
  };

  // 拦下一次按下后，浏览器仍会派发 mousedown / mouseup / click；litegraph 的编辑/拖拽是在
  // 这些事件上启动的，所以紧跟着的那一串也要吃掉，否则点选参数时会顺带把参数带进输入状态
  // （出现光标、把键盘输入写进参数值）。
  let swallowNext = false;
  const swallowMouse = () => {
    swallowNext = true;
    setTimeout(() => { swallowNext = false; }, 0);
  };
  const onPickMouseDown = (e) => {
    if (!swallowNext) return;
    swallowNext = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const onPickFollow = (e) => {
    if (!swallowNext) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const dropRowFocus = () => {
    const a = document.activeElement;
    if (a && a !== document.body && a.closest && a.closest(".lg-node-widget")) {
      try { a.blur(); } catch (_) { /* ignore */ }
    }
  };

  const onPickMove = (e) => { lastPointer = [e.clientX, e.clientY]; };

  const hookPick = (on) => {
    pickSwitch.classList.toggle("kp-on", !!on);
    pickSwitch.textContent = on ? t("Picking is on") : t("Picking is off");
    pickHint.style.opacity = on ? ".62" : ".4";
    if (on === pickHooked) return;
    pickHooked = on;
    if (on) {
      window.addEventListener("pointerdown", onPickDown, true);
      window.addEventListener("mousedown", onPickMouseDown, true);
      window.addEventListener("mouseup", onPickFollow, true);
      window.addEventListener("click", onPickFollow, true);
      window.addEventListener("pointermove", onPickMove, true);
    } else {
      window.removeEventListener("pointerdown", onPickDown, true);
      window.removeEventListener("mousedown", onPickMouseDown, true);
      window.removeEventListener("mouseup", onPickFollow, true);
      window.removeEventListener("click", onPickFollow, true);
      window.removeEventListener("pointermove", onPickMove, true);
      lastPointer = null;
    }
    paintLayerLive(on);
  };

  // ---- 画布上的勾选框（照官方 App Builder 的样子） ----
  // 官方构建器是在每个参数行左边画一个小方框，勾上就把这项变成应用里的输入；勾了的行
  // 外面再套一圈蓝框。这里复刻同样的手感：一层固定定位的透明蒙层盖在画布上，按当前
  // 缩放/平移把方框贴到每个参数行上，每帧重算（几十个方框，成本可以忽略）。缩放、拖动
  // 画布、折叠节点都会跟住；画布外和被面板盖住的行不画。
  let layerEl = null;
  let layerRaf = 0;
  let layerNodes = new Map();     // 行 key -> {box, sel}
  let hoverBoxKey = null;         // 鼠标停在哪个方框上（用来高亮它对应的行）
  let lastPointer = null;         // 最近一次鼠标位置（悬停高亮用）
  const KP_PICK_PAD = 24;         // 点选时给每行左侧让出的宽度（节点坐标，跟画布一起缩放）
  const indented = new Set();     // 被连线顶上、只剩圆点的那种行：临时加缩进，好把方框放进去

  const ensureLayer = () => {
    if (!layerEl || !document.contains(layerEl)) {
      layerEl = document.createElement("div");
      layerEl.className = "kp-layer";
      document.body.appendChild(layerEl);
      layerNodes = new Map();
    }
    return layerEl;
  };

  const dropLayer = () => {
    if (layerRaf) { cancelAnimationFrame(layerRaf); layerRaf = 0; }
    if (layerEl) { layerEl.remove(); layerEl = null; }
    layerNodes = new Map();
    hoverBoxKey = null;
    for (const e of indented) { try { e.classList.remove("kp-indent"); } catch (_) { /* ignore */ } }
    indented.clear();
    document.body.classList.remove("kp-picking");
  };

  const paintLayer = () => {
    const cv = app.canvas;
    const layer = layerEl;
    if (!layer || !cv || !cv.canvas || !cv.ds || !cv.graph) return;
    const scale = cv.ds.scale || 1;
    const ox = cv.ds.offset[0], oy = cv.ds.offset[1];
    const cr = cv.canvas.getBoundingClientRect();
    let pr = null;
    try { pr = hostEl && document.contains(hostEl) ? hostEl.getBoundingClientRect() : null; } catch (_) { pr = null; }

    // 鼠标正压在哪一行：直接问行元素，跟眼睛看到的完全一致
    let hoverKey = null;
    const hp = lastPointer;
    if (hp) {
      let el = null;
      try { el = document.elementFromPoint(hp[0], hp[1]); } catch (_) { el = null; }
      if (el && !(el.closest && el.closest(".kp-layer"))) {
        const rh = rowElFromTarget(el);
        if (rh) {
          const row = findRowByIds(rh.node.id, [rh.widget.name]);
          if (row) hoverKey = keyOf(row);
        }
      }
    }

    const seen = new Set();
    const cache = new Map();
    for (const r of rows) {
      const node = cv.graph.getNodeById(r.c.node);
      if (!node || (node.flags && node.flags.collapsed)) continue;
      const key = keyOf(r);
      let map = cache.get(node.id);
      if (map === undefined) { map = nodeRows(node); cache.set(node.id, map); }

      let rowLeft = 0, rowTop = 0, rowPx = 0, rowW = 0, domRow = true;
      const nr = map;
      const el = nr ? nr.byRow.get(key) : null;
      if (nr) {
        // Vue 卡片在：只认真正画出来的行，没画出来的（折叠/隐藏）不出方框
        if (!el) continue;
        const b = el.getBoundingClientRect();
        if (b.width < 8 || b.height < 4) continue;
        if (el.classList && !el.classList.contains("lg-node-widget")) {
          // 被连线顶成圆点的行本来没有左侧留白，临时补上，方框才不压住圆点
          if (!el.classList.contains("kp-indent")) el.classList.add("kp-indent");
          indented.add(el);
        }
        rowLeft = b.left; rowTop = b.top; rowPx = b.height; rowW = b.width;
        const gx = (b.left + 6 - cr.left) / scale - ox;
        const gy = (b.top + b.height / 2 - cr.top) / scale - oy;
        let topNode = null;
        try { topNode = cv.graph.getNodeOnPos(gx, gy); } catch (_) { topNode = null; }
        if (topNode && topNode !== node) continue;      // 被别的节点压住：不画，免得飘在人家身上
      } else {
        domRow = false;
        const w = (node.widgets || []).find((x) => x && x.name === r.c.input);
        if (!w || typeof w.y !== "number") continue;
        const ch = rowH(w);
        if (!ch) continue;
        const surf = w._visibility && w._visibility.surfaces;
        if (surf && surf.vueNode === "hidden") continue;
        const gyTop = node.pos[1] + w.y;
        let topNode = null;
        try { topNode = cv.graph.getNodeOnPos(node.pos[0] + 2, gyTop + ch / 2); } catch (_) { topNode = null; }
        if (topNode && topNode !== node) continue;
        rowLeft = (node.pos[0] + ox) * scale + cr.left;
        rowTop = (gyTop + oy) * scale + cr.top;
        rowPx = ch * scale;
        rowW = (node.size ? node.size[0] : 200) * scale;
      }

      const hi = key === hoverKey || key === hoverBoxKey;
      // 方框画在行首：Vue 卡片给每行留了一点左内边距（见下面的 CSS），方框正好落进去，
      // 参数名整体右移，跟官方构建器一样；老渲染没有那列空白，就贴到节点左外侧。
      const padPx = domRow ? Math.max(0, Math.min(KP_PICK_PAD * scale, rowPx)) : 0;
      const size = Math.max(8, Math.min(16, domRow ? padPx - 3 : rowPx * 0.8));
      const sx = domRow ? rowLeft + Math.max(1, (padPx - size) / 2) : rowLeft - size - 5;
      const boxTop = rowTop + Math.max(0, Math.min((rowPx - size) / 2, (Math.min(rowPx, 26 * scale) - size) / 2));
      if (sx < cr.left - 2 || sx > cr.right - size || rowTop < cr.top || rowTop + rowPx > cr.bottom) continue;
      if (pr && sx + size > pr.left && sx < pr.right && rowTop + rowPx > pr.top && rowTop < pr.bottom) continue;
      seen.add(key);

      let it = layerNodes.get(key);
      if (!it) {
        const sel = document.createElement("div");
        sel.className = "kp-selbox";
        const box = document.createElement("div");
        box.className = "kp-hit";
        box.onpointerdown = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          swallowMouse();
          toggleRow(r);
          renderPick();
        };
        box.onpointerenter = () => { hoverBoxKey = key; };
        box.onpointerleave = () => { if (hoverBoxKey === key) hoverBoxKey = null; };
        layer.append(sel, box);
        it = { box, sel };
        layerNodes.set(key, it);
      }
      const on = !!r.cb.checked;
      it.box.classList.toggle("kp-on", on);
      it.box.classList.toggle("kp-hi", hi);
      let byWire = false;
      for (const s of node.inputs || []) {
        if (s && s.widget && s.widget.name === r.c.input) { byWire = !!(s.link || (s.links && s.links.length)); break; }
      }
      it.box.title = ((node.title || node.type || "") + " · " + (r.lab.value || r.c.label))
        + (byWire ? "（现在由连线提供）" : "");
      it.box.style.left = sx + "px";
      it.box.style.top = boxTop + "px";
      it.box.style.width = size + "px";
      it.box.style.height = size + "px";
      // 勾中的行套蓝框；鼠标压着的那行给一圈虚框，跟方框对上号
      if (on || hi) {
        it.sel.style.display = "";
        it.sel.classList.toggle("kp-sel-hi", !on);
        it.sel.style.left = rowLeft + "px";
        it.sel.style.top = rowTop + "px";
        it.sel.style.width = rowW + "px";
        it.sel.style.height = rowPx + "px";
      } else {
        it.sel.style.display = "none";
      }
    }
    for (const [k, it] of layerNodes) {
      if (seen.has(k)) continue;
      it.box.remove();
      it.sel.remove();
      layerNodes.delete(k);
    }
  };

  const tickLayer = () => {
    layerRaf = 0;
    if (!pickHooked) return;
    try { paintLayer(); } catch (_) { /* 单帧失败不打断循环 */ }
    if (pickHooked) layerRaf = requestAnimationFrame(tickLayer);
  };

  function paintLayerLive(on) {
    if (!on) { dropLayer(); return; }
    ensureLayer();
    document.body.classList.add("kp-picking");
    if (!layerRaf) layerRaf = requestAnimationFrame(tickLayer);
  }

  renderPick = () => {
    const map = rowMap();
    const ordered = pickOrder.map((k) => map.get(k)).filter(Boolean);
    pickCount.textContent = ordered.length ? t("Top to bottom is the order users see") : "";
    pickClear.style.display = ordered.length ? "" : "none";
    pickList.innerHTML = "";
    if (!ordered.length) {
      const empty = document.createElement("div");
      empty.className = "kp-pickhint";
      // 这张图压根没有可暴露的控件时，再说「去画布上点一个」就是误导
      empty.textContent = rows.length
        ? t("Nothing picked yet — click a parameter on the canvas.")
        : t("No exposeable widgets in the current workflow (all nodes are connection-type?).");
      pickList.appendChild(empty);
      renderPreview();
      return;
    }
    ordered.forEach((r, i) => {
      const el = document.createElement("div");
      el.className = "kp-pickrow" + (r.orphan ? " kp-orphan" : "");
      el.dataset.key = keyOf(r);
      const grip = document.createElement("span");
      grip.className = "kp-drag";
      grip.textContent = "⋮⋮";
      grip.title = t("Hold and drag to reorder");
      const lab = document.createElement("input");
      lab.className = "kp-lab";
      lab.value = r.lab.value || r.c.label;
      lab.title = r.orphan
        ? t("Name shown to users · #{node}:{input} · not in the current workflow",
            { node: r.c.node, input: r.c.input })
        : t("Name shown to users · #{node}:{input}", { node: r.c.node, input: r.c.input });
      lab.oninput = () => { r.lab.value = lab.value; renderPreview(); };
      const sel = document.createElement("select");
      sel.className = "kp-sel";
      for (const opt of KP_WIDGETS) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = t(KP_WIDGET_LABEL[opt] || opt);
        if (opt === r.sel.value) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => {
        r.sel.value = sel.value;
        renderPreview();
      };
      const move = (dir) => {
        const j = pickOrder.indexOf(keyOf(r));
        const k = j + dir;
        if (j < 0 || k < 0 || k >= pickOrder.length) return;
        pickOrder.splice(j, 1);
        pickOrder.splice(k, 0, keyOf(r));
        renderPick();
      };
      const up = document.createElement("button");
      up.className = "kp-pmove";
      up.textContent = "↑";
      up.title = t("Move up");
      up.disabled = i === 0;
      up.onclick = () => move(-1);
      const down = document.createElement("button");
      down.className = "kp-pmove";
      down.textContent = "↓";
      down.title = t("Move down");
      down.disabled = i === ordered.length - 1;
      down.onclick = () => move(1);
      const del = document.createElement("button");
      del.className = "kp-pdel";
      del.textContent = "×";
      del.title = t("Remove");
      del.onclick = () => toggleRow(r);
      el.append(grip);
      if (r.orphan) {
        const badge = document.createElement("span");
        badge.className = "kp-orbadge";
        badge.textContent = "!";
        badge.title = t("This parameter is not in the current workflow; it comes from the app package.");
        el.append(badge);
      }
      el.append(lab, sel, up, down, del);
      pickList.appendChild(el);
      if (dragKey && el.dataset.key === dragKey) el.classList.add("kp-dragging");
    });
    renderPreview();
  };

  // 按住 ⋮⋮ 上下拖：拖动过程中直接改 pickOrder，松手就定下来（小箭头仍在，两种都行）
  let dragKey = null;
  const rowKeyAt = (y) => {
    const list = Array.from(pickList.querySelectorAll(".kp-pickrow"));
    if (!list.length) return null;
    for (const el of list) {
      const r = el.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return el.dataset.key;
    }
    return y < list[0].getBoundingClientRect().top ? list[0].dataset.key : list[list.length - 1].dataset.key;
  };
  pickList.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest && e.target.closest(".kp-drag");
    if (!grip) return;
    const row = grip.closest(".kp-pickrow");
    if (!row || !row.dataset.key) return;
    dragKey = row.dataset.key;
    row.classList.add("kp-dragging");
    try { pickList.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    e.preventDefault();
  });
  pickList.addEventListener("pointermove", (e) => {
    if (!dragKey) return;
    const toKey = rowKeyAt(e.clientY);
    if (!toKey) return;
    const from = pickOrder.indexOf(dragKey);
    const to = pickOrder.indexOf(toKey);
    if (from < 0 || to < 0 || from === to) return;
    pickOrder.splice(from, 1);
    pickOrder.splice(to, 0, dragKey);
    renderPick();
  });
  const endDrag = () => {
    if (!dragKey) return;
    dragKey = null;
    renderPick();
  };
  pickList.addEventListener("pointerup", endDrag);
  pickList.addEventListener("pointercancel", endDrag);
  pickClear.onclick = () => {
    pickOrder.length = 0;
    for (const r of rows) r.cb.checked = false;
    updateCount();
  };

  // 「用户看到的样子」：按清单顺序摆一遍应用的样子（只画，不接任何操作）
  renderPreview = () => {
    const map = rowMap();
    const ordered = pickOrder.map((k) => map.get(k)).filter(Boolean);
    previewSum.textContent = ordered.length
      ? t("What users will see ({n} fields)", { n: ordered.length })
      : t("What users will see");
    previewBody.innerHTML = "";
    if (!ordered.length) {
      const empty = document.createElement("div");
      empty.className = "kp-pv-empty";
      empty.textContent = t("Pick some parameters and they show up here, arranged like the app.");
      previewBody.appendChild(empty);
      return;
    }
    const head = document.createElement("div");
    const nm = document.createElement("div");
    nm.className = "kp-pv-name";
    nm.textContent = nameInput.value.trim() || t("Untitled app");
    head.appendChild(nm);
    const dsc = descInput.value.trim();
    if (dsc) {
      const dd = document.createElement("div");
      dd.className = "kp-pv-desc";
      dd.textContent = dsc;
      head.appendChild(dd);
    }
    previewBody.appendChild(head);
    for (const r of ordered) {
      const field = document.createElement("div");
      field.className = "kp-pv-field";
      const lab = document.createElement("div");
      lab.className = "kp-pv-lab";
      lab.textContent = r.lab.value || r.c.label;
      field.appendChild(lab);
      const w = r.sel.value;
      if (w === "toggle") {
        const sw = document.createElement("div");
        sw.className = "kp-pv-sw";
        field.appendChild(sw);
      } else if (w === "image" || w === "kedou_media") {
        const up = document.createElement("div");
        up.className = "kp-pv-up";
        up.textContent = t("Click to upload an image");
        field.appendChild(up);
      } else {
        const box = document.createElement("div");
        box.className = "kp-pv-in" + (w === "prompt" ? " kp-pv-area" : "");
        const txt = kpPreview(r.c.default, w) || t("(empty)");
        box.textContent = txt + (w === "combo" ? "  ▾" : "");
        field.appendChild(box);
      }
      previewBody.appendChild(field);
    }
    const run = document.createElement("div");
    run.className = "kp-pv-run";
    run.textContent = t("Run");
    previewBody.appendChild(run);
  };
  nameInput.addEventListener("input", () => { if (typeof renderPreview === "function") renderPreview(); });
  descInput.addEventListener("input", () => { if (typeof renderPreview === "function") renderPreview(); });

  pickSwitch.onclick = () => {
    pickOn = !pickOn;
    hookPick(pickOn);
  };
  kpUnhookPick = () => {
    if (pickHooked) {
      pickHooked = false;
      window.removeEventListener("pointerdown", onPickDown, true);
      window.removeEventListener("mousedown", onPickMouseDown, true);
      window.removeEventListener("mouseup", onPickFollow, true);
      window.removeEventListener("click", onPickFollow, true);
      window.removeEventListener("pointermove", onPickMove, true);
      lastPointer = null;
    }
    dropLayer();
  };
  syncPick();
  renderPick();

  // ---- 编辑已打包应用 ----
  // 从列表里点「编辑」后，把包里的参数映射回当前画布的候选行；当前画布没有的参数
  // 仍然留在清单里（打 ! 标），可以改标签 / 控件类型，也可以取消勾选。
  let editing = null;        // {id, file, kapp}

  const setPrimaryLabel = () => {
    if (editing) { gen.textContent = t("Save changes"); return; }
    gen.textContent = fmtSel.value === "official" ? t("Generate official app") : t("Generate app package");
  };
  // 官方格式只能从画布 UI 图生成，而「编辑已打包的应用」里只有 kapp：
  // 编辑态锁死格式，免得用户以为能把旧 kapp 原地转成官方包。
  const syncFmt = () => {
    const official = fmtSel.value === "official";
    descField.style.display = official ? "none" : "";
    fmtSel.disabled = !!editing;
    fmtSel.title = editing ? t("Editing an existing app keeps its format") : "";
    if (!gen.disabled) setPrimaryLabel();
  };
  fmtSel.onchange = syncFmt;
  syncFmt();

  const resetRows = () => {
    // 上一轮编辑旧包时补进来的孤立行（画布上根本没有这个节点）留着没用，直接丢掉，
    // 否则换一个应用后它们还挂在 rows 里，看着像当前工作流的参数。
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].orphan) rows.splice(i, 1);
    }
    for (const r of rows) {
      r.cb.checked = false;
      r.lab.value = r.c.label;
      r.sel.value = KP_WIDGETS.indexOf(r.c.widget) >= 0 ? r.c.widget : "text";
      r.orphan = false;
      r.existingParam = null;
    }
  };

  // 旧版打包把数值/布尔都存成了 text；重新打开时以当前控件识别结果为准。
  // 用户自己改过的类型（非 text）保留，不覆盖。
  const editedWidgetType = (saved, cand) => {
    const w = KP_WIDGETS.indexOf(saved) >= 0 ? saved : "text";
    if (!cand || w !== "text") return w;
    return KP_WIDGETS.indexOf(cand.widget) >= 0 ? cand.widget : w;
  };
  // 标题：旧应用的 label 往往就是节点标题（整组同名），换成控件自己的标题；
  // 用户改过的标题保留。同节点多个参数共用一个标题也视为旧的节点标题。
  const editedLabel = (saved, p, cand, dup) => {
    const s = String(saved || "").trim();
    const input = String((cand && cand.input) || p.input || "").trim();
    const titles = [cand && cand.node_title, p.node_title].filter(Boolean);
    const stale = !s || s === input || titles.indexOf(s) >= 0 || (dup && dup[s] > 1);
    if (stale && cand && cand.label) return String(cand.label);
    return s || input;
  };
  const applyEditing = (file, kapp, id) => {
    editing = { id: id || "", file, kapp: kapp || {} };
    fmtSel.value = "kapp";
    syncFmt();
    resetRows();
    nameInput.value = String(editing.kapp.name || "");
    nameAuto = false;
    nameInput.title = t("For an existing app, this only changes the display name; the file name stays.");
    descInput.value = String(editing.kapp.desc || "");
    graphCb.checked = false;
    graphField.style.display = "";
    editHint.textContent = t("Editing \"{name}\": saving writes back to that app file.",
                             { name: editing.kapp.name || id || "" });
    editHint.style.display = "";
    const params = Array.isArray(editing.kapp.params) ? editing.kapp.params : [];
    const labelCount = {};
    pickOrder = [];                  // 清单按包里原来的顺序重建，别被画布顺序打乱
    for (const p of params) {
      const s = p && typeof p === "object" ? String(p.label || "").trim() : "";
      if (s) labelCount[s] = (labelCount[s] || 0) + 1;
    }
    for (const p of params) {
      if (!p || typeof p !== "object") continue;
      const nodeId = String(p.node == null ? "" : p.node);
      const input = String(p.input == null ? "" : p.input);
      let r = rows.find((x) => x.c.node === nodeId && x.c.input === input);
      const widget = editedWidgetType(p.widget, r ? r.c : null);
      const label = editedLabel(p.label, p, r ? r.c : null, labelCount);
      if (!r) {
        // 当前画布上没有这个参数：仍然列出来（否则一编辑旧包就丢参数），标成 orphan
        r = addRow({
          node: nodeId, input, widget,
          default: p.default,
          node_type: p.node_type || "", node_title: p.node_title || "",
          label,
          valuePreview: kpPreview(p.default, widget),
          min: p.min, max: p.max, step: p.step,
          options: Array.isArray(p.options) ? p.options : null,
          multiline: !!p.multiline,
          usage_input: p.usage_input,
          usage_options: p.usage_options,
          usage_default: p.usage_default,
        });
        r.orphan = true;
      }
      r.cb.checked = true;
      r.lab.value = label;
      r.sel.value = widget;
      r.existingParam = p;
      pickOrder.push(keyOf(r));
    }
    updateCount();
    setPrimaryLabel();
    renderAppList();                 // 高亮正在编辑的这一行
    err.textContent = "";
  };
  const resetEditor = () => {
    editing = null;
    syncFmt();
    resetRows();
    nameInput.value = defaultAppName();
    nameAuto = true;
    nameInput.title = "";
    descInput.value = "";
    graphCb.checked = false;
    graphField.style.display = "none";
    editHint.style.display = "none";
    updateCount();
    setPrimaryLabel();
    renderAppList();
    err.textContent = "";
  };
  newBtn.onclick = () => resetEditor();

  // ---- 已打包的应用列表：拉取 + 渲染 ----
  let appsData = [];
  const renderAppList = () => {
    appListEl.innerHTML = "";
    appCount.textContent = appsData.length
      ? t("Packaged apps ({n})", { n: appsData.length })
      : t("Packaged apps");
    if (!appsData.length) {
      const empty = document.createElement("div");
      empty.className = "kp-empty";
      empty.textContent = t("No apps packed yet.");
      appListEl.appendChild(empty);
      return;
    }
    for (const a of appsData) {
      const row = document.createElement("div");
      row.className = "kp-approw" + (editing && editing.id === a.id ? " kp-on" : "");
      const info = document.createElement("div");
      info.className = "kp-appinfo";
      const nm = document.createElement("div");
      nm.className = "kp-appname";
      nm.textContent = String(a.name || a.id);
      nm.title = nm.textContent;
      const meta = document.createElement("div");
      meta.className = "kp-appmeta";
      meta.textContent = t("{p} params · {n} nodes", { p: a.param_count || 0, n: a.node_count || 0 });
      info.append(nm, meta);
      const acts = document.createElement("div");
      acts.className = "kp-appacts";
      const wfB = document.createElement("button");
      wfB.className = "kp-tbtn";
      wfB.textContent = t("Workflow");
      // 不置灰：11 个老包全都没有 source，一排灰按钮看着像坏了。
      // 点了如实说明「旧包没记来源，重新打包一次就好」，比灰着等人来猜强。
      wfB.title = a.source
        ? t("Open the workflow this app was packed from in a tab")
        : t("This app was packed before the source workflow was recorded; re-pack it once and this button will work.");
      wfB.onclick = () => openSourceWorkflow(a, wfB);
      const edB = document.createElement("button");
      edB.className = "kp-tbtn";
      edB.textContent = t("Edit");
      edB.title = t("Load this app's parameters into the panel");
      edB.onclick = () => loadAppForEdit(a.id);
      const delB = document.createElement("button");
      delB.className = "kp-tbtn kp-danger";
      delB.textContent = t("Delete");
      delB.title = t("Move this app file to the recycle folder");
      delB.onclick = () => deleteApp(a);
      acts.append(wfB, edB, delB);
      row.append(info, acts);
      appListEl.appendChild(row);
    }
  };

  const loadApps = async () => {
    try {
      const r = await fetch("/ps/pack/apps");
      let j = null;
      try { j = await r.json(); } catch (_) { /* ignore */ }
      if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
      appsData = (j.apps || []).filter((a) => a && !a.error && a.id);
      renderAppList();
      // 切过源工作流 / 存过新包：面板重建后自动回到原来那个应用，用户不用再点一次
      if (kpRestoreApp) {
        const want = kpRestoreApp;
        kpRestoreApp = "";
        loadAppForEdit(want);
      }
    } catch (e) {
      console.warn("[kedou] 打包应用列表加载失败", e);
      appsData = [];
      appCount.textContent = t("Packaged apps");
      appListEl.innerHTML = "";
      const bad = document.createElement("div");
      bad.className = "kp-empty";
      bad.textContent = t("Failed to load the app list: {msg}",
                          { msg: String((e && e.message) || e) });
      appListEl.appendChild(bad);
    }
  };
  loadApps();

  let editReq = 0;            // 连点两下时，丢弃过期的读取结果
  const loadAppForEdit = async (id) => {
    if (!id) { resetEditor(); return; }
    if (editing && editing.id === id) return;    // 正在编辑它，别把没保存的改动冲掉
    const seq = ++editReq;
    err.textContent = "";
    try {
      const r = await fetch("/ps/apps/" + encodeURIComponent(id) + "/package");
      let j = null;
      try { j = await r.json(); } catch (_) { /* ignore */ }
      if (seq !== editReq) return;
      if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
      // target 相对工作流目录，回写时原样传回；file 只是展示路径（相对 ComfyUI 根）
      applyEditing(j.target || j.file, j.kapp, id);
    } catch (e) {
      if (seq !== editReq) return;
      const msg = serverError(e && e.message ? e.message : String(e));
      resetEditor();
      err.textContent = t("Failed to load app: {msg}", { msg });
    }
  };

  // 「工作流」：全程走 ComfyUI 自己的页签机制，**绝不动当前画布**。
  //   ① 已经开着的页签里有 → 切过去（未保存的改动留在各自页签里）
  //   ② 磁盘工作流列表里有 → 开新页签
  //   ③ 列表里没有（刚建 / 刚改名）→ 读文件内容，作为临时工作流开新页签
  const openSourceWorkflow = async (a, btn) => {
    const want = String((a && a.source) || "").trim();
    if (!want) {
      kpToast(t("This app was packed before the source workflow was recorded; re-pack it once and this button will work."), true);
      return;
    }
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = t("Opening…");
    const done = () => { btn.disabled = false; btn.textContent = old; };
    try {
      const mgr = app.extensionManager && app.extensionManager.workflow;
      if (!mgr || typeof mgr.openWorkflow !== "function") {
        throw new Error(t("This ComfyUI frontend has no workflow tabs; update ComfyUI."));
      }
      // computed ref 和普通数组都兜住
      const listOf = (x) => (x && x.value !== undefined ? x.value : x) || [];
      const norm = (s) => String(s || "").replace(/\\/g, "/");
      const target = norm(want);
      // fullFilename 就是「相对工作流目录」的名字，正好和 kapp 里的 source 同格式
      const same = (w) => {
        if (!w) return false;
        const rel = norm(w.fullFilename);
        const p = norm(w.path);
        return rel === target || p === "workflows/" + target || p.endsWith("/" + target);
      };
      kpRestoreApp = (editing && editing.id) || "";   // 切完面板会重建，把它选回来

      // ① 已打开的页签：直接切，画布内容由 ComfyUI 自己的页签机制接管
      const opened = listOf(mgr.openWorkflows).find(same);
      if (opened) {
        await mgr.openWorkflow(opened);
        kpToast(t("Switched to {name}", { name: opened.fullFilename || target }));
        done();
        return;
      }
      // ② 磁盘上有这张：openWorkflow 发现它没开过就会新开一个页签
      const onDisk = listOf(mgr.workflows).find(same);
      if (onDisk) {
        await mgr.openWorkflow(onDisk);
        kpToast(t("Opened {name} in a new tab", { name: onDisk.fullFilename || target }));
        done();
        return;
      }
      // ③ 列表里没有：读文件内容，造一个临时工作流开新页签（同样不碰当前画布）
      const r = await fetch("/ps/pack/workflow?file=" + encodeURIComponent(want));
      let j = null;
      try { j = await r.json(); } catch (_) { /* ignore */ }
      if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
      const tmp = mgr.createTemporary(target.split("/").pop(), j.workflow);
      await mgr.openWorkflow(tmp);
      kpToast(t("Opened {name} in a new tab", { name: j.file }));
      done();
    } catch (e) {
      done();
      err.textContent = serverError(e && e.message ? e.message : String(e));
    }
  };

  // 「删除」= 移到 user/default/kedou_trash，不是真删 —— 手滑点错还能捞回来。
  const deleteApp = async (a) => {
    const label = String(a.name || a.id);
    if (!window.confirm(t("Delete \"{name}\"? It moves to user/default/kedou_trash (not erased) and disappears from the launcher and the PS panel.", { name: label }))) return;
    err.textContent = "";
    try {
      const r = await fetch("/ps/pack/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: a.target || "" }),
      });
      let j = null;
      try { j = await r.json(); } catch (_) { /* ignore */ }
      if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
      if (editing && editing.id === a.id) resetEditor();
      kpToast(t("Deleted {name}", { name: label }));
      await loadApps();
    } catch (e) {
      err.textContent = t("Delete failed: {msg}",
                          { msg: serverError(e && e.message ? e.message : String(e)) });
    }
  };

  const repaint = () => {
    titleEl.textContent = t("Pack app");
    newBtn.textContent = t("New");
    newBtn.title = t("Start a new app from the current workflow");
    nameLab.textContent = t("App name");
    fmtLab.textContent = t("Output format");
    fmtSel.options[0].textContent = t("Kedou app package (.kapp.json)");
    fmtSel.options[1].textContent = t("Official app (.app.json) - opens in ComfyUI's Apps sidebar");
    descLab.textContent = t("Description (optional)");
    descInput.placeholder = t("One sentence describing what this app does");
    nameInput.title = editing ? t("For an existing app, this only changes the display name; the file name stays.") : "";
    if (editing) {
      editHint.textContent = t("Editing \"{name}\": saving writes back to that app file.",
                               { name: editing.kapp.name || editing.id || "" });
    }
    graphSpan.textContent = t("Update graph from current workflow");
    pickSwitch.textContent = pickOn ? t("Picking is on") : t("Picking is off");
    pickSwitch.title = t("While on, clicking a parameter on the canvas adds or removes it");
    pickHint.textContent = t("Click a parameter on the canvas to add it; click again to remove it. Or tick the little box on its left.");
    pickClear.textContent = t("Clear all");
    pickClear.title = t("Remove every picked parameter; the canvas is untouched");
    if (!gen.disabled) setPrimaryLabel();
    renderAppList();     // 行内按钮文案也要跟着语言走
    updateCount();       // 清单 + 预览随之重画
  };
  kpUnsubRepaint = onLocaleChange(repaint);   // 侧栏常驻也要能注销，否则重建一次泄漏一个监听

  gen.onclick = () => doGenerate({
    nameInput, descInput, rows, err, gen, graphCb, fmtSel,
    order: () => pickOrder,
    editing: () => editing,
    refreshList: () => loadApps(),
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
        return;
      }
      if (nameAuto && !editing) {
        const auto = defaultAppName();
        if (auto && nameInput.value !== auto) nameInput.value = auto;
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
  const checked = ctx.rows.filter((r) => r.cb.checked);
  // 点选页的顺序就是 kapp 里的参数顺序：按 pickOrder 排一遍（没点过的排在后面）
  if (typeof ctx.order === "function") {
    const ord = ctx.order() || [];
    const pos = (r) => {
      const i = ord.indexOf(String(r.c.node) + "|" + String(r.c.input));
      return i < 0 ? 1e6 : i;
    };
    checked.sort((a, b) => pos(a) - pos(b));
  }
  if (!checked.length) {
    ctx.err.textContent = t("Select at least one parameter");
    return;
  }
  // 官方 .app.json 只能从画布 UI 图生成，且「编辑已打包的应用」里只有 kapp
  if (!editing && ctx.fmtSel && ctx.fmtSel.value === "official") {
    await doGenerateOfficial(ctx, checked);
    return;
  }
  // 编辑已有应用时默认保留原 graph / outputs，只改参数声明；
  // 勾了「用当前工作流更新图」才重新抓图（参数也得能在新图里找到）。
  const updateGraph = !editing || !!(ctx.graphCb && ctx.graphCb.checked);
  const primary = () => editing ? t("Save changes") : t("Generate app package");
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
    if (p.widget === "bbox") {
      // 画布比例跟着节点的 width/height 走（换图时以画布当前值为准）
      if (updateGraph || p.canvas_w == null) { if (c.canvas_w != null) p.canvas_w = c.canvas_w; }
      if (updateGraph || p.canvas_h == null) { if (c.canvas_h != null) p.canvas_h = c.canvas_h; }
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
  // source 记「这包是从哪张工作流打的」，只为了以后能一键切回那张图。
  // 新建、或勾了「用当前工作流更新图」时，源就是画布上现在这张，顺手刷新它。
  if (updateGraph) {
    const rel = currentWorkflowRel();
    if (rel) kapp.source = rel;
  }
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
      if (typeof ctx.refreshList === "function") ctx.refreshList();   // 列表里补上新包
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

// 官方 App Mode 的应用就是 UI 工作流本身 + extra.linearMode/linearData：
// 必须发 app.graph.serialize()（整张界面图），API 图反推不回位置与连线。
// 参数只报 node/input，后端按节点类型把自绘控件换成 DOM 把手（media_state→kedou_media）。
async function doGenerateOfficial(ctx, checked) {
  const primary = () => t("Generate official app");
  ctx.gen.disabled = true;
  ctx.gen.textContent = t("Generating…");
  ctx.err.textContent = "";
  let wf;
  try {
    wf = app.graph.serialize();
  } catch (e) {
    ctx.err.textContent = t("Failed to read the workflow: {msg}", { msg: e && e.message ? e.message : e });
    ctx.gen.disabled = false;
    ctx.gen.textContent = primary();
    return;
  }
  const params = checked.map((r) => ({
    node: r.c.node,
    input: r.c.input,
    label: r.lab.value.trim() || r.c.label || r.c.input,
  }));
  const outputs = [];
  for (const n of (wf.nodes || [])) {
    if (n && String(n.type || "").toLowerCase().includes("save")) outputs.push(String(n.id));
  }
  if (!outputs.length) {
    ctx.err.textContent = t("No output node found; add a SaveImage-like node first.");
    ctx.gen.disabled = false;
    ctx.gen.textContent = primary();
    return;
  }
  const name = ctx.nameInput.value.trim() || defaultAppName();
  try {
    const resp = await fetch("/ps/pack/app", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, workflow: wf, params, outputs }),
    });
    let j = null;
    try { j = await resp.json(); } catch (_) { /* ignore */ }
    if (!resp.ok || !j || !j.ok) {
      const msg = serverError((j && j.error) ? j.error : ("HTTP " + resp.status));
      const text = t("Generation failed: {msg}", { msg });
      ctx.err.textContent = text;
      kpToast(text, true);
    } else {
      kpToast(t("Generated {file}; refresh the launcher to see it", { file: j.file || name }));
      closePackPanel();
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

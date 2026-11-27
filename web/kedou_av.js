// KedouAVLoader —— 视频/音频多选面板。普通模式按顺序配对同时输出，批次模式逐组排队。

import { app } from "../../scripts/app.js";
import { t, initI18n, onLocaleChange, serverError } from "./i18n.js";
import { ensureCss, thumbUrl, fetchLibrary, kdToast, nodeOnCanvas, settleQueueSubmission, kdGesture, hideMediaStateInput } from "./kedou_media.js";

const NODE_CLASS = "KedouAVLoader";
const AV_SLOTS = 8;
const AV_ITEM_LIMIT = 500;
const AV_OUTPUT_SLOTS = 32;
const VID_EXTS = [".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".ogv"];
const AUD_EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"];
const INFO_CACHE = new Map();

const AV_CSS = [
  ".kav-card{height:100%;min-height:260px;display:flex;flex-direction:column;box-sizing:border-box;}",
  ".kav-card.kd-batch-lock .kav-body{pointer-events:none;user-select:none;}",
  ".kav-body{display:flex;flex-direction:column;gap:8px;padding:8px;overflow:hidden;flex:1;min-height:0;}",
  ".kav-top{flex-wrap:wrap;}",
  ".kav-mode{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;}",
  ".kav-mode button{border:1px solid var(--border-color,#3a3a44);background:transparent;color:var(--fg-color,#ddd);",
  "font:11px system-ui;padding:3px 10px;border-radius:7px;cursor:pointer;}",
  ".kav-mode button.on{border-color:var(--p-primary-color,#4a7dff);color:var(--p-primary-color,#4a7dff);}",
  ".kav-slots{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:8px;flex:1;min-height:0;}",
  ".kav-slot{height:100%;min-height:0;min-width:0;box-sizing:border-box;border:1px solid var(--border-color,#3a3a44);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:5px;}",
  ".kav-slot-hd{display:flex;align-items:center;gap:5px;flex-wrap:wrap;flex-shrink:0;font-size:11px;}",
  ".kav-slot-hd b{font-weight:600;}",
  ".kav-slot-hd .kav-grow{flex:1;min-width:0;}",
  ".kav-slot-hd .kd-btn{font-size:11px;padding:3px 8px;max-width:100%;white-space:normal;overflow-wrap:anywhere;}",
  ".kav-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:max-content;gap:6px;flex:1;min-height:0;overflow:auto;align-content:start;}",
  ".kav-item{position:relative;border:1px solid var(--border-color,#3a3a44);border-radius:7px;overflow:hidden;",
  "background:rgba(0,0,0,.18);cursor:pointer;min-width:0;}",
  ".kav-item.off{opacity:.42;}",
  ".kav-item.on{outline:2px solid var(--p-primary-color,#4a7dff);outline-offset:-2px;}",
  ".kav-item.drag-over{outline:2px dashed var(--p-primary-color,#4a7dff);outline-offset:-2px;}",
  ".kav-item img{display:block;width:100%;height:64px;object-fit:cover;background:#181820;}",
  ".kav-item-name{display:block;padding:4px 22px 4px 20px;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".kav-item-no{position:absolute;left:5px;bottom:5px;min-width:16px;height:16px;line-height:16px;text-align:center;",
  "border-radius:8px;background:rgba(0,0,0,.7);color:#fff;font-size:10px;}",
  ".kav-item-del{position:absolute;right:3px;bottom:3px;width:18px;height:18px;border:0;border-radius:5px;",
  "background:rgba(0,0,0,.65);color:#fff;cursor:pointer;font-size:13px;line-height:16px;}",
  ".kav-empty{grid-column:1/-1;font-size:11px;color:var(--descrip-text,#9a9aa6);padding:8px 4px;text-align:center;}",
  ".kav-frames{display:none;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;flex-shrink:0;}",
  ".kav-frames.on{display:grid;}",
  ".kav-frames label{display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--descrip-text,#9a9aa6);}",
  ".kav-frames input{width:100%;box-sizing:border-box;background:var(--comfy-input-bg,#1b1b21);color:#eee;",
  "border:1px solid var(--border-color,#3a3a44);border-radius:6px;padding:4px 5px;font:11px system-ui;}",
  ".kav-foot{display:flex;align-items:center;gap:6px;padding:7px 8px;border-top:1px solid var(--border-color,#3a3a44);flex-shrink:0;}",
  ".kav-foot .kav-meta{min-width:0;overflow-wrap:anywhere;}",
  ".kav-run{margin-left:auto;}",
  ".kav-lib-preview{width:100%;height:74px;object-fit:cover;border-radius:6px;background:#181820;}",
  ".kav-trim-pop{position:fixed;z-index:100020;width:min(380px,94vw);background:var(--interface-panel-surface,#20222a);",
  "color:var(--fg-color,#e7e7ea);border:1px solid var(--interface-stroke,#3a3a44);border-radius:10px;",
  "box-shadow:0 16px 42px rgba(0,0,0,.55);overflow:hidden;font:12px system-ui;}",
  ".kav-trim-video{display:block;width:100%;height:190px;object-fit:contain;background:#111;cursor:crosshair;touch-action:none;}",
  ".kav-trim-bar{display:flex;align-items:center;gap:7px;padding:7px 9px;}",
  ".kav-trim-play{width:26px;height:24px;border:1px solid var(--interface-stroke,#3a3a44);border-radius:6px;",
  "background:transparent;color:inherit;cursor:pointer;display:grid;place-items:center;padding:0;}",
  ".kav-trim-play svg{display:block;width:14px;height:14px;fill:currentColor;}",
  ".kav-trim-play.is-playing{color:var(--p-primary-color,#4a7dff);border-color:var(--p-primary-color,#4a7dff);",
  "background:rgba(74,125,255,.12);}",
  ".kav-trim-time{font:10.5px ui-monospace,monospace;white-space:nowrap;}",
  ".kav-trim-track{position:relative;height:24px;margin:0 9px 8px;border-radius:5px;background:#343440;cursor:crosshair;touch-action:none;overflow:hidden;}",
  ".kav-trim-out{position:absolute;top:0;bottom:0;background:rgba(0,0,0,.62);pointer-events:none;}",
  ".kav-trim-range{position:absolute;top:3px;bottom:3px;border:1px solid var(--p-primary-color,#4a7dff);",
  "background:rgba(74,125,255,.24);cursor:grab;touch-action:none;}",
  ".kav-trim-range:active{cursor:grabbing;}",
  ".kav-trim-handle{position:absolute;top:0;bottom:0;width:7px;background:var(--p-primary-color,#4a7dff);cursor:ew-resize;z-index:1;}",
  ".kav-trim-hint{padding:0 9px 8px;color:var(--descrip-text,#9a9aa6);font-size:10.5px;}",
  ".kav-seg-btn{margin-left:auto;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;",
  "border:1px solid var(--interface-stroke,#3a3a44);border-radius:6px;background:transparent;color:inherit;",
  "opacity:.66;font:10.5px system-ui;cursor:pointer;}",
  ".kav-seg-btn:hover,.kav-seg-btn:focus-visible{opacity:1;border-color:var(--p-primary-color,#4a7dff);}",
  ".kav-seg-btn svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;}",
  ".kav-seg-pop{position:fixed;z-index:100030;width:min(560px,calc(100vw - 16px));max-height:calc(100vh - 16px);",
  "max-height:calc(100dvh - 16px);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;",
  "background:var(--interface-panel-surface,#20222a);",
  "color:var(--fg-color,#e7e7ea);border:1px solid var(--interface-stroke,#3a3a44);border-radius:10px;",
  "box-shadow:0 16px 42px rgba(0,0,0,.55);font:12px system-ui;}",
  ".kav-seg-hd{display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid var(--interface-stroke,#3a3a44);}",
  ".kav-seg-title{min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".kav-seg-file{min-width:0;opacity:.6;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".kav-seg-close{margin-left:auto;flex:0 0 24px;width:24px;height:24px;padding:0;border:0;border-radius:5px;",
  "background:transparent;color:inherit;opacity:.65;cursor:pointer;}",
  ".kav-seg-close:hover{opacity:1;background:rgba(127,127,127,.15);}",
  ".kav-seg-close svg{display:block;width:14px;height:14px;margin:auto;fill:none;stroke:currentColor;stroke-width:1.8;}",
  ".kav-seg-scroll{min-height:0;overflow:auto;padding:9px 10px;display:flex;flex-direction:column;gap:8px;}",
  ".kav-seg-tabs{display:flex;gap:5px;}",
  ".kav-seg-tabs button,.kav-seg-btn2{min-height:27px;border:1px solid var(--interface-stroke,#3a3a44);border-radius:6px;",
  "background:transparent;color:inherit;font:11px system-ui;padding:4px 9px;cursor:pointer;}",
  ".kav-seg-tabs button.on{color:var(--p-primary-color,#4a7dff);border-color:var(--p-primary-color,#4a7dff);background:rgba(74,125,255,.1);}",
  ".kav-seg-form{display:flex;align-items:flex-end;gap:7px;flex-wrap:wrap;}",
  ".kav-seg-form[hidden],.kav-seg-form label[hidden]{display:none;}",
  ".kav-seg-foot .kd-btn,.kav-seg-previewbar .kd-btn{display:inline-flex;align-items:center;gap:5px;}",
  ".kav-seg-foot .kd-btn svg,.kav-seg-previewbar .kd-btn svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;}",
  ".kav-seg-form label{display:flex;flex-direction:column;gap:3px;min-width:92px;font-size:10.5px;opacity:.8;}",
  ".kav-seg-form input,.kav-seg-form select{box-sizing:border-box;width:100%;min-height:27px;border:1px solid var(--interface-stroke,#3a3a44);",
  "border-radius:6px;background:var(--comfy-input-bg,#1b1b21);color:#eee;font:11px system-ui;padding:3px 6px;}",
  ".kav-seg-primary{border-color:var(--p-primary-color,#4a7dff)!important;color:var(--p-primary-color,#4a7dff)!important;}",
  ".kav-seg-pop button:disabled{opacity:.45;cursor:not-allowed;}",
  ".kav-seg-video{display:block;width:100%;height:clamp(110px,22vh,200px);min-height:0;object-fit:contain;background:#111;}",
  ".kav-seg-previewbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}",
  ".kav-seg-time{font:10.5px ui-monospace,monospace;opacity:.7;}",
  ".kav-seg-progress{display:grid;grid-template-columns:minmax(0,1fr) 38px;align-items:center;gap:7px;}",
  ".kav-seg-progress progress{width:100%;height:7px;accent-color:var(--p-primary-color,#4a7dff);}",
  ".kav-seg-message{min-height:15px;font-size:11px;line-height:1.45;opacity:.75;overflow-wrap:anywhere;}",
  ".kav-seg-message.error{color:var(--error-text,#ff6b6b);opacity:1;}",
  ".kav-seg-engine-hint{padding:0 2px;color:var(--fg-color,#e7e7ea);font-size:10.5px;line-height:1.45;opacity:.6;overflow-wrap:anywhere;}",
  ".kav-seg-engine-hint[hidden]{display:none;}",
  ".kav-seg-timeline{position:relative;height:30px;border-radius:5px;overflow:hidden;background:rgba(127,127,127,.18);}",
  ".kav-seg-block{position:absolute;top:0;bottom:0;min-width:2px;box-sizing:border-box;padding:0;border:0;border-right:2px solid var(--interface-panel-surface,#20222a);",
  "background:rgba(74,125,255,.42);color:#fff;cursor:pointer;font:10px system-ui;}",
  ".kav-seg-block:nth-child(3n+2){background:rgba(55,178,128,.48);}",
  ".kav-seg-block:nth-child(3n+3){background:rgba(214,151,52,.5);}",
  ".kav-seg-block.selected{outline:2px solid var(--p-primary-color,#4a7dff);outline-offset:-2px;z-index:1;}",
  ".kav-seg-head{display:flex;align-items:center;gap:7px;font-size:10.5px;opacity:.7;}",
  ".kav-seg-list{max-height:210px;overflow:auto;overscroll-behavior:contain;border:1px solid var(--interface-stroke,#3a3a44);border-radius:6px;}",
  ".kav-seg-row{display:grid;grid-template-columns:20px minmax(54px,1fr) minmax(54px,1fr) 46px 44px 25px 25px;",
  "align-items:center;gap:5px;padding:5px 6px;border-bottom:1px solid rgba(127,127,127,.18);}",
  ".kav-seg-row:last-child{border-bottom:0;}",
  ".kav-seg-row.selected{background:rgba(74,125,255,.12);}",
  ".kav-seg-row input[type=checkbox]{width:14px;height:14px;margin:0;accent-color:var(--p-primary-color,#4a7dff);}",
  ".kav-seg-row input[type=number]{box-sizing:border-box;width:100%;min-width:0;height:25px;background:var(--comfy-input-bg,#1b1b21);",
  "color:#eee;border:1px solid var(--interface-stroke,#3a3a44);border-radius:5px;font:10.5px ui-monospace,monospace;padding:2px 3px;}",
  ".kav-seg-duration,.kav-seg-confidence{font:10px ui-monospace,monospace;opacity:.72;text-align:right;white-space:nowrap;}",
  ".kav-seg-icon{width:25px;height:25px;padding:0;border:0;border-radius:5px;background:transparent;color:inherit;opacity:.6;cursor:pointer;}",
  ".kav-seg-icon:hover:not(:disabled){opacity:1;background:rgba(127,127,127,.15);}",
  ".kav-seg-icon svg{display:block;width:13px;height:13px;margin:auto;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;}",
  ".kav-seg-foot{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px 10px;border-top:1px solid var(--interface-stroke,#3a3a44);}",
  ".kav-seg-count{margin-right:auto;font-size:10.5px;opacity:.65;}",
  ".kav-seg-empty{padding:12px 6px;text-align:center;font-size:11px;opacity:.6;}",
  "@media(max-width:520px){.kav-seg-row{grid-template-columns:18px minmax(42px,1fr) minmax(42px,1fr) 38px 34px 24px 24px;gap:3px;padding:5px 4px;}",
  ".kav-seg-form label{flex:1;min-width:78px;}.kav-seg-foot .kd-btn{flex:1;}}",
];

function ensureAvCss() {
  ensureCss();
  if (document.querySelector("style[data-kav]")) return;
  const st = document.createElement("style");
  st.dataset.kav = "1";
  st.textContent = AV_CSS.join("");
  document.head.appendChild(st);
}

function cleanName(raw) {
  const name = String(raw || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!name || name.includes("\x00") || /^[A-Za-z]:/.test(name)) return "";
  const parts = name.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return "";
  return parts.join("/");
}

function cleanSegmentId(raw) {
  const value = String(raw == null ? "" : raw).trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "";
}

function cleanItem(raw, slot) {
  if (!raw || typeof raw !== "object") return null;
  const filename = cleanName(raw.filename || raw.name);
  if (!filename) return null;
  const tab = raw.tab === "output" ? "output" : "input";
  const source_id = tab + "|" + filename;
  const segment_id = cleanSegmentId(raw.segment_id);
  const id = source_id + (segment_id ? "#" + segment_id : "");
  const low = filename.toLowerCase();
  const isVideo = VID_EXTS.some((e) => low.endsWith(e));
  const isAudio = AUD_EXTS.some((e) => low.endsWith(e));
  const kind = slot === "video" ? "video" : (raw.kind === "audio" || raw.kind === "video"
    ? raw.kind : (isAudio ? "audio" : "video"));
  if ((kind === "video" && !isVideo) || (kind === "audio" && !isAudio)) return null;
  const extract_audio = slot === "audio" && kind === "video" && raw.extract_audio !== false;
  if (slot === "audio" && kind === "video" && !extract_audio) return null;
  const rawStart = Number(raw.trim_start);
  const trim_start = Number.isFinite(rawStart) ? Math.max(0, rawStart) : 0;
  const raw_end = raw.trim_end == null ? null : Number(raw.trim_end);
  const trim_end = raw_end != null && Number.isFinite(raw_end) && raw_end > trim_start ? raw_end : null;
  return { id, source_id, ...(segment_id ? { segment_id } : {}), filename, tab, kind, extract_audio, trim_start, trim_end,
    ...(Number.isFinite(Number(raw.mtime)) ? { mtime: Number(raw.mtime) } : {}),
    ...(Number.isFinite(Number(raw.size)) ? { size: Number(raw.size) } : {}) };
}

function cleanList(raw, slot) {
  const out = [], seen = new Set();
  for (const value of Array.isArray(raw) ? raw : []) {
    const item = cleanItem(value, slot);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id); out.push(item);
    if (out.length >= AV_ITEM_LIMIT) break;
  }
  return out;
}

function findItemBySelector(list, selector) {
  const exact = list.find((x) => x.id === selector);
  if (exact) return exact;
  if (!String(selector).includes("|")) {
    const names = list.filter((x) => x.filename === selector);
    if (names.length === 1) return names[0];
  }
  const sourceMatches = list.filter((x) => x.source_id === selector);
  return sourceMatches.length === 1 ? sourceMatches[0] : null;
}

function defaultState() {
  return {
    v: 2, kind: "av", videos: [], audios: [],
    picked_videos: [], picked_audios: [], select: false, batch: false, cursor: 0,
    video_audio: false, legacy_pairs: false, port_order: [], hidden_links: {},
    output_mode: "video",
    frame_options: { start_frame: 0, max_frames: 16, frame_step: 1, max_side: 512 },
  };
}

function intValue(v, fallback, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function readState(node) {
  const out = defaultState();
  let raw = {};
  try { raw = JSON.parse((node.widgets || []).find((w) => w.name === "media_state")?.value || "{}"); } catch (_) {}
  if (!raw || typeof raw !== "object") return out;
  const hasArrays = Array.isArray(raw.videos) || Array.isArray(raw.audios);
  out.videos = cleanList(raw.videos, "video");
  out.audios = cleanList(raw.audios, "audio");
  if (!hasArrays && raw.video) out.videos = cleanList([raw.video], "video");
  if (!hasArrays && raw.audio) out.audios = cleanList([raw.audio], "audio");
  const keepLegacyPairs = raw.legacy_pairs === true || (!hasArrays && !raw.video && !raw.audio && Array.isArray(raw.pairs));
  if (keepLegacyPairs && Array.isArray(raw.pairs)) {
    out.videos = cleanList(raw.pairs.map((p) => p && p.video), "video");
    out.audios = cleanList(raw.pairs.map((p) => p && p.audio), "audio");
    out.legacy_pairs = true;
    out.pairs = raw.pairs.slice(0, AV_ITEM_LIMIT);
  }
  out.select = !!raw.select;
  out.batch = !!raw.batch;
  out.video_audio = raw.video_audio === true;
  out.cursor = intValue(raw.cursor, 0, 0, AV_ITEM_LIMIT - 1);
  const matchSelectors = (value, list) => {
    const result = [];
    for (const entry of Array.isArray(value) ? value : []) {
      let selector = "";
      if (typeof entry === "string") selector = entry;
      else if (entry && typeof entry === "object") {
        selector = entry.id || entry.source_id || ((entry.tab || "input") + "|" + (entry.filename || ""));
      }
      const item = findItemBySelector(list, selector);
      if (item && !result.includes(item.id)) result.push(item.id);
    }
    return result;
  };
  if (Array.isArray(raw.picked_videos)) out.picked_videos = matchSelectors(raw.picked_videos, out.videos);
  if (Array.isArray(raw.picked_audios)) out.picked_audios = matchSelectors(raw.picked_audios, out.audios);
  if (raw.picked && !Array.isArray(raw.picked_videos) && !Array.isArray(raw.picked_audios)) {
    if (Array.isArray(raw.picked)) {
      out.picked_videos = matchSelectors(raw.picked, out.videos);
      out.picked_audios = matchSelectors(raw.picked, out.audios);
    } else if (typeof raw.picked === "object") {
      out.picked_videos = matchSelectors(raw.picked.videos, out.videos);
      out.picked_audios = matchSelectors(raw.picked.audios, out.audios);
    }
  }
  out.output_mode = raw.output_mode === "frames" ? "frames" : "video";
  if (Array.isArray(raw.port_order)) {
    const seen = new Set();
    out.port_order = raw.port_order.filter((key) => {
      const value = String(key || "");
      if (!/^(video|frames|video_audio|audio)_\d+$/.test(value) || seen.has(value) || out.port_order.length >= AV_OUTPUT_SLOTS) return false;
      seen.add(value); return true;
    });
  }
  if (raw.hidden_links && typeof raw.hidden_links === "object") {
    for (const [key, targets] of Object.entries(raw.hidden_links)) {
      if (!/^(video|frames|video_audio|audio)_\d+$/.test(key) || !Array.isArray(targets)) continue;
      const clean = targets.map((target) => ({
        targetId: target && target.targetId != null ? target.targetId : "",
        targetSlot: Number(target && target.targetSlot),
        linkId: target && target.linkId != null ? Number(target.linkId) : null,
      })).filter((target) => target.targetId && Number.isInteger(target.targetSlot));
      if (clean.length) out.hidden_links[key] = clean;
    }
  }
  const fo = raw.frame_options || {};
  out.frame_options = {
    start_frame: intValue(fo.start_frame, 0, 0, 100000),
    max_frames: intValue(fo.max_frames, 16, 1, 128),
    frame_step: intValue(fo.frame_step, 1, 1, 60),
    max_side: intValue(fo.max_side, 512, 0, 2048),
  };
  const count = pairCount(out);
  if (count) out.cursor = Math.min(out.cursor, count - 1);
  return out;
}

function writeState(node, state, quiet = false) {
  const w = (node.widgets || []).find((x) => x.name === "media_state");
  if (!w) return;
  w.value = JSON.stringify(state);
  try { node.setDirtyCanvas(true, true); } catch (_) {}
  if (!quiet) {
    try { window.dispatchEvent(new CustomEvent("kedou:media-changed", { detail: { nodeId: node.id } })); } catch (_) {}
  }
}

function effectiveList(state, slot) {
  const list = slot === "video" ? state.videos : state.audios;
  const picked = slot === "video" ? state.picked_videos : state.picked_audios;
  if (!state.select) return list;
  const map = new Map(list.map((x) => [x.id, x]));
  return picked.map((id) => map.get(id)).filter(Boolean);
}

function pairCount(state) {
  const count = state.legacy_pairs && state.batch && Array.isArray(state.pairs)
    ? state.pairs.length
    : Math.max(effectiveList(state, "video").length, effectiveList(state, "audio").length);
  return state.batch ? Math.min(AV_ITEM_LIMIT, count) : Math.min(AV_SLOTS, count);
}

function pairAt(state, index) {
  if (state.legacy_pairs && state.batch && Array.isArray(state.pairs)) {
    const pair = state.pairs[index] || {};
    return { video: cleanItem(pair.video, "video"), audio: cleanItem(pair.audio, "audio") };
  }
  return { video: effectiveList(state, "video")[index] || null,
    audio: effectiveList(state, "audio")[index] || null };
}

function linksOf(node, index) {
  const o = node && node.outputs ? node.outputs[index] : null;
  if (!o) return [];
  return Array.isArray(o.links) ? o.links.slice() : (o.link != null ? [o.link] : []);
}

function avPortInfo(key) {
  const match = /^(video_audio|video|audio|frames)_(\d+)$/.exec(String(key || ""));
  if (!match) return { key, type: "VIDEO", display_name: key };
  const kind = match[1], n = match[2];
  if (kind === "video") return { key, type: "VIDEO", display_name: t("Video {n}", { n }) };
  if (kind === "frames") return { key, type: "IMAGE", display_name: t("Video frames {n}", { n }) };
  if (kind === "audio") return { key, type: "AUDIO", display_name: t("Audio {n}", { n }) };
  return { key, type: "AUDIO", display_name: t("Video {n} audio", { n }) };
}

function outputLayout(state) {
  const videos = state.batch
    ? [pairAt(state, state.cursor).video].filter(Boolean)
    : effectiveList(state, "video").slice(0, AV_SLOTS);
  const audios = state.batch
    ? [pairAt(state, state.cursor).audio].filter(Boolean)
    : effectiveList(state, "audio").slice(0, AV_SLOTS);
  const active = state.output_mode === "video" ? "video" : "frames";
  if (videos.length && !audios.length) {
    const visible = [active + "_1"];
    if (state.video_audio) visible.push("video_audio_1");
    visible.push("audio_1");
    for (let index = 2; index <= videos.length; index++) {
      visible.push(active + "_" + index);
      if (state.video_audio) visible.push("video_audio_" + index);
    }
    return visible;
  }
  const visible = [];
  videos.forEach((_video, i) => {
    const n = i + 1;
    visible.push((state.output_mode === "video" ? "video_" : "frames_") + n);
    if (state.video_audio) visible.push("video_audio_" + n);
  });
  audios.forEach((_audio, i) => { visible.push("audio_" + (i + 1)); });
  return visible;
}

function legacyOutputKey(output, index) {
  if (output && output.__kdAVKey) return output.__kdAVKey;
  const name = String(output && output.name || "");
  if (/^(video|audio|frames|video_audio)_\d+$/.test(name)) return name;
  const legacy = /^output_(\d+)$/.exec(name);
  if (legacy) {
    const i = Number(legacy[1]) - 1;
    return ["video", "audio", "frames"][i % 3] + "_" + (Math.floor(i / 3) + 1);
  }
  return /^(video|audio|frames|video_audio)_\d+$/.test(name) ? name : "__kd_legacy_" + index;
}

function graphLink(graph, linkId) {
  if (!graph || !graph.links || linkId == null) return null;
  return typeof graph.links.get === "function" ? graph.links.get(linkId) : graph.links[linkId];
}

function graphNode(graph, nodeId) {
  if (!graph || nodeId == null) return null;
  if (typeof graph.getNodeById === "function") return graph.getNodeById(nodeId);
  return Array.isArray(graph._nodes) ? graph._nodes.find((node) => node.id === nodeId) || null : null;
}

function outputTargets(node, index, graph) {
  const targets = linksOf(node, index).map((linkId) => {
    const link = graphLink(graph, linkId);
    if (Array.isArray(link)) return { linkId, targetId: link[2], targetSlot: link[3] };
    if (link && typeof link === "object") {
      return { linkId, targetId: link.target_id || link.target, targetSlot: link.target_slot };
    }
    return { linkId, targetId: null, targetSlot: null };
  }).filter((target) => target.targetId != null && target.targetSlot != null && graphNode(graph, target.targetId));
  if (!graph || !graph.links) return targets;
  const entries = typeof graph.links.values === "function" ? graph.links.values() : Object.values(graph.links);
  for (const link of entries) {
    if (!link) continue;
    const originId = Array.isArray(link) ? link[1] : link.origin_id;
    const originSlot = Array.isArray(link) ? link[2] : link.origin_slot;
    if (String(originId) !== String(node.id) || Number(originSlot) !== index) continue;
    const linkId = Array.isArray(link) ? link[0] : link.id;
    const targetId = Array.isArray(link) ? link[3] : (link.target_id || link.target);
    const targetSlot = Array.isArray(link) ? link[4] : link.target_slot;
    if (targetId != null && targetSlot != null && graphNode(graph, targetId)) {
      targets.push({ linkId, targetId, targetSlot });
    }
  }
  return mergeTargets(targets);
}

function mergeTargets(...groups) {
  const merged = [], seen = new Set();
  for (const group of groups) {
    for (const target of group || []) {
      const key = String(target.targetId) + ":" + String(target.targetSlot);
      if (seen.has(key)) continue;
      seen.add(key); merged.push(target);
    }
  }
  return merged;
}

function syncOutputs(node, state) {
  if (!node.outputs) node.outputs = [];
  if (node.__kdAVRebuildingOutputs || app.configuringGraph) return;
  const graph = node.graph || app.graph;
  const mediaPrefix = state.output_mode === "frames" ? "frames" : "video";
  if (!(node.__kdAVHiddenLinks instanceof Map)) node.__kdAVHiddenLinks = new Map();
  const hiddenLinks = node.__kdAVHiddenLinks;
  for (const [key, targets] of Object.entries(state.hidden_links || {})) {
    if (Array.isArray(targets) && targets.length) hiddenLinks.set(key, mergeTargets(hiddenLinks.get(key), targets));
  }
  for (const [key, targets] of hiddenLinks) {
    const valid = Array.isArray(targets) ? targets.filter((target) => graphNode(graph, target.targetId)) : [];
    if (valid.length) hiddenLinks.set(key, valid);
    else hiddenLinks.delete(key);
  }

  const connected = new Map();
  node.outputs.forEach((port, index) => {
    const targets = outputTargets(node, index, graph);
    if (targets.length) connected.set(legacyOutputKey(port, index), targets);
  });
  for (const [key, targets] of hiddenLinks) {
    if (Array.isArray(targets) && targets.length) connected.set(key, mergeTargets(connected.get(key), targets));
  }
  let videoCount = 1, audioCount = 1;
  for (const [key, targets] of connected) {
    if (!targets.length) continue;
    const match = /^(video|frames|audio)_(\d+)$/.exec(key);
    if (!match) continue;
    if (match[1] === "audio") audioCount = Math.max(audioCount, Number(match[2]) + 1);
    else if (match[1] === mediaPrefix) videoCount = Math.max(videoCount, Number(match[2]) + 1);
  }
  videoCount = Math.min(AV_SLOTS, videoCount);
  audioCount = Math.min(AV_SLOTS, audioCount);
  const nextLayout = [];
  for (let index = 1; index <= videoCount; index++) {
    nextLayout.push(mediaPrefix + "_" + index);
    if (state.video_audio) nextLayout.push("video_audio_" + index);
  }
  for (let index = 1; index <= audioCount; index++) nextLayout.push("audio_" + index);
  const visibleKeys = new Set(nextLayout);
  const same = node.outputs.length === nextLayout.length &&
    node.outputs.every((port, index) => port && legacyOutputKey(port, index) === nextLayout[index]) &&
    !nextLayout.some((key) => hiddenLinks.has(key));
  const appendOnly = node.outputs.length < nextLayout.length &&
    node.outputs.every((port, index) => port && legacyOutputKey(port, index) === nextLayout[index]) &&
    !nextLayout.some((key) => hiddenLinks.has(key));

  const snapshots = node.outputs.map((port, index) => ({
    key: legacyOutputKey(port, index),
    targets: outputTargets(node, index, graph),
  }));
  const keyedTargets = new Map();
  for (const snapshot of snapshots) {
    keyedTargets.set(snapshot.key, mergeTargets(keyedTargets.get(snapshot.key), snapshot.targets));
  }
  for (const snapshot of snapshots) {
    if (visibleKeys.has(snapshot.key) || !snapshot.targets.length) continue;
    hiddenLinks.set(snapshot.key, mergeTargets(hiddenLinks.get(snapshot.key), snapshot.targets));
  }
  for (const [key, targets] of hiddenLinks) {
    if (!visibleKeys.has(key)) continue;
    keyedTargets.set(key, mergeTargets(keyedTargets.get(key), targets));
  }

  if (appendOnly) {
    nextLayout.slice(node.outputs.length).forEach((key) => {
      const info = avPortInfo(key);
      if (typeof node.addOutput === "function") node.addOutput(key, info.type);
      else node.outputs.push({ name: key, type: info.type, links: [] });
    });
  } else if (!same) {
    node.__kdAVRebuildingOutputs = true;
    try {
      for (let i = node.outputs.length - 1; i >= 0; i--) {
        if (linksOf(node, i).length && typeof node.disconnectOutput === "function") node.disconnectOutput(i);
      }
      while (node.outputs.length) {
        if (typeof node.removeOutput === "function") node.removeOutput(node.outputs.length - 1);
        else node.outputs.pop();
      }
      nextLayout.forEach((key) => {
        const info = avPortInfo(key);
        if (typeof node.addOutput === "function") node.addOutput(key, info.type);
        else node.outputs.push({ name: key, type: info.type, links: [] });
        const port = node.outputs[node.outputs.length - 1];
        if (!port) return;
        port.__kdAVKey = key;
        port.name = key;
        port.type = info.type;
        port.display_name = info.display_name;
        port.label = info.display_name;
        port.localized_name = info.display_name;
      });
    } finally {
      node.__kdAVRebuildingOutputs = false;
    }
  }

  node.outputs.forEach((port, index) => {
    const key = nextLayout[index];
    const info = avPortInfo(key);
    port.__kdAVKey = key;
    port.name = key;
    port.type = info.type;
    port.display_name = info.display_name;
    port.label = info.display_name;
    port.localized_name = info.display_name;
    const targets = keyedTargets.get(key) || [];
    const restored = new Set();
    if (!same && !appendOnly) {
      for (const target of targets) {
        const targetNode = graphNode(graph, target.targetId);
        if (!targetNode) continue;
        const input = targetNode.inputs && targetNode.inputs[target.targetSlot];
        if (input && input.link != null && input.link !== target.linkId) continue;
        let ok = false;
        try {
          if (typeof node.connect === "function") ok = node.connect(index, targetNode, target.targetSlot) !== false;
          else if (graph && typeof graph.link === "function") {
            graph.link(port, input);
            ok = true;
          } else if (target.linkId != null) {
            port.links = port.links || []; port.links.push(target.linkId);
            ok = true;
          }
        } catch (_) {}
        if (ok) restored.add(String(target.targetId) + ":" + String(target.targetSlot));
      }
    }
    const pending = (hiddenLinks.get(key) || []).filter((target) =>
      !restored.has(String(target.targetId) + ":" + String(target.targetSlot)));
    if (pending.length) hiddenLinks.set(key, pending);
    else hiddenLinks.delete(key);
    if (!visibleKeys.has(key) && targets.length) hiddenLinks.set(key, targets);
  });
  for (const [key, targets] of hiddenLinks) {
    if (!targets.length) hiddenLinks.delete(key);
  }
  state.port_order = nextLayout.slice();
  state.hidden_links = Object.fromEntries([...hiddenLinks].filter(([, targets]) => targets.length));
  const stateWidget = (node.widgets || []).find((widget) => widget.name === "media_state");
  if (stateWidget) stateWidget.value = JSON.stringify(state);
  node.__kdAVOutputSignature = JSON.stringify(nextLayout);
  try { node.setDirtyCanvas(true, true); } catch (_) {}
}

function queueOutputSync(node) {
  const token = (node.__kdAVSyncToken = (node.__kdAVSyncToken || 0) + 1);
  const run = () => {
    if (node.__kdAVSyncToken !== token) return;
    syncOutputs(node, readState(node));
  };
  setTimeout(run, 0);
  setTimeout(run, 80);
}

function itemFromLibrary(it, slot) {
  const path = (it.subfolder ? it.subfolder + "/" : "") + it.name;
  return cleanItem({ filename: path, tab: it.tab || "input", kind: it.kind || slot,
    extract_audio: slot === "audio" && it.kind === "video", mtime: it.mtime, size: it.size }, slot);
}

function waveUrl(item, w) {
  const p = new URLSearchParams({ filename: item.filename.split("/").pop(),
    subfolder: item.filename.includes("/") ? item.filename.slice(0, item.filename.lastIndexOf("/")) : "",
    type: item.tab, w: String(w || 256) });
  return "/ps/waveform?" + p.toString();
}

function previewUrl(item) {
  if (!item) return "";
  if (item.kind === "audio") return waveUrl(item, 320);
  const name = item.filename.split("/").pop();
  const sub = item.filename.includes("/") ? item.filename.slice(0, item.filename.lastIndexOf("/")) : "";
  return thumbUrl(name, sub, 320, item.tab, "raw");
}

async function mediaInfo(item) {
  if (!item) return null;
  const cacheKey = item.id + "|" + String(item.mtime || 0) + "|" + String(item.size || 0);
  if (INFO_CACHE.has(cacheKey)) return INFO_CACHE.get(cacheKey);
  const name = item.filename.split("/").pop();
  const sub = item.filename.includes("/") ? item.filename.slice(0, item.filename.lastIndexOf("/")) : "";
  const qs = new URLSearchParams({ filename: name, subfolder: sub, type: item.tab }).toString();
  for (const prefix of ["/ps/media/info?", "/api/ps/media/info?"]) {
    try {
      const r = await fetch(prefix + qs);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.ok) {
        INFO_CACHE.set(cacheKey, j);
        while (INFO_CACHE.size > 512) INFO_CACHE.delete(INFO_CACHE.keys().next().value);
        return j;
      }
    } catch (_) {}
  }
  return null;
}

function formatDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return "";
  const m = Math.floor(n / 60), s = Math.floor(n % 60);
  return m + ":" + String(s).padStart(2, "0");
}

function openLibrary(slot, onPick) {
  closeSegmentPopup();
  closeTrimPopup();
  ensureAvCss();
  const ov = document.createElement("div");
  ov.className = "kd-lib";
  const win = document.createElement("div");
  win.className = "kd-libwin";
  const top = document.createElement("div");
  top.className = "kd-libtop";
  const title = document.createElement("b");
  title.textContent = slot === "video" ? t("Reference video") : t("Reference audio");
  const tabs = document.createElement("div"); tabs.className = "kd-seg";
  let curTab = "all", seq = 0, anchorIdx = -1;
  const selected = new Map();
  [["all", t("All")], ["input", t("Imported")], ["output", t("Generated")]].forEach(([v, label]) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "kd-segbtn" + (v === "all" ? " on" : ""); b.textContent = label;
    b.onclick = () => {
      curTab = v; selected.clear(); anchorIdx = -1;
      tabs.querySelectorAll(".kd-segbtn").forEach((x) => x.classList.toggle("on", x === b));
      render();
    };
    tabs.appendChild(b);
  });
  const search = document.createElement("input"); search.placeholder = t("Search file name…");
  const body = document.createElement("div"); body.className = "kd-libbody";
  const foot = document.createElement("div"); foot.className = "kd-libfoot";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "kd-btn"; cancel.textContent = t("Cancel");
  const ok = document.createElement("button"); ok.type = "button"; ok.className = "kd-btn kd-p"; ok.textContent = t("Add"); ok.disabled = true;
  cancel.style.marginLeft = "auto"; foot.append(cancel, ok);
  top.append(title, tabs, search); win.append(top, body, foot); ov.appendChild(win); document.body.appendChild(ov);
  let timer = null, previewObserver = null;
  function close() {
    clearTimeout(timer); seq++;
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    ov.remove(); document.removeEventListener("keydown", onKey, true);
  }
  function onKey(e) { if (e.key === "Escape") close(); }
  ov.onclick = (e) => { if (e.target === ov) close(); };
  cancel.onclick = close;
  ok.onclick = () => {
    if (!selected.size) return;
    const items = [...selected.values()]; close(); onPick(items);
  };
  document.addEventListener("keydown", onKey, true);
  search.oninput = () => { selected.clear(); anchorIdx = -1; clearTimeout(timer); timer = setTimeout(render, 250); };
  async function render() {
    const my = ++seq;
    selected.clear(); anchorIdx = -1; ok.disabled = true; ok.textContent = t("Add");
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    body.innerHTML = ""; body.textContent = t("Loading…");
    const items = await fetchLibrary(slot, search.value, curTab);
    if (my !== seq) return;
    body.innerHTML = "";
    if (!items || !items.length) { body.textContent = t("No matching images."); return; }
    const all = items.map((it) => itemFromLibrary(it, slot)).filter(Boolean);
    let shown = 0;
    const loadPreview = (img, item) => {
      if (img.dataset.loaded) return;
      img.dataset.loaded = "1";
      let tries = 0;
      img.onerror = () => {
        img.style.visibility = "hidden";
        if (tries++ < 1) setTimeout(() => { img.style.visibility = ""; img.src = previewUrl(item) + "&_r=" + Date.now(); }, 1200);
      };
      img.src = previewUrl(item);
    };
    if ("IntersectionObserver" in window) {
      previewObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.isIntersecting) {
          loadPreview(entry.target, entry.target.__kdItem);
          previewObserver.unobserve(entry.target);
        }
      }, { root: body });
    }
    const paintSelection = () => {
      ok.disabled = !selected.size;
      ok.textContent = selected.size ? t("Add {n}", { n: selected.size }) : t("Add");
      body.querySelectorAll(".kd-cell").forEach((cell) => {
        const on = selected.has(cell.dataset.kdPickKey);
        cell.classList.toggle("on", on);
        cell.style.outline = on ? "2px solid var(--p-primary-color,#4a7dff)" : "none";
      });
    };
    const append = () => {
      const next = all.slice(shown, shown + 80);
      for (const item of next) {
        const index = shown++;
        const cell = document.createElement("button");
        cell.type = "button"; cell.className = "kd-cell"; cell.dataset.kdPickKey = item.id; cell.dataset.index = index;
        const img = document.createElement("img"); img.className = "kav-lib-preview"; img.loading = "lazy"; img.__kdItem = item;
        const no = document.createElement("span"); no.className = "kd-no"; no.textContent = item.filename.split("/").pop();
        cell.append(img, no);
        cell.onclick = (ev) => {
          if (ev.shiftKey && anchorIdx >= 0) {
            const lo = Math.min(anchorIdx, index), hi = Math.max(anchorIdx, index);
            for (let i = lo; i <= hi; i++) selected.set(all[i].id, all[i]);
          } else if (selected.has(item.id)) selected.delete(item.id);
          else selected.set(item.id, item);
          anchorIdx = index; paintSelection();
        };
        body.appendChild(cell);
        if (previewObserver) previewObserver.observe(img); else loadPreview(img, item);
      }
    };
    append();
    body.onscroll = () => { if (shown < all.length && body.scrollTop + body.clientHeight >= body.scrollHeight - 160) append(); };
  }
  render();
}

async function uploadOne(file, kind) {
  const fd = new FormData(); fd.append("file", file, file.name);
  for (const prefix of ["/ps/media/upload?type=", "/api/ps/media/upload?type="]) {
    try {
      const r = await fetch(prefix + encodeURIComponent(kind), { method: "POST", body: fd });
      if (r.status === 404) continue;
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok && j.filename) return j.filename;
      throw new Error((j && j.error) || ("HTTP " + r.status));
    } catch (e) { if (prefix.indexOf("/api/") >= 0) throw e; }
  }
  throw new Error(t("Media upload needs one ComfyUI restart (bridge route not registered yet)."));
}

function trimTime(sec) {
  const n = Math.max(0, Number(sec) || 0);
  const m = Math.floor(n / 60), s = n - m * 60;
  return m + ":" + s.toFixed(1).padStart(4, "0");
}

function mediaSourceUrl(item) {
  const name = item.filename.split("/").pop();
  const sub = item.filename.includes("/") ? item.filename.slice(0, item.filename.lastIndexOf("/")) : "";
  return "/view?" + new URLSearchParams({ filename: name, subfolder: sub, type: item.tab }).toString();
}

const SEG_ICONS = {
  cut: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8.2 8.2 11.3 7.6M8.2 15.8 19.5 8.2"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7"/></svg>',
  merge: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h6v6H4zM14 13h6v6h-6zM10 8h5a4 4 0 0 1 4 4v1M7 11v4a3 3 0 0 0 3 3h4"/></svg>',
  export: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/></svg>',
  add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
};

let activeSegmentPopup = null;

async function segmentRequest(url, options) {
  let response;
  try { response = await fetch(url, options); }
  catch (e) { throw new Error(t("Request failed: {msg}", { msg: e.message || String(e) })); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok !== true) {
    throw new Error(serverError(data && data.error ? data.error : "HTTP " + response.status));
  }
  return data;
}

function segmentJobId(jobId, index, suffix = "") {
  const safeJob = String(jobId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "job";
  const tail = String(suffix).replace(/[^A-Za-z0-9_-]/g, "");
  const marker = "-" + index + (tail ? "-" + tail : "");
  const job = safeJob.slice(0, Math.max(1, 60 - marker.length));
  return cleanSegmentId("seg-" + job + marker);
}

function segmentProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n <= 1 ? n * 100 : n));
}

function segmentStage(job, exporting) {
  if (!job) return exporting ? t("Preparing export") : t("Preparing analysis");
  const labels = {
    queued: t("Queued for processing"), running: exporting ? t("Exporting") : t("Analyzing"),
    done: exporting ? t("Export complete") : t("Analysis complete"),
    error: exporting ? t("Export failed") : t("Analysis failed"),
    cancelled: exporting ? t("Export cancelled") : t("Analysis cancelled"),
    probe: t("Reading video information"), probing: t("Reading video information"),
    decode: t("Decoding video"), decoding: t("Decoding video"),
    detect: t("Detecting shot changes"), detecting: t("Detecting shot changes"),
    scan: t("Scanning video frames"), scanning: t("Scanning video frames"),
    split: t("Splitting video"), splitting: t("Splitting video"),
    copy: t("Copying video segments"), copying: t("Copying video segments"),
    finalize: t("Finishing up"), finalizing: t("Finishing up"),
  };
  const rawStage = String(job.stage || "");
  if (/[一-鿿]/.test(rawStage)) return rawStage;
  return labels[rawStage.toLowerCase()] || labels[job.status] ||
    (exporting ? t("Exporting") : t("Analyzing"));
}

function closeSegmentPopup(owner = null) {
  const popup = activeSegmentPopup;
  if (!popup || (owner && popup.owner !== owner)) return;
  activeSegmentPopup = null;
  popup.closed = true;
  clearTimeout(popup.timer); popup.timer = null;
  popup.el.remove();
  window.removeEventListener("keydown", popup.onKey, true);
  window.removeEventListener("resize", popup.onResize);
  try { popup.video.pause(); } catch (_) {}
  if (popup.jobId) {
    const url = "/ps/video/segments/jobs/" + encodeURIComponent(popup.jobId) + "/cancel";
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  }
}

function openSegmentPopup(anchor, item, onAdd, getLimit = () => AV_SLOTS, owner = null) {
  closeSegmentPopup();
  closeTrimPopup();
  const el = document.createElement("div");
  el.className = "kav-seg-pop"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", t("Long video segmentation"));
  const header = document.createElement("div"); header.className = "kav-seg-hd";
  const title = document.createElement("span"); title.className = "kav-seg-title"; title.textContent = t("Long video segmentation");
  const file = document.createElement("span"); file.className = "kav-seg-file"; title.title = item.filename; file.textContent = item.filename;
  const close = document.createElement("button"); close.type = "button"; close.className = "kav-seg-close";
  close.setAttribute("aria-label", t("Close")); close.innerHTML = SEG_ICONS.close;
  header.append(title, file, close);
  const scroll = document.createElement("div"); scroll.className = "kav-seg-scroll";
  const tabs = document.createElement("div"); tabs.className = "kav-seg-tabs";
  const modeButtons = {};
  for (const [value, label] of [["duration", t("By duration")], ["shot", t("By shot")]]) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label;
    button.onclick = () => { if (!popup.busy) { popup.mode = value; renderMode(); } };
    tabs.appendChild(button); modeButtons[value] = button;
  }
  const form = document.createElement("div"); form.className = "kav-seg-form";
  const durationFields = document.createElement("div"); durationFields.className = "kav-seg-form kav-seg-duration-fields";
  const shotFields = document.createElement("div"); shotFields.className = "kav-seg-form kav-seg-shot-fields";
  const field = (parent, labelText, input) => {
    const lab = document.createElement("label"); lab.textContent = labelText; lab.appendChild(input); parent.appendChild(lab); return input;
  };
  const seconds = field(durationFields, t("Seconds per segment"), document.createElement("input"));
  seconds.type = "number"; seconds.min = "0.5"; seconds.max = "600"; seconds.step = "0.1"; seconds.value = "15";
  const tail = field(durationFields, t("Tail handling"), document.createElement("select"));
  for (const [value, label] of [["keep", t("Keep tail")], ["merge", t("Merge tail into previous")], ["drop", t("Drop tail")]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; tail.appendChild(option);
  }
  const engine = field(shotFields, t("Detection engine"), document.createElement("select"));
  for (const [value, label] of [["fast", t("Fast frame difference")], ["transnet", t("AI model (TransNetV2)")], ["omnishotcut", t("OmniShotCut high precision")]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; engine.appendChild(option);
  }
  const threshold = field(shotFields, t("Shot sensitivity"), document.createElement("input"));
  threshold.type = "number"; threshold.min = "0.05"; threshold.max = "0.8"; threshold.step = "0.01"; threshold.value = "0.22";
  const minSeconds = field(shotFields, t("Minimum shot seconds"), document.createElement("input"));
  minSeconds.type = "number"; minSeconds.min = "0.2"; minSeconds.max = "30"; minSeconds.step = "0.1"; minSeconds.value = "1.0";
  const analyze = document.createElement("button"); analyze.type = "button"; analyze.className = "kd-btn kd-p kav-seg-primary";
  analyze.textContent = t("Analyze segments");
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "kd-btn"; cancel.textContent = t("Cancel task"); cancel.disabled = true;
  const engineHint = document.createElement("div"); engineHint.className = "kav-seg-engine-hint"; engineHint.hidden = true;
  engineHint.setAttribute("role", "note"); engineHint.textContent = t("First use downloads about 31MB of model weights; then it runs locally offline");
  const engineThresholds = { fast: "0.22", transnet: "0.5" };
  let activeEngine = "fast";
  const syncShotEngine = () => {
    const nextEngine = ["fast", "transnet", "omnishotcut"].includes(engine.value) ? engine.value : "fast";
    if (nextEngine !== activeEngine) {
      if (activeEngine === "fast" || activeEngine === "transnet") engineThresholds[activeEngine] = threshold.value;
      if (nextEngine === "fast" || nextEngine === "transnet") threshold.value = engineThresholds[nextEngine];
      activeEngine = nextEngine;
    }
    const aiShot = popup.mode === "shot" && activeEngine !== "fast";
    const highPrecisionShot = popup.mode === "shot" && activeEngine === "omnishotcut";
    threshold.closest("label").hidden = highPrecisionShot;
    threshold.min = activeEngine === "transnet" ? "0.01" : "0.05";
    threshold.max = activeEngine === "transnet" ? "0.99" : "0.8";
    engineHint.hidden = !aiShot;
    engineHint.textContent = highPrecisionShot
      ? t("First use downloads about 202MB of model weights; then it runs locally offline")
      : t("First use downloads about 31MB of model weights; then it runs locally offline");
    analyze.textContent = highPrecisionShot ? t("Start high-precision detection")
      : aiShot ? t("Start AI detection") : t("Analyze segments");
  };
  threshold.oninput = () => { engineThresholds[activeEngine] = threshold.value; };
  engine.onchange = syncShotEngine;
  form.append(durationFields, shotFields, analyze, cancel);
  const video = document.createElement("video"); video.className = "kav-seg-video"; video.src = mediaSourceUrl(item);
  video.preload = "metadata"; video.muted = true; video.playsInline = true; video.controls = true;
  const previewBar = document.createElement("div"); previewBar.className = "kav-seg-previewbar";
  const previewTime = document.createElement("span"); previewTime.className = "kav-seg-time"; previewTime.textContent = "0:00.0 / 0:00.0";
  const split = document.createElement("button"); split.type = "button"; split.className = "kd-btn"; split.innerHTML = SEG_ICONS.cut;
  split.appendChild(document.createTextNode(t("Split at playhead"))); split.disabled = true;
  previewBar.append(previewTime, split);
  const progressWrap = document.createElement("div"); progressWrap.className = "kav-seg-progress";
  const progress = document.createElement("progress"); progress.max = 100; progress.value = 0;
  const percent = document.createElement("span"); percent.className = "kav-seg-time"; percent.textContent = "0%";
  progressWrap.append(progress, percent);
  const message = document.createElement("div"); message.className = "kav-seg-message"; message.setAttribute("role", "status");
  message.textContent = t("Choose a mode, then analyze the video");
  const timeline = document.createElement("div"); timeline.className = "kav-seg-timeline"; timeline.hidden = true;
  timeline.setAttribute("aria-label", t("Segment timeline"));
  const listHead = document.createElement("div"); listHead.className = "kav-seg-head";
  const listTitle = document.createElement("span"); listTitle.textContent = t("Segments");
  const selectedCount = document.createElement("span"); selectedCount.className = "kav-seg-count"; selectedCount.textContent = t("Selected {n}", { n: 0 });
  listHead.append(listTitle, selectedCount);
  const list = document.createElement("div"); list.className = "kav-seg-list";
  const empty = document.createElement("div"); empty.className = "kav-seg-empty"; empty.textContent = t("No segments yet"); list.appendChild(empty);
  scroll.append(tabs, form, engineHint, video, previewBar, progressWrap, message, timeline, listHead, list);
  const footer = document.createElement("div"); footer.className = "kav-seg-foot";
  const add = document.createElement("button"); add.type = "button"; add.className = "kd-btn kd-p"; add.innerHTML = SEG_ICONS.add;
  const segmentLimit = () => Math.max(1, Math.min(AV_ITEM_LIMIT, Number(getLimit()) || AV_SLOTS));
  add.appendChild(document.createTextNode(t("Add to node (up to {n} segments)", { n: segmentLimit() }))); add.disabled = true;
  const exportBtn = document.createElement("button"); exportBtn.type = "button"; exportBtn.className = "kd-btn"; exportBtn.innerHTML = SEG_ICONS.export;
  exportBtn.appendChild(document.createTextNode(t("Export segments"))); exportBtn.disabled = true;
  const footCount = document.createElement("span"); footCount.className = "kav-seg-count"; footCount.textContent = t("Selected {n}", { n: 0 });
  footer.append(footCount, add, exportBtn);
  el.append(header, scroll, footer); document.body.appendChild(el);
  const popup = {
    el, video, owner, closed: false, mode: "duration", segments: [], duration: 0,
    jobId: null, jobKind: "", busy: false, timer: null, pollErrors: 0, selectedId: "", splitSeq: 0,
    onKey: (e) => { if (e.key === "Escape") closeSegmentPopup(); },
  };
  activeSegmentPopup = popup;
  const position = () => {
    const width = el.offsetWidth, height = el.offsetHeight;
    const left = Math.max(8, Math.min(anchor.getBoundingClientRect().left, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(anchor.getBoundingClientRect().bottom + 8, window.innerHeight - height - 8));
    el.style.left = left + "px"; el.style.top = top + "px";
  };
  popup.onResize = position;
  position();
  window.addEventListener("keydown", popup.onKey, true);
  window.addEventListener("resize", popup.onResize);
  close.onclick = closeSegmentPopup;

  const isActive = () => activeSegmentPopup === popup && !popup.closed;
  const setMessage = (text, error = false) => {
    if (!isActive()) return;
    message.textContent = text; message.classList.toggle("error", error);
  };
  const updateBusy = () => {
    analyze.disabled = popup.busy;
    exportBtn.disabled = popup.busy || !popup.segments.some((s) => s.checked);
    add.disabled = popup.busy || !popup.segments.some((s) => s.checked);
    split.disabled = popup.busy || !popup.segments.length;
    cancel.disabled = !popup.jobId;
    for (const button of Object.values(modeButtons)) button.disabled = popup.busy;
  };
  const paintJob = (job) => {
    if (!isActive()) return;
    const value = segmentProgress(job.progress);
    progress.value = value; percent.textContent = Math.round(value) + "%";
    setMessage(segmentStage(job, popup.jobKind === "export"));
    cancel.disabled = !popup.jobId || ["done", "error", "cancelled"].includes(job.status);
  };
  const selectSegment = (id, scrollTo = false) => {
    const segment = popup.segments.find((s) => s.segment_id === id);
    if (!segment) return;
    segment.checked = true; popup.selectedId = id; renderResults();
    if (scrollTo) {
      const row = list.querySelector('[data-segment-id="' + CSS.escape(id) + '"]');
      if (row) row.scrollIntoView({ block: "nearest" });
    }
  };
  const checkedSegments = () => popup.segments.filter((s) => s.checked);
  const sourcePayload = () => {
    const name = item.filename.split("/").pop();
    const subfolder = item.filename.includes("/") ? item.filename.slice(0, item.filename.lastIndexOf("/")) : "";
    return { name, subfolder, tab: item.tab };
  };
  const acceptResult = (result) => {
    const duration = Number(result.duration);
    popup.duration = Number.isFinite(duration) && duration > 0 ? duration : popup.duration;
    const rawSegments = Array.isArray(result.segments) ? result.segments : [];
    if (!popup.duration) {
      const inferred = rawSegments.reduce((max, raw) => Math.max(max, Number(raw.end) || 0), 0);
      if (Number.isFinite(inferred) && inferred > 0) popup.duration = inferred;
    }
    const used = new Set();
    popup.segments = rawSegments.map((raw, index) => {
      let start = Number(raw.start), end = Number(raw.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || (popup.duration && end > popup.duration + 0.001)) return null;
      start = Math.max(0, start); end = popup.duration ? Math.min(end, popup.duration) : end;
      let segmentId = segmentJobId(result.job_id || popup.analysisJobId || "analysis", index);
      while (used.has(segmentId)) segmentId = segmentJobId(result.job_id || popup.analysisJobId || "analysis", index, "x" + used.size);
      used.add(segmentId);
      const confidence = raw.confidence == null ? null : Number(raw.confidence);
      return { start, end, confidence: confidence != null && Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
        segment_id: segmentId, original_index: index, checked: true };
    }).filter(Boolean).sort((a, b) => a.start - b.start || a.original_index - b.original_index);
    popup.selectedId = popup.segments.length ? popup.segments[0].segment_id : "";
    renderResults();
    setMessage(t("Analysis complete: {n} segments", { n: popup.segments.length }));
  };
  const pollJob = (kind) => {
    const jobId = popup.jobId;
    if (!isActive() || !jobId) return;
    popup.timer = setTimeout(async () => {
      if (!isActive() || popup.jobId !== jobId) return;
      try {
        const data = await segmentRequest("/ps/video/segments/jobs/" + encodeURIComponent(jobId));
        if (!isActive() || popup.jobId !== jobId) return;
        popup.pollErrors = 0;
        const job = data.job || {};
        paintJob(job);
        if (job.status === "done") {
          if (kind === "analyze") popup.analysisJobId = jobId;
          popup.timer = null; popup.jobId = null; popup.busy = false; updateBusy();
          if (kind === "analyze") acceptResult(job.result || {});
          else {
            const count = Array.isArray(job.result && job.result.items) ? job.result.items.length : 0;
            setMessage(t("Export complete: {n} segments", { n: count }));
            kdToast(t("Exported {n} segments", { n: count }));
          }
          return;
        }
        if (job.status === "error" || job.status === "cancelled") {
          popup.timer = null; popup.jobId = null; popup.busy = false; updateBusy();
          const cancelled = job.status === "cancelled";
          const text = cancelled ? (kind === "analyze" ? t("Analysis cancelled") : t("Export cancelled"))
            : t("Task failed: {msg}", { msg: serverError(job.error) || t("Unknown error") });
          setMessage(text, true); kdToast(text, true); return;
        }
        pollJob(kind);
      } catch (e) {
        if (!isActive() || popup.jobId !== jobId) return;
        popup.pollErrors += 1;
        if (popup.pollErrors < 3) {
          popup.timer = setTimeout(() => pollJob(kind), 1000);
          return;
        }
        popup.timer = null; popup.jobId = null; popup.busy = false; updateBusy();
        const text = t("Task failed: {msg}", { msg: e.message || String(e) });
        setMessage(text, true); kdToast(text, true);
      }
    }, 500);
  };
  const runJob = async (kind) => {
    if (popup.busy) return;
    let url, body;
    if (kind === "analyze") {
      const durationSeconds = Number(seconds.value);
      const shotThreshold = Number(threshold.value), shortest = Number(minSeconds.value);
      if (popup.mode === "duration" && (!Number.isFinite(durationSeconds) || durationSeconds < 0.5 || durationSeconds > 600)) {
        setMessage(t("Seconds per segment must be greater than 0"), true); return;
      }
      const shotMin = activeEngine === "transnet" ? 0.01 : 0.05;
      const shotMax = activeEngine === "transnet" ? 0.99 : 0.8;
      if (popup.mode === "shot" && ((activeEngine !== "omnishotcut" &&
        (!Number.isFinite(shotThreshold) || shotThreshold < shotMin || shotThreshold > shotMax)) ||
        !Number.isFinite(shortest) || shortest < 0.2 || shortest > 30)) {
        setMessage(t("Invalid shot detection parameters"), true); return;
      }
      const params = popup.mode === "duration" ? { seconds: durationSeconds, tail: tail.value }
        : { engine: activeEngine, threshold: activeEngine === "omnishotcut" ? 0.5 : shotThreshold, min_seconds: shortest };
      url = "/ps/video/segments/analyze"; body = { ...sourcePayload(), mode: popup.mode, params };
    } else {
      const picked = checkedSegments();
      if (!picked.length) { setMessage(t("Select at least one segment"), true); return; }
      url = "/ps/video/segments/export"; body = { ...sourcePayload(), mode: "copy", segments: picked.map((s) => ({ start: s.start, end: s.end })) };
    }
    popup.busy = true; popup.jobKind = kind; progress.value = 0; percent.textContent = "0%"; updateBusy();
    setMessage(kind === "analyze" ? t("Submitting analysis") : t("Submitting export"));
    try {
      const data = await segmentRequest(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!isActive()) {
        if (data && data.job_id) {
          fetch("/ps/video/segments/jobs/" + encodeURIComponent(data.job_id) + "/cancel",
            { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
        }
        return;
      }
      popup.jobId = String(data.job_id || "");
      if (!popup.jobId) throw new Error(t("Task ID missing"));
      popup.pollErrors = 0;
      updateBusy(); pollJob(kind);
    } catch (e) {
      if (!isActive()) return;
      popup.busy = false; popup.jobId = null; updateBusy();
      const text = t("Task failed: {msg}", { msg: e.message || String(e) }); setMessage(text, true); kdToast(text, true);
    }
  };
  analyze.onclick = () => runJob("analyze");
  exportBtn.onclick = () => runJob("export");
  cancel.onclick = async () => {
    if (!popup.jobId) return;
    const jobId = popup.jobId;
    cancel.disabled = true;
    try {
      const data = await segmentRequest("/ps/video/segments/jobs/" + encodeURIComponent(jobId) + "/cancel",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!isActive()) return;
      clearTimeout(popup.timer); popup.timer = null; popup.jobId = null; popup.busy = false;
      paintJob(data.job || { status: "cancelled" }); updateBusy();
      const text = popup.jobKind === "analyze" ? t("Analysis cancelled") : t("Export cancelled");
      setMessage(text); kdToast(text);
    } catch (e) { if (isActive()) { setMessage(t("Task failed: {msg}", { msg: e.message || String(e) }), true); updateBusy(); } }
  };
  add.onclick = () => {
    const picked = checkedSegments();
    if (!picked.length) { setMessage(t("Select at least one segment"), true); return; }
    const limit = segmentLimit();
    const chosen = picked.slice(0, limit);
    if (picked.length > limit) kdToast(t("Only the first {n} selected segments were added", { n: limit }));
    const items = chosen.map((s) => cleanItem({ ...item, segment_id: s.segment_id, trim_start: s.start, trim_end: s.end }, "video")).filter(Boolean);
    if (items.length) onAdd(items);
  };
  split.onclick = () => {
    const time = Number(video.currentTime);
    const index = popup.segments.findIndex((s) => time >= s.start && time < s.end && time - s.start >= 0.05 && s.end - time >= 0.05);
    if (index < 0) { setMessage(t("Move the playhead inside a segment before splitting"), true); return; }
    const current = popup.segments[index];
    let suffix = "split" + (++popup.splitSeq), nextId = segmentJobId(popup.analysisJobId || "analysis", current.original_index, suffix);
    while (popup.segments.some((s) => s.segment_id === nextId)) nextId = segmentJobId(nextId, current.original_index, "x" + popup.splitSeq);
    const next = { ...current, start: time, segment_id: nextId, checked: current.checked };
    current.end = time; popup.segments.splice(index + 1, 0, next); popup.selectedId = current.segment_id;
    renderResults(); setMessage(t("Split at {time} seconds", { time: time.toFixed(1) }));
  };
  const paintPreviewTime = () => {
    if (!isActive()) return;
    const current = Number(video.currentTime) || 0, duration = Number(video.duration) || popup.duration || 0;
    previewTime.textContent = trimTime(current) + " / " + trimTime(duration);
  };
  video.addEventListener("loadedmetadata", () => {
    const duration = Number(video.duration);
    if (!popup.duration && Number.isFinite(duration) && duration > 0) popup.duration = duration;
    paintPreviewTime();
  });
  video.addEventListener("timeupdate", paintPreviewTime);
  video.addEventListener("error", () => setMessage(t("Video preview unavailable; analysis is still available"), true));

  function renderMode() {
    if (!isActive()) return;
    for (const [value, button] of Object.entries(modeButtons)) {
      button.classList.toggle("on", value === popup.mode); button.setAttribute("aria-pressed", String(value === popup.mode));
    }
    durationFields.hidden = popup.mode !== "duration"; shotFields.hidden = popup.mode !== "shot";
    syncShotEngine();
  }
  function renderResults() {
    if (!isActive()) return;
    timeline.hidden = !popup.segments.length; timeline.innerHTML = ""; list.innerHTML = "";
    const count = checkedSegments().length;
    selectedCount.textContent = footCount.textContent = t("Selected {n}", { n: count });
    if (!popup.segments.length) {
      const blank = document.createElement("div"); blank.className = "kav-seg-empty"; blank.textContent = t("No segments yet"); list.appendChild(blank);
      updateBusy(); return;
    }
    popup.segments.forEach((segment, index) => {
      const block = document.createElement("button"); block.type = "button"; block.className = "kav-seg-block";
      block.dataset.segmentId = segment.segment_id; block.style.left = (segment.start / popup.duration * 100) + "%";
      block.style.width = ((segment.end - segment.start) / popup.duration * 100) + "%";
      block.classList.toggle("selected", segment.segment_id === popup.selectedId); block.textContent = index + 1;
      block.title = trimTime(segment.start) + " — " + trimTime(segment.end); block.onclick = () => selectSegment(segment.segment_id, true);
      timeline.appendChild(block);
      const row = document.createElement("div"); row.className = "kav-seg-row"; row.dataset.segmentId = segment.segment_id;
      row.dataset.originalIndex = segment.original_index; row.classList.toggle("selected", segment.segment_id === popup.selectedId);
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = segment.checked;
      checkbox.setAttribute("aria-label", t("Select segment {n}", { n: index + 1 }));
      checkbox.onchange = () => { segment.checked = checkbox.checked; renderResults(); };
      const start = document.createElement("input"); start.type = "number"; start.min = "0"; start.max = popup.duration; start.step = "0.1"; start.value = segment.start;
      start.dataset.field = "start"; start.setAttribute("aria-label", t("Segment {n} start seconds", { n: index + 1 }));
      const end = document.createElement("input"); end.type = "number"; end.min = "0"; end.max = popup.duration; end.step = "0.1"; end.value = segment.end;
      end.dataset.field = "end"; end.setAttribute("aria-label", t("Segment {n} end seconds", { n: index + 1 }));
      const edit = (input, key) => {
        input.onchange = () => {
          const raw = input.value.trim(), value = Number(raw);
          const nextStart = key === "start" ? value : segment.start, nextEnd = key === "end" ? value : segment.end;
          const previous = popup.segments[index - 1], next = popup.segments[index + 1];
          const overlaps = (previous && nextStart < previous.end - 1e-9) || (next && nextEnd > next.start + 1e-9);
          if (!raw || !Number.isFinite(value) || nextStart < 0 || nextEnd <= nextStart || nextEnd > popup.duration + 1e-9 || overlaps) {
            input.value = segment[key];
            setMessage(t("Invalid segment time: require 0 <= start < end <= {duration} seconds and no overlap", { duration: popup.duration }), true);
            kdToast(t("Invalid segment time; changes were not saved"), true); return;
          }
          segment[key] = Math.min(value, popup.duration); popup.selectedId = segment.segment_id; renderResults();
          setMessage(t("Segment times updated"));
        };
      };
      edit(start, "start"); edit(end, "end");
      const duration = document.createElement("span"); duration.className = "kav-seg-duration";
      duration.textContent = t("{n} seconds", { n: (segment.end - segment.start).toFixed(1) });
      const confidence = document.createElement("span"); confidence.className = "kav-seg-confidence";
      confidence.textContent = segment.confidence == null ? "—" : Math.round(segment.confidence * 100) + "%";
      confidence.title = t("Shot confidence");
      const del = document.createElement("button"); del.type = "button"; del.className = "kav-seg-icon"; del.innerHTML = SEG_ICONS.trash;
      del.setAttribute("aria-label", t("Delete segment")); del.onclick = () => {
        const at = popup.segments.indexOf(segment); popup.segments.splice(at, 1);
        if (popup.selectedId === segment.segment_id) popup.selectedId = (popup.segments[Math.min(at, popup.segments.length - 1)] || {}).segment_id || "";
        renderResults(); setMessage(t("Segment deleted; gaps are kept"));
      };
      const merge = document.createElement("button"); merge.type = "button"; merge.className = "kav-seg-icon"; merge.innerHTML = SEG_ICONS.merge;
      merge.setAttribute("aria-label", t("Merge with previous segment")); merge.disabled = index === 0;
      merge.onclick = () => {
        if (index <= 0) return;
        const previous = popup.segments[index - 1], current = popup.segments[index];
        if (previous.confidence != null && current.confidence != null) {
          const total = (previous.end - previous.start) + (current.end - current.start);
          previous.confidence = total > 0 ? (previous.confidence * (previous.end - previous.start) + current.confidence * (current.end - current.start)) / total : previous.confidence;
        } else previous.confidence = previous.confidence == null ? current.confidence : previous.confidence;
        previous.end = current.end; popup.segments.splice(index, 1); popup.selectedId = previous.segment_id;
        renderResults(); setMessage(t("Merged with previous segment"));
      };
      row.append(checkbox, start, end, duration, confidence, del, merge); list.appendChild(row);
    });
    updateBusy();
  }
  popup.analysisJobId = "";
  renderMode(); renderResults(); updateBusy(); paintPreviewTime();
}

let activeTrimPopup = null, trimHideTimer = null;
function closeTrimPopup(owner = null) {
  clearTimeout(trimHideTimer); trimHideTimer = null;
  if (!activeTrimPopup || (owner && activeTrimPopup.owner !== owner)) return;
  const popup = activeTrimPopup; activeTrimPopup = null;
  try { popup.video.pause(); } catch (_) {}
  popup.el.remove();
  window.removeEventListener("scroll", popup.onScroll, true);
  window.removeEventListener("keydown", popup.onKey, true);
}

function attachVideoTrim(cell, getItem, onChange, onSegments, onLimit, isSelectMode, owner = null) {
  cell.addEventListener("mouseenter", () => {
    if (isSelectMode && isSelectMode()) { closeTrimPopup(owner); return; }
    clearTimeout(trimHideTimer);
    showVideoTrim(cell, getItem(), onChange, onSegments, onLimit, owner);
  });
  cell.addEventListener("mouseleave", () => {
    clearTimeout(trimHideTimer);
    trimHideTimer = setTimeout(() => closeTrimPopup(owner), 140);
  });
}

function showVideoTrim(anchor, item, onChange, onSegments, onLimit, owner = null) {
  closeSegmentPopup();
  closeTrimPopup();
  const el = document.createElement("div"); el.className = "kav-trim-pop";
  const video = document.createElement("video");
  video.className = "kav-trim-video"; video.src = mediaSourceUrl(item);
  video.preload = "metadata"; video.muted = true; video.playsInline = true;
  const bar = document.createElement("div"); bar.className = "kav-trim-bar";
  const play = document.createElement("button"); play.type = "button"; play.className = "kav-trim-play";
  play.dataset.state = "paused";
  play.setAttribute("aria-label", t("Play"));
  const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const pauseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM14 5h4v14h-4z"/></svg>';
  play.innerHTML = playIcon;
  const time = document.createElement("span"); time.className = "kav-trim-time";
  bar.append(play, time);
  if (onSegments) {
    const segments = document.createElement("button"); segments.type = "button"; segments.className = "kav-seg-btn";
    segments.innerHTML = SEG_ICONS.cut; segments.appendChild(document.createTextNode(t("Segments")));
    segments.setAttribute("aria-label", t("Long video segmentation"));
    segments.onclick = (ev) => { ev.stopPropagation(); onSegments(item, onLimit, owner); };
    bar.appendChild(segments);
  }
  const track = document.createElement("div"); track.className = "kav-trim-track";
  const left = document.createElement("div"); left.className = "kav-trim-out";
  const right = document.createElement("div"); right.className = "kav-trim-out";
  const range = document.createElement("div"); range.className = "kav-trim-range";
  const handleL = document.createElement("div"); handleL.className = "kav-trim-handle"; handleL.dataset.handle = "start";
  const handleR = document.createElement("div"); handleR.className = "kav-trim-handle"; handleR.dataset.handle = "end";
  track.append(left, right, range, handleL, handleR);
  const hint = document.createElement("div"); hint.className = "kav-trim-hint";
  hint.textContent = t("Drag on the video or timeline to select a time range");
  el.append(video, bar, track, hint); document.body.appendChild(el);
  let duration = 0, start = Number(item.trim_start) || 0, end = item.trim_end == null ? null : Number(item.trim_end);
  let drag = null;
  const popup = {
    el, video, owner,
    onScroll: () => closeTrimPopup(owner),
    onKey: (e) => { if (e.key === "Escape") closeTrimPopup(owner); },
  };
  activeTrimPopup = popup;
  const setPlaying = (playing) => {
    play.innerHTML = playing ? pauseIcon : playIcon;
    play.classList.toggle("is-playing", playing);
    play.dataset.state = playing ? "playing" : "paused";
    const label = playing ? t("Pause") : t("Play");
    play.title = label; play.setAttribute("aria-label", label); play.setAttribute("aria-pressed", String(playing));
  };
  video.addEventListener("play", () => setPlaying(true));
  video.addEventListener("pause", () => setPlaying(false));
  video.addEventListener("ended", () => setPlaying(false));
  video.onerror = () => { if (activeTrimPopup === popup) hint.textContent = t("Video preview unavailable"); };
  const rect = anchor.getBoundingClientRect();
  const pw = el.offsetWidth, ph = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8)) + "px";
  el.style.top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - ph - 8)) + "px";
  window.addEventListener("scroll", popup.onScroll, true);
  window.addEventListener("keydown", popup.onKey, true);
  el.onmouseenter = () => clearTimeout(trimHideTimer);
  el.onmouseleave = () => { clearTimeout(trimHideTimer); trimHideTimer = setTimeout(() => closeTrimPopup(owner), 140); };
  const paint = () => {
    if (!duration) return;
    const a = Math.max(0, Math.min(start, duration)) / duration * 100;
    const b = Math.max(0, Math.min(end == null ? duration : end, duration)) / duration * 100;
    left.style.left = "0"; left.style.width = a + "%";
    right.style.left = b + "%"; right.style.right = "0";
    range.style.left = a + "%"; range.style.width = Math.max(0, b - a) + "%";
    handleL.style.left = "calc(" + a + "% - 3px)";
    handleR.style.left = "calc(" + b + "% - 3px)";
    time.textContent = trimTime(start) + " — " + trimTime(end == null ? duration : end);
  };
  const seek = (value) => { try { video.currentTime = Math.max(0, Math.min(value, duration || value)); } catch (_) {} };
  const commit = (a, b) => {
    let s = Math.max(0, Math.min(a, b)), e = Math.max(a, b);
    if (e - s < 0.1) return;
    if (e >= duration - 0.05) e = null;
    start = s; end = e; paint();
    onChange({ trim_start: start, trim_end: end });
  };
  const at = (ev, target) => {
    const r = target.getBoundingClientRect();
    return Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width))) * duration;
  };
  const down = (ev) => {
    if (!duration || ev.button !== 0) return;
    ev.preventDefault();
    const handle = ev.target.dataset && ev.target.dataset.handle;
    const kind = handle || (ev.target === range ? "move" : "new");
    drag = kind === "move"
      ? { kind, moved: false, pointerId: ev.pointerId, anchor: at(ev, track),
        start, end: end == null ? duration : end }
      : { kind, moved: false, pointerId: ev.pointerId,
        anchor: kind === "new" ? at(ev, ev.currentTarget) : null };
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (_) {}
    video.pause();
  };
  const applyDrag = (value) => {
    if (drag.kind === "new") {
      start = Math.min(drag.anchor, value); end = Math.max(drag.anchor, value);
    } else if (drag.kind === "move") {
      const length = Math.min(duration, Math.max(0.1, drag.end - drag.start));
      const shifted = Math.max(0, Math.min(drag.start + value - drag.anchor, duration - length));
      start = shifted; end = shifted + length;
    } else if (drag.kind === "start") start = Math.min(value, (end == null ? duration : end) - 0.1);
    else end = Math.max(value, start + 0.1);
  };
  const move = (ev) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const value = at(ev, drag.kind === "move" ? track : ev.currentTarget);
    drag.moved = true;
    applyDrag(value);
    paint(); seek(value);
  };
  const up = (ev) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const current = drag;
    const value = at(ev, current.kind === "move" ? track : ev.currentTarget);
    applyDrag(value);
    drag = null;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (_) {}
    if (!current.moved && Math.abs(value - (current.kind === "new" ? current.anchor : value)) < 0.001) return;
    commit(start, end == null ? duration : end);
  };
  video.addEventListener("pointerdown", down); track.addEventListener("pointerdown", down);
  video.addEventListener("pointermove", move); track.addEventListener("pointermove", move);
  video.addEventListener("pointerup", up); track.addEventListener("pointerup", up);
  video.addEventListener("pointercancel", (ev) => { if (drag && ev.pointerId === drag.pointerId) drag = null; });
  video.addEventListener("loadedmetadata", () => {
    duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      duration = 0; hint.textContent = t("Video preview unavailable"); return;
    }
    const correctedStart = Math.min(start, Math.max(0, duration - 0.1));
    let correctedEnd = end == null ? null : Math.min(end, duration);
    if (correctedEnd != null && correctedEnd <= correctedStart) correctedEnd = null;
    if (correctedEnd != null && correctedEnd >= duration - 0.05) correctedEnd = null;
    const changed = correctedStart !== start || correctedEnd !== end;
    start = correctedStart; end = correctedEnd;
    seek(start); paint();
    if (changed) onChange({ ...item, trim_start: start, trim_end: end });
    if (start > 0 || end != null) video.play().catch(() => {});
  });
  video.addEventListener("timeupdate", () => {
    if (end != null && video.currentTime >= end) seek(start);
  });
  play.onclick = (ev) => {
    ev.stopPropagation();
    if (video.paused) {
      setPlaying(true);
      video.play().catch(() => setPlaying(false));
    } else {
      video.pause(); setPlaying(false);
    }
  };
  if (video.readyState >= 1) video.dispatchEvent(new Event("loadedmetadata"));
}

const AV_SETS_API = "/ps/av-sets";
let avSetsMenu = null;
let avSetsOwner = null;

function closeAvSetsMenu(owner = null) {
  if (!avSetsMenu || (owner && avSetsOwner !== owner)) return;
  if (avSetsMenu.__kdCleanup) avSetsMenu.__kdCleanup();
  avSetsMenu.remove();
  avSetsMenu = null;
  avSetsOwner = null;
}

async function avSetsApi(path, body) {
  const response = await fetch(AV_SETS_API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error((data && data.error) || ("HTTP " + response.status));
  return data || {};
}

async function openAvSetsMenu(node, anchor, onApply) {
  closeAvSetsMenu();
  const menu = document.createElement("div");
  menu.className = "kd-setsmenu";
  avSetsMenu = menu;
  avSetsOwner = node;

  const head = document.createElement("div");
  head.className = "kd-sets-head";
  const title = document.createElement("span");
  title.textContent = t("AV arrangements");
  const close = document.createElement("button");
  close.type = "button"; close.textContent = "×"; close.title = t("Close"); close.onclick = closeAvSetsMenu;
  head.append(title, close);

  const saveRow = document.createElement("div");
  saveRow.className = "kd-sets-save";
  const nameInput = document.createElement("input");
  nameInput.type = "text"; nameInput.maxLength = 60;
  nameInput.placeholder = t("Name this arrangement (optional)");
  const save = document.createElement("button");
  save.type = "button"; save.className = "kd-btn kd-p"; save.textContent = t("Save");
  saveRow.append(nameInput, save);

  const list = document.createElement("div");
  list.className = "kd-sets-list";
  const hint = document.createElement("div");
  hint.className = "kd-sets-hint";
  hint.textContent = t("Only names, order and settings are saved. Media must still be in the input/output folders.");
  menu.append(head, saveRow, list, hint);
  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth || 330;
  const height = Math.min(menu.offsetHeight || 260, Math.round((window.innerHeight || 800) * 0.72));
  menu.style.left = Math.max(6, Math.min(rect.left, (window.innerWidth || 1280) - width - 6)) + "px";
  const below = rect.bottom + 6;
  menu.style.top = (below + height <= (window.innerHeight || 800) - 6)
    ? below + "px" : Math.max(6, rect.top - height - 6) + "px";

  const onDoc = (event) => {
    if (menu.contains(event.target) || anchor.contains(event.target)) return;
    closeAvSetsMenu();
  };
  const onKey = (event) => { if (event.key === "Escape") closeAvSetsMenu(); };
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
      const response = await fetch(AV_SETS_API);
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      items = (data && data.items) || [];
    } catch (error) {
      const empty = document.createElement("div");
      empty.className = "kd-sets-empty";
      empty.textContent = t("Load failed: {error}", { error: serverError(error.message) });
      list.appendChild(empty);
      return;
    }
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "kd-sets-empty";
      empty.textContent = t("No saved AV arrangements yet");
      list.appendChild(empty);
      return;
    }
    let armed = { id: "", at: 0 };
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "kd-setsrow";
      const name = document.createElement("span");
      name.className = "kd-sets-name"; name.textContent = item.name; name.title = item.name;
      const load = document.createElement("button");
      load.type = "button"; load.className = "kd-btn"; load.textContent = t("Load");
      const rename = document.createElement("button");
      rename.type = "button"; rename.className = "kd-btn"; rename.textContent = t("Rename");
      const del = document.createElement("button");
      del.type = "button"; del.className = "kd-btn"; del.textContent = t("Delete");
      load.onclick = async () => {
        try {
          const result = await avSetsApi("/load", { id: item.id });
          if (avSetsMenu !== menu || avSetsOwner !== node || !menu.isConnected) return;
          onApply(result.item);
          closeAvSetsMenu();
          const missing = result.missing || [];
          const message = t("Arrangement loaded: {name}", { name: result.item.name });
          kdToast(missing.length ? message + " · " + t("Missing {n}: {names}", {
            n: missing.length, names: missing.slice(0, 3).join(", "),
          }) : message, missing.length > 0);
        } catch (error) { kdToast(t("Load failed: {error}", { error: serverError(error.message) }), true); }
      };
      rename.onclick = async () => {
        const nextName = window.prompt(t("Rename"), item.name || "");
        if (nextName == null || !nextName.trim()) return;
        try {
          await avSetsApi("/rename", { id: item.id, name: nextName.trim() });
          await paintList();
        } catch (error) { kdToast(t("Rename failed: {error}", { error: serverError(error.message) }), true); }
      };
      del.onclick = async () => {
        if (armed.id !== item.id || Date.now() - armed.at > 2500) {
          armed = { id: item.id, at: Date.now() };
          del.textContent = t("Confirm"); del.style.color = "var(--error-text,#ff6b6b)";
          setTimeout(() => { del.textContent = t("Delete"); del.style.color = ""; }, 2600);
          return;
        }
        try {
          await avSetsApi("/delete", { id: item.id });
          await paintList();
        } catch (error) { kdToast(t("Delete failed: {error}", { error: serverError(error.message) }), true); }
      };
      row.append(name, load, rename, del);
      list.appendChild(row);
    });
  }

  save.onclick = async () => {
    const state = readState(node);
    if (!state.videos.length && !state.audios.length) {
      kdToast(t("Choose at least one video or audio"), true);
      return;
    }
    save.disabled = true;
    try {
      await avSetsApi("/save", {
        name: nameInput.value,
        videos: state.videos, audios: state.audios,
        batch: state.batch, select: state.select,
        picked_videos: state.picked_videos, picked_audios: state.picked_audios,
        output_mode: state.output_mode, video_audio: state.video_audio,
        frame_options: state.frame_options,
      });
      nameInput.value = "";
      await paintList();
    } catch (error) { kdToast(t("Load failed: {error}", { error: serverError(error.message) }), true); }
    finally { save.disabled = false; }
  };
  await paintList();
}

function build(node) {
  if (node.__kdAVUI && (node.widgets || []).some((w) => w.name === "media_state")) return;
  const pw = (node.widgets || []).find((w) => w.name === "media_state");
  if (!pw) return;
  hideMediaStateInput(node);
  try { pw.options = pw.options || {}; pw.options.hidden = true; } catch (_) {}
  ensureAvCss();
  const card = document.createElement("div"); card.className = "kd-card kav-card";
  const top = document.createElement("div"); top.className = "kd-top kav-top";
  const title = document.createElement("b"); title.textContent = t("Audio / video");
  const topCount = document.createElement("em"); topCount.textContent = "0";
  const mode = document.createElement("div"); mode.className = "kd-btns kav-mode";
  const videoMode = document.createElement("button"), framesMode = document.createElement("button");
  videoMode.type = framesMode.type = "button";
  videoMode.textContent = t("Video"); framesMode.textContent = t("Video frames");
  mode.append(videoMode, framesMode);
  const selectLabel = document.createElement("label"); selectLabel.className = "kd-sw";
  const selectCb = document.createElement("input"); selectCb.type = "checkbox";
  const selectI = document.createElement("i"); selectLabel.append(selectCb, selectI, document.createTextNode(t("Select")));
  const batchLabel = document.createElement("label"); batchLabel.className = "kd-sw";
  const batchCb = document.createElement("input"); batchCb.type = "checkbox";
  const batchI = document.createElement("i"); batchLabel.append(batchCb, batchI, document.createTextNode(t("Batch")));
  const videoAudioLabel = document.createElement("label"); videoAudioLabel.className = "kd-sw";
  const videoAudioCb = document.createElement("input"); videoAudioCb.type = "checkbox";
  const videoAudioI = document.createElement("i");
  videoAudioLabel.append(videoAudioCb, videoAudioI, document.createTextNode(t("Video built-in audio")));
  const setsBtn = document.createElement("button");
  setsBtn.type = "button"; setsBtn.className = "kd-btn"; setsBtn.textContent = t("Arrangements");
  setsBtn.title = t("Save or load an AV arrangement");
  top.append(title, topCount, batchLabel, selectLabel, videoAudioLabel, mode);
  const body = document.createElement("div"); body.className = "kav-body";
  const slots = document.createElement("div"); slots.className = "kav-slots";
  const sections = {};
  for (const slot of ["video", "audio"]) {
    const box = document.createElement("div"); box.className = "kav-slot";
    const hd = document.createElement("div"); hd.className = "kav-slot-hd";
    const lab = document.createElement("b"); lab.textContent = slot === "video" ? t("Videos") : t("Audios");
    const count = document.createElement("span"); count.className = "kav-meta";
    const grow = document.createElement("span"); grow.className = "kav-grow";
    const same = document.createElement("button"); same.type = "button"; same.className = "kd-btn";
    same.textContent = t("Use video audio"); same.hidden = slot !== "audio";
    const choose = document.createElement("button"); choose.type = "button"; choose.className = "kd-btn"; choose.textContent = t("From library");
    const upload = document.createElement("button"); upload.type = "button"; upload.className = "kd-btn"; upload.textContent = t("Upload");
    const clear = document.createElement("button"); clear.type = "button"; clear.className = "kd-btn"; clear.textContent = t("Clear");
    const file = document.createElement("input"); file.type = "file"; file.hidden = true; file.multiple = true;
    file.accept = slot === "video" ? VID_EXTS.join(",") : AUD_EXTS.join(",") + "," + VID_EXTS.join(",");
    hd.append(lab, count, grow, same, choose, upload, clear, file);
    const list = document.createElement("div"); list.className = "kav-list";
    box.append(hd, list); slots.appendChild(box);
    sections[slot] = { box, list, count, choose, upload, clear, file, same, armed: 0 };
  }
  body.appendChild(slots);
  for (const slot of ["video", "audio"]) {
    const list = sections[slot].list;
    const pkey = slot === "video" ? "picked_videos" : "picked_audios";
    const anchorKey = "__kdAVAnchor_" + slot;
    kdGesture(list, () => Array.from(list.querySelectorAll(".kav-item")), {
      cellSelector: ".kav-item",
      enabled: () => !node.__kdAVRun && !!readState(node).select,
      onCellTap(index, shift) {
        const current = readState(node), items = slot === "video" ? current.videos : current.audios;
        const id = items[index] && items[index].id;
        if (!id) return;
        if (shift && Number.isInteger(node[anchorKey])) {
          const lo = Math.min(node[anchorKey], index), hi = Math.max(node[anchorKey], index);
          mutate((st) => {
            for (let i = lo; i <= hi; i++) {
              const item = (slot === "video" ? st.videos : st.audios)[i];
              if (item && !st[pkey].includes(item.id)) st[pkey].push(item.id);
            }
          });
        } else togglePicked(slot, id);
        node[anchorKey] = index;
      },
      onMarquee(indices) {
        mutate((st) => {
          for (const index of indices) {
            const item = (slot === "video" ? st.videos : st.audios)[index];
            if (item && !st[pkey].includes(item.id)) st[pkey].push(item.id);
          }
        });
      },
      onBlankTap() { mutate((st) => { st[pkey] = []; }); },
    });
  }
  for (const slot of ["video", "audio"]) {
    const list = sections[slot].list;
    list.addEventListener("dragstart", (e) => {
      const cell = e.target.closest(".kav-item");
      if (!cell || node.__kdAVRun || readState(node).select) { e.preventDefault(); return; }
      const index = Array.from(list.querySelectorAll(".kav-item")).indexOf(cell);
      node.__kdAVDrag = { slot, index };
      cell.style.opacity = "0.45";
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", "kedou-av-item"); } catch (_) {}
      }
    });
    list.addEventListener("dragover", (e) => {
      const cell = e.target.closest(".kav-item");
      if (!cell || !node.__kdAVDrag || node.__kdAVDrag.slot !== slot) return;
      e.preventDefault();
      list.querySelectorAll(".kav-item.drag-over").forEach((el) => el.classList.remove("drag-over"));
      cell.classList.add("drag-over");
    });
    list.addEventListener("drop", (e) => {
      const cell = e.target.closest(".kav-item");
      const drag = node.__kdAVDrag;
      if (!cell || !drag || drag.slot !== slot) return;
      e.preventDefault();
      const to = Array.from(list.querySelectorAll(".kav-item")).indexOf(cell);
      node.__kdAVDrag = null;
      if (to < 0 || to === drag.index) { render(); return; }
      mutate((st) => {
        const key = slot === "video" ? "videos" : "audios";
        const pkey = slot === "video" ? "picked_videos" : "picked_audios";
        const moved = st[key].splice(drag.index, 1)[0];
        if (!moved) return;
        st[key].splice(to, 0, moved);
        const picked = new Set(st[pkey]);
        st[pkey] = st[key].map((item) => item.id).filter((id) => picked.has(id));
      });
    });
    list.addEventListener("dragend", () => {
      node.__kdAVDrag = null;
      list.querySelectorAll(".kav-item").forEach((el) => { el.style.opacity = ""; el.classList.remove("drag-over"); });
    });
  }
  const frames = document.createElement("div"); frames.className = "kav-frames";
  const frameFields = {};
  [["start_frame", 0, 100000], ["max_frames", 1, 128], ["frame_step", 1, 60], ["max_side", 0, 2048]].forEach(([key, min, max]) => {
    const label = document.createElement("label");
    const names = { start_frame: t("Start frame"), max_frames: t("Max frames"), frame_step: t("Frame step"), max_side: t("Max side") };
    label.textContent = names[key];
    const input = document.createElement("input"); input.type = "number"; input.min = min; input.max = max;
    input.onchange = () => mutate((st) => { st.frame_options[key] = intValue(input.value, st.frame_options[key], min, max); });
    label.appendChild(input); frames.appendChild(label); frameFields[key] = input;
  });
  body.appendChild(frames);
  const foot = document.createElement("div"); foot.className = "kav-foot";
  const status = document.createElement("span"); status.className = "kav-meta";
  const run = document.createElement("button"); run.type = "button"; run.className = "kd-btn kd-p kav-run"; run.textContent = t("Run");
  foot.append(setsBtn, status, run); card.append(top, body, foot);
  node.addDOMWidget("kedou_av", "div", card, { getMinHeight: () => 260, hideOnZoom: false, serialize: false });
  const domW = node.widgets.find((w) => w.name === "kedou_av");
  if (domW) { domW.serialize = false; if (domW.options) domW.options.serialize = false; }
  try { node.setSize([Math.max(Number(node.size && node.size[0]) || 0, 460), 300]); } catch (_) {}
  const ui = { card, body, top, topCount, setsBtn, videoMode, framesMode, selectCb, batchCb, videoAudioCb, sections, frames, frameFields, status, run };
  node.__kdAVUI = ui;
  ui.render = render;

  let selectionVersion = 0;
  function mutate(fn) {
    if (node.__kdAVRun) return;
    selectionVersion += 1;
    const st = readState(node);
    if (st.legacy_pairs) { st.legacy_pairs = false; delete st.pairs; }
    fn(st); writeState(node, st); render();
  }
  function addItems(slot, items, replace = false) {
    mutate((st) => {
      const key = slot === "video" ? "videos" : "audios";
      const pkey = slot === "video" ? "picked_videos" : "picked_audios";
      const limit = readState(node).batch ? AV_ITEM_LIMIT : AV_SLOTS;
      if (replace) {
        st[key] = [];
        st[pkey] = [];
      }
      const seen = new Set(st[key].map((x) => x.id));
      for (const item of items) {
        if (st[key].length >= limit) break;
        if (!item || seen.has(item.id)) continue;
        st[key].push(item); seen.add(item.id);
      }
      const liveIds = new Set(st[key].map((x) => x.id));
      st[pkey] = st[pkey].filter((id) => liveIds.has(id));
    });
    const st = readState(node);
    const limit = st.batch ? AV_ITEM_LIMIT : AV_SLOTS;
    if ((slot === "video" ? st.videos : st.audios).length >= limit) kdToast(t("Up to {n} items", { n: limit }));
  }
  function updateItem(slot, id, patch, repaint = true) {
    selectionVersion += 1;
    const st = readState(node);
    if (st.legacy_pairs) { st.legacy_pairs = false; delete st.pairs; }
    const key = slot === "video" ? "videos" : "audios";
    const current = findItemBySelector(st[key], id);
    if (current) st[key][st[key].indexOf(current)] = { ...current, ...patch };
    writeState(node, st);
    if (repaint) render();
  }
  function removeItem(slot, id) {
    mutate((st) => {
      const key = slot === "video" ? "videos" : "audios";
      const pkey = slot === "video" ? "picked_videos" : "picked_audios";
      st[key] = st[key].filter((x) => x.id !== id);
      st[pkey] = st[pkey].filter((x) => x !== id);
    });
  }
  function togglePicked(slot, id) {
    mutate((st) => {
      const pkey = slot === "video" ? "picked_videos" : "picked_audios";
      const at = st[pkey].indexOf(id);
      if (at >= 0) st[pkey].splice(at, 1); else st[pkey].push(id);
    });
  }
  for (const slot of ["video", "audio"]) {
    const s = sections[slot];
    s.choose.onclick = () => { if (!node.__kdAVRun) openLibrary(slot, (items) => addItems(slot, items, true)); };
    s.upload.onclick = () => { if (!node.__kdAVRun) s.file.click(); };
    s.file.onchange = async () => {
      const files = [...(s.file.files || [])]; s.file.value = "";
      if (!files.length || node.__kdAVRun) return;
      s.upload.disabled = true;
      const version = selectionVersion;
      const uploaded = [], failed = [];
      try {
        for (const f of files) {
          try {
            const low = f.name.toLowerCase();
            const inferred = VID_EXTS.some((e) => low.endsWith(e)) ? "video" : "audio";
            const filename = await uploadOne(f, inferred);
            const item = cleanItem({ filename, tab: "input", kind: inferred,
              extract_audio: slot === "audio" && inferred === "video" }, slot);
            if (!item) throw new Error(t("Upload failed"));
            uploaded.push(item);
          } catch (e) { failed.push(f.name); }
        }
        if (selectionVersion !== version || !nodeOnCanvas(node)) {
          if (uploaded.length) kdToast(t("Selection changed; upload was not applied"), true);
        } else if (uploaded.length) addItems(slot, uploaded, true);
        if (failed.length) kdToast(t("Upload failed: {names}", { names: failed.join(", ") }), true);
      } finally { s.upload.disabled = false; }
    };
    s.clear.onclick = () => {
      if (Date.now() - s.armed >= 2500) {
        s.armed = Date.now(); s.clear.textContent = t("Confirm clear?"); s.clear.style.color = "var(--error-text,#ff6b6b)";
        setTimeout(() => { s.clear.textContent = t("Clear"); s.clear.style.color = ""; }, 2600);
        return;
      }
      s.armed = 0; s.clear.textContent = t("Clear"); s.clear.style.color = "";
      mutate((st) => {
        if (slot === "video") { st.videos = []; st.picked_videos = []; }
        else { st.audios = []; st.picked_audios = []; }
      });
    };
  }
  sections.audio.same.onclick = () => {
    const st = readState(node), vids = effectiveList(st, "video");
    if (!vids.length) { kdToast(t("Choose at least one reference video"), true); return; }
    addItems("audio", vids.map((v) => ({ ...v, kind: "video", extract_audio: true })), true);
  };
  videoMode.onclick = () => mutate((st) => { st.output_mode = "video"; });
  framesMode.onclick = () => mutate((st) => { st.output_mode = "frames"; });
  selectCb.onchange = () => mutate((st) => { st.select = selectCb.checked; });
  batchCb.onchange = () => mutate((st) => { st.batch = batchCb.checked; st.cursor = 0; });
  videoAudioCb.onchange = () => mutate((st) => { st.video_audio = videoAudioCb.checked; });
  setsBtn.onclick = () => {
    if (node.__kdAVRun) return;
    openAvSetsMenu(node, setsBtn, (item) => mutate((st) => {
      st.videos = item.videos; st.audios = item.audios;
      st.picked_videos = item.picked_videos; st.picked_audios = item.picked_audios;
      st.select = item.select; st.batch = item.batch; st.cursor = 0;
      st.output_mode = item.output_mode; st.video_audio = item.video_audio;
      st.frame_options = item.frame_options;
      st.port_order = []; st.hidden_links = {}; st.legacy_pairs = false; delete st.pairs;
    }));
  };

  function render() {
    closeAvSetsMenu(node);
    closeSegmentPopup(node);
    closeTrimPopup(node);
    const st = readState(node);
    videoMode.classList.toggle("on", st.output_mode === "video");
    framesMode.classList.toggle("on", st.output_mode === "frames");
    frames.classList.toggle("on", st.output_mode === "frames");
    selectCb.checked = st.select; batchCb.checked = st.batch; videoAudioCb.checked = st.video_audio;
    topCount.textContent = String(Math.max(st.videos.length, st.audios.length));
    for (const key of Object.keys(frameFields)) frameFields[key].value = st.frame_options[key];
    for (const slot of ["video", "audio"]) {
      const s = sections[slot], list = st[slot === "video" ? "videos" : "audios"];
      const picked = slot === "video" ? st.picked_videos : st.picked_audios;
      s.count.textContent = list.length + "/" + AV_ITEM_LIMIT;
      s.clear.hidden = !list.length;
      s.list.classList.toggle("has-items", !!list.length);
      s.list.innerHTML = "";
      if (!list.length) {
        const empty = document.createElement("div"); empty.className = "kav-empty";
        empty.textContent = slot === "video" ? t("No videos yet") : t("No audio yet");
        s.list.appendChild(empty);
      }
      list.forEach((item, i) => {
        const cell = document.createElement("div");
        cell.className = "kav-item" + (st.select ? (picked.includes(item.id) ? " on" : " off") : "");
        const img = document.createElement("img"); img.src = previewUrl(item);
        img.onerror = () => { img.style.visibility = "hidden"; };
        const pickOrder = new Map(picked.map((id, index) => [id, index + 1]));
        const no = document.createElement("span"); no.className = "kav-item-no";
        no.textContent = st.select && pickOrder.has(item.id) ? pickOrder.get(item.id) : i + 1;
        const name = document.createElement("span"); name.className = "kav-item-name"; name.textContent = item.filename;
        const del = document.createElement("button"); del.type = "button"; del.className = "kav-item-del"; del.textContent = "×";
        del.onclick = (e) => { e.stopPropagation(); removeItem(slot, item.id); };
        cell.append(img, no, name, del);
        if (item.kind === "video") {
          const key = slot === "video" ? "videos" : "audios";
          attachVideoTrim(cell,
            () => findItemBySelector(readState(node)[key], item.id) || item,
            (patch) => updateItem(slot, item.id, patch, false),
            slot === "video" ? (source, getLimit, owner) => {
              const current = findItemBySelector(readState(node)[key], source.id) || source;
              openSegmentPopup(cell, current, (items) => addItems("video", items), getLimit, owner);
            } : null,
            () => readState(node).batch ? AV_ITEM_LIMIT : AV_SLOTS,
            () => readState(node).select,
            node);
        }
        mediaInfo(item).then((info) => {
          if (!info) return;
          const bits = []; const dur = formatDuration(info.duration); if (dur) bits.push(dur);
          if (info.width && info.height) bits.push(info.width + "×" + info.height);
          if (info.sample_rate) bits.push(info.sample_rate + " Hz");
          name.title = bits.join(" · ");
        });
        s.list.appendChild(cell);
      });
      s.same.hidden = slot !== "audio" || !effectiveList(st, "video").length;
    }
    const count = pairCount(st);
    run.textContent = st.batch ? t("Run {n}", { n: Math.max(1, count) }) : t("Run");
    run.disabled = st.output_mode === "frames" ? !effectiveList(st, "video").length : !count;
    const total = Math.max(effectiveList(st, "video").length, effectiveList(st, "audio").length);
    status.textContent = st.batch ? t("Batch mode: {n} segments in total", { n: count })
      : total > AV_SLOTS ? t("Normal mode only outputs the first 8 groups; enable Batch for more")
      : t("Normal mode: output paired videos and audio at the same time");
    syncOutputs(node, st);
  }

  run.onclick = () => runAV(node);
  const onCfg = node.onConfigure;
  node.onConfigure = function () {
    const r = typeof onCfg === "function" ? onCfg.apply(this, arguments) : undefined;
    const token = (node.__kdAVCfgToken = (node.__kdAVCfgToken || 0) + 1);
    let tries = 0;
    const settle = () => {
      if (node.__kdAVCfgToken !== token) return;
      if (app.configuringGraph) {
        if (tries++ < 200) setTimeout(settle, 50);
        return;
      }
      syncOutputs(node, readState(node));
    };
    setTimeout(settle, 0);
    return r;
  };
  const onConn = node.onConnectionsChange;
  const onConnectOutput = node.onConnectOutput;
  node.onConnectOutput = function (slot) {
    const index = Number(slot);
    const port = Number.isInteger(index) && this.outputs ? this.outputs[index] : null;
    if (!port) return false;
    const key = legacyOutputKey(port, index);
    const layout = outputLayout(readState(this));
    if (!(layout.length ? layout.includes(key) : /^(video|frames|audio)_\d+$/.test(key))) return false;
    queueOutputSync(this);
    return typeof onConnectOutput === "function" ? onConnectOutput.apply(this, arguments) : true;
  };
  node.onConnectionsChange = function () {
    const r = typeof onConn === "function" ? onConn.apply(this, arguments) : undefined;
    queueOutputSync(node);
    return r;
  };
  const onRm = node.onRemoved;
  node.onRemoved = function () {
    closeAvSetsMenu(node);
    closeSegmentPopup(node);
    closeTrimPopup(node);
    if (node.__kdAVRun) node.__kdAVRun.cancelled = true;
    if (node.__kdAVUnsub) { node.__kdAVUnsub(); node.__kdAVUnsub = null; }
    return typeof onRm === "function" ? onRm.apply(this, arguments) : undefined;
  };
  const unsub = onLocaleChange(() => { try { render(); } catch (_) {} });
  node.__kdAVUnsub = unsub;
  render();
  queueOutputSync(node);
}

async function runAV(node) {
  if (node.__kdAVRun) { kdToast(t("A batch is already being queued"), true); return; }
  const snapshot = readState(node);
  const vids = effectiveList(snapshot, "video"), audios = effectiveList(snapshot, "audio");
  const count = pairCount(snapshot);
  if (!count) { kdToast(t("Choose at least one video or audio"), true); return; }
  if (snapshot.output_mode === "frames") {
    if (!vids.length) { kdToast(t("Choose at least one reference video"), true); return; }
    if (snapshot.batch) {
      const missing = Array.from({ length: count }, (_, i) => pairAt(snapshot, i).video ? null : i + 1).filter(Boolean);
      if (missing.length) { kdToast(t("Batch group {n} needs a reference video", { n: missing[0] }), true); return; }
    }
  }
  const jobs = snapshot.batch ? count : 1;
  const token = { cancelled: false };
  node.__kdAVRun = token;
  const ui = node.__kdAVUI;
  const topControls = ui && [ui.videoMode, ui.framesMode, ui.selectCb, ui.batchCb, ui.videoAudioCb, ui.setsBtn];
  const savedTop = topControls && topControls.map((el) => ({ el, disabled: !!el.disabled }));
  if (ui) {
    ui.body.inert = true;
    if ("inert" in ui.top) ui.top.inert = true;
    else topControls.forEach((el) => { el.disabled = true; });
    ui.card.classList.add("kd-batch-lock");
  }
  let lastExpected = "";
  try {
    for (let i = 0; i < jobs; i++) {
      if (token.cancelled || !nodeOnCanvas(node)) throw new Error(t("The media node was removed; batch stopped"));
      const st = snapshot.batch ? { ...snapshot, cursor: i } : snapshot;
      writeState(node, st, true);
      lastExpected = (node.widgets || []).find((w) => w.name === "media_state")?.value || "";
      const result = await app.queuePrompt(0);
      await settleQueueSubmission(node, token, result);
      if (token.cancelled || !nodeOnCanvas(node)) throw new Error(t("The media node was removed; batch stopped"));
      if (((node.widgets || []).find((w) => w.name === "media_state")?.value || "") !== lastExpected) {
        throw new Error(t("Media settings changed while queuing; batch stopped without overwriting them"));
      }
    }
    kdToast(snapshot.batch ? t("Batch submitted: {n} media items queued, ComfyUI will run them in order", { n: jobs }) : t("Queued"));
  } catch (e) {
    kdToast(t("Batch submit failed: {msg}", { msg: e && e.message ? e.message : String(e) }), true);
  } finally {
    if (node.__kdAVRun === token) node.__kdAVRun = null;
    if (ui) {
      ui.body.inert = false;
      if ("inert" in ui.top) ui.top.inert = false;
      else savedTop.forEach(({ el, disabled }) => { el.disabled = disabled; });
      ui.card.classList.remove("kd-batch-lock");
    }
    if (nodeOnCanvas(node) && node.__kdAVUI) node.__kdAVUI.render();
  }
}

app.registerExtension({
  name: "kedou.avLoader",
  async setup() { await initI18n(app); },
  nodeCreated(node) {
    const cls = (node.constructor && node.constructor.comfyClass) || node.comfyClass || "";
    if (cls !== NODE_CLASS) return;
    try { build(node); } catch (e) { console.error("[kedou] 音视频节点构建失败", e); }
  },
});

export { readState, writeState, effectiveList, pairCount, pairAt, outputLayout, build, runAV };

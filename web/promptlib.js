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

// ───────── 参考图写法：各模型在提示词里指代第 N 张参考图的格式不一样 ─────────
// 只负责把「第 N 张」渲染成目标模型认识的 token；图片本身仍要按同样顺序接到模型。
// 依据（2026-10）：Seedance 2.x = @图片N / @Image N；MiniMax H3 = <Picture N>；
// 万相 2.7 = 图 N / Image N；Vidu Q2+ = @图N；可灵 3.0 Omni API = <<<image_N>>>。
const REF_STYLES = [
  { id: "generic", label: "Generic · @图片N", token: (n) => `@图片${n}`, re: /@图片(\d+)/g },
  { id: "seedance-zh", label: "Seedance · @图片N", token: (n) => `@图片${n}`, re: /@图片(\d+)/g },
  { id: "seedance-en", label: "Seedance EN · @Image N", token: (n) => `@Image ${n}`, re: /@Image (\d+)/g },
  { id: "h3", label: "MiniMax H3 · <Picture N>", token: (n) => `<Picture ${n}>`, re: /<Picture (\d+)>/g },
  { id: "wan-zh", label: "Wan · 图 N", token: (n) => `图 ${n}`, re: /图 (\d+)/g },
  { id: "wan-en", label: "Wan EN · Image N", token: (n) => `Image ${n}`, re: /Image (\d+)/g },
  { id: "vidu", label: "Vidu · @图N", token: (n) => `@图${n}`, re: /@图(\d+)/g },
  { id: "kling", label: "Kling Omni API · <<<image_N>>>", token: (n) => `<<<image_${n}>>>`, re: /<<<image_(\d+)>>>/g },
];
const REF_STORE_KEY = "kedou_ref_style";
function refStyle(id) {
  return REF_STYLES.find((s) => s.id === id) || REF_STYLES[0];
}
function refToken(id, n) {
  return refStyle(id).token(Math.max(1, Number(n) || 1));
}
function loadRefStyleId() {
  try {
    const v = localStorage.getItem(REF_STORE_KEY);
    if (REF_STYLES.some((s) => s.id === v)) return v;
  } catch (_) { /* ignore */ }
  return REF_STYLES[0].id;
}
function saveRefStyleId(id) {
  try { localStorage.setItem(REF_STORE_KEY, id); } catch (_) { /* ignore */ }
}

// 历史日期只显示相对短格式：今天/昨天带时间，今年内只留月日，跨年才带年。
// 完整时间放在 meta 的 title 里，鼠标停一下就能看全。
function historyDay(stamp) {
  const s = String(stamp || "");
  if (s.length < 10) return s;
  const day = s.slice(0, 10), hm = s.slice(11, 16);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterday = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
  if (day === today) return t("Today") + (hm ? " " + hm : "");
  if (day === yesterday) return t("Yesterday") + (hm ? " " + hm : "");
  if (day.slice(0, 4) === String(now.getFullYear())) return day.slice(5);
  return day;
}
function historyWhen(stamp) {
  const s = String(stamp || "");
  const day = historyDay(s);
  const hm = s.slice(11, 16);
  return (day === t("Today") || day === t("Yesterday")) && hm ? day + " " + hm : day;
}
// 版本行只要“哪一天”，今天/昨天不重复写时间
function historyDayLabel(stamp) {
  const day = historyDay(stamp);
  if (day === t("Today") || day.startsWith(t("Today") + " ")) return t("Today");
  if (day === t("Yesterday") || day.startsWith(t("Yesterday") + " ")) return t("Yesterday");
  return day;
}

// ───────── 历史迭代归组：几乎相同的提示词只留一行，旧版本折在下面 ─────────
// 判断只做两件轻量的事：一条是不是另一条的开头（追加式修改），或字符二元组相似度够高。
// 全量两两比较上限 50 条，开销可以忽略；不落库，删/改后分组会自动重算。
function normPrompt(s) {
  return String(s || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
function bigramSet(s) {
  const out = new Set();
  if (!s) return out;
  if (s.length === 1) { out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function promptSimilar(a, b) {
  const x = normPrompt(a), y = normPrompt(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  if (short.length < 4) return false;
  // 追加式迭代：短的是长的前缀，且长度不能差太远（防止 "masterpiece" 把一堆无关提示词串起来）
  if (long.startsWith(short) && short.length / long.length >= 0.55) return true;
  if (short.length / long.length < 0.45) return false;
  const A = bigramSet(x), B = bigramSet(y);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return (2 * hit) / (A.size + B.size) >= 0.72;
}
function histTime(e) {
  const s = String((e && (e.updated || e.created)) || "");
  // 只有日期的旧条目按当天 00:00 比，别让 localeCompare 把“长字符串”排到前面
  return s.length === 10 ? s + " 00:00:00" : s;
}
function histCmp(a, b) {
  const x = histTime(a), y = histTime(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
function groupHistory(items) {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (i, j) => {
    const a = find(i), b = find(j);
    if (a !== b) parent[b] = a;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (promptSimilar(items[i].positive, items[j].positive)) union(i, j);
    }
  }
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!map.has(root)) map.set(root, []);
    map.get(root).push(items[i]);
  }
  const groups = [...map.values()];
  groups.forEach((g) => g.sort(histCmp));
  groups.sort((a, b) => histCmp(b[b.length - 1], a[a.length - 1]));
  return groups;
}
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
.kd-pbox-refrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.kd-pbox-refrow[hidden]{display:none !important;}
.kd-pbox-refthumbs{display:flex;gap:6px;overflow-x:auto;padding:1px 1px 2px;
  scrollbar-width:none;-ms-overflow-style:none;}
.kd-pbox-refthumbs[hidden]{display:none !important;}
.kd-pbox-refthumbs::-webkit-scrollbar{display:none;}
.kd-refthumb{flex:none;display:flex;flex-direction:column;align-items:center;gap:2px;width:62px;padding:3px;
  border:1px solid var(--interface-stroke,#3a3a44);border-radius:8px;background:transparent;
  cursor:pointer;transition:border-color .15s,background .15s;}
.kd-refthumb:hover{border-color:var(--p-primary-color,#4a7dff);background:var(--content-bg,#16161c);}
.kd-refthumb .kd-refthumb-img{position:relative;display:flex;align-items:center;justify-content:center;
  width:46px;height:46px;border-radius:5px;overflow:hidden;background:var(--content-bg,#16161c);
  color:var(--fg-color,#777);font-size:16px;font-weight:600;}
.kd-refthumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}
.kd-refthumb .kd-refthumb-tag{max-width:56px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:9.5px;color:var(--fg-color,#999);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;}
.kd-refthumb:hover .kd-refthumb-tag{color:var(--p-primary-color,#6a9bff);}
.kd-refthumb.kd-bad{border-color:var(--error-text,#a33);}
.kd-refthumb.kd-bad .kd-refthumb-img{color:var(--error-text,#ffb3b3);}
.kd-pbox-reflab{font-size:10.5px;color:var(--fg-color,#888);white-space:nowrap;}
.kd-pbox-ref{flex:1;min-width:150px;max-width:250px;font-size:11px;}
.kd-pbox-refrow .kd-pbox-btn{padding:4px 8px;font-size:11px;}
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
.kd-cat-input{width:104px;max-width:40vw;background:var(--content-bg,#16161c);
  border:1px solid var(--p-primary-color,#4a7dff);border-radius:999px;color:var(--fg-color,#ddd);
  font:inherit;font-size:11.5px;padding:3px 10px;outline:none;}
.kd-row-name .kd-badge + .kd-badge{margin-left:0;}
.kd-cat-badge{color:var(--p-primary-color,#6a9bff) !important;border-color:var(--p-primary-color,#4a7dff66) !important;}
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
/* 图片排列：行内小缩略图条，加载前先确认是哪套图 */
.kd-set-ico{flex:none;font-size:11px;color:var(--p-primary-color,#8fb0ff);}
.kd-set-thumbs{display:flex;gap:3px;margin-top:5px;align-items:center;min-height:30px;overflow:hidden;}
.kd-set-thumb{width:30px;height:30px;flex:none;border-radius:4px;overflow:hidden;background:rgba(127,127,127,.12);
  display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:var(--fg-color,#888);}
.kd-set-thumb img{width:100%;height:100%;object-fit:cover;display:block;}
.kd-set-thumb.kd-bad{border:1px dashed var(--error-text,#a33);color:var(--error-text,#ff8a8a);}
.kd-set-more{flex:none;font-size:10px;color:var(--fg-color,#888);padding:0 2px;}
.kd-set-row .kd-row-prev{margin-top:4px;font-size:10.5px;}
/* 历史：正文只显示一行；悬停展开，最多 4 行，再多就在正文里滚动 */
.kd-hist-row .kd-row-head{display:flex;align-items:flex-start;gap:6px;min-width:0;}
.kd-hist-row .kd-hist-text{flex:1;min-width:0;display:block;font-size:12.5px;font-weight:600;
  color:var(--fg-color,#e0e0e0);line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.kd-hist-row .kd-hist-meta{flex:none;margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;
  gap:2px;line-height:1.3;font-size:10px;color:var(--fg-color,#888);}
.kd-hist-row .kd-hist-uses{white-space:nowrap;color:var(--p-primary-color,#8fb0ff);
  border:1px solid var(--p-primary-color,#4a7dff55);border-radius:5px;padding:0 5px;}
.kd-hist-row .kd-hist-when{white-space:nowrap;font-size:9.5px;opacity:.85;}
.kd-hist-row:hover .kd-hist-text{white-space:pre-wrap;word-break:break-word;overflow-y:auto;
  max-height:6em;font-weight:400;color:var(--fg-color,#ccc);padding-right:4px;
  scrollbar-width:thin;scrollbar-color:var(--interface-stroke,#3a3a44) transparent;}
.kd-hist-fold{flex:none;align-self:center;display:inline-flex;align-items:center;justify-content:center;
  width:22px;height:22px;margin-right:1px;padding:0;border:none;border-radius:5px;background:none;
  color:var(--fg-color,#999);font:inherit;font-size:16px;line-height:1;cursor:pointer;}
.kd-hist-fold:hover{color:var(--p-primary-color,#6a9bff);background:var(--content-bg,#16161c);}
.kd-hist-versions{margin-top:6px;padding-top:5px;border-top:1px dashed var(--interface-stroke,#3a3a44);
  display:flex;flex-direction:column;gap:3px;}
.kd-hist-versions[hidden]{display:none !important;}
.kd-hist-ver{display:flex;align-items:baseline;gap:6px;min-width:0;padding:3px 4px;border-radius:6px;cursor:pointer;}
.kd-hist-ver:hover{background:var(--content-bg,#16161c);}
.kd-hist-vtag{flex:none;font-size:9.5px;color:var(--p-primary-color,#8fb0ff);
  border:1px solid var(--p-primary-color,#4a7dff55);border-radius:4px;padding:0 4px;}
.kd-hist-ver-text{flex:1;min-width:0;font-size:11.5px;color:var(--fg-color,#bbb);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.kd-hist-ver.kd-used .kd-hist-ver-text{color:var(--p-primary-color,#8fb0ff);}
.kd-hist-ver-meta{flex:none;font-size:9.5px;color:var(--fg-color,#777);white-space:nowrap;}
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
.kd-menu.kd-ref-menu{min-width:250px;max-width:min(390px,calc(100vw - 24px));max-height:min(440px,72vh);
  overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--interface-stroke,#3a3a44) transparent;}
.kd-ref-group{font-size:10px;color:var(--fg-color,#777);padding:5px 10px 2px;margin-top:2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.kd-ref-group:first-of-type{margin-top:0;}
.kd-menu .kd-ref-item{display:flex;align-items:center;gap:8px;min-width:0;padding:4px 8px;}
.kd-menu .kd-ref-thumb{flex:none;position:relative;display:flex;align-items:center;justify-content:center;
  width:32px;height:32px;border-radius:5px;overflow:hidden;background:var(--content-bg,#16161c);
  color:var(--fg-color,#777);font-size:13px;font-weight:600;}
.kd-menu .kd-ref-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}
.kd-menu .kd-ref-thumb.kd-bad{color:var(--error-text,#ffb3b3);}
.kd-menu .kd-ref-token{flex:none;font-size:11.5px;color:var(--p-primary-color,#8fb0ff);
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace;}
.kd-menu .kd-ref-file{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:10.5px;color:var(--fg-color,#888);}
.kd-menu .kd-ref-hint{font-size:10.5px;color:var(--fg-color,#777);padding:5px 10px;line-height:1.45;}
.kd-menu .kd-ref-foot{border-top:1px solid var(--interface-stroke,#3a3a44);margin-top:4px;}
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

async function apiAbs(url, body) {
  const r = await fetch(url, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  if (!r.ok) {
    let msg = "HTTP " + r.status;
    try { const d = await r.json(); if (d && d.error) msg = d.error; } catch (_) { /* 非 JSON */ }
    throw new Error(msg);
  }
  return r.json();
}

async function api(path, body) {
  return apiAbs(API + path, body);
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
// 图片排列存在词库目录（<vault>/.kedou/image_sets.json），词库面板里单独一组展示。
const SETS_API = "/ps/image-sets";
const SETS_GROUP = "__sets";
let setsCache = null;
let setsStamp = 0;
async function setsLib(force) {
  if (force || !setsCache || Date.now() - setsStamp > 30000) {
    setsCache = await apiAbs(SETS_API);
    setsStamp = Date.now();
  }
  return setsCache;
}
function libInvalidate() { libCache = phraseCache = histCache = setsCache = null; }
// 图片加载器上的「排列」菜单增删后，词库面板里的同一份记录要跟着更新
window.addEventListener("kedou:sets-changed", () => {
  setsCache = null;
  if (libPanel && libTab === "phrases" && libState.phraseGroup === SETS_GROUP && libRefresh) {
    libRefresh();
  }
});

// ───────── 库面板：语库 / 词库 / 历史 三个入口都在节点上，面板内部不再分标签页 ─────────
let libPanel = null;
let libOwner = null;   // 哪个节点打开的
let libTab = "prompts";
let libSession = 0;    // 关掉再开：旧请求回来不能画到新面板上
let libReposition = null;   // 窗口尺寸变化时重新贴到节点旁边
const libState = {
  editId: null,            // 语库就地编辑
  phraseEditId: null,      // 词库编辑
  setEditId: null,         // 图片排列就地重命名
  phraseFormOpen: false,   // 词库新建
  phraseInit: false,       // 只在第一次拿到数据时选默认分类
  phraseGroup: "",         // ""=全部 / "__fav"=收藏 / 顶层分组名
  phraseCat: "",           // 词库二级分类
  promptCat: "",           // 语库分类（与用途叠加筛选）
  q: { prompts: "", phrases: "", history: "" },
  clearArmed: 0,
};
let libData = { prompts: [], phrases: [], history: [], groups: [], categories: [], promptCategories: [], sets: [] };
let libErrors = { prompts: "", phrases: "", history: "", sets: "" };
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
        category: isHistory ? (libState.promptCat || "")
          : ((entry.category && entry.category !== "未分类") ? entry.category : (libState.promptCat || "")),
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

// 就地编辑（行内展开：短名 / 分类 / 正文 / 负面 / 用途勾选 / 保存）
function renderRowEdit(row, entry, onSaved) {
  const box = document.createElement("div");
  box.className = "kd-edit";
  box.innerHTML = `
    <div class="kd-form-row">
      <input data-f="name" value="${esc(entry.name)}" placeholder="${t("Short name")}">
      <input data-f="category" value="${esc(entry.category || "")}" placeholder="${t("Category (optional)")}">
    </div>
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
      category: g("category").value.trim(),
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
  const group = entry ? entry.group
    : (libState.phraseGroup && libState.phraseGroup !== "__fav" ? libState.phraseGroup : "");
  const cat = entry ? entry.category : (group ? libState.phraseCat : "");
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
    } else if (group) {
      body.group = group;
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
  libState.setEditId = null;
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
      <button class="kd-pbox-btn kd-plib-newcat">＋ ${t("New category")}</button>
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
  const newCatBtn = libPanel.querySelector(".kd-plib-newcat");
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
    newBtn.hidden = libTab !== "phrases" || libState.phraseGroup === SETS_GROUP;
    const catIn = libPanel.querySelector(".kd-cat-input");
    if (catIn && catIn.dataset.kdCatTab !== libTab) catIn.remove();
    newCatBtn.hidden = libTab === "history" || libState.phraseGroup === SETS_GROUP
      || !!libPanel.querySelector(".kd-cat-input");
    clearBtn.hidden = libTab !== "history";
    qEl.placeholder = libTab === "phrases"
      ? (libState.phraseGroup === SETS_GROUP ? t("Search arrangements…") : t("Search tags…"))
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
  newCatBtn.onclick = () => {
    const scope = libTab === "phrases" ? "phrases" : "prompts";
    const group = scope === "phrases" && libState.phraseGroup && libState.phraseGroup !== "__fav"
      ? libState.phraseGroup : "";
    addCategoryInline(libPanel.querySelector(".kd-plib-tools"), newCatBtn, scope, group);
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
          libData.promptCategories = d.categories || [];
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
          const d = await setsLib(force);
          libData.sets = d.items || [];
          libErrors.sets = "";
        } catch (e) {
          libErrors.sets = serverError(e.message);
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
    if (libTab === "phrases" || libTab === "prompts") paintCats();
    else { catsEl.hidden = true; subcatsEl.hidden = true; }
    paintBody();
    tipEl.textContent = libTab === "phrases"
      ? (libState.phraseGroup === SETS_GROUP
        ? t("Click an arrangement to load it into the image loader · right-click to rename or delete")
        : t("Click a tag to insert · click again to remove · right-click to edit"))
      : libTab === "history"
        ? t("Prompts you run land here automatically · right-click to delete")
        : t("Click to insert · click again to remove · right-click for more");
  }

  // 分类输入：就地变成一个小输入框，Enter 保存、Esc 取消、点外面按输入内容提交
  function addCategoryInline(container, btn, scope, group) {
    btn.hidden = true;
    const input = document.createElement("input");
    input.className = "kd-cat-input";
    input.placeholder = t("Category name");
    input.maxLength = 60;
    input.dataset.kdCatTab = scope === "prompts" ? "prompts" : "phrases";
    container.appendChild(input);
    input.focus();
    let done = false, busy = false;
    const finish = () => {
      if (done) return;
      done = true;
      input.remove();
      btn.hidden = false;
    };
    const commit = async () => {
      if (busy || done) return;
      const name = input.value.trim();
      if (!name) { finish(); return; }
      busy = true;
      try {
        const r = await api("/categories", { scope, name, group: group || "" });
        if (!r.ok) {
          toast(t("Save failed: {error}", { error: serverError(r.error) }), true);
          busy = false;
          try { input.focus(); } catch (_) { /* ignore */ }
          return;
        }
        finish();
        if (scope === "prompts") {
          libState.q.prompts = "";
          libState.promptCat = name;
        } else {
          libState.q.phrases = "";
          libState.phraseInit = true;
          libState.phraseGroup = r.group || group || "我的词";
          libState.phraseCat = name;
        }
        toast(t("Category created: {name}", { name }));
        refresh();
      } catch (e) {
        toast(t("Save failed: {error}", { error: serverError(e.message) }), true);
        busy = false;
        try { input.focus(); } catch (_) { /* ignore */ }
      }
    };
    input.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") finish();
    };
    input.onblur = () => { if (!done && !busy) commit(); };
    input.onpointerdown = (e) => e.stopPropagation();
    input.onclick = (e) => e.stopPropagation();
  }
  function paintCats() {
    catsEl.innerHTML = "";
    subcatsEl.innerHTML = "";
    const qkey = libTab === "phrases" ? "phrases" : "prompts";
    if ((libState.q[qkey] || "").trim()) {
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

    if (libTab === "prompts") {
      subcatsEl.hidden = true;
      add(t("All categories"), !libState.promptCat, () => {
        libState.promptCat = ""; paint();
      });
      (libData.promptCategories || []).forEach((c) => add(c, libState.promptCat === c, () => {
        libState.promptCat = c; paint();
      }));
      return;
    }

    add(t("All"), libState.phraseGroup === "", () => {
      libState.phraseGroup = ""; libState.phraseCat = ""; paint();
    });
    add(t("Favorites"), libState.phraseGroup === "__fav", () => {
      libState.phraseGroup = "__fav"; libState.phraseCat = ""; paint();
    });
    const setsN = (libData.sets || []).length;
    add(t("Image arrangements") + (setsN ? ` (${setsN})` : ""),
      libState.phraseGroup === SETS_GROUP, () => {
        libState.phraseGroup = SETS_GROUP;
        libState.phraseCat = "";
        paint();
      });
    (libData.groups || []).forEach((g) => add(g, libState.phraseGroup === g, () => {
      libState.phraseGroup = g;
      const cats = libData.categories.filter((c) => c.group === g);
      libState.phraseCat = cats.length ? cats[0].name : "";
      paint();
    }));

    if (libState.phraseGroup === SETS_GROUP) {
      subcatsEl.hidden = true;
      return;
    }
    const group = libState.phraseGroup && libState.phraseGroup !== "__fav"
      ? libState.phraseGroup : "";
    subcatsEl.hidden = !group;
    if (!group) return;
    const cats = libData.categories.filter((c) => c.group === group).map((c) => c.name);
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
    else if (libTab === "phrases") {
      if (libState.phraseGroup === SETS_GROUP) paintSets();
      else paintPhrases();
    } else paintHistory();
  }

  function paintPrompts() {
    const use = pb.useSel.value;
    const q = (libState.q.prompts || "").trim().toLowerCase();
    const all = (libData.prompts || []).filter((e) => (e.use_for || []).indexOf(use) !== -1);
    const pool = libState.promptCat
      ? all.filter((e) => (e.category || "") === libState.promptCat) : all;
    const rows = pool.filter((e) => match(e, q));
    if (!all.length && !q) {
      empty(t('No prompts for "{usage}" yet — write one and hit "Save"', { usage: usageLabel(use) }), true);
      return;
    }
    if (!rows.length) {
      empty(libState.promptCat ? t("No prompts in this category yet") : t("Nothing matches this filter"));
      return;
    }
    const grid = document.createElement("div");
    grid.className = "kd-lib-grid";
    rows.forEach((e) => {
      const row = document.createElement("div");
      row.className = "kd-row" + (insText(pb.ta, e) ? " kd-used" : "");
      row.dataset.id = e.id;
      row.title = (e.positive || e.negative || "").slice(0, 400);
      row.innerHTML = `
        <div class="kd-row-name">${e.pinned ? '<span class="kd-star">★</span>' : ""}<span class="kd-name-t">${esc(e.name)}</span>
          ${e.category ? `<span class="kd-badge kd-cat-badge">${esc(e.category)}</span>` : ""}
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

  // ---- 图片排列（与图片加载器上的「排列」是同一份数据，存在词库目录里） ----
  function setThumbStrip(imgs) {
    const strip = document.createElement("div");
    strip.className = "kd-set-thumbs";
    imgs.slice(0, 6).forEach((name) => {
      const box = document.createElement("span");
      box.className = "kd-set-thumb";
      box.title = name;
      const img = document.createElement("img");
      img.loading = "eager";
      img.draggable = false;
      img.alt = String(name).split(/[\\/]/).pop();
      img.src = refThumbUrl(name, 64, "input");
      img.onerror = () => {
        if (img.dataset.tried !== "output") {
          img.dataset.tried = "output";
          img.src = refThumbUrl(name, 64, "output");
          return;
        }
        img.remove();
        box.textContent = "?";
        box.classList.add("kd-bad");
      };
      box.appendChild(img);
      strip.appendChild(box);
    });
    if (imgs.length > 6) {
      const more = document.createElement("span");
      more.className = "kd-set-more";
      more.textContent = "+" + (imgs.length - 6);
      strip.appendChild(more);
    }
    return strip;
  }

  async function loadSetInto(node, set) {
    try {
      const r = await apiAbs(SETS_API + "/load", { id: set.id });
      if (!r.ok) {
        toast(t("Load failed: {error}", { error: serverError(r.error) }), true);
        return;
      }
      const found = r.found || [];
      if (!found.length) {
        toast(t("No images in this arrangement are still available"), true);
        return;
      }
      // 状态写入交给 kedou_media.js：它知道怎么同步输出槽和重绘面板
      try {
        window.dispatchEvent(new CustomEvent("kedou:media-apply", { detail: {
          nodeId: node.id,
          images: found.map((f) => f.filename),
          batch: !!r.item.batch,
          select: !!r.item.select,
          picked: r.item.picked || [],
        } }));
      } catch (_) { /* 事件失败也要提示，至少状态已由后端确认 */ }
      let msg = t("Arrangement loaded: {name} ({n} images)",
        { name: r.item.name || t("(unnamed)"), n: found.length });
      const missing = r.missing || [];
      if (missing.length) {
        msg += " · " + t("Missing {n}: {names}", {
          n: missing.length,
          names: missing.slice(0, 3).join(", ") + (missing.length > 3 ? "…" : ""),
        });
      }
      toast(msg, missing.length > 0);
    } catch (e) {
      toast(t("Load failed: {error}", { error: serverError(e.message) }), true);
    }
  }

  // 画布上有多个加载器时先问一句，避免把排列盖到错误的节点上
  function openLoaderPicker(set, loaders, anchorEl) {
    closeMenu();
    menuEl = document.createElement("div");
    menuEl.className = "kd-menu";
    const title = document.createElement("div");
    title.className = "kd-menu-title";
    title.textContent = t("Apply to which image loader?");
    menuEl.appendChild(title);
    loaders.forEach((n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = (n.title || t("Image loader")) + " · " +
        t("{n} images", { n: loaderImageList(n).length });
      b.onclick = () => {
        closeMenu();
        loadSetInto(n, set);
      };
      menuEl.appendChild(b);
    });
    document.body.appendChild(menuEl);
    const r = anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect()
      : { left: 40, top: 40, bottom: 70 };
    menuEl.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 230)) + "px";
    const mh = Math.min(menuEl.offsetHeight || 170, window.innerHeight - 12);
    menuEl.style.top = (r.bottom + mh + 6 <= window.innerHeight)
      ? (r.bottom + 4) + "px"
      : Math.max(6, r.top - mh - 4) + "px";
    void menuEl.offsetWidth;
    menuEl.classList.add("kd-in");
  }

  function applySet(set, row) {
    const loaders = imageLoaderNodes();
    if (!loaders.length) {
      toast(t("No image loader on the canvas. Add a Kedou Image Loader first."), true);
      return;
    }
    if (loaders.length === 1) {
      loadSetInto(loaders[0], set);
      return;
    }
    openLoaderPicker(set, loaders, row);
  }

  function renderSetEdit(row, entry, onSaved) {
    const box = document.createElement("div");
    box.className = "kd-edit";
    box.innerHTML = `
      <div class="kd-form-row">
        <input data-f="name" value="${esc(entry.name || "")}" placeholder="${t("Name this arrangement (optional)")}">
      </div>
      <div class="kd-edit-acts">
        <button class="kd-pbox-btn kd-main" data-a="save">${t("Save")}</button>
        <button class="kd-pbox-btn" data-a="cancel">${t("Cancel")}</button>
      </div>`;
    box.addEventListener("pointerdown", (e) => e.stopPropagation());
    box.addEventListener("click", (e) => e.stopPropagation());
    box.querySelector("[data-a=cancel]").onclick = () => { libState.setEditId = null; onSaved(); };
    box.querySelector("[data-a=save]").onclick = async () => {
      const name = box.querySelector("[data-f=name]").value.trim();
      if (!name) { toast(t("Name cannot be empty"), true); return; }
      try {
        const r = await apiAbs(SETS_API + "/rename", { id: entry.id, name });
        if (!r.ok) { toast(t("Save failed: {error}", { error: serverError(r.error) }), true); return; }
        setsCache = null;
        libState.setEditId = null;
        toast(t("Renamed to “{name}”", { name }));
        onSaved();
      } catch (e) {
        toast(t("Save failed: {error}", { error: serverError(e.message) }), true);
      }
    };
    row.appendChild(box);
    const input = box.querySelector("[data-f=name]");
    input.focus();
    input.select();
    input.onkeydown = (e) => {
      e.stopPropagation();             // Escape 只退出重命名，不要把整个词库面板一起关掉
      if (e.key === "Enter") { e.preventDefault(); box.querySelector("[data-a=save]").click(); }
      else if (e.key === "Escape") box.querySelector("[data-a=cancel]").click();
    };
  }

  function openSetMenu(x, y, entry, onChanged) {
    closeMenu();
    menuEl = document.createElement("div");
    menuEl.className = "kd-menu";
    menuEl.innerHTML = `
      <button data-a="rename">✎ ${t("Rename")}</button>
      <button data-a="del">🗑 ${t("Delete")}</button>`;
    menuEl.style.left = Math.max(6, Math.min(x, window.innerWidth - 170)) + "px";
    menuEl.style.top = Math.max(6, Math.min(y, window.innerHeight - 100)) + "px";
    document.body.appendChild(menuEl);
    void menuEl.offsetWidth;
    menuEl.classList.add("kd-in");
    menuEl.querySelector("[data-a=rename]").onclick = () => {
      closeMenu();
      libState.setEditId = entry.id;
      if (libRepaint) libRepaint();
    };
    const del = menuEl.querySelector("[data-a=del]");
    del.onclick = async () => {
      if (!del.classList.contains("kd-armed")) {
        del.classList.add("kd-armed");
        del.textContent = t("Confirm delete?");
        return;
      }
      closeMenu();
      try {
        const r = await apiAbs(SETS_API + "/delete", { id: entry.id });
        if (!r.ok) { toast(t("Delete failed: {error}", { error: serverError(r.error) }), true); return; }
        setsCache = null;
        if (libState.setEditId === entry.id) libState.setEditId = null;
        toast(t("Deleted"));
        onChanged();
      } catch (e) {
        toast(t("Delete failed: {error}", { error: serverError(e.message) }), true);
      }
    };
  }

  function setRow(e) {
    const imgs = Array.isArray(e.images) ? e.images : [];
    const row = document.createElement("div");
    row.className = "kd-row kd-set-row";
    row.dataset.id = e.id;
    row.title = imgs.join("\n");

    const head = document.createElement("div");
    head.className = "kd-row-name";
    const ico = document.createElement("span");
    ico.className = "kd-set-ico";
    ico.textContent = "▦";
    const nm = document.createElement("span");
    nm.className = "kd-name-t";
    nm.textContent = e.name || t("(unnamed)");
    const badge = document.createElement("span");
    badge.className = "kd-badge";
    const flags = [t("{n} images", { n: imgs.length })];
    if (e.batch) flags.push(t("Batch"));
    if (e.select) flags.push(t("Select"));
    badge.textContent = flags.join(" · ");
    head.append(ico, nm, badge);
    row.appendChild(head);
    if (imgs.length) row.appendChild(setThumbStrip(imgs));

    const prev = document.createElement("div");
    prev.className = "kd-row-prev";
    prev.textContent = imgs.slice(0, 4).join(" · ") + (imgs.length > 4 ? " …" : "");
    row.appendChild(prev);

    row.onclick = () => {
      if (libState.setEditId === e.id) return;
      applySet(e, row);
    };
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openSetMenu(ev.clientX, ev.clientY, e, refresh);
    };
    if (libState.setEditId === e.id) renderSetEdit(row, e, refresh);
    return row;
  }

  function paintSets() {
    const q = (libState.q.phrases || "").trim().toLowerCase();
    const all = libData.sets || [];
    if (!all.length) {
      if (libErrors.sets) {
        empty(t("Failed to load: {error}", { error: libErrors.sets }));
        return;
      }
      empty(q ? t("Nothing matches this filter")
        : t('No image arrangements yet — save one with the "Sets" button on an image loader'));
      return;
    }
    const rows = all.filter((e) => {
      if (!q) return true;
      return String(e.name || "").toLowerCase().includes(q)
        || (e.images || []).some((n) => String(n).toLowerCase().includes(q));
    });
    if (!rows.length) {
      empty(t("Nothing matches this filter"));
      return;
    }
    const grid = document.createElement("div");
    grid.className = "kd-lib-grid";
    rows.forEach((e) => grid.appendChild(setRow(e)));
    listEl.appendChild(grid);
  }

  function histMetaHtml(e, group) {    const total = group.reduce((sum, x) => sum + (Number(x.uses) || 0), 0);
    const uses = group.length > 1
      ? t("{n} versions", { n: group.length }) + " · " + t("{n} uses", { n: total })
      : t("{n} uses", { n: total });
    const when = historyWhen(e.updated || e.created);
    return `<span class="kd-hist-meta" title="${esc(String(e.updated || e.created || "").slice(0, 16))}">
      <span class="kd-hist-uses">${uses}</span>
      ${when ? `<span class="kd-hist-when">${esc(when)}</span>` : ""}
    </span>`;
  }

  // 一组迭代只占一张卡：主行是最新版本，旧版本点开后才展开
  function renderHistGroup(group) {
    const latest = group[group.length - 1];
    const grouped = group.length > 1;
    const row = document.createElement("div");
    row.className = "kd-row kd-hist-row" + (insText(pb.ta, latest) ? " kd-used" : "");
    row.dataset.id = latest.id;
    // 只显示正文一行；名字就是正文前 20 字，再单独放一遍只会重复
    row.innerHTML = `
      <div class="kd-row-head">
        ${grouped ? `<button type="button" class="kd-hist-fold" title="${t("Toggle versions")}">▸</button>` : ""}
        <span class="kd-hist-text">${esc(latest.positive || latest.name || "")}</span>
        ${histMetaHtml(latest, group)}
      </div>`;
    bindToggle(row, latest, "history");
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openRowMenu(ev.clientX, ev.clientY, latest, "history", refresh);
    };
    if (grouped) {
      const box = document.createElement("div");
      box.className = "kd-hist-versions";
      box.hidden = true;
      group.slice(0, -1).forEach((v, idx) => {
        const vr = document.createElement("div");
        vr.className = "kd-hist-ver" + (insText(pb.ta, v) ? " kd-used" : "");
        vr.title = v.positive || "";
        vr.innerHTML = `
          <span class="kd-hist-vtag">v${idx + 1}</span>
          <span class="kd-hist-ver-text">${esc(v.positive || v.name || "")}</span>
          <span class="kd-hist-ver-meta">${t("{n} uses", { n: v.uses || 0 })}${v.updated ? " · " + esc(historyDayLabel(v.updated)) : ""}</span>`;
        bindToggle(vr, v, "history");
        vr.oncontextmenu = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openRowMenu(ev.clientX, ev.clientY, v, "history", refresh);
        };
        box.appendChild(vr);
      });
      const fold = row.querySelector(".kd-hist-fold");
      fold.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        box.hidden = !box.hidden;
        fold.textContent = box.hidden ? "▸" : "▾";
      };
      fold.onpointerdown = (ev) => ev.stopPropagation();
      row.appendChild(box);
    }
    return row;
  }

  function paintHistory() {
    const use = pb.useSel.value;
    const q = (libState.q.history || "").trim().toLowerCase();
    const pool = (libData.history || []).filter((e) => (e.use_for || []).indexOf(use) !== -1);
    if (!pool.length) {
      empty(t("No history for this usage yet — prompts you run land here automatically"), true);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "kd-lib-grid";
    if (q) {
      // 搜索时保持平铺：要精确看到哪一条命中，不把结果藏进折叠组
      const rows = pool.filter((e) => match(e, q));
      if (!rows.length) { empty(t("Nothing matches this filter")); return; }
      rows.forEach((e) => grid.appendChild(renderHistGroup([e])));
    } else {
      groupHistory(pool).forEach((g) => grid.appendChild(renderHistGroup(g)));
    }
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
  libState.setEditId = null;
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

// ───────── 参考图插入：读画布上的 KedouImageLoader，不依赖连线 ─────────
function imageLoaderNodes() {
  const nodes = (app.graph && app.graph._nodes) || [];
  return nodes.filter((n) => {
    if (!n || n.mode !== 0) return false;                       // 跳过静音/旁路节点
    const cls = (n.constructor && n.constructor.comfyClass) || n.comfyClass || n.type || "";
    return cls === "KedouImageLoader";
  });
}

// 与 kedou_media.js 的 effectiveImages 保持一致：选择模式有选中项时，输出顺序就是选中顺序。
function loaderImageList(node) {
  const w = (node.widgets || []).find((x) => x.name === "media_state");
  let st = null;
  try { st = JSON.parse(String(w ? w.value == null ? "" : w.value : "")); } catch (_) { st = null; }
  let list = st && Array.isArray(st.images) ? st.images : [];
  list = list
    .map((it) => (it && typeof it === "object" ? it : { filename: it }))
    .filter((it) => it && typeof it.filename === "string" && it.filename.trim());
  const picked = st && Array.isArray(st.picked) ? st.picked : [];
  if (st && st.select && picked.length) {
    const map = new Map(list.map((it) => [it.filename, it]));
    const ordered = picked.filter((f) => map.has(f)).map((f) => map.get(f));
    if (ordered.length) list = ordered;
  }
  return list;
}

// 从提示词里找出所有已知写法的图片编号；长 token 优先，避免 "@Image 1" 又被 "Image 1" 匹配一次。
function parseRefTokens(text) {
  const src = String(text || "");
  const found = [];
  for (const style of REF_STYLES) {
    const re = new RegExp(style.re.source, "g");
    let m;
    while ((m = re.exec(src))) {
      const n = Number(m[1]) || 0;
      if (n > 0) found.push({ n, token: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const picked = [];
  for (const f of found) {
    if (picked.some((x) => f.start < x.end && f.end > x.start)) continue;   // 被更长的 token 包住
    picked.push(f);
  }
  // 同一张图多处引用只占一个缩略图位，保留第一次出现的位置
  const seen = new Set();
  return picked.filter((f) => {
    if (seen.has(f.n)) return false;
    seen.add(f.n);
    return true;
  }).sort((a, b) => a.start - b.start);
}

// 编号 -> 图片加载器里的第 N 张（与菜单/输出槽同一套顺序）。多个加载器时返回所有命中。
function resolveRefImages(n, loaders) {
  const hits = [];
  for (const node of loaders) {
    const item = loaderImageList(node)[n - 1];
    if (item) hits.push({ node, item });
  }
  return hits;
}

function refThumbUrl(filename, w, tab) {
  const raw = String(filename || "").replace(/\\/g, "/");
  const i = raw.lastIndexOf("/");
  const name = i >= 0 ? raw.slice(i + 1) : raw;
  const sub = i >= 0 ? raw.slice(0, i) : "";
  // mode=raw：要原比例、不补边的图。后端默认出的是「补边成正方形」的版本（PS 面板要），
  // 那张图喂给这里的 object-fit:cover 会失效、缩略图四周多出一圈底色边。
  return "/ps/thumb?" + new URLSearchParams(
    { filename: name, subfolder: sub, type: tab || "input", w: String(w || 64), mode: "raw" }).toString();
}

// 切写法时把已写入的旧 token 全部换成新写法（只认本写法自己的模式，不动别的文字）。
function rewriteRefTokens(ta, oldId, newId) {
  const old = refStyle(oldId);
  if (!old.re || oldId === newId) return 0;
  let n = 0;
  ta.value = ta.value.replace(old.re, (m, digits) => {
    const next = refToken(newId, digits);
    if (next === m) return m;
    n += 1;
    return next;
  });
  return n;
}

// @ 菜单：按当前写法列出所有图片加载器里的图；编号 = 输出槽顺序。
function openRefMenu(ta, sync, triggerAt, styleId) {
  closeMenu();
  styleId = REF_STYLES.some((s) => s.id === styleId) ? styleId : loadRefStyleId();
  const m = document.createElement("div");
  m.className = "kd-menu kd-ref-menu";

  const title = document.createElement("div");
  title.className = "kd-menu-title";
  title.textContent = t("Insert image reference · {style}", { style: refStyle(styleId).label });
  m.appendChild(title);

  const loaders = imageLoaderNodes();
  loaders.forEach((node) => {
    const list = loaderImageList(node);
    const head = document.createElement("div");
    head.className = "kd-ref-group";
    head.textContent = loaders.length > 1 ? (node.title || t("Image loader")) : t("Images");
    m.appendChild(head);
    if (!list.length) {
      const hint = document.createElement("div");
      hint.className = "kd-ref-hint";
      hint.textContent = t("No images in this loader yet");
      m.appendChild(hint);
      return;
    }
    list.forEach((it, i) => {
      const n = i + 1;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kd-ref-item";
      const token = refToken(styleId, n);
      const file = String(it.filename || "").split(/[\\/]/).pop();
      // 缩略图直接给“选哪张”一个视觉答案；input 找不到再退 output，都不行就留 ?
      const thumb = document.createElement("span");
      thumb.className = "kd-ref-thumb";
      thumb.textContent = "?";
      const img = document.createElement("img");
      img.loading = "eager";
      img.draggable = false;
      img.alt = file;
      img.src = refThumbUrl(it.filename, 56, "input");
      img.onerror = () => {
        if (img.dataset.tried !== "output") {
          img.dataset.tried = "output";
          img.src = refThumbUrl(it.filename, 56, "output");
          return;
        }
        img.remove();
        thumb.classList.add("kd-bad");
      };
      thumb.appendChild(img);
      const tokenEl = document.createElement("span");
      tokenEl.className = "kd-ref-token";
      tokenEl.textContent = token;
      const fileEl = document.createElement("span");
      fileEl.className = "kd-ref-file";
      fileEl.textContent = file;
      b.append(thumb, tokenEl, fileEl);
      b.title = t("Slot {n}: {name}", { n, name: it.filename });
      b.onclick = () => {
        closeMenu();
        const tok = insertRefToken(ta, sync, styleId, n, triggerAt);
        if (tok) toast(t("Inserted {token}", { token: tok }));
      };
      m.appendChild(b);
    });
  });

  if (!loaders.length) {
    const hint = document.createElement("div");
    hint.className = "kd-ref-hint";
    hint.textContent = t("No image loader on the canvas. Add a Kedou Image Loader first.");
    m.appendChild(hint);
  }
  const foot = document.createElement("div");
  foot.className = "kd-ref-hint kd-ref-foot";
  foot.textContent = loaders.length > 1
    ? t("Multiple loaders: numbers restart from 1 in each. Make sure the model receives images in the same order.")
    : t("Numbering follows the loader's output slots. Wire images to the model in the same order.");
  m.appendChild(foot);

  menuEl = m;
  document.body.appendChild(m);
  // 先量再定位：贴输入框左下/左上，避免超出视口
  const r = ta.getBoundingClientRect();
  const mw = m.offsetWidth || 260;
  const mh = Math.min(m.offsetHeight || 240, Math.round((window.innerHeight || 800) * 0.72));
  const left = Math.max(6, Math.min(r.left + 6, (window.innerWidth || 1280) - mw - 6));
  const top = (r.bottom + 6 + mh <= (window.innerHeight || 800))
    ? r.bottom + 6
    : Math.max(6, r.top - mh - 6);
  m.style.left = left + "px";
  m.style.top = top + "px";
  void m.offsetWidth;
  m.classList.add("kd-in");
}

function insertRefToken(ta, sync, styleId, n, triggerAt) {
  const tok = refToken(styleId, n);
  if (!tok) return "";
  const st = typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length;
  const en = typeof ta.selectionEnd === "number" ? ta.selectionEnd : st;
  // 输入 @ 触发时，把那个 @ 本身替换掉；点按钮触发时按当前光标/选区插入
  const start = (typeof triggerAt === "number" && triggerAt >= 0) ? triggerAt : st;
  const end = (typeof triggerAt === "number" && triggerAt >= 0) ? triggerAt + 1 : en;
  const after = ta.value.slice(end);
  const suffix = (after && !isSepChar(after[0])) ? " " : "";
  const text = tok + suffix;
  if (typeof ta.setRangeText === "function") {
    ta.setRangeText(text, start, end, "end");
  } else {
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  }
  try { ta.focus(); ta.setSelectionRange(start + text.length, start + text.length); } catch (_) { /* ignore */ }
  sync();
  try { ta.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) { /* ignore */ }
  return tok;
}

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
    updateRefRow();
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

  // 参考图写法：各模型 token 不同，写错等于没引用。下拉只影响“插入什么”，
  // 图片仍要按编号顺序接到模型；切换写法会把已写入的同格式 token 一起改掉。
  const refRow = document.createElement("div");
  refRow.className = "kd-pbox-refrow";
  const refLab = document.createElement("span");
  refLab.className = "kd-pbox-reflab";
  refLab.textContent = t("Reference");
  const refSel = document.createElement("select");
  refSel.className = "kd-pbox-use kd-pbox-ref";
  refSel.title = t('Reference syntax. The tag is inserted when you type @ or click "@ Image".');
  REF_STYLES.forEach((s) => {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.label;
    refSel.appendChild(o);
  });
  refSel.value = loadRefStyleId();
  refSel.__kdPrev = refSel.value;
  refSel.onpointerdown = (e) => e.stopPropagation();
  refSel.onchange = () => {
    const oldId = refSel.__kdPrev || refSel.value;
    const newId = refSel.value;
    refSel.__kdPrev = newId;
    saveRefStyleId(newId);
    const n = rewriteRefTokens(ta, oldId, newId);
    if (n) {
      sync();
      toast(t("Updated {n} reference tag(s)", { n }));
    }
    paintRefThumbs(true);
  };
  const atBtn = document.createElement("button");
  atBtn.type = "button"; atBtn.className = "kd-pbox-btn";
  atBtn.textContent = t("@ Image");
  atBtn.title = t("Insert a reference to an image from the image loader");
  atBtn.onpointerdown = (e) => e.stopPropagation();
  atBtn.onclick = (ev) => { ev.stopPropagation(); openRefMenu(ta, sync, null, refSel.value); };
  refRow.append(refLab, refSel, atBtn);

  // @图片 对图生视频/参考生视频有意义（首帧、参考图都要点名）：其它用途整行隐藏，输入 @ 也不弹菜单。
  function updateRefRow() {
    const on = useSel.value === "参考生视频" || useSel.value === "图生视频";
    refRow.hidden = !on;
    if (!on && menuEl && menuEl.classList.contains("kd-ref-menu")) closeMenu();
    paintRefThumbs(true);
  }

  const ta = document.createElement("textarea");
  ta.className = "kd-pbox-ta";
  ta.placeholder = t('Enter a prompt… open "Prompts" to insert / "Save" to store under the current usage');
  ta.value = String(pw.value || "");

  // 每次现从 node.widgets 里找，不用闭包里那个 pw：
  // ComfyUI 有几个时机（重建控件、把控件转成输入再转回来、节点定义重载）
  // 会把 widgets 里的对象整个换掉，闭包里的老引用就成了孤儿 ——
  // 往里写值不报错、界面照常显示，但提交时读到的是新对象，值是空。
  // 表现就是「输入框里明明有字，跑出来却是空」。
  function pwNow() {
    const w = (node.widgets || []).find((x) => x && x.name === "prompt_state");
    return w || pw;
  }
  function sync() {
    const w = pwNow();
    if (!w) return;
    if (w.value !== ta.value) w.value = ta.value;
    try { node.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }
  }
  let usedT = null;
  ta.addEventListener("input", () => {
    sync();
    // 手动删掉已插入的文本后，高亮也要跟着灭；不重新请求，只重绘本地状态
    clearTimeout(usedT);
    usedT = setTimeout(() => {
      paintChips();
      paintRefThumbs();
      if (libOwner === node && libRepaint) libRepaint();
    }, 250);
  });
  // 输入 @ 立刻列出图片加载器里的图；继续输入别的字符就收掉菜单。
  ta.addEventListener("input", () => {
    if (useSel.value !== "参考生视频" && useSel.value !== "图生视频") return;
    const pos = typeof ta.selectionStart === "number" ? ta.selectionStart : 0;
    if (pos > 0 && ta.value.charAt(pos - 1) === "@") {
      openRefMenu(ta, sync, pos - 1, refSel.value);
    } else if (menuEl && menuEl.classList.contains("kd-ref-menu")) {
      closeMenu();
    }
  });
  ta.addEventListener("pointerdown", (e) => e.stopPropagation());
  ta.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  // 提示词里出现的引用编号 -> 小缩略图，确认 @ 的到底是哪张图。
  const refThumbs = document.createElement("div");
  refThumbs.className = "kd-pbox-refthumbs";
  refThumbs.hidden = true;
  card.append(top, refRow, ta, refThumbs);
  updateRefRow();

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

  // 提示词里的引用 token -> 缩略图。签名不变就不重建，避免每次按键都重新请求图片。
  function paintRefThumbs(force) {
    const on = useSel.value === "参考生视频" || useSel.value === "图生视频";
    const refs = on ? parseRefTokens(ta.value) : [];
    if (!on || !refs.length) {
      refThumbs.hidden = true;
      refThumbs.innerHTML = "";
      refThumbs.__sig = "";
      return;
    }
    const loaders = imageLoaderNodes();
    const sig = JSON.stringify([
      useSel.value,
      refs.map((r) => [r.n, r.token]),
      loaders.map((n) => String(n.id)),
    ]);
    if (!force && refThumbs.__sig === sig) return;
    refThumbs.__sig = sig;
    refThumbs.hidden = false;
    refThumbs.innerHTML = "";
    const multi = loaders.length > 1;
    refs.forEach((r) => {
      const hits = resolveRefImages(r.n, loaders);
      const hit = hits[0] || null;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kd-refthumb" + (hit ? "" : " kd-bad");
      const box = document.createElement("span");
      box.className = "kd-refthumb-img";
      box.textContent = "?";
      if (hit) {
        const img = document.createElement("img");
        img.loading = "eager";
        img.draggable = false;
        const name = String(hit.item.filename || "");
        img.alt = name.split(/[\\/]/).pop();
        img.src = refThumbUrl(name, 64, "input");
        img.onerror = () => {
          if (img.dataset.tried !== "output") {
            img.dataset.tried = "output";
            img.src = refThumbUrl(name, 64, "output");
            return;
          }
          img.remove();                         // input/output 都找不到：露出底下的 "?"
          b.classList.add("kd-bad");
        };
        box.appendChild(img);
      }
      const tag = document.createElement("span");
      tag.className = "kd-refthumb-tag";
      tag.textContent = r.token;
      b.append(box, tag);
      if (hit) {
        const where = hits.length > 1
          ? t(" (matches {n} loaders)", { n: hits.length })
          : (multi ? " · " + (hit.node.title || t("Image loader")) : "");
        b.title = t("Slot {n}: {name}", { n: r.n, name: hit.item.filename }) + where
          + "\n" + t("Click to locate this reference in the prompt");
      } else {
        b.title = t("Image {n} is missing from the loader. It may have been removed or reordered.", { n: r.n });
      }
      b.onclick = (ev) => {
        ev.stopPropagation();
        const at = ta.value.indexOf(r.token);
        if (at < 0) return;
        try {
          ta.focus();
          ta.setSelectionRange(at, at + r.token.length);
        } catch (_) { /* ignore */ }
      };
      refThumbs.appendChild(b);
    });
  }

  // 三个按钮各自打开面板的对应内容：再点当前那个就关，点另一个原地切换
  function togglePanel(tab) {
    if (libOwner === node && libPanel) {
      if (libTab === tab) { closeLib(); return; }
      libTab = tab;
      libState.editId = null;
      libState.phraseEditId = null;
      libState.setEditId = null;
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
        const r = await api("/save", { name: text.slice(0, 20), type: "精选", positive: text,
          category: libState.promptCat || "", usage: [useSel.value] });
        if (!r.ok) { toast(t("Save failed"), true); return; }
        libState.q.prompts = "";      // 保存后清掉搜索，刚存的那条一定看得见
        toast(r.deduped ? t("Already in the library")
          : (libState.promptCat
            ? t("Saved under {usage} · {category}", { usage: usageLabel(useSel.value), category: libState.promptCat })
            : t("Saved under {usage}", { usage: usageLabel(useSel.value) })));
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

  // serialize 必须设在控件对象上：addDOMWidget 的第 4 个参数是 options，
  // ComfyUI 只认 widget.serialize，写在 options 里不生效 ——
  // 不生效时自绘控件会跟着进 widgets_values，白占一格 ""。
  const domW = node.addDOMWidget("kedou_promptbox", "div", card, {
    getMinHeight: () => 240, hideOnZoom: false,
  });
  try { if (domW) domW.serialize = false; } catch (_) { /* ignore */ }
  node._kdCard = card;

  const prevCfg = node.onConfigure;
  node.onConfigure = function () {
    const r = typeof prevCfg === "function" ? prevCfg.apply(this, arguments) : undefined;
    setTimeout(() => {
      ta.value = String((pwNow() || {}).value || "");
      ta.__kdIns = null;          // 工作流切换/重载：旧的插入记录不再可信
      useSel.value = String((uw && uw.value) || USAGES[0]);
      refSel.value = loadRefStyleId();
      refSel.__kdPrev = refSel.value;
      updateRefRow();
      paintRefThumbs(true);
      paintChips();
    }, 0);
    return r;
  };

  const prevRemoved = node.onRemoved;
  node.onRemoved = function () {
    if (libOwner === node) closeLib(true);   // 节点被删了，旁边开着的面板也一起收掉
    return typeof prevRemoved === "function" ? prevRemoved.apply(this, arguments) : undefined;
  };

  node.__kdPbox = { ta, sync, pw, useSel, refSel, atBtn, paintChips, paintRefThumbs, libBtn, phraseBtn, histBtn };
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

// 提交前把所有提示词框的输入框内容强行写回控件。
// 输入框是自绘的（数据控件被 hidden），两者只靠 input 事件同步：
// 只要有一条输入路径没触发 input（或者控件对象被 ComfyUI 换过），
// 就会出现「界面上有字、提交上去是空」。这里在唯一出口兜一次，
// 保证「输入框里有字 = 提交的 prompt_state 有字」。
function syncAllPbox() {
  let fixed = 0;
  try {
    for (const n of ((app.graph && app.graph._nodes) || [])) {
      const p = n.__kdPbox;
      if (!p || !p.ta) continue;
      const w = (n.widgets || []).find((x) => x && x.name === "prompt_state");
      if (!w) continue;
      if (w.value !== p.ta.value) { w.value = p.ta.value; fixed += 1; }
    }
  } catch (_) { /* ignore */ }
  return fixed;
}

// 包住 graphToPrompt（执行前唯一一次「把画布变成 API 图」的出口）。
// 只挂在 app 实例上，不碰原型，别的扩展不受影响。
function hookSubmitSync(appObj) {
  try {
    if (!appObj || typeof appObj.graphToPrompt !== "function" || appObj.__kdSubmitSync) return false;
    const orig = appObj.graphToPrompt;
    appObj.graphToPrompt = async function () {
      const n = syncAllPbox();
      if (n) console.info("[kedou] 提交前补同步了 %d 个提示词框（界面有字、控件里是空的）", n);
      return orig.apply(this, arguments);
    };
    appObj.__kdSubmitSync = true;
    return true;
  } catch (_) {
    return false;
  }
}

// 图片加载器增删/换序/改选中后，提示词框里的缩略图跟着刷新
let refThumbT = null;
function refreshAllRefThumbs() {
  clearTimeout(refThumbT);
  refThumbT = setTimeout(() => {
    try {
      for (const n of ((app.graph && app.graph._nodes) || [])) {
        if (n.__kdPbox && n.__kdPbox.paintRefThumbs) n.__kdPbox.paintRefThumbs(true);
      }
    } catch (_) { /* ignore */ }
  }, 120);
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
    // 提交前兜底同步提示词框（见 hookSubmitSync 的说明）
    try { hookSubmitSync(app); } catch (_) { /* ignore */ }
    // 词库下拉列表 / 节点 chips 可重绘，接一下语言切换即时刷新；
    // 节点 widget 内部静态结构（<option>、按钮、标题）不接，下次建节点/重开面板生效。
    onLocaleChange(() => {
      try { if (libRepaint) libRepaint(); } catch (_) { /* ignore */ }
      try { refreshAllPbox(); } catch (_) { /* ignore */ }
      try { refreshAllRefThumbs(); } catch (_) { /* ignore */ }
    });
    // 图片加载器改图/换序/改选中时由 kedou_media.js 发事件，缩略图立刻跟上
    try { window.addEventListener("kedou:media-changed", refreshAllRefThumbs); } catch (_) { /* ignore */ }
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

(async function () {
  const A = window.__avTools || {};
  const host = document.getElementById("host");
  const out = document.getElementById("out");
  const results = [];
  const test = (name, actual, expected = true) => results.push({
    name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tapCell = (cell, shift = false) => {
    const down = new MouseEvent("mousedown", { button: 0, bubbles: true });
    if (shift) Object.defineProperty(down, "shiftKey", { value: true });
    cell.dispatchEvent(down);
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
  };
  const settleLayout = async () => { await sleep(0); await sleep(0); };
  const rounded = (value) => Math.round(value * 10) / 10;
  const measureCard = (node) => {
    const ui = node.__kdAVUI, card = ui.card, top = card.querySelector(".kav-top") || card.querySelector(".kd-top");
    const cr = card.getBoundingClientRect(), fr = card.querySelector(".kav-foot").getBoundingClientRect();
    const body = ui.body, list = ui.sections.video.list;
    return {
      viewport: [window.innerWidth, window.innerHeight], nodeSize: node.size.slice(),
      card: [rounded(cr.width), rounded(cr.height)], minHeight: getComputedStyle(card).minHeight,
      maxHeight: getComputedStyle(card).maxHeight,
      topWrap: getComputedStyle(top).flexWrap,
      topRows: new Set([...top.children].filter((el) => !el.hidden && el.getClientRects().length)
        .map((el) => rounded(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2))).size,
      slotHeights: ["video", "audio"].map((slot) => rounded(ui.sections[slot].box.getBoundingClientRect().height)),
      slotWidths: ["video", "audio"].map((slot) => rounded(ui.sections[slot].box.getBoundingClientRect().width)),
      slotLefts: ["video", "audio"].map((slot) => rounded(ui.sections[slot].box.getBoundingClientRect().left)),
      slotRights: ["video", "audio"].map((slot) => rounded(ui.sections[slot].box.getBoundingClientRect().right)),
      slotTops: ["video", "audio"].map((slot) => rounded(ui.sections[slot].box.getBoundingClientRect().top)),
      slotBottoms: ["video", "audio"].map((slot) => rounded(ui.sections[slot].box.getBoundingClientRect().bottom)),
      slotsGap: rounded(ui.sections.audio.box.getBoundingClientRect().left - ui.sections.video.box.getBoundingClientRect().right),
      slotsVGap: rounded(ui.sections.audio.box.getBoundingClientRect().top - ui.sections.video.box.getBoundingClientRect().bottom),
      clearHidden: ["video", "audio"].map((slot) => ui.sections[slot].clear.hidden),
      sameHidden: ["video", "audio"].map((slot) => ui.sections[slot].same.hidden),
      footGap: rounded(cr.bottom - fr.bottom), footFlexShrink: getComputedStyle(card.querySelector(".kav-foot")).flexShrink,
      body: [body.clientHeight, body.scrollHeight], bodyOverflowY: getComputedStyle(body).overflowY,
      list: { clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, items: list.childElementCount,
        maxHeight: getComputedStyle(list).maxHeight, overflowY: getComputedStyle(list).overflowY,
        columns: getComputedStyle(list).gridTemplateColumns.split(" ").length },
      lists: ["video", "audio"].map((slot) => {
        const el = ui.sections[slot].list;
        return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, overflowY: getComputedStyle(el).overflowY,
          maxHeight: getComputedStyle(el).maxHeight, items: el.childElementCount };
      }),
      cardOverflowX: card.scrollWidth - card.clientWidth, pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
    };
  };
  window.__avGeometry = {};
  const waitFor = async (fn, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn(); if (v) return v;
      await sleep(25);
    }
    return fn();
  };
  Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return this.__kdPaused !== false; } });
  Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get() { return this.__kdDuration || 10; } });
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { configurable: true, get() { return this.__kdTime || 0; }, set(v) { this.__kdTime = v; } });
  HTMLMediaElement.prototype.play = function () { this.__kdPaused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function () { this.__kdPaused = true; this.dispatchEvent(new Event("pause")); };
  const graphLinks = () => window.__app.graph.links;
  const getLink = (id) => graphLinks() instanceof Map ? graphLinks().get(id) : graphLinks()[id];
  const setLink = (id, link) => { if (graphLinks() instanceof Map) graphLinks().set(id, link); else graphLinks()[id] = link; };
  const deleteLink = (id) => { if (graphLinks() instanceof Map) graphLinks().delete(id); else delete graphLinks()[id]; };
  const linkIds = () => graphLinks() instanceof Map ? [...graphLinks().keys()] : Object.keys(graphLinks()).map(Number);
  class AVNode {
    constructor() {
      this.id = 801;
      this.comfyClass = "KedouAVLoader";
      this.size = [460, 520];
      this.sizeHistory = [];
      this.widgets = [{ name: "media_state", value: "{}", type: "string", options: {} }];
      this.inputs = [{ name: "media_state", type: "STRING", link: null }];
      this.outputs = [];
    }
    removeInput(index) { this.inputs.splice(index, 1); }
    setSize(s) {
      this.sizeHistory.push(s.slice()); this.size = s;
      if (this.domWrapper) this.domWrapper.style.height = s[1] + "px";
    }
    setDirtyCanvas() {}
    addDOMWidget(name, _type, el, options = {}) {
      const wrapper = document.createElement("div");
      wrapper.style.width = "100%"; wrapper.style.height = this.size[1] + "px";
      wrapper.appendChild(el); host.appendChild(wrapper); this.domWrapper = wrapper;
      this.widgets.push({ name, type: "div", value: "", serialize: false, options });
    }
    addOutput(name, type) {
      this.outputs.push({ name, type, links: [], draw() {}, drawCollapsed() {},
        toJSON() { return { name: this.name, type: this.type }; } });
    }
    removeOutput(i) { this.outputs.splice(i, 1); }
    disconnectOutput(i) {
      const o = this.outputs[i]; if (!o) return;
      for (const id of o.links || []) {
        const link = getLink(id);
        const target = link && window.__app.graph.getNodeById(link.target_id);
        if (target && target.inputs && target.inputs[link.target_slot]) target.inputs[link.target_slot].link = null;
        deleteLink(id);
      }
      o.links = [];
    }
    connect(index, target, targetSlot) {
      if (typeof this.onConnectOutput === "function" && this.onConnectOutput(index, { target_node: target, target_slot: targetSlot }) === false) return false;
      const port = this.outputs[index]; if (!port || !target.inputs || !target.inputs[targetSlot]) return false;
      const id = Math.max(0, ...linkIds()) + 1;
      port.links = port.links || []; port.links.push(id);
      target.inputs[targetSlot].link = id;
      setLink(id, { id, origin_id: this.id, origin_slot: index, target_id: target.id, target_slot: targetSlot, type: port.type });
      if (typeof this.onConnectionsChange === "function") this.onConnectionsChange("output", index);
      return true;
    }
  }
  const portKeys = (node) => node.outputs.map((o) => o.__kdAVKey || o.name);
  const connectKey = (node, key, target, targetSlot) => node.connect(
    node.outputs.findIndex((o) => (o.__kdAVKey || o.name) === key), target, targetSlot);
  const linkTargets = (node, key) => {
    const port = node.outputs.find((o) => (o.__kdAVKey || o.name) === key);
    return (port ? port.links || [] : []).map((id) => {
      const link = getLink(id); return link ? [link.target_id, link.target_slot] : null;
    }).filter(Boolean);
  };
  const noHiddenPorts = (node) => node.outputs.every((o) =>
    o.name === (o.__kdAVKey || o.name) && !!o.display_name && !("__kdHidden" in o) &&
    o.color_on !== "rgba(0,0,0,0)" && o.color_off !== "rgba(0,0,0,0)");
  const video = (name) => ({ id: "input|" + name, filename: name, tab: "input", kind: "video", extract_audio: false });
  const audio = (name) => ({ id: "input|" + name, filename: name, tab: "input", kind: "audio", extract_audio: false });
  try {
    const node = new AVNode();
    window.__app.graph._nodes = [node];
    A.build(node);
    test("media_state内部输入槽已移除", node.inputs.some((input) => input.name === "media_state"), false);
    const domWidget = node.widgets.find((w) => w.name === "kedou_av");
    test("DOM widget最小高度260且初始节点高度300", [domWidget.options.getMinHeight(), node.sizeHistory[0][1]], [260, 300]);
    await settleLayout();
    const ui = node.__kdAVUI;
    test("深色输入框使用固定浅色文字", getComputedStyle(ui.frameFields.max_frames).color, "rgb(238, 238, 238)");
    const emptyGeometry = measureCard(node);
    window.__avGeometry.empty = emptyGeometry;
    test("渲染两个多选列表", !!ui.sections.video.list && !!ui.sections.audio.list, true);
    const topChildren = [...ui.card.querySelector(".kav-top").children];
    test("顶部按图片加载器布局排列", [topChildren[0].tagName, topChildren[1].tagName,
      topChildren.indexOf(ui.batchCb.parentElement), topChildren.indexOf(ui.selectCb.parentElement),
      topChildren.indexOf(ui.videoAudioCb.parentElement), topChildren.indexOf(ui.videoMode.parentElement),
      ui.topCount.textContent], ["B", "EM", 2, 3, 4, 5, "0"]);
    test("空状态卡片高度等于节点高度且清空隐藏", [Math.abs(emptyGeometry.card[1] - node.size[1]) <= 1,
      node.size[0] >= 460, ui.sections.video.clear.hidden, ui.sections.audio.clear.hidden,
      emptyGeometry.minHeight, emptyGeometry.maxHeight], [true, true, true, true, "260px", "none"]);
    test("空状态两槽等宽等高且上下各占一半，视频在上", [Math.abs(emptyGeometry.slotWidths[0] - emptyGeometry.slotWidths[1]) <= 1,
      Math.abs(emptyGeometry.slotHeights[0] - emptyGeometry.slotHeights[1]) <= 1,
      emptyGeometry.slotBottoms[0] < emptyGeometry.slotTops[1], emptyGeometry.slotsVGap,
      Math.abs(emptyGeometry.slotWidths[0] -
        ui.sections.video.box.parentElement.getBoundingClientRect().width) <= 1,
      Math.abs(emptyGeometry.slotHeights[0] + emptyGeometry.slotHeights[1] + emptyGeometry.slotsVGap -
        ui.sections.video.box.parentElement.getBoundingClientRect().height) <= 1], [true, true, true, 8, true, true]);
    test("空素材槽提示保持紧凑且列表区域随灰框拉高", ["video", "audio"].every((slot) => {
      const list = ui.sections[slot].list, empty = list.firstElementChild;
      return list.children.length === 1 && empty.classList.contains("kav-empty") &&
        empty.scrollHeight <= empty.clientHeight + 1 && list.clientHeight >= empty.clientHeight;
    }), true);
    test("空状态列表不限高且可独立滚动", ["video", "audio"].map((slot) => {
      const style = getComputedStyle(ui.sections[slot].list); return [style.maxHeight, style.overflowY];
    }), [["none", "auto"], ["none", "auto"]]);
    test("空状态body不整体滚动", [emptyGeometry.bodyOverflowY, emptyGeometry.body[1] <= emptyGeometry.body[0] + 1],
      ["hidden", true]);
    node.setSize([460, 420]); ui.render(); await settleLayout();
    const grownGeometry = measureCard(node);
    window.__avGeometry.grown = grownGeometry;
    test("手动调高节点后卡片与灰框跟随", [node.size[1], grownGeometry.card[1],
      node.sizeHistory[node.sizeHistory.length - 1]], [420, 420, [460, 420]]);
    test("手动调高节点后两槽等高增长", [grownGeometry.slotHeights[0] > emptyGeometry.slotHeights[0],
      grownGeometry.slotHeights[1] > emptyGeometry.slotHeights[1],
      Math.abs(grownGeometry.slotHeights[0] - grownGeometry.slotHeights[1]) <= 1,
      grownGeometry.slotHeights[0] === grownGeometry.slotHeights[1]], [true, true, true, true]);
    test("手动调高节点后素材列表区域增长", grownGeometry.lists.every((list, i) =>
      list.clientHeight > emptyGeometry.lists[i].clientHeight), true);
    node.setSize([460, 300]); await settleLayout();
    test("槽位操作并入标题且按钮顺序保持", ["video", "audio"].map((slot) => {
      const hd = ui.sections[slot].box.querySelector(".kav-slot-hd");
      return [[...hd.children].map((el) => el.tagName.toLowerCase() + (el.classList.contains("kav-meta") ? ".kav-meta" :
        el.classList.contains("kav-grow") ? ".kav-grow" : el.type === "file" ? "[type=file]" : "")),
        [...hd.querySelectorAll("button")].map((el) => el.textContent), !hd.querySelector(".kav-actions")];
    }), [
      [["b", "span.kav-meta", "span.kav-grow", "button", "button", "button", "button", "input[type=file]"],
        ["使用视频音轨", "从库里选", "上传", "清除"], true],
      [["b", "span.kav-meta", "span.kav-grow", "button", "button", "button", "button", "input[type=file]"],
        ["使用视频音轨", "从库里选", "上传", "清除"], true],
    ]);
    test("空状态底栏贴近卡片且不收缩", [emptyGeometry.footGap <= 2, emptyGeometry.footFlexShrink], [true, "0"]);
    test("顶部自然换行且常规宽度不换行", [emptyGeometry.topWrap,
      window.innerWidth < 1000 || emptyGeometry.topRows === 1, emptyGeometry.cardOverflowX <= 1], ["wrap", true, true]);
    test("卡片及页面无横向溢出", [emptyGeometry.cardOverflowX <= 1, emptyGeometry.pageOverflowX <= 1,
      [...ui.card.querySelectorAll(".kav-top,.kav-slot-hd,.kav-foot")].every((el) => el.scrollWidth <= el.clientWidth + 1)],
      [true, true, true]);
    test("空状态协议布局为空", [A.outputLayout(A.readState(node)).length, A.readState(node).video_audio], [0, false]);
    test("空状态初始显示视频和音频两个端口", [portKeys(node), noHiddenPorts(node), node.__kdAVHiddenLinks instanceof Map,
      node.outputs[1].type, node.outputs[1].display_name],
      [["video_1", "audio_1"], true, true, "AUDIO", "音频1"]);
    const emptyGrowth = new AVNode(); emptyGrowth.id = 809;
    const emptySink = { id: 808, inputs: [
      { name: "v", type: "VIDEO", link: null }, { name: "a", type: "AUDIO", link: null },
      { name: "v2", type: "VIDEO", link: null }, { name: "a2", type: "AUDIO", link: null },
    ] };
    window.__app.graph._nodes.push(emptyGrowth, emptySink);
    A.build(emptyGrowth);
    emptyGrowth.connect(0, emptySink, 0); emptyGrowth.connect(1, emptySink, 1);
    await sleep(5);
    test("空素材时连接初始视频和音频口也各自长出新口", portKeys(emptyGrowth),
      ["video_1", "video_2", "audio_1", "audio_2"]);
    test("空素材时视频2和音频2可连线", [connectKey(emptyGrowth, "video_2", emptySink, 2),
      connectKey(emptyGrowth, "audio_2", emptySink, 3)], [true, true]);
    await sleep(5);
    test("连接视频2和音频2后继续长出视频3和音频3", portKeys(emptyGrowth),
      ["video_1", "video_2", "video_3", "audio_1", "audio_2", "audio_3"]);
    for (const key of ["video_1", "video_2", "audio_1", "audio_2"]) {
      const index = emptyGrowth.outputs.findIndex((o) => o.__kdAVKey === key);
      if (index >= 0) emptyGrowth.disconnectOutput(index);
    }
    emptyGrowth.onConnectionsChange("output", 0); await sleep(5);
    test("空素材断开后收回多余口", portKeys(emptyGrowth), ["video_1", "audio_1"]);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== emptyGrowth && n !== emptySink);

    const emptyFrames = new AVNode(); emptyFrames.id = 811;
    const emptyFramesSink = { id: 810, inputs: [
      { name: "f", type: "IMAGE", link: null }, { name: "a", type: "AUDIO", link: null },
      { name: "f2", type: "IMAGE", link: null }, { name: "a2", type: "AUDIO", link: null },
    ] };
    window.__app.graph._nodes.push(emptyFrames, emptyFramesSink);
    A.build(emptyFrames);
    emptyFrames.__kdAVUI.framesMode.click(); await sleep(5);
    test("无视频也可直接切换帧模式", [A.readState(emptyFrames).output_mode, portKeys(emptyFrames),
      emptyFrames.outputs[0].type, emptyFrames.outputs[1].type],
      ["frames", ["frames_1", "audio_1"], "IMAGE", "AUDIO"]);
    test("帧模式初始口可连线", [emptyFrames.connect(0, emptyFramesSink, 0), emptyFrames.connect(1, emptyFramesSink, 1)],
      [true, true]);
    await sleep(5);
    test("帧模式连接后长出视频帧2和音频2", portKeys(emptyFrames),
      ["frames_1", "frames_2", "audio_1", "audio_2"]);
    test("帧模式第二组口可连线", [connectKey(emptyFrames, "frames_2", emptyFramesSink, 2),
      connectKey(emptyFrames, "audio_2", emptyFramesSink, 3)], [true, true]);
    await sleep(5);
    test("帧模式第二组连接后长出视频帧3和音频3", portKeys(emptyFrames),
      ["frames_1", "frames_2", "frames_3", "audio_1", "audio_2", "audio_3"]);
    for (const key of ["frames_1", "frames_2", "audio_1", "audio_2"]) {
      const index = emptyFrames.outputs.findIndex((o) => o.__kdAVKey === key);
      if (index >= 0) emptyFrames.disconnectOutput(index);
    }
    emptyFrames.onConnectionsChange("output", 0); await sleep(5);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== emptyFrames && n !== emptyFramesSink);

    const oldPicked = { v: 2, kind: "av", video: video("old.mp4"), audio: audio("old.wav"),
      output_mode: "video", frame_options: { start_frame: 0, max_frames: 16, frame_step: 1, max_side: 512 },
      select: true, batch: false, cursor: 0, picked: ["old.mp4", "old.wav"] };
    node.widgets[0].value = JSON.stringify(oldPicked);
    test("旧 picked 文件名迁移到新选择列表", [A.readState(node).picked_videos, A.readState(node).picked_audios],
      [["input|old.mp4"], ["input|old.wav"]]);
    const oldPairs = { v: 2, kind: "av", output_mode: "video",
      frame_options: { start_frame: 0, max_frames: 16, frame_step: 1, max_side: 512 },
      batch: true, cursor: 1, pairs: [
        { video: video("v1.mp4"), audio: audio("a1.wav") },
        { video: video("v1.mp4"), audio: audio("a2.wav") },
      ] };
    node.widgets[0].value = JSON.stringify(oldPairs);
    const migrated = A.readState(node);
    test("旧批次保留原始配对而非展平重配", [migrated.legacy_pairs, A.pairAt(migrated, 1).video.filename, A.pairAt(migrated, 1).audio.filename],
      [true, "v1.mp4", "a2.wav"]);
    node.widgets[0].value = '{"v":2,"kind":"av","videos":[{"filename":"v.mp4","tab":"input","trim_start":1e999}],"audios":[],"output_mode":"video","frame_options":{"start_frame":0,"max_frames":16,"frame_step":1,"max_side":512}}';
    test("非有限裁剪起点回退为0", A.readState(node).videos[0].trim_start, 0);
    node.widgets[0].value = "{}";

    let st = A.readState(node);
    st.videos = [video("v1.mp4"), video("v2.mp4")];
    st.audios = [audio("a1.wav")];
    A.writeState(node, st); ui.render();
    test("视频/音频分别多选", [st.videos.length, st.audios.length], [2, 1]);
    test("顶部数量跟随较多一侧素材", ui.topCount.textContent, "2");
    test("有素材时清空显示且same逻辑保持", [ui.sections.video.clear.hidden, ui.sections.audio.clear.hidden,
      ui.sections.audio.same.hidden], [false, false, false]);
    test("普通模式按 index 配对两组", A.pairCount(A.readState(node)), 2);
    test("普通模式只返回可见键且音频置底", A.outputLayout(A.readState(node)),
      ["video_1", "video_2", "audio_1"]);
    test("2视频1音频初始只显示视频1和音频1", [portKeys(node), noHiddenPorts(node)], [["video_1", "audio_1"], true]);
    test("端口对象使用语义key实际类型和中文名", [node.outputs[0].name, node.outputs[0].type, node.outputs[0].display_name,
      node.outputs[0].__kdAVKey, node.outputs.map((o) => o.__kdAVKey).includes("frames_1")],
      ["video_1", "VIDEO", "视频1", "video_1", false]);
    test("第二组缺音频时不生成音频2可见键", A.outputLayout(A.readState(node)).includes("audio_2"), false);
    test("不再创建任何隐藏占位端口", [node.outputs.length, node.outputs.some((o) => o.__kdHidden),
      node.outputs.some((o) => !o.name || o.color_on === "rgba(0,0,0,0)")], [2, false, false]);

    const firstVideoCard = ui.sections.video.list.querySelector(".kav-item");
    firstVideoCard.dispatchEvent(new MouseEvent("mouseenter"));
    const trimPop = await waitFor(() => document.querySelector(".kav-trim-pop"));
    test("视频悬浮弹出可播放预览", !!trimPop, true);
    if (trimPop) {
      const vid = trimPop.querySelector("video");
      vid.__kdDuration = 10; vid.dispatchEvent(new Event("loadedmetadata"));
      await sleep(0);
      const vr = vid.getBoundingClientRect();
      const x1 = vr.left + vr.width * 0.2, x2 = vr.left + vr.width * 0.6, x3 = vr.left + vr.width * 0.8, y = vr.top + vr.height / 2;
      vid.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 77, button: 0, clientX: x1, clientY: y, bubbles: true }));
      vid.dispatchEvent(new PointerEvent("pointermove", { pointerId: 77, button: 0, clientX: x2, clientY: y, bubbles: true }));
      vid.dispatchEvent(new PointerEvent("pointerup", { pointerId: 77, button: 0, clientX: x3, clientY: y, bubbles: true }));
      await sleep(0);
      const trimmed = A.readState(node).videos[0];
      test("视频画面拖动写入起止时间", [trimmed.trim_start, trimmed.trim_end], [2, 8]);
      test("裁剪后预览保持打开便于微调", !!document.querySelector(".kav-trim-pop"), true);
    }

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    firstVideoCard.dispatchEvent(new MouseEvent("mouseenter"));
    const reopenedPop = await waitFor(() => document.querySelector(".kav-trim-pop"));
    test("关闭重开后保留已裁剪区间", !!reopenedPop, true);
    if (reopenedPop) {
      const vid = reopenedPop.querySelector("video");
      vid.__kdDuration = 10; vid.dispatchEvent(new Event("loadedmetadata"));
      await sleep(0);
      test("重开浮层显示最新起止时间", reopenedPop.querySelector(".kav-trim-time").textContent,
        "0:02.0 — 0:08.0");
      const playBtn = reopenedPop.querySelector(".kav-trim-play");
      vid.pause(); playBtn.click();
      test("播放按钮切换为正在播放状态", [playBtn.dataset.state, playBtn.querySelector("svg").innerHTML.includes("M7 5h4v14H7z")],
        ["playing", true]);
      playBtn.click();
      test("再次点击恢复暂停图标", [playBtn.dataset.state, playBtn.querySelector("svg").innerHTML.includes("M8 5v14l11-7z")],
        ["paused", true]);

      const track = reopenedPop.querySelector(".kav-trim-track");
      const selected = reopenedPop.querySelector(".kav-trim-range");
      const tr = track.getBoundingClientRect(), ty = tr.top + tr.height / 2;
      selected.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 78, button: 0,
        clientX: tr.left + tr.width * 0.5, clientY: ty, bubbles: true }));
      selected.dispatchEvent(new PointerEvent("pointermove", { pointerId: 78, button: 0,
        clientX: tr.left + tr.width * 0.6, clientY: ty, bubbles: true }));
      selected.dispatchEvent(new PointerEvent("pointerup", { pointerId: 78, button: 0,
        clientX: tr.left + tr.width * 0.6, clientY: ty, bubbles: true }));
      await sleep(0);
      const moved = A.readState(node).videos[0];
      test("整体拖动选区保持时长并前后平移", [moved.trim_start, moved.trim_end], [3, 9]);
    }

    st = A.readState(node); st.videos[0].trim_start = 12; st.videos[0].trim_end = 15;
    A.writeState(node, st); ui.render();
    ui.sections.video.list.querySelector(".kav-item").dispatchEvent(new MouseEvent("mouseenter"));
    const longPop = await waitFor(() => document.querySelector(".kav-trim-pop"));
    if (longPop) {
      const vid = longPop.querySelector("video"); vid.__kdDuration = 10; vid.dispatchEvent(new Event("loadedmetadata"));
      await sleep(0);
      const corrected = A.readState(node).videos[0];
      test("超长裁剪起点按实际时长校正", [corrected.trim_start, corrected.trim_end], [9.9, null]);
    }

    ui.selectCb.click();
    st = A.readState(node);
    test("开启选择模式不自动全选", [st.select, st.picked_videos.length, st.picked_audios.length], [true, 0, 0]);
    st.picked_videos = [st.videos[1].id]; st.picked_audios = [st.audios[0].id];
    A.writeState(node, st); ui.render();
    test("选择模式按 picked 顺序取视频", A.effectiveList(A.readState(node), "video").map((x) => x.filename), ["v2.mp4"]);
    test("选择模式只布局当前 picked 组", [A.outputLayout(A.readState(node)), portKeys(node)],
      [["video_1", "audio_1"], ["video_1", "audio_1"]]);
    const selectCell = ui.sections.video.list.querySelector(".kav-item");
    selectCell.dispatchEvent(new MouseEvent("mouseenter")); await sleep(5);
    test("选择模式不弹出视频裁剪预览", !document.querySelector(".kav-trim-pop"), true);
    tapCell(selectCell); await sleep(0);
    test("选择模式点击格子可继续勾选", A.readState(node).picked_videos.length, 2);
    test("选择模式徽标按点击顺序重排", [...ui.sections.video.list.querySelectorAll(".kav-item-no")]
      .map((el) => el.textContent), ["2", "1"]);

    const gestureNode = new AVNode(); gestureNode.id = 815;
    window.__app.graph._nodes.push(gestureNode);
    const gestureState = A.readState(gestureNode);
    gestureState.videos = [video("g1.mp4"), video("g2.mp4"), video("g3.mp4")];
    gestureState.select = true;
    A.writeState(gestureNode, gestureState); A.build(gestureNode);
    const gestureCells = () => gestureNode.__kdAVUI.sections.video.list.querySelectorAll(".kav-item");
    tapCell(gestureCells()[0]);
    test("选择模式单击切换", A.readState(gestureNode).picked_videos, ["input|g1.mp4"]);
    test("选择模式记录范围锚点", gestureNode.__kdAVAnchor_video, 0);
    tapCell(gestureCells()[2], true);
    test("选择模式Shift范围选择", A.readState(gestureNode).picked_videos,
      ["input|g1.mp4", "input|g2.mp4", "input|g3.mp4"]);
    const gestureList = gestureNode.__kdAVUI.sections.video.list;
    gestureList.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    test("选择模式点空白清空", A.readState(gestureNode).picked_videos, []);
    await sleep(20);
    const firstRect = gestureCells()[0].getBoundingClientRect(), lastRect = gestureCells()[1].getBoundingClientRect();
    gestureCells()[0].dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true,
      clientX: firstRect.left + 1, clientY: firstRect.top + 1 }));
    document.dispatchEvent(new MouseEvent("mousemove", { button: 0, bubbles: true,
      clientX: lastRect.right - 1, clientY: lastRect.bottom - 1 }));
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true,
      clientX: lastRect.right - 1, clientY: lastRect.bottom - 1 }));
    test("选择模式拖框多选", A.readState(gestureNode).picked_videos,
      ["input|g1.mp4", "input|g2.mp4"]);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== gestureNode);

    const sortNode = new AVNode(); sortNode.id = 818;
    window.__app.graph._nodes.push(sortNode);
    const sortState = A.readState(sortNode);
    sortState.videos = [video("s1.mp4"), video("s2.mp4"), video("s3.mp4")];
    A.writeState(sortNode, sortState); A.build(sortNode);
    const sortCells = sortNode.__kdAVUI.sections.video.list.querySelectorAll(".kav-item");
    const sortDt = new DataTransfer();
    sortCells[0].dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: sortDt }));
    sortCells[2].dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: sortDt }));
    test("普通模式支持拖拽调整视频顺序", A.readState(sortNode).videos.map((x) => x.filename),
      ["s2.mp4", "s3.mp4", "s1.mp4"]);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== sortNode);

    st = A.readState(node);
    st.videos = [video("v1.mp4"), video("v2.mp4")]; st.audios = [audio("a1.wav")];
    st.select = false; st.video_audio = true; A.writeState(node, st); ui.render();
    test("视频音轨开关调整可见布局顺序", A.outputLayout(A.readState(node)).slice(0, 5),
      ["video_1", "video_audio_1", "video_2", "video_audio_2", "audio_1"]);
    test("视频音轨开关渲染到state", [ui.videoAudioCb.checked, A.readState(node).video_audio], [true, true]);
    st = A.readState(node); st.video_audio = false; A.writeState(node, st); ui.render();
    test("关闭音轨时按视频后音频排列", [A.outputLayout(A.readState(node)), ui.videoAudioCb.checked],
      [["video_1", "video_2", "audio_1"], false]);
    const sink = { id: 999, inputs: [
      { name: "v1", type: "VIDEO", link: null }, { name: "v2", type: "VIDEO", link: null },
      { name: "va", type: "AUDIO", link: null }, { name: "a", type: "AUDIO", link: null },
    ] };
    window.__app.graph._nodes.push(sink);
    test("连线前保留视频1和音频1", portKeys(node), ["video_1", "audio_1"]);
    const firstPort = node.outputs[0];
    test("可向可见视频端口连线", connectKey(node, "video_1", sink, 0), true);
    const graphOnlyLinkId = node.outputs[0].links[0];
    node.outputs[0].links = [];
    await sleep(5);
    test("连video_1后自动长出video_2且音频口下移", portKeys(node), ["video_1", "video_2", "audio_1"]);
    test("port.links未及时更新时仍按graph.links增长", portKeys(node), ["video_1", "video_2", "audio_1"]);
    node.outputs[0].links = [graphOnlyLinkId];
    test("音频口下移不丢已有连线", [node.outputs[0] === firstPort, linkTargets(node, "video_1")],
      [false, [[999, 0]]]);
    test("连video_2后自动长出video_3", connectKey(node, "video_2", sink, 1), true);
    await sleep(5);
    test("第二个视频连线后端口变为4口", portKeys(node), ["video_1", "video_2", "video_3", "audio_1"]);
    test("前两条视频连线保持原目标", [linkTargets(node, "video_1"), linkTargets(node, "video_2")],
      [[[999, 0]], [[999, 1]]]);
    ui.videoAudioCb.click(); await sleep(5);
    test("开启音轨后端口按完整可见布局增长", portKeys(node),
      ["video_1", "video_audio_1", "video_2", "video_audio_2", "video_3", "video_audio_3", "audio_1"]);
    test("可连接视频自带音频端口", connectKey(node, "video_audio_1", sink, 2), true);
    await sleep(5);
    ui.videoAudioCb.click(); await sleep(5);
    test("关闭音轨直接移除端口且暂存连线", [portKeys(node), node.outputs.some((o) => o.__kdAVKey === "video_audio_1"),
      node.__kdAVHiddenLinks.get("video_audio_1").map((x) => [x.targetId, x.targetSlot]), noHiddenPorts(node)],
      [["video_1", "video_2", "video_3", "audio_1"], false, [[999, 2]], true]);
    const savedAVState = JSON.parse(node.widgets[0].value);
    test("隐藏连线写入media_state", savedAVState.hidden_links.video_audio_1.map((x) => [x.targetId, x.targetSlot]),
      [[999, 2]]);
    const restored = new AVNode(); restored.id = 816;
    restored.widgets[0].value = JSON.stringify(savedAVState);
    window.__app.graph._nodes.push(restored);
    A.build(restored);
    restored.__kdAVUI.videoAudioCb.click(); await sleep(5);
    test("工作流重开后恢复隐藏连线", linkTargets(restored, "video_audio_1"), [[999, 2]]);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== restored);

    const blockedSink = { id: 818, inputs: [{ name: "a", type: "AUDIO", link: 12345 }] };
    const blockedState = JSON.parse(JSON.stringify(savedAVState));
    blockedState.hidden_links.video_audio_1 = [{ targetId: 818, targetSlot: 0, linkId: null }];
    setLink(12345, { id: 12345, origin_id: 1, origin_slot: 0, target_id: 818, target_slot: 0, type: "AUDIO" });
    window.__app.graph._nodes.push(blockedSink);
    const blocked = new AVNode(); blocked.id = 817; blocked.widgets[0].value = JSON.stringify(blockedState);
    window.__app.graph._nodes.push(blocked); A.build(blocked);
    blocked.__kdAVUI.videoAudioCb.click(); await sleep(5);
    test("目标已被新连线占用时保留隐藏记录", [linkTargets(blocked, "video_audio_1"),
      blocked.__kdAVHiddenLinks.has("video_audio_1"), blockedSink.inputs[0].link],
      [[], true, 12345]);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== blocked && n !== blockedSink);
    deleteLink(12345);
    ui.videoAudioCb.click(); await sleep(5);
    test("重开音轨恢复原连线且不重复", [portKeys(node), linkTargets(node, "video_audio_1"), noHiddenPorts(node)],
      [["video_1", "video_audio_1", "video_2", "video_audio_2", "video_3", "video_audio_3", "audio_1"], [[999, 2]], true]);
    ui.framesMode.click(); await sleep(5);
    test("切帧模式移除视频端口并暂存连线", [portKeys(node), node.outputs.some((o) => /^video_\d+$/.test(o.__kdAVKey)),
      node.__kdAVHiddenLinks.has("video_1"), node.__kdAVHiddenLinks.has("video_2"), noHiddenPorts(node)],
      [["frames_1", "video_audio_1", "frames_2", "video_audio_2", "audio_1"], false, true, true, true]);
    test("不存在的隐藏端口拒绝连接", [node.onConnectOutput(99, { target_node: sink, target_slot: 0 }),
      node.connect(node.outputs.findIndex((o) => o.__kdAVKey === "video_1"), sink, 0)], [false, false]);
    ui.videoMode.click(); await sleep(5);
    test("切回视频模式按语义键恢复全部连线", [portKeys(node), linkTargets(node, "video_1"),
      linkTargets(node, "video_2"), linkTargets(node, "video_audio_1"), noHiddenPorts(node)],
      [["video_1", "video_audio_1", "video_2", "video_audio_2", "video_3", "video_audio_3", "audio_1"], [[999, 0]], [[999, 1]], [[999, 2]], true]);
    const samePorts = node.outputs.slice(); ui.render();
    test("签名不变时只更新状态不重建端口", node.outputs.every((o, i) => o === samePorts[i]), true);
    for (let i = node.outputs.length - 1; i >= 0; i--) node.disconnectOutput(i);
    node.outputs = [];
    node.__kdAVHiddenLinks = new Map();
    node.onConnectionsChange("output", 0); await sleep(5);
    test("断开全部连线后收回为初始端口", portKeys(node), ["video_1", "video_audio_1", "audio_1"]);
    const audioOnlyNode = new AVNode(); audioOnlyNode.id = 814;
    window.__app.graph._nodes.push(audioOnlyNode);
    const audioOnlyState = A.readState(audioOnlyNode);
    audioOnlyState.audios = [audio("a1.wav"), audio("a2.wav")];
    A.writeState(audioOnlyNode, audioOnlyState); A.build(audioOnlyNode);
    test("纯音频可见布局置底且按序排列", [A.outputLayout(A.readState(audioOnlyNode)), portKeys(audioOnlyNode), noHiddenPorts(audioOnlyNode)],
      [["audio_1", "audio_2"], ["video_1", "audio_1"], true]);
    test("无视频时same隐藏但音频清空可用", [audioOnlyNode.__kdAVUI.sections.audio.same.hidden,
      audioOnlyNode.__kdAVUI.sections.audio.clear.hidden], [true, false]);
    test("纯音频也从1个空位按连线增长", connectKey(audioOnlyNode, "audio_1", sink, 3), true);
    await sleep(5);
    test("连audio_1后长出audio_2且音频口仍在视频口下方", [portKeys(audioOnlyNode), linkTargets(audioOnlyNode, "audio_1")],
      [["video_1", "audio_1", "audio_2"], [[999, 3]]]);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== audioOnlyNode);
    st = A.readState(node); st.videos = [video("v1.mp4"), video("v2.mp4")]; st.audios = [audio("a1.wav")];
    A.writeState(node, st); ui.render();

    st = A.readState(node); st.videos = []; st.audios = []; st.picked_videos = []; st.picked_audios = []; st.select = false;
    A.writeState(node, st); ui.render();
    ui.sections.video.choose.click();
    const c1 = await waitFor(() => document.querySelector(".kd-lib .kd-cell[data-kd-pick-key='input|ref.mp4']"));
    const c2 = await waitFor(() => document.querySelector(".kd-lib .kd-cell[data-kd-pick-key='input|second.mp4']"));
    test("媒体库能同时列出多个视频", !!c1 && !!c2, true);
    if (c1 && c2) {
      c1.click(); c2.click();
      document.querySelector(".kd-libfoot .kd-p").click();
      await sleep(0);
    }
    st = A.readState(node);
    test("媒体库多选后加入视频列表", st.videos.map((x) => x.filename), ["ref.mp4", "second.mp4"]);

    const replaceNode = new AVNode(); replaceNode.id = 812;
    window.__app.graph._nodes.push(replaceNode);
    A.build(replaceNode);
    replaceNode.__kdAVUI.sections.video.choose.click();
    const firstPick = await waitFor(() => document.querySelector(".kd-lib .kd-cell[data-kd-pick-key='input|ref.mp4']"));
    if (firstPick) { firstPick.click(); document.querySelector(".kd-libfoot .kd-p").click(); await sleep(0); }
    replaceNode.__kdAVUI.sections.video.choose.click();
    const secondPick = await waitFor(() => document.querySelector(".kd-lib .kd-cell[data-kd-pick-key='input|second.mp4']"));
    if (secondPick) { secondPick.click(); document.querySelector(".kd-libfoot .kd-p").click(); await sleep(0); }
    test("再次从媒体库加载会替换旧视频而非累积", A.readState(replaceNode).videos.map((x) => x.filename),
      ["second.mp4"]);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== replaceNode);

    ui.sections.audio.same.click();
    st = A.readState(node);
    test("视频音轨可批量配对到音频列表", st.audios.map((x) => [x.filename, x.extract_audio]),
      [["ref.mp4", true], ["second.mp4", true]]);

    ui.framesMode.click();
    st = A.readState(node);
    test("多选后可切换视频帧模式", st.output_mode, "frames");
    test("帧设置区位于双槽下方且不收缩", [ui.sections.video.box.parentElement.nextElementSibling === ui.frames,
      getComputedStyle(ui.frames).flexShrink], [true, "0"]);
    test("帧模式只显示IMAGE端口且移除旧VIDEO端口", [node.outputs.some((o) => o.__kdAVKey === "video_1"),
      node.outputs[0].__kdAVKey, node.outputs[0].type, noHiddenPorts(node)], [false, "frames_1", "IMAGE", true]);

    const queued = [];
    let queueTarget = node;
    window.__app.queuePrompt = async () => { queued.push(JSON.parse(queueTarget.widgets[0].value)); return true; };
    ui.batchCb.click();
    await A.runAV(node);
    test("批次多选逐组提交", queued.map((s) => s.cursor), [0, 1]);
    test("批次每组使用各自视频和音频", queued.map((s) => [s.videos[s.cursor].filename, s.audios[s.cursor].filename]),
      [["ref.mp4", "ref.mp4"], ["second.mp4", "second.mp4"]]);
    test("批次结束恢复交互", ui.body.inert, false);

    queued.length = 0; ui.batchCb.click(); await A.runAV(node);
    test("普通模式一次提交同时输出多组", queued.length, 1);

    const uploadDt = new DataTransfer();
    uploadDt.items.add(new File(["video"], "uploaded.mp4", { type: "video/mp4" }));
    Object.defineProperty(ui.sections.audio.file, "files", { configurable: true, value: uploadDt.files });
    ui.sections.audio.file.dispatchEvent(new Event("change"));
    await sleep(350);
    st = A.readState(node);
    test("音频槽上传视频会作为音轨素材加入", st.audios[st.audios.length - 1].kind === "video" && st.audios[st.audios.length - 1].extract_audio, true);

    const uploadNode = new AVNode(); uploadNode.id = 817;
    window.__app.graph._nodes.push(uploadNode);
    A.build(uploadNode);
    const multiUpload = new DataTransfer();
    multiUpload.items.add(new File(["one"], "multi-one.mp4", { type: "video/mp4" }));
    multiUpload.items.add(new File(["two"], "multi-two.mp4", { type: "video/mp4" }));
    Object.defineProperty(uploadNode.__kdAVUI.sections.video.file, "files", {
      configurable: true, value: multiUpload.files,
    });
    test("上传控件支持多文件", uploadNode.__kdAVUI.sections.video.file.multiple, true);
    uploadNode.__kdAVUI.sections.video.file.dispatchEvent(new Event("change"));
    await sleep(650);
    test("一次上传多个视频全部加入", A.readState(uploadNode).videos.map((x) => x.filename),
      ["multi-one.mp4", "multi-two.mp4"]);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== uploadNode);

    const setNode = new AVNode(); setNode.id = 819;
    window.__app.graph._nodes.push(setNode);
    const setState = A.readState(setNode);
    setState.videos = [video("set-one.mp4"), video("set-two.mp4")];
    setState.audios = [audio("set.wav")];
    A.writeState(setNode, setState); A.build(setNode);
    setNode.__kdAVUI.setsBtn.click();
    let setsMenu = await waitFor(() => document.querySelector(".kd-setsmenu"));
    setsMenu.querySelector(".kd-sets-save input").value = "AV demo";
    setsMenu.querySelector(".kd-sets-save .kd-p").click();
    await waitFor(() => [...document.querySelectorAll(".kd-setsrow")].some((row) => row.textContent.includes("AV demo")));
    test("音视频排列可保存", [...document.querySelectorAll(".kd-setsrow")].some((row) => row.textContent.includes("AV demo")), true);
    const clearedSetState = A.readState(setNode);
    clearedSetState.videos = []; clearedSetState.audios = [];
    A.writeState(setNode, clearedSetState); setNode.__kdAVUI.render();
    setNode.__kdAVUI.setsBtn.click();
    setsMenu = await waitFor(() => document.querySelector(".kd-setsmenu .kd-setsrow"));
    setsMenu.querySelector(".kd-setsrow .kd-btn").click(); await sleep(30);
    test("音视频排列可加载并恢复列表", [A.readState(setNode).videos.map((x) => x.filename),
      A.readState(setNode).audios.map((x) => x.filename)], [["set-one.mp4", "set-two.mp4"], ["set.wav"]]);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== setNode);

    st = A.readState(node); st.videos = [video("only.mp4")]; st.audios = [audio("a1.wav"), audio("a2.wav")];
    st.output_mode = "frames"; st.batch = true; st.cursor = 0; A.writeState(node, st); ui.render();
    const beforeInvalid = queued.length;
    await A.runAV(node);
    test("帧模式批次无视频组整体拒绝入队", queued.length, beforeInvalid);
    test("非法帧批次给出明确提示", (document.querySelector(".kd-toast") || {}).textContent,
      "批次第 2 组还需要参考视频");
    st = A.readState(node); st.output_mode = "video"; st.videos = [video("c1.mp4"), video("c2.mp4")];
    A.writeState(node, st); ui.render();

    ui.sections.video.clear.click();
    test("清空第一次只进入确认态", A.readState(node).videos.length, 2);
    ui.sections.video.clear.click();
    test("清空第二次移除全部视频", A.readState(node).videos.length, 0);

    st = A.readState(node);
    st.videos = Array.from({ length: 10 }, (_, i) => video("v" + i + ".mp4"));
    st.audios = Array.from({ length: 10 }, (_, i) => audio("a" + i + ".wav"));
    st.batch = false; st.cursor = 0;
    A.writeState(node, st); ui.render();
    await settleLayout();
    const mediaGeometry = measureCard(node);
    window.__avGeometry.media = mediaGeometry;
    test("有素材列表保持两列且在槽内独立滚动", [mediaGeometry.list.maxHeight, mediaGeometry.list.overflowY,
      mediaGeometry.list.scrollHeight > mediaGeometry.list.clientHeight, mediaGeometry.list.items,
      mediaGeometry.list.columns], ["none", "auto", true, 10, 2]);
    test("素材列表各自滚动且body不整体滚动", [mediaGeometry.lists.every((list) =>
      list.overflowY === "auto" && list.maxHeight === "none" && list.scrollHeight > list.clientHeight),
      mediaGeometry.bodyOverflowY, mediaGeometry.body[1] <= mediaGeometry.body[0] + 1], [true, "hidden", true]);
    test("有素材时节点保持手动高度且底栏贴近卡片", [node.size[1], mediaGeometry.card[1],
      node.size[0] >= 460, mediaGeometry.body[1] <= mediaGeometry.body[0] + 1, mediaGeometry.footGap <= 2],
      [300, 300, true, true, true]);
    test("普通模式读取完整10项但只输出8组", [A.readState(node).videos.length, A.pairCount(A.readState(node))], [10, 8]);
    test("普通模式超过8组显示批次提示", node.__kdAVUI.status.textContent, "普通模式仅输出前8组，更多请开启批次");
    st.batch = true; st.cursor = 9; A.writeState(node, st); ui.render();
    test("批次模式保留10项并按实际count限制cursor", [A.pairCount(A.readState(node)), A.readState(node).cursor,
      node.__kdAVUI.status.textContent], [10, 9, "批次模式：共 10 段"]);

    st = A.readState(node); st.videos = [video("only.mp4")]; st.audios = []; st.picked_videos = []; st.picked_audios = [];
    st.output_mode = "video"; st.batch = false; st.select = false; A.writeState(node, st); ui.render();
    ui.sections.video.list.querySelector(".kav-item").dispatchEvent(new MouseEvent("mouseenter"));
    const segmentTrim = await waitFor(() => document.querySelector(".kav-trim-pop"));
    if (!segmentTrim) throw new Error("分段入口未出现");
    segmentTrim.querySelector(".kav-seg-btn").click();
    let segPop = await waitFor(() => document.querySelector(".kav-seg-pop"));
    test("视频工具条可打开固定分段浮层", !!segPop && !document.querySelector(".kav-trim-pop"), true);
    const otherAV = new AVNode(); otherAV.id = 820;
    window.__app.graph._nodes.push(otherAV); A.build(otherAV); otherAV.__kdAVUI.render();
    test("其他节点重绘不关闭当前分段浮层", document.querySelector(".kav-seg-pop") === segPop, true);
    otherAV.onRemoved();
    test("删除其他节点不取消当前分段任务", document.querySelector(".kav-seg-pop") === segPop, true);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== otherAV);
    const segRect = segPop.getBoundingClientRect();
    test("分段浮层在小屏内且列表可滚动", [segRect.left >= 0, segRect.top >= 0,
      segRect.right <= window.innerWidth + 1, segRect.bottom <= window.innerHeight + 1,
      getComputedStyle(segPop.querySelector(".kav-seg-list")).overflowY], [true, true, true, true, "auto"]);
    test("按时长默认15秒并保留尾段", [Number(segPop.querySelector(".kav-seg-duration-fields input").value),
      segPop.querySelector(".kav-seg-duration-fields select").value], [15, "keep"]);
    segPop.querySelector(".kav-seg-primary").click();
    await waitFor(() => document.querySelectorAll(".kav-seg-row").length === 2);
    test("按时长分析完成显示两段", document.querySelectorAll(".kav-seg-row").length, 2);
    test("分段行在小屏不横向溢出", [...document.querySelectorAll(".kav-seg-row")].every((r) => r.scrollWidth <= r.clientWidth + 1), true);
    test("分析完成阶段使用中文", segPop.querySelector(".kav-seg-message").textContent, "分析完成：共 2 段");
    test("时间轴按结果渲染两个色块", segPop.querySelectorAll(".kav-seg-block").length, 2);
    test("按时长请求参数正确", window.__segAnalyzes[0], {
      name: "only.mp4", subfolder: "", tab: "input", mode: "duration", params: { seconds: 15, tail: "keep" },
    });
    segPop.querySelectorAll(".kav-seg-block")[1].click();
    test("点击时间轴色块勾选并选中对应行", [segPop.querySelectorAll(".kav-seg-row")[1].classList.contains("selected"),
      segPop.querySelectorAll(".kav-seg-row")[1].querySelector("input[type=checkbox]").checked], [true, true]);
    const segVideo = segPop.querySelector("video");
    segVideo.currentTime = 2.5; segVideo.dispatchEvent(new Event("timeupdate"));
    segPop.querySelector(".kav-seg-previewbar .kd-btn").click();
    await waitFor(() => document.querySelectorAll(".kav-seg-row").length === 3);
    const splitRows = [...document.querySelectorAll(".kav-seg-row")];
    const stableFirstId = splitRows[0].dataset.segmentId, stableTailId = splitRows[2].dataset.segmentId;
    test("在播放处切分保留原段稳定编号", [splitRows.length, /^seg-duration-job-\d+-0$/.test(stableFirstId),
      splitRows[0].children[1].value, splitRows[0].children[2].value,
      splitRows[1].children[1].value, splitRows[1].children[2].value],
      [3, true, "0", "2.5", "2.5", "5"]);
    const invalidStart = document.querySelectorAll(".kav-seg-row")[2].children[1];
    invalidStart.value = "10"; invalidStart.dispatchEvent(new Event("change"));
    test("非法片段时间提示且不写入", [document.querySelectorAll(".kav-seg-row")[2].children[1].value,
      segPop.querySelector(".kav-seg-message").classList.contains("error")], ["5", true]);
    const validStart = document.querySelectorAll(".kav-seg-row")[2].children[1];
    validStart.value = "5.2"; validStart.dispatchEvent(new Event("change"));
    test("手动编辑片段起止秒数", [...document.querySelectorAll(".kav-seg-row")].map((r) => [r.children[1].value, r.children[2].value]),
      [["0", "2.5"], ["2.5", "5"], ["5.2", "10"]]);
    const overlapEnd = document.querySelectorAll(".kav-seg-row")[0].children[2];
    overlapEnd.value = "4"; overlapEnd.dispatchEvent(new Event("change"));
    test("手动编辑不允许相邻片段重叠", [document.querySelectorAll(".kav-seg-row")[0].children[2].value,
      segPop.querySelector(".kav-seg-message").classList.contains("error")], ["2.5", true]);
    document.querySelectorAll(".kav-seg-row")[1].querySelectorAll(".kav-seg-icon")[0].click();
    test("删除片段保留时间缺口且编号不重排", [...document.querySelectorAll(".kav-seg-row")].map((r) => [r.dataset.segmentId,
      r.children[1].value, r.children[2].value]), [[stableFirstId, "0", "2.5"], [stableTailId, "5.2", "10"]]);
    document.querySelectorAll(".kav-seg-row")[1].querySelectorAll(".kav-seg-icon")[1].click();
    test("与上一段合并取前段起点和当前终点", [document.querySelectorAll(".kav-seg-row").length,
      document.querySelector(".kav-seg-row").dataset.segmentId, document.querySelector(".kav-seg-row").children[1].value,
      document.querySelector(".kav-seg-row").children[2].value], [1, stableFirstId, "0", "10"]);
    segPop.querySelector(".kav-seg-primary").click();
    await waitFor(() => document.querySelectorAll(".kav-seg-row").length === 2);
    segPop.querySelector(".kav-seg-foot .kd-btn:not(.kd-p)").click();
    await waitFor(() => window.__segExports.length === 1 && segPop.querySelector(".kav-seg-message").textContent.includes("导出完成"));
    test("导出提交全部勾选片段且不复制媒体", window.__segExports[0], {
      name: "only.mp4", subfolder: "", tab: "input", mode: "copy", segments: [{ start: 0, end: 5 }, { start: 5, end: 10 }],
    });
    test("导出完成提示片段数量", segPop.querySelector(".kav-seg-message").textContent, "导出完成：共 2 个片段");
    document.querySelectorAll(".kav-seg-row")[0].querySelector("input[type=checkbox]").click();
    segPop.querySelector(".kav-seg-foot .kd-btn:not(.kd-p)").click();
    await waitFor(() => window.__segExports.length === 2 && !segPop.querySelector(".kav-seg-foot .kd-p").disabled);
    test("导出仅提交当前勾选片段", window.__segExports[1].segments, [{ start: 5, end: 10 }]);
    document.querySelectorAll(".kav-seg-row")[0].querySelector("input[type=checkbox]").click();

    const cleanedSegment = A.cleanItem({ ...video("clean.mp4"), segment_id: "Seg_1-ok", trim_start: 1, trim_end: 2 }, "video");
    test("segment_id生成同源独立id", [cleanedSegment.id, cleanedSegment.source_id, cleanedSegment.segment_id],
      ["input|clean.mp4#Seg_1-ok", "input|clean.mp4", "Seg_1-ok"]);
    test("非法segment_id回退旧id", A.cleanItem({ ...video("clean.mp4"), segment_id: "bad id" }, "video").id, "input|clean.mp4");
    const savedState = node.widgets[0].value;
    const oneSegment = { ...video("only.mp4"), segment_id: "seg-one", trim_start: 0, trim_end: 5 };
    node.widgets[0].value = JSON.stringify({ ...st, videos: [oneSegment], select: true, picked_videos: ["input|only.mp4"] });
    test("旧base selector在source_id唯一时匹配分段", A.readState(node).picked_videos, ["input|only.mp4#seg-one"]);
    node.widgets[0].value = JSON.stringify({ ...st, videos: [oneSegment, { ...oneSegment, segment_id: "seg-two" }], select: true, picked_videos: ["input|only.mp4"] });
    test("旧base selector遇到多个同源片段时不误选", A.readState(node).picked_videos, []);
    node.widgets[0].value = savedState;
    segPop.querySelector(".kav-seg-foot .kd-p").click();
    await sleep(0);
    st = A.readState(node);
    const addedSegments = st.videos.slice(1);
    test("加入节点产生同源不同segment_id且裁剪正确", [st.videos.length,
      st.videos.every((x) => x.source_id === "input|only.mp4"), new Set(st.videos.map((x) => x.id)).size,
      addedSegments.map((x) => [x.trim_start, x.trim_end]), !!addedSegments[0] && /^seg-duration-job-\d+-0$/.test(addedSegments[0].segment_id),
      !!addedSegments[1] && /^seg-duration-job-\d+-1$/.test(addedSegments[1].segment_id)],
      [3, true, 3, [[0, 5], [5, 10]], true, true]);
    test("加入节点后清理旧分段浮层", !document.querySelector(".kav-seg-pop"), true);

    ui.sections.video.list.querySelector(".kav-item").dispatchEvent(new MouseEvent("mouseenter"));
    const shotTrim = await waitFor(() => document.querySelector(".kav-trim-pop"));
    shotTrim.querySelector(".kav-seg-btn").click();
    segPop = await waitFor(() => document.querySelector(".kav-seg-pop"));
    segPop.querySelectorAll(".kav-seg-tabs button")[1].click();
    test("按镜头默认灵敏度0.22最短1秒", [Number(segPop.querySelector(".kav-seg-shot-fields input").value),
      Number(segPop.querySelectorAll(".kav-seg-shot-fields input")[1].value)], [0.22, 1]);
    const shotEngine = segPop.querySelector(".kav-seg-shot-fields select");
    const shotThreshold = segPop.querySelector(".kav-seg-shot-fields input");
    test("按镜头默认使用快速帧差引擎", shotEngine.value, "fast");
    segPop.querySelector(".kav-seg-primary").click();
    await waitFor(() => document.querySelectorAll(".kav-seg-row").length === 3);
    test("按镜头分析显示三段及置信度", [...document.querySelectorAll(".kav-seg-confidence")].map((x) => x.textContent), ["91%", "76%", "88%"]);
    test("按镜头请求参数正确", window.__segAnalyzes[2], {
      name: "only.mp4", subfolder: "", tab: "input", mode: "shot", params: { engine: "fast", threshold: 0.22, min_seconds: 1 },
    });

    shotEngine.value = "transnet"; shotEngine.dispatchEvent(new Event("change"));
    const aiHint = segPop.querySelector(".kav-seg-engine-hint");
    test("切到AI模型使用0.5阈值并显示轻提示", [Number(shotThreshold.value), shotThreshold.min, shotThreshold.max,
      aiHint.textContent, aiHint.hidden, segPop.querySelector(".kav-seg-primary").textContent],
      [0.5, "0.01", "0.99", "首次使用需下载约31MB模型权重，之后本地离线运行", false, "开始AI检测"]);
    segPop.querySelector(".kav-seg-primary").click();
    await waitFor(() => window.__segAnalyzes.length === 4 && !segPop.querySelector(".kav-seg-primary").disabled &&
      segPop.querySelector(".kav-seg-message").textContent.includes("分析完成"));
    test("AI检测请求携带transnet引擎", window.__segAnalyzes[3], {
      name: "only.mp4", subfolder: "", tab: "input", mode: "shot", params: { engine: "transnet", threshold: 0.5, min_seconds: 1 },
    });
    test("AI检测桩同样返回三段及置信度", [...document.querySelectorAll(".kav-seg-confidence")].map((x) => x.textContent), ["91%", "76%", "88%"]);
    const aiFirstEnd = document.querySelectorAll(".kav-seg-row")[0].children[2];
    aiFirstEnd.value = "2.8"; aiFirstEnd.dispatchEvent(new Event("change"));
    test("AI检测结果仍可人工编辑", document.querySelectorAll(".kav-seg-row")[0].children[2].value, "2.8");
    segPop.querySelector(".kav-seg-foot .kd-btn:not(.kd-p)").click();
    await waitFor(() => window.__segExports.length === 3 && segPop.querySelector(".kav-seg-message").textContent.includes("导出完成"));
    test("AI检测结果仍可导出", window.__segExports[2], {
      name: "only.mp4", subfolder: "", tab: "input", mode: "copy",
      segments: [{ start: 0, end: 2.8 }, { start: 3, end: 7 }, { start: 7, end: 10 }],
    });

    test("检测引擎包含OmniShotCut高精度选项", [...shotEngine.options].map((o) => [o.value, o.textContent]),
      [["fast", "快速帧差"], ["transnet", "AI模型（TransNetV2）"], ["omnishotcut", "OmniShotCut 高精度"]]);
    shotEngine.value = "omnishotcut"; shotEngine.dispatchEvent(new Event("change"));
    const highPrecisionThresholdLabel = shotThreshold.closest("label");
    test("切到OmniShotCut隐藏灵敏度字段", [highPrecisionThresholdLabel.hidden,
      getComputedStyle(highPrecisionThresholdLabel).display], [true, "none"]);
    test("OmniShotCut显示202MB提示和高精度按钮", [aiHint.textContent, aiHint.hidden,
      segPop.querySelector(".kav-seg-primary").textContent],
      ["首次使用需下载约202MB模型权重，之后本地离线运行", false, "开始高精度检测"]);
    segPop.querySelector(".kav-seg-primary").click();
    await waitFor(() => window.__segAnalyzes.length === 5 && document.querySelectorAll(".kav-seg-row").length === 4 &&
      !segPop.querySelector(".kav-seg-primary").disabled && segPop.querySelector(".kav-seg-message").textContent.includes("分析完成"));
    test("高精度检测请求携带omnishotcut引擎", window.__segAnalyzes[4], {
      name: "only.mp4", subfolder: "", tab: "input", mode: "shot", params: { engine: "omnishotcut", threshold: 0.5, min_seconds: 1 },
    });
    test("高精度检测显示四段及不同置信度", [...document.querySelectorAll(".kav-seg-confidence")].map((x) => x.textContent),
      ["97%", "83%", "69%", "92%"]);
    const highPrecisionFirstEnd = document.querySelectorAll(".kav-seg-row")[0].children[2];
    highPrecisionFirstEnd.value = "2.3"; highPrecisionFirstEnd.dispatchEvent(new Event("change"));
    test("高精度检测结果仍可人工编辑", document.querySelectorAll(".kav-seg-row")[0].children[2].value, "2.3");
    segPop.querySelector(".kav-seg-foot .kd-btn:not(.kd-p)").click();
    await waitFor(() => window.__segExports.length === 4 && segPop.querySelector(".kav-seg-message").textContent.includes("导出完成"));
    test("高精度检测结果仍可导出", window.__segExports[3], {
      name: "only.mp4", subfolder: "", tab: "input", mode: "copy",
      segments: [{ start: 0, end: 2.3 }, { start: 2.4, end: 5.1 }, { start: 5.1, end: 7.8 }, { start: 7.8, end: 10 }],
    });
    shotEngine.value = "transnet"; shotEngine.dispatchEvent(new Event("change"));
    test("切回TransNet恢复阈值字段和0.5阈值", [highPrecisionThresholdLabel.hidden,
      Number(shotThreshold.value), aiHint.textContent, segPop.querySelector(".kav-seg-primary").textContent],
      [false, 0.5, "首次使用需下载约31MB模型权重，之后本地离线运行", "开始AI检测"]);

    const thresholdMemory = [];
    shotEngine.value = "fast"; shotEngine.dispatchEvent(new Event("change")); thresholdMemory.push(Number(shotThreshold.value));
    shotThreshold.value = "0.3"; shotThreshold.dispatchEvent(new Event("input"));
    shotEngine.value = "transnet"; shotEngine.dispatchEvent(new Event("change")); thresholdMemory.push(Number(shotThreshold.value));
    shotThreshold.value = "0.61"; shotThreshold.dispatchEvent(new Event("input"));
    shotEngine.value = "fast"; shotEngine.dispatchEvent(new Event("change")); thresholdMemory.push(Number(shotThreshold.value));
    shotEngine.value = "transnet"; shotEngine.dispatchEvent(new Event("change")); thresholdMemory.push(Number(shotThreshold.value));
    test("切换引擎保留各自上次手改阈值", thresholdMemory, [0.22, 0.5, 0.3, 0.61]);
    ui.render();
    test("节点重绘清理分段浮层", !document.querySelector(".kav-seg-pop"), true);

    const legacy = new AVNode();
    legacy.id = 803;
    legacy.outputs = Array.from({ length: 24 }, (_, i) => ({
      name: "output_" + (i + 1), type: ["VIDEO", "AUDIO", "IMAGE"][i % 3], links: [],
      draw() {}, drawCollapsed() {}, color_on: "#fff", color_off: "#888",
    }));
    test("legacyOutputKey保留output_n旧映射", [0, 1, 2, 3, 23].map((i) => A.legacyOutputKey(legacy.outputs[i], i)),
      ["video_1", "audio_1", "frames_1", "video_2", "frames_8"]);
    const legacyState = A.readState(legacy); legacyState.videos = [video("legacy.mp4")]; legacyState.audios = [audio("legacy.wav")];
    A.writeState(legacy, legacyState);
    const legacySink = { id: 998, inputs: [
      { name: "v", type: "VIDEO", link: null }, { name: "a", type: "AUDIO", link: null },
      { name: "f", type: "IMAGE", link: null },
    ] };
    window.__app.graph._nodes.push(legacy, legacySink);
    legacy.connect(0, legacySink, 0); legacy.connect(1, legacySink, 1); legacy.connect(2, legacySink, 2);
    A.build(legacy); await sleep(5);
    test("旧24端口workflow迁移到可见语义槽", [portKeys(legacy), noHiddenPorts(legacy)],
      [["video_1", "video_2", "audio_1", "audio_2"], true]);
    test("旧24端口视频和音频连线按key恢复", [linkTargets(legacy, "video_1"), linkTargets(legacy, "audio_1")],
      [[[998, 0]], [[998, 1]]]);
    test("旧帧模式连线暂存而非保留隐藏端口", [legacy.outputs.some((o) => o.__kdAVKey === "frames_1"),
      legacy.__kdAVHiddenLinks.get("frames_1").map((x) => [x.targetId, x.targetSlot])], [false, [[998, 2]]]);
    legacy.__kdAVUI.framesMode.click(); await sleep(5);
    test("旧workflow切帧模式恢复frames_1原连线", [portKeys(legacy), linkTargets(legacy, "frames_1"),
      linkTargets(legacy, "audio_1")], [["frames_1", "frames_2", "audio_1", "audio_2"], [[998, 2]], [[998, 1]]]);
    legacy.__kdAVUI.videoMode.click(); await sleep(5);
    test("旧workflow切回视频模式恢复video_1原连线", [linkTargets(legacy, "video_1"), linkTargets(legacy, "audio_1")],
      [[[998, 0]], [[998, 1]]]);

    queued.length = 0;
    const large = new AVNode(); large.id = 802;
    window.__app.graph._nodes.push(large);
    const largeState = A.readState(large);
    largeState.batch = true; largeState.cursor = 0; largeState.output_mode = "video";
    largeState.videos = Array.from({ length: 500 }, (_, i) => video("batch-" + i + ".mp4"));
    largeState.audios = Array.from({ length: 500 }, (_, i) => audio("batch-" + i + ".wav"));
    A.writeState(large, largeState); A.build(large); queueTarget = large;
    test("500段批次状态不截断且cursor按实际count", [A.readState(large).videos.length, A.pairCount(A.readState(large))], [500, 500]);
    test("500段批次只布局当前组且初始保留音频空位", [A.outputLayout(A.readState(large)), portKeys(large), noHiddenPorts(large)],
      [["video_1", "audio_1"], ["video_1", "audio_1"], true]);
    const batchSink = { id: 997, inputs: [{ name: "v", type: "VIDEO", link: null }] };
    window.__app.graph._nodes.push(batchSink);
    test("batch当前组视频口可真实连线", large.connect(0, batchSink, 0), true);
    await sleep(5);
    test("batch连当前组视频后长出video_2且音频口下移", portKeys(large), ["video_1", "video_2", "audio_1"]);
    await A.runAV(large);
    test("batch 500完整提交且只推进当前组cursor", [queued.length, queued[0].cursor, queued[499].cursor,
      queued.every((s) => s.videos.length === 500 && s.audios.length === 500)], [500, 0, 499, true]);
    test("批次每组状态仅返回当前组可见键", [A.outputLayout({ ...A.readState(large), cursor: 49 }),
      A.outputLayout({ ...A.readState(large), cursor: 499 }), A.pairAt(A.readState(large), 49).video.filename],
      [["video_1", "audio_1"], ["video_1", "audio_1"], "batch-49.mp4"]);

    queued.length = 0;
    const fifty = new AVNode(); fifty.id = 813;
    window.__app.graph._nodes.push(fifty);
    const fiftyState = A.readState(fifty); fiftyState.batch = true;
    fiftyState.videos = Array.from({ length: 50 }, (_, i) => video("fifty-" + i + ".mp4"));
    A.writeState(fifty, fiftyState); A.build(fifty); queueTarget = fifty; await A.runAV(fifty);
    test("batch 50不截断", [A.readState(fifty).videos.length, queued.length, queued[49].cursor], [50, 50, 49]);
    test("batch 50仍只布局当前组并保留音频空位", [A.outputLayout(A.readState(fifty)), portKeys(fifty)],
      [["video_1", "audio_1"], ["video_1", "audio_1"]]);

    queued.length = 0;
    const normal = new AVNode(); normal.id = 804;
    window.__app.graph._nodes.push(normal);
    const normalState = A.readState(normal); normalState.videos = Array.from({ length: 50 }, (_, i) => video("normal-" + i + ".mp4"));
    A.writeState(normal, normalState); A.build(normal); queueTarget = normal; await A.runAV(normal);
    test("normal 50项仍只提交一次且保留音频空位", [queued.length, A.pairCount(A.readState(normal)),
      A.outputLayout(A.readState(normal)).length, portKeys(normal)], [1, 8, 9, ["video_1", "audio_1"]]);
    const normalSink = { id: 996, inputs: Array.from({ length: 9 }, (_, i) => ({
      name: "slot" + i, type: i === 8 ? "AUDIO" : "VIDEO", link: null,
    })) };
    window.__app.graph._nodes.push(normalSink);
    for (let i = 1; i <= 8; i++) {
      const key = "video_" + i;
      test("normal第" + i + "个视频口真实连线成功", connectKey(normal, key, normalSink, i - 1), true);
      await sleep(5);
      if (i < 3 || i === 8) test("normal连第" + i + "个视频口后动态端口数", normal.outputs.length, Math.min(9, i + 2));
    }
    test("normal 50按连线增长且音频口始终置底", [normal.outputs.length, noHiddenPorts(normal),
      normal.outputs.every((o, i) => o.__kdAVKey === (i === 8 ? "audio_1" : "video_" + (i + 1)))],
      [9, true, true]);

    st = A.readState(node); st.videos = [video("only.mp4")]; st.audios = []; st.batch = true; st.cursor = 0;
    st.output_mode = "video"; st.video_audio = false; A.writeState(node, st); ui.render();
    node.__kdAVUI.sections.video.list.querySelector(".kav-item").dispatchEvent(new MouseEvent("mouseenter"));
    const batchTrim = await waitFor(() => document.querySelector(".kav-trim-pop"));
    batchTrim.querySelector(".kav-seg-btn").click();
    segPop = await waitFor(() => document.querySelector(".kav-seg-pop"));
    test("分段浮层按批次显示500段上限", segPop.querySelector(".kav-seg-foot .kd-p").textContent, "加入节点（最多 500 段）");
    test("小屏顶部全局开关与状态行不溢出", (() => {
      const card = node.__kdAVUI.card, r = card.getBoundingClientRect();
      return [r.left >= -1, r.right <= window.innerWidth + 1,
        [...card.querySelectorAll(".kd-top .kd-sw")].every((el) => el.getBoundingClientRect().right <= r.right + 1),
        node.__kdAVUI.status.textContent];
    })(), [true, true, true, "批次模式：共 1 段"]);
    test("小屏双槽标题按钮与列表无横向溢出", (() => {
      const card = node.__kdAVUI.card;
      const selectors = [".kav-slots", ".kav-slot", ".kav-slot-hd", ".kav-slot-hd button", ".kav-list", ".kav-item"];
      return [card.scrollWidth <= card.clientWidth + 1, node.__kdAVUI.body.scrollWidth <= node.__kdAVUI.body.clientWidth + 1,
        selectors.every((selector) => [...card.querySelectorAll(selector)].filter((el) => el.getClientRects().length)
          .every((el) => el.scrollWidth <= el.clientWidth + 1))];
    })(), [true, true, true]);

    test("小屏端口只保留可见语义端口", [portKeys(node), noHiddenPorts(node)], [["video_1", "video_2", "audio_1"], true]);

    const staleSink = { id: 995, inputs: [{ name: "v", type: "VIDEO", link: null }] };
    window.__app.graph._nodes.push(staleSink);
    const stale = new AVNode(); stale.id = 805;
    window.__app.graph._nodes.push(stale);
    const staleState = A.readState(stale); staleState.videos = [video("stale1.mp4"), video("stale2.mp4")];
    A.writeState(stale, staleState); A.build(stale);
    stale.connect(0, staleSink, 0); await sleep(5);
    stale.__kdAVUI.framesMode.click(); await sleep(5);
    test("隐藏连线先按语义键暂存", stale.__kdAVHiddenLinks.get("video_1").map((x) => [x.targetId, x.targetSlot]), [[995, 0]]);
    window.__app.graph._nodes = window.__app.graph._nodes.filter((n) => n !== staleSink);
    stale.__kdAVUI.videoMode.click(); await sleep(5);
    test("目标节点不存在时丢弃隐藏连线并收回空位", [stale.__kdAVHiddenLinks.has("video_1"),
      portKeys(stale), linkTargets(stale, "video_1")], [false, ["video_1", "audio_1"], []]);

    const originalLinks = window.__app.graph.links;
    window.__app.graph.links = {};
    try {
      const objectNode = new AVNode(); objectNode.id = 806;
      window.__app.graph._nodes.push(objectNode);
      const objectState = A.readState(objectNode);
      objectState.videos = [video("object1.mp4"), video("object2.mp4")]; objectState.audios = [audio("object.wav")];
      A.writeState(objectNode, objectState); A.build(objectNode);
      const objectSink = { id: 994, inputs: [
        { name: "v1", type: "VIDEO", link: null }, { name: "v2", type: "VIDEO", link: null },
      ] };
      window.__app.graph._nodes.push(objectSink);
      objectNode.connect(0, objectSink, 0); await sleep(5);
      objectNode.connect(1, objectSink, 1); await sleep(5);
      test("graph.links为对象时仍按连线增长", [portKeys(objectNode), linkTargets(objectNode, "video_1"),
        linkTargets(objectNode, "video_2")], [["video_1", "video_2", "video_3", "audio_1"], [[994, 0]], [[994, 1]]]);
      objectNode.__kdAVUI.framesMode.click(); await sleep(5);
      test("对象form graph.links切换模式无隐藏端口", [portKeys(objectNode), noHiddenPorts(objectNode),
        objectNode.__kdAVHiddenLinks.has("video_1")], [["frames_1", "audio_1"], true, true]);
      objectNode.__kdAVUI.videoMode.click(); await sleep(5);
      test("对象form graph.links切回恢复语义连线", [linkTargets(objectNode, "video_1"), linkTargets(objectNode, "video_2")],
        [[[994, 0]], [[994, 1]]]);
    } finally {
      window.__app.graph.links = originalLinks;
    }
    test("服务器graph.links继续使用Map", window.__app.graph.links instanceof Map, true);

    ui.sections.video.list.querySelector(".kav-item").dispatchEvent(new MouseEvent("mouseenter"));
    await waitFor(() => document.querySelector(".kav-seg-pop"));
    node.onRemoved();
    test("删除节点关闭悬浮预览", !document.querySelector(".kav-trim-pop"), true);
    test("删除节点清理分段浮层", !document.querySelector(".kav-seg-pop"), true);
  } catch (e) {
    results.push({ name: "运行中抛异常", pass: false, actual: String(e && e.stack || e), expected: "无异常" });
  }
  const bad = results.filter((r) => !r.pass);
  out.textContent = "RESULT" + JSON.stringify({ total: results.length, failed: bad.length, bad, geometry: window.__avGeometry, all: results });
})();

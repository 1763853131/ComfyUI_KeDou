// 悬浮显示原图尺寸 —— 真浏览器里的交互断言（配 tests/serve_image_size.py 跑）
//
// 正向：/module.js（改动后）应当全绿。
// 反向：/before.js（改动前的备份）跑同一套，必须逐条失败 —— 证明这些断言真的在测新行为。
// 所有期望的像素值都来自 /fixtures.json（后端造图时的真实尺寸 + 后端 bucket_size 的结果），
// 不拿前端自己的计算当期望值。
(async function () {
  const T = window.__kdTools || {};
  const app = window.__app;
  const host = document.getElementById("host");
  const out = document.getElementById("out");
  const results = [];
  const test = (name, actual, expected = true) => results.push({
    name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const value = fn();
      if (value) return value;
      await sleep(25);
    }
    return fn();
  };
  const fx = await (await fetch("/fixtures.json")).json();
  const want = (w, h, res) => fx.cases.find((c) => c.w === w && c.h === h && c.res === res);

  function makeNode(images, opts) {
    opts = opts || {};
    const card = document.createElement("div");
    card.className = "kd-card";
    const body = document.createElement("div");
    body.className = "kd-body";
    card.appendChild(body);
    host.appendChild(card);
    return {
      id: 1, size: [460, 380], outputs: [],
      widgets: [{ name: "media_state", value: JSON.stringify({
        images: images.map((f) => ({ filename: f })), batch: !!opts.batch, cursor: 0,
        select: !!opts.select, picked: opts.picked || [], bucket: opts.bucket || 0 }) }],
      graph: { links: {}, getLink: () => null },
      setSize(s) { this.size = s; },
      computeSize() { return [460, 380]; },
      setDirtyCanvas() {},
      addOutput(n, t) { this.outputs.push({ name: n, type: t, links: [] }); },
      _kdUI: { card, body, count: document.createElement("span"),
               runBtn: document.createElement("button"),
               swBatchCb: { checked: false }, swSelCb: { checked: false } },
    };
  }
  const zoom = () => (T.zoomEl ? T.zoomEl() : null);
  const cap = () => { const d = zoom(); return d ? d.querySelector(".kd-zoomcap") : null; };
  // 合并后尺寸行是 .kd-zdim；改动前的备份里尺寸直接写在 .kd-zoomcap 上，两处都认，
  // 反向测试才能跑到「num」而不是每条都等超时。
  const dimRow = (c) => (c ? (c.querySelector(".kd-zdim") || c) : null);
  const nameOf = (c) => {
    const s = c && c.querySelector(".kd-zname");
    return s ? s.textContent : null;
  };
  const dim = (el) => {
    const s = el && el.querySelector(".kd-zd");
    return s ? s.textContent : null;
  };
  const outSize = (el) => {
    const s = el && el.querySelector(".kd-zo");
    return s ? s.textContent : null;
  };
  const move = (cell, x, y) => cell.dispatchEvent(
    new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
  const hover = (cell, x, y) => {
    cell.dispatchEvent(new MouseEvent("mouseenter", { clientX: x, clientY: y }));
    move(cell, x, y);
  };
  const leave = (cell) => cell.dispatchEvent(new MouseEvent("mouseleave"));
  async function waitNum(timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 2500)) {
      const c = cap();
      const row = dimRow(c);
      if (row && row.dataset.state === "num") return c;
      await sleep(25);
    }
    return cap();
  }
  const setState = (node, patch) => {
    const st = T.readState(node);
    Object.assign(st, patch);
    T.writeState(node, st);
    T.renderPanel(node);
  };

  try {
    // 删除类用例会真删 fixture：每轮开跑前先重建，换主题 / 反向跑同一进程也干净
    await fetch("/reset", { method: "POST" });
    T.ensureCss();
    const internalState = { filename: "internal.png" };
    const internalNode = {
      inputs: [{ name: "media_state", type: "STRING", widget: { name: "media_state" } }],
      widgets: [{ name: "media_state", value: JSON.stringify({ images: [internalState] }) }],
      removeInput(index) { this.inputs.splice(index, 1); },
      configure(info) { this.inputs.push(...info.inputs); },
    };
    T.hideMediaStateInput(internalNode);
    test("内部状态接口隐藏且控件值保留", [internalNode.inputs.length,
      T.readState(internalNode).images[0].filename], [0, "internal.png"]);
    internalNode.configure({ inputs: [{ name: "media_state", type: "STRING" }] });
    test("工作流重新加载后内部状态接口仍隐藏", [internalNode.inputs.length,
      T.readState(internalNode).images[0].filename], [0, "internal.png"]);
    const node = makeNode(["wide.png", "rot.jpg", "gen.png", "small.webp", "fixed.png"]);
    T.renderPanel(node);
    await sleep(60);
    const cells = () => Array.from(node._kdUI.body.querySelectorAll(".kd-cell"));
    test("面板渲染出 5 个格子", cells().length, 5);

    // ---------------------------------------------------------------- 普通模式
    hover(cells()[0], 120, 120);
    let c = await waitNum();
    test("悬浮层出现", zoom() ? zoom().style.display : null, "block");
    test("悬浮图仍用 512 缩略图（没去拉原图）",
         !!(zoom() && zoom().firstElementChild.src.indexOf("w=512") > 0));
    test("显示的是原图尺寸，不是缩略图尺寸", dim(c), "1600 × 900");
    test("桶为原尺寸时不多出一条输出尺寸", outSize(c), null);

    // ------------------------------------------- 文件名与尺寸合并成一条（不再两个提示互相盖）
    test("文件名和尺寸在同一条信息里", nameOf(c), "wide.png");
    const nmEl = c ? c.querySelector(".kd-zname") : null;
    const dmEl = dimRow(c);
    test("名字行在尺寸行上方",
         nmEl && dmEl ? nmEl.getBoundingClientRect().bottom <= dmEl.getBoundingClientRect().top + 0.5 : false);
    test("格子不再挂原生 title（浏览器提示不会压到悬浮层上）",
         cells()[0].getAttribute("title"), null);
    test("格子保留 aria-label 给读屏", cells()[0].getAttribute("aria-label"), "wide.png");
    const theme = new URLSearchParams(location.search).get("theme") || "dark";
    test("悬浮层底色不随主题变（" + theme + " 主题下也是深底）",
         getComputedStyle(zoom()).backgroundColor, "rgb(28, 28, 34)");
    test(theme + " 主题下尺寸数字仍是浅字（深底上可读）",
         dmEl && dmEl.querySelector(".kd-zd")
           ? getComputedStyle(dmEl.querySelector(".kd-zd")).color : null, "rgb(232, 232, 238)");
    test(theme + " 主题下文件名也是浅字",
         nmEl ? getComputedStyle(nmEl).color : null, "rgb(232, 232, 238)");

    const calls0 = window.__sizeCalls.filter((u) => u.indexOf("wide.png") >= 0).length;
    test("一张图只发一次尺寸请求", calls0, 1);
    for (let i = 0; i < 20; i++) move(cells()[0], 120 + i, 120 + (i % 3));
    await sleep(80);
    test("鼠标反复移动不再发请求",
         window.__sizeCalls.filter((u) => u.indexOf("wide.png") >= 0).length, calls0);

    const capStyle = c ? getComputedStyle(c) : null;
    test("尺寸条文字是浅色（悬浮层底色恒为深色）",
         capStyle ? capStyle.color : null, "rgb(232, 232, 238)");
    leave(cells()[0]);
    test("移开后悬浮层收起", zoom().style.display, "none");

    // ---------------------------------------------------------------- EXIF / 目录回退
    hover(cells()[1], 140, 140);
    c = await waitNum();
    test("竖拍图按 EXIF 方向报宽高", dim(c), "900 × 1600");
    leave(cells()[1]);
    hover(cells()[2], 160, 160);
    c = await waitNum();
    test("只在 output 里的图也能报尺寸", dim(c), "1024 × 1536");
    leave(cells()[2]);

    // ---------------------------------------------------------------- 对齐分辨率
    // 故意不重绘面板：改分辨率只写状态，悬浮层必须现取
    const st = T.readState(node);
    st.bucket = 1024;
    T.writeState(node, st);
    hover(cells()[0], 120, 120);
    c = await waitNum();
    const w1 = want(1600, 900, 1024);
    test("桶开着仍显示原图尺寸", dim(c), "1600 × 900");
    test("桶开着补出对齐后的输出尺寸", outSize(c), w1.bw + " × " + w1.bh);
    test("输出尺寸带中文标签", c ? (c.querySelector(".kd-zl") || {}).textContent : null, "输出");
    leave(cells()[0]);
    hover(cells()[4], 180, 180);
    c = await waitNum();
    test("已经在不动点上的图不重复显示输出尺寸", outSize(c), null);
    leave(cells()[4]);
    test("前端桶算法与后端 bucket_size 全表一致",
         T.kdBucketSize ? fx.cases.every((k) => JSON.stringify(T.kdBucketSize(k.w, k.h, k.res)) ===
                                                JSON.stringify([k.bw, k.bh])) : false);
    test("半数取偶那一档也没走样（1089×4096@1024）",
         T.kdBucketSize ? T.kdBucketSize(1089, 4096, 1024) : null,
         [want(1089, 4096, 1024).bw, want(1089, 4096, 1024).bh]);

    // ---------------------------------------------------------------- 选择模式
    setState(node, { select: true, bucket: 0 });
    await sleep(40);
    // 故意悬第二张（rot.jpg）：悬浮层是单例，若选择模式不更新图，src 会停在上一张的宽图上。
    hover(cells()[1], 150, 150);
    c = await waitNum();
    test("选择模式也能看到尺寸", dim(c), "900 × 1600");
    test("选择模式悬浮也带文件名", nameOf(c), "rot.jpg");
    test("选择模式悬浮也出放大预览图", zoom().firstElementChild.style.display, "");
    test("选择模式预览图跟着当前格子换（512 缩略图）",
         zoom().firstElementChild.src.indexOf("rot.jpg") > 0 &&
         zoom().firstElementChild.src.indexOf("w=512") > 0);
    test("选择模式不再用小浮标样式", zoom().classList.contains("kd-chip"), false);
    test("选择模式悬浮层不挡点击（pointer-events:none）",
         getComputedStyle(zoom()).pointerEvents, "none");
    // 框选期间不该有悬浮层跟选框抢视线。
    // 手势本来是 build() 挂的，这里只调 renderPanel，所以按 build 的同一套口径补挂一次。
    if (T.kdGesture) {
      T.kdGesture(node._kdUI.body, () => cells(), {
        enabled: () => !!T.readState(node).select,
        onCellTap() {}, onBlankTap() {}, onMarquee() {},
      });
    }
    cells()[0].dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 150, clientY: 150, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 240, clientY: 240, bubbles: true }));
    test("框选中收起悬浮层", zoom().style.display, "none");
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 240, clientY: 240, bubbles: true }));
    await sleep(40);
    // 悬浮出了预览图，但点击必须仍归选中：不能顺手打开大图预览。
    cells()[1].click();
    await sleep(60);
    test("选择模式点击不打开大图预览（点击留给选中）", document.querySelector(".kd-big"), null);
    test("选择模式格子不挂 openBig 的 onclick", cells()[1].onclick, null);
    leave(cells()[1]);

    // ---------------------------------------------------------------- 旧后端 / 读不到
    setState(node, { select: false, picked: [] });
    await sleep(40);
    window.__blockSize = true;
    if (T.kdSizeCache) T.kdSizeCache.clear();
    hover(cells()[3], 200, 200);
    await sleep(400);
    test("后端还没这条路由时，放大图照常出", zoom().style.display, "block");
    test("读不到尺寸时尺寸行收起，不编数字",
         dimRow(cap()) ? dimRow(cap()).style.display : "(没有尺寸行)", "none");
    test("读不到尺寸时不留下任何数字", dim(cap()), null);
    test("读不到尺寸时文件名仍在（原生 title 已去掉，名字只剩这一处）",
         nameOf(cap()), "small.webp");
    leave(cells()[3]);
    window.__blockSize = false;
    if (T.kdSizeCache) T.kdSizeCache.clear();

    // ---------------------------------------------------------------- 大图预览
    cells()[0].click();
    await sleep(400);
    const big = document.querySelector(".kd-big");
    test("点击打开大图预览", !!big);
    test("大图预览也显示原图尺寸", big ? dim(big.querySelector(".kd-bigdim")) : null, "1600 × 900");
    if (big) big.click();
    test("大图预览可关闭", !document.querySelector(".kd-big"));

    // ---------------------------------------------------------------- 媒体库共用
    T.openLibrary(() => {});
    await sleep(500);
    const lib = document.querySelector(".kd-lib");
    const libCell = lib ? lib.querySelector('.kd-cell[data-kd-key="wide.png"]') : null;
    test("媒体库里能找到 wide.png 的格子", !!libCell);
    if (libCell) {
      hover(libCell, 300, 300);
      const lc = await waitNum();
      test("媒体库悬浮同样显示尺寸", dim(lc), "1600 × 900");
      leave(libCell);
    }
    if (lib) lib.remove();

    // ---------------------------------------------------------------- 媒体库右键删除（两步确认）
    T.openLibrary(() => {});
    await sleep(500);
    const lib2 = document.querySelector(".kd-lib");
    const cellOf = (name) => lib2.querySelector('.kd-cell[data-kd-key="' + name + '"]');
    const menu = () => document.querySelector(".kd-menu");
    const menuBtn = () => (menu() ? menu().querySelector("button") : null);
    // 反向基线没有菜单：用空点击占位，让每条断言逐条失败而不是整页抛 TypeError
    const clickMenu = () => { const b = menuBtn(); if (b) b.click(); };
    const rightClickCell = (el, x, y) => {
      const ev = new MouseEvent("contextmenu", { clientX: x, clientY: y, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev;
    };
    const listed = async (name) => {
      const j = await (await fetch("/ps/media?type=image&tab=all")).json();
      return (j.items || []).some((i) => i.name === name);
    };
    const rc = rightClickCell(cellOf("small.webp"), 300, 300);
    test("右键阻止浏览器默认菜单", rc.defaultPrevented);
    test("右键出删除菜单", menuBtn() ? menuBtn().textContent : null, "删除");
    clickMenu();
    await sleep(60);
    test("第一次点只进入确认态，不删", menuBtn() ? menuBtn().textContent : null, "确认删除?");
    test("确认态白字压错误色", menuBtn() ? getComputedStyle(menuBtn()).color : null, "rgb(255, 255, 255)");
    test("确认前文件还在清单里", await listed("small.webp"));
    test("确认前格子还在", !!cellOf("small.webp"));
    clickMenu();
    await sleep(400);
    test("确认后文件从清单消失", !(await listed("small.webp")));
    test("确认后格子移除", !cellOf("small.webp"));
    test("删除后菜单收起", !menu());
    test("删除成功有可见提示",
         (document.querySelector(".kd-toast") || {}).textContent,
         "已删除 small.webp（进回收站，可捞回）。");
    const trash = await (await fetch("/trash.json")).json();
    test("文件真的进了回收站（可捞回）",
         (trash.items || []).some((p) => /^media\/input\/small\..+\.webp$/.test(p)));
    // 超时回退：armed 后 2.5s 不点第二下，回到「删除」，文件不动
    rightClickCell(cellOf("tiny.gif"), 320, 320);
    clickMenu();
    await sleep(2700);
    test("超过 2.5s 确认态自动回退", menuBtn() ? menuBtn().textContent : null, "删除");
    test("回退后文件没被删", await listed("tiny.gif"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    test("Esc 收起菜单", !menu());
    rightClickCell(cellOf("tiny.gif"), 320, 320);
    document.dispatchEvent(new MouseEvent("mousedown", { clientX: 5, clientY: 5, bubbles: true }));
    test("点菜单外收起", !menu());
    // 后端还没这条路由（没重启）：给明确提示，而不是笼统失败，也不动文件
    window.__blockDelete = true;
    rightClickCell(cellOf("tiny.gif"), 320, 320);
    clickMenu();
    await sleep(50);
    clickMenu();
    await sleep(300);
    test("后端没路由时提示重启",
         (document.querySelector(".kd-toast") || {}).textContent,
         "删除需要重启一次 ComfyUI（桥接路由还没注册）。");
    test("没路由时文件不动", await listed("tiny.gif"));
    window.__blockDelete = false;
    lib2.querySelector(".kd-btn").click();
    test("关库同时收掉菜单", !document.querySelector(".kd-lib") && !menu());

    // ---------------------------------------------------------------- 批次快照与交互锁
    const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status });
    const tapCell = (el, shift = false) => {
      el.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 20, clientY: 20, shiftKey: shift, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 20, clientY: 20, shiftKey: shift, bubbles: true }));
    };
    const confirmDelete = async () => {
      rightClickCell(document.querySelector(".kd-lib .kd-cell[data-kd-pick-key='input|tiny.gif']"));
      const b = document.querySelector(".kd-menu button");
      b.click(); await sleep(20); b.click(); await sleep(20);
    };
    const batchNode = () => {
      const n = makeNode(["wide.png", "rot.jpg", "gen.png"], {
        batch: true, select: true, picked: ["rot.jpg", "wide.png"],
      });
      const ui = n._kdUI;
      ["libBtn", "setsBtn", "clearBtn", "upBtn"].forEach((name) => {
        ui[name] = document.createElement("button");
      });
      ui.fileEl = document.createElement("input");
      T.renderPanel(n);
      app.graph._nodes = [n];
      return n;
    };
    const oldQueue = app.queuePrompt;
    try {
      const bn = batchNode();
      const releases = [], queued = [];
      app.queuePrompt = () => new Promise((resolve) => releases.push(resolve));
      const job = T.runBatch(bn);
      await sleep(0);
      test("批次开始后关键交互全部禁用", ["libBtn", "setsBtn", "clearBtn", "upBtn", "runBtn", "swBatchCb", "swSelCb"]
        .every((k) => bn._kdUI[k].disabled), true);
      test("批次开始后网格 inert", bn._kdUI.body.inert, true);
      // 即使用脚本绕过 disabled 点删除，处理器也必须拒绝，不能悄悄改冻结快照。
      bn._kdUI.body.querySelector(".kd-x").click();
      for (let i = 0; i < 2; i++) {
        queued.push(JSON.parse(bn.widgets[0].value));
        releases.shift()(); await sleep(0);
      }
      await job;
      test("批次每轮从冻结 picked 顺序取图", queued.map((s) => [s.cursor, s.select, s.picked]), [
        [0, true, ["rot.jpg", "wide.png"]], [1, true, ["rot.jpg", "wide.png"]],
      ]);
      test("批次结束后恢复交互", bn._kdUI.body.inert && bn._kdUI.libBtn.disabled, false);
      const after = T.readState(bn);
      test("批次结束保留冻结图片/选择", [after.images.length, after.picked, after.cursor], [3, ["rot.jpg", "wide.png"], 1]);

      // 外部路径绕过 UI 锁改状态时必须明确中止，并保留用户改动。
      const changed = batchNode();
      let releaseChanged;
      let changedCalls = 0;
      app.queuePrompt = () => {
        changedCalls++;
        return changedCalls === 1 ? new Promise((resolve) => { releaseChanged = resolve; }) : Promise.resolve();
      };
      const changedJob = T.runBatch(changed);
      await sleep(0);
      const userState = T.readState(changed);
      userState.picked = ["gen.png"];
      T.writeState(changed, userState);
      releaseChanged(); await changedJob;
      test("排队期间外部改状态会中止且不覆盖", [changedCalls, T.readState(changed).picked], [1, ["gen.png"]]);
      test("外部改状态给出可见错误", (document.querySelector(".kd-toast") || {}).textContent,
        "批次提交失败：排队期间图片设置被修改，批次已停止且未覆盖你的修改");

      // 节点在 await 期间被移除：不能继续排第二轮。
      const removed = batchNode();
      let releaseRemoved, removedCalls = 0;
      app.queuePrompt = () => {
        removedCalls++;
        return removedCalls === 1 ? new Promise((resolve) => { releaseRemoved = resolve; }) : Promise.resolve();
      };
      const removedJob = T.runBatch(removed);
      await sleep(0);
      app.graph._nodes = [];
      releaseRemoved(); await removedJob;
      test("节点移除后批次立即停止", removedCalls, 1);
      test("节点移除给出可见错误", (document.querySelector(".kd-toast") || {}).textContent,
        "批次提交失败：图片节点已被移除，批次已停止");

      // 真实 ComfyUI 的 false 表示已进入内部 queueItems：等 processor 读完本轮再推进 cursor。
      const busy = batchNode(), busyStates = [];
      const oldProcessing = app.processingQueue;
      let busyCalls = 0;
      app.processingQueue = true;
      app.queuePrompt = () => {
        busyCalls++;
        busyStates.push([JSON.parse(busy.widgets[0].value).cursor, app.processingQueue]);
        if (busyCalls === 1) {
          setTimeout(() => { app.processingQueue = false; }, 30);
          return Promise.resolve(false);
        }
        return Promise.resolve(true);
      };
      await T.runBatch(busy);
      test("queuePrompt=false 时等待内部队列处理完再推进", busyStates, [[0, true], [1, false]]);
      app.processingQueue = oldProcessing;

      const rejected = batchNode();
      let rejectedCalls = 0;
      app.processingQueue = undefined;
      app.queuePrompt = () => { rejectedCalls++; return Promise.resolve(false); };
      await T.runBatch(rejected);
      test("无 processor 的 false 明确停止且不误报成功", rejectedCalls, 1);
      test("拒绝提交有可见错误", (document.querySelector(".kd-toast") || {}).textContent,
        "批次提交失败：ComfyUI 拒绝了这次批次提交");
      app.processingQueue = oldProcessing;

      const invalid = batchNode();
      let invalidCalls = 0;
      const oldErrors = app.lastNodeErrors;
      app.processingQueue = true;
      app.lastNodeErrors = [{ message: "validation failed" }];
      app.queuePrompt = () => {
        invalidCalls++;
        setTimeout(() => { app.processingQueue = false; }, 20);
        return Promise.resolve(false);
      };
      await T.runBatch(invalid);
      test("全局 lastNodeErrors 不干扰已入队批次", invalidCalls, 2);
      test("全局错误不误报本次拒绝", ((document.querySelector(".kd-toast") || {}).textContent || "").includes("拒绝"), false);
      app.lastNodeErrors = oldErrors;
      app.processingQueue = oldProcessing;
    } finally {
      app.queuePrompt = oldQueue;
      app.graph._nodes = [];
    }

    // ---------------------------------------------------------------- 同名媒体选择 / output 转 input
    await fetch("/reset", { method: "POST" });
    let libraryPick = null;
    T.openLibrary((list) => { libraryPick = list; });
    await sleep(450);
    let libSame = document.querySelector(".kd-lib");
    const inBoth = libSame.querySelector("[data-kd-pick-key='input|both.png']");
    const outBoth = libSame.querySelector("[data-kd-pick-key='output|both.png']");
    test("同名 input/output 有不同选择键", [inBoth.dataset.kdPickKey, outBoth.dataset.kdPickKey],
      ["input|both.png", "output|both.png"]);
    test("旧 data-kd-key 选择器仍兼容", libSame.querySelectorAll("[data-kd-key='both.png']").length, 2);
    tapCell(inBoth); tapCell(outBoth);
    test("同名两项可同时选中", [inBoth.style.outline, outBoth.style.outline],
      ["2px solid var(--p-primary-color,#4a7dff)", "2px solid var(--p-primary-color,#4a7dff)"]);
    window.__blockPick = true;
    libSame.querySelector(".kd-libfoot .kd-p").click();
    await sleep(80);
    test("output 转换失败不关闭选择器", !!document.querySelector(".kd-lib"), true);
    test("output 转换失败有可见错误", document.querySelector(".kd-toast").classList.contains("kd-err"), true);
    test("output 转换走已有 pick 路由", window.__pickCalls.filter((u) => u.indexOf("/ps/media/pick") >= 0).length, 2);
    window.__blockPick = false;
    libSame.querySelector(".kd-libfoot .kd-p").click();
    await sleep(500);
    test("确定后 output 使用转换出的 input 文件名", libraryPick && libraryPick.map((x) => x.filename),
      ["both.png", "both_库1.png"]);
    test("成功后选择器关闭", !!document.querySelector(".kd-lib"), false);
    await fetch("/ps/media/delete", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "both_库1.png", subfolder: "", tab: "input" }) });

    await fetch("/reset", { method: "POST" });
    const pickBase = window.__pickCalls.length;
    window.__pickFailAt = pickBase + 2;
    T.openLibrary((list) => { libraryPick = list; });
    await sleep(450);
    libSame = document.querySelector(".kd-lib");
    tapCell(libSame.querySelector("[data-kd-pick-key='output|both.png']"));
    tapCell(libSame.querySelector("[data-kd-pick-key='output|gen.png']"));
    libSame.querySelector(".kd-libfoot .kd-p").click();
    await sleep(150);
    test("第二项转换失败时选择器保持打开", !!document.querySelector(".kd-lib"), true);
    libSame.querySelector(".kd-libfoot .kd-p").click();
    await sleep(500);
    test("重试不重复复制已成功输出文件", [window.__pickCalls.length - pickBase,
      libraryPick && libraryPick.map((x) => x.filename),
      libraryPick && libraryPick.some((x) => x.filename === "both_库2.png")],
      [3, ["both_库1.png", "gen.png"], false]);
    window.__pickFailAt = 0;
    for (const name of ["both_库1.png", "gen.png"]) {
      await fetch("/ps/media/delete", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, subfolder: "", tab: "input" }) });
    }
    await fetch("/reset", { method: "POST" });

    // 删除选中项只清理对应 tab，不能把另一目录的同名选择也删掉。
    T.openLibrary(() => {});
    await sleep(450);
    libSame = document.querySelector(".kd-lib");
    tapCell(libSame.querySelector("[data-kd-pick-key='input|both.png']"));
    tapCell(libSame.querySelector("[data-kd-pick-key='output|both.png']"));
    rightClickCell(libSame.querySelector("[data-kd-pick-key='input|both.png']"));
    const delSame = document.querySelector(".kd-menu button");
    delSame.click(); await sleep(20); delSame.click(); await sleep(300);
    test("删除同名 input 后 output 格子仍在", !!libSame.querySelector("[data-kd-pick-key='output|both.png']"), true);
    test("删除同名 input 后 output 选择仍在", libSame.querySelector("[data-kd-pick-key='output|both.png']").style.outline,
      "2px solid var(--p-primary-color,#4a7dff)");
    libSame.querySelector(".kd-libtop > .kd-btn, .kd-libfoot .kd-btn").click();

    // ---------------------------------------------------------------- 删除乱序回调不污染新视图/新菜单
    await fetch("/reset", { method: "POST" });
    T.openLibrary(() => {});
    await waitFor(() => document.querySelector(".kd-lib .kd-cell[data-kd-pick-key='input|tiny.gif']"));
    window.__holdDelete = true;
    await confirmDelete();
    test("删除请求已挂起", window.__deleteRequests.length, 1);
    const pendingDelete = window.__deleteRequests.shift();
    const search = document.querySelector(".kd-libtop input");
    const previousGrid = document.querySelector(".kd-lib .kd-grid");
    search.value = "tiny"; search.dispatchEvent(new Event("input", { bubbles: true }));
    const freshTiny = await waitFor(() => {
      const grid = document.querySelector(".kd-lib .kd-grid");
      const cell = document.querySelector(".kd-lib [data-kd-pick-key='input|tiny.gif']");
      return cell && grid && grid !== previousGrid ? cell : null;
    });
    rightClickCell(freshTiny);                 // 等待期间新开一个菜单
    const freshMenu = document.querySelector(".kd-menu");
    const realDelete = await fetch(pendingDelete.url, pendingDelete.opts);
    pendingDelete.resolve(realDelete);
    await sleep(100);
    window.__holdDelete = false;
    test("旧删除响应不关掉新菜单", document.querySelector(".kd-menu") === freshMenu, true);
    test("旧删除响应不删新视图格子", !!document.querySelector(".kd-lib [data-kd-pick-key='input|tiny.gif']"), true);
    document.querySelector(".kd-lib").querySelector(".kd-libfoot .kd-btn").click();

    // ---------------------------------------------------------------- 打包 await 后工作流竞态
    const savesBefore = window.__packSaves;
    app.graph.id = "graph-old";
    T.setPackGraph("graph-old");
    let releaseGraph;
    app.graphToPrompt = () => new Promise((resolve) => { releaseGraph = resolve; });
    const genBtn = { disabled: false, textContent: "" }, genErr = { textContent: "" };
    const genJob = T.doGenerate({
      rows: [{ cb: { checked: true }, c: { node: "1", input: "text", label: "old" }, lab: { value: "" }, sel: { value: "text" } }],
      nameInput: { value: "race" }, descInput: { value: "" }, err: genErr, gen: genBtn,
      graphCb: { checked: true }, order: () => [], editing: () => null, groups: () => [], refreshList() {},
    });
    await sleep(0);
    app.graph.id = "graph-new";
    releaseGraph({ output: { "1": { class_type: "OldNode" } } });
    await genJob;
    test("打包 await 期间换图不提交旧候选", window.__packSaves, savesBefore);
    test("打包竞态恢复按钮", genBtn.disabled, false);
    test("打包竞态有明确错误", genErr.textContent, "工作流已切换，请重新打开打包面板再生成。");

    // ---------------------------------------------------------------- 贴位几何
    hover(cells()[0], window.innerWidth - 12, window.innerHeight - 12);
    c = await waitNum();
    await sleep(120);
    const r = zoom().getBoundingClientRect();
    test("贴到右下角时整层仍在视口内",
         r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5 &&
         r.left >= -0.5 && r.top >= -0.5);
    test("尺寸条真的有高度（没被裁掉）", c ? c.getBoundingClientRect().height > 8 : false);
    leave(cells()[0]);

    // ---------------------------------------------------------------- 长文件名不撑破悬浮层
    const longHost = document.createElement("div");
    longHost.style.cssText = "position:fixed;left:10px;top:10px;width:80px;height:60px;";
    document.body.appendChild(longHost);
    const longName = fx.longName;
    if (T.attachZoom) {
      T.attachZoom(longHost, T.thumbUrl(longName, "", 512, "input", "raw"),
                   { name: longName, sub: "", tab: "input", bucket: 1024 });
    }
    longHost.dispatchEvent(new MouseEvent("mouseenter", { clientX: 40, clientY: 40 }));
    longHost.dispatchEvent(new MouseEvent("mousemove", { clientX: 40, clientY: 40 }));
    await waitFor(() => {
      const z = zoom(), n = z && z.querySelector(".kd-zname");
      const row = z && (z.querySelector(".kd-zdim") || z);
      const d = row && row.querySelector(".kd-zd");
      return z && n && n.scrollWidth > n.clientWidth && d && d.textContent ? z : null;
    });
    const lz = zoom();
    const lnm = lz ? lz.querySelector(".kd-zname") : null;
    test("长文件名也进同一条信息", lnm ? lnm.textContent : null, longName);
    test("长文件名走省略号，不撑宽悬浮层",
         lnm ? (lnm.scrollWidth > lnm.clientWidth &&
                lz.getBoundingClientRect().width <= 348.5) : false);
    test("长文件名时尺寸行仍完整可见", dim(cap()), "1600 × 900");
    longHost.dispatchEvent(new MouseEvent("mouseleave"));
    longHost.remove();

    // ---------------------------------------------------------------- promptlib：控件重查 / 缓存 / 提交快照
    window.__promptControl = true;
    const P = await import("/promptlib.js?races=" + Date.now()).then((m) => m.__promptTools || window.__promptTools);
    const drainPromptReplies = (data) => {
      const reqs = window.__promptRequests.splice(0);
      reqs.forEach((r) => r.resolve(jsonResponse(data || { ok: true, items: [], groups: [], categories: [] })));
    };
    const PNode = function () {};
    PNode.comfyClass = "KedouPromptBox";
    const oldUsage = { name: "usage", value: "文生图", options: {} };
    const pnode = {
      id: 701, constructor: PNode, size: [440, 430], widgets: [
        { name: "prompt_state", value: "initial prompt", options: {} }, oldUsage,
      ],
      setDirtyCanvas() {}, setSize(s) { this.size = s; },
      addDOMWidget(_name, _type, el) { document.getElementById("host").appendChild(el); },
      onConfigure: null,
    };
    app.graph._nodes = [pnode];
    P.buildPromptBox(pnode);
    await sleep(0);
    drainPromptReplies();
    const newUsage = { name: "usage", value: "文生视频", options: {} };
    pnode.widgets = [{ name: "prompt_state", value: "loaded prompt", options: {} }, newUsage];
    pnode.onConfigure();
    await sleep(20);
    test("onConfigure 重查替换后的 usage 控件", pnode.__kdPbox.useSel.value, "文生视频");
    pnode.__kdPbox.useSel.value = "图生视频";
    pnode.__kdPbox.useSel.dispatchEvent(new Event("change"));
    test("onchange 写当前 usage 控件", newUsage.value, "图生视频");
    test("onchange 不写旧 usage 控件", oldUsage.value, "文生图");

    const papi = new EventTarget();
    let queueIds = ["p1", "pa", "pb"];
    let pendingReply = null, releaseReply = null;
    let linkedPrompt = false;
    const apiGraph = () => ({ [pnode.id]: { class_type: "KedouPromptBox", inputs: {
      prompt_state: linkedPrompt ? ["upstream", 0] : pnode.widgets.find((w) => w.name === "prompt_state").value,
      usage: pnode.widgets.find((w) => w.name === "usage").value,
    } } });
    app.api.queuePrompt = () => pendingReply
      ? new Promise((resolve) => { releaseReply = resolve; })
      : Promise.resolve({ prompt_id: queueIds.shift() });
    // 真实 1.55：app.queuePrompt 返回 boolean，prompt_id 只从 api.queuePrompt 返回。
    app.queuePrompt = async () => { await app.api.queuePrompt(0, { output: apiGraph() }); return true; };
    P.hookHistory(app, papi);
    localStorage.setItem("kedou_plib_hist", "1");
    window.__historyPosts = [];
    const start = (pid) => {
      papi.dispatchEvent(new CustomEvent("execution_start", { detail: { prompt_id: pid } }));
      papi.dispatchEvent(new CustomEvent("executing", { detail: { prompt_id: pid, node: pnode.id } }));
    };
    const success = (pid) => { start(pid); papi.dispatchEvent(new CustomEvent("execution_success", { detail: { prompt_id: pid } })); };
    pnode.__kdPbox.ta.value = "submitted original prompt"; pnode.__kdPbox.sync();
    await app.queuePrompt();
    pnode.__kdPbox.ta.value = "modified after submission"; pnode.__kdPbox.sync();
    success("p1"); await sleep(30);
    test("自动历史记提交快照而非当前画布", window.__historyPosts.map((x) => x.positive), ["submitted original prompt"]);
    test("自动历史记提交时 usage", window.__historyPosts[0].usage, "图生视频");
    pnode.__kdPbox.ta.value = "batch first prompt"; pnode.__kdPbox.sync(); await app.queuePrompt();
    pnode.__kdPbox.ta.value = "batch second prompt"; pnode.__kdPbox.sync(); await app.queuePrompt();
    pnode.__kdPbox.ta.value = "never submitted current prompt"; pnode.__kdPbox.sync();
    start("pa"); start("pb");
    papi.dispatchEvent(new CustomEvent("execution_success", { detail: { prompt_id: "pa" } })); await sleep(20);
    papi.dispatchEvent(new CustomEvent("execution_success", { detail: { prompt_id: "pb" } })); await sleep(20);
    test("交错执行各 prompt 不串用 ran 集合", window.__historyPosts.map((x) => x.positive),
      ["submitted original prompt", "batch first prompt", "batch second prompt"]);

    // 成功事件先于队列 HTTP 响应：响应到达后必须补记，不能永久丢弃。
    pendingReply = true;
    pnode.__kdPbox.ta.value = "early success prompt"; pnode.__kdPbox.sync();
    const earlyJob = app.queuePrompt();
    await sleep(0);
    success("early"); await sleep(20);
    test("早到成功事件暂存等待快照", window.__historyPosts.length, 3);
    releaseReply({ prompt_id: "early" }); pendingReply = null;
    await earlyJob; await sleep(30);
    test("快照到达后补记早到成功", window.__historyPosts.map((x) => x.positive),
      ["submitted original prompt", "batch first prompt", "batch second prompt", "early success prompt"]);
    success("external-without-snapshot"); await sleep(20);
    test("无匹配快照不硬记当前画布", window.__historyPosts.length, 4);

    linkedPrompt = true;
    pnode.__kdPbox.ta.value = "stale local prompt"; pnode.__kdPbox.sync();
    queueIds.push("linked"); await app.queuePrompt(); success("linked"); await sleep(30);
    test("连线驱动 prompt_state 不记录陈旧本地文本", window.__historyPosts.length, 4);
    linkedPrompt = false;

    pnode.__kdPbox.ta.value = "long running prompt"; pnode.__kdPbox.sync();
    queueIds.push("long"); await app.queuePrompt(); start("long");
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    start("prune-trigger");
    Date.now = realNow;
    success("long"); await sleep(30);
    test("运行超过TTL的任务成功仍记历史", window.__historyPosts.some((x) => x.positive === "long running prompt"), true);

    for (let i = 0; i < 300; i++) {
      papi.dispatchEvent(new CustomEvent("execution_error", { detail: { prompt_id: "failed-" + i } }));
    }
    test("错误终态集合保持有界", P.completed() <= 256, true);
    for (let i = 0; i < 300; i++) {
      papi.dispatchEvent(new CustomEvent("execution_start", { detail: { prompt_id: "running-" + i } }));
    }
    test("无终态执行集合保持有界", P.running() <= 256, true);
    await sleep(1000);              // 等历史写入触发的 libTouch 完成
    drainPromptReplies();
    await sleep(50);
    drainPromptReplies();

    const cacheCases = [
      [P.libStore, "/ps/prompts"], [P.phraseStore, "/ps/prompts/phrases"],
      [P.histStore, "/ps/prompts/history"], [P.setsStore, "/ps/image-sets"],
    ];
    for (const [store, url] of cacheCases) {
      const first = store.load(true), second = store.load(true);
      const reqs = window.__promptRequests.filter((r) => r.url === url);
      const older = reqs[0], newer = reqs[reqs.length - 1];
      newer.resolve(jsonResponse({ ok: true, items: ["new"] }));
      await sleep(0);
      older.resolve(jsonResponse({ ok: true, items: ["old"] }));
      const values = await Promise.all([first, second]);
      const cached = await store.load(false);
      test("分类缓存旧响应不覆盖新值 " + url, [values[0], values[1].items, cached.items], [null, ["new"], ["new"]]);
      store.invalidate();
      const beforeShared = window.__promptRequests.filter((r) => r.url === url).length;
      const shared1 = store.load(false), shared2 = store.load(false);
      const sharedReqs = window.__promptRequests.filter((r) => r.url === url);
      test("普通缓存读取共享一个在途请求 " + url, sharedReqs.length - beforeShared, 1);
      sharedReqs[sharedReqs.length - 1].resolve(jsonResponse({ ok: true, items: ["shared"] }));
      test("共享请求双方都拿到数据 " + url, (await Promise.all([shared1, shared2])).map((x) => x.items), [["shared"], ["shared"]]);

      store.invalidate();
      const stale = store.load(false);
      const staleReqs = window.__promptRequests.filter((r) => r.url === url);
      const staleReq = staleReqs[staleReqs.length - 1];
      store.invalidate();
      const fresh = store.load(false);
      const freshReqs = window.__promptRequests.filter((r) => r.url === url);
      const freshReq = freshReqs[freshReqs.length - 1];
      freshReq.resolve(jsonResponse({ ok: true, items: ["fresh"] }));
      const freshValue = await fresh;
      staleReq.resolve(jsonResponse({ ok: true, items: ["stale"] }));
      const staleValue = await stale;
      test("invalidate 后不复用旧在途请求 " + url, [staleValue, freshValue.items, (await store.load(false)).items],
        [null, ["fresh"], ["fresh"]]);
    }

    // reload 的子请求在 Promise.all 前不得写 libData/loc；旧一轮全部完成后仍保持新数据。
    P.openLib(pnode, "prompts");
    await sleep(0);
    P.refresh(true);
    await sleep(0);
    const primaryUrls = ["/ps/prompts", "/ps/prompts/phrases", "/ps/image-sets", "/ps/prompts/history"];
    for (const url of primaryUrls) {
      const reqs = window.__promptRequests.filter((r) => r.url === url);
      const newer = reqs[reqs.length - 1];
      newer.resolve(jsonResponse({ ok: true, items: ["new-" + url], groups: ["new-group"],
        categories: [{ group: "new-group", name: "new-cat" }], vault: "D:/new" }));
    }
    await sleep(30);
    test("reload 新一波统一提交四类数据", primaryUrls.map((url) => P.data()[
      url === "/ps/prompts" ? "prompts" : url === "/ps/prompts/phrases" ? "phrases" :
      url === "/ps/image-sets" ? "sets" : "history"][0]), primaryUrls.map((url) => "new-" + url));
    test("reload 默认分类来自新结果", [P.state().phraseGroup, P.state().phraseCat], ["new-group", "new-cat"]);
    window.__promptRequests.splice(0).forEach((r) => r.resolve(jsonResponse({ ok: true,
      items: ["old"], groups: ["old-group"], categories: [], vault: "D:/old" })));
    await sleep(30);
    test("reload 旧一波不污染数据/位置/分类", [P.data().prompts[0], P.state().phraseGroup,
      (document.querySelector(".kd-plib-vault") || {}).textContent], ["new-/ps/prompts", "new-group", "D:/new默认位置"]);
    P.closeLib(true);
    window.__promptControl = false;

    // ---------------------------------------------------------------- i18n 语言请求竞态 / 英文回退
    const i18nRequests = [], i18nChanges = [];
    const i18nListeners = new Map();
    const i18nApi = {
      ui: { settings: { getSettingValue: async () => "en" } },
      api: { addEventListener: (type, fn) => i18nListeners.set(type, fn) },
    };
    window.__i18nApp = i18nApi;
    window.__i18nFetch = () => new Promise((resolve, reject) => i18nRequests.push({ resolve, reject }));
    const I = await import("/i18n-test.js?races=" + Date.now());
    I.onLocaleChange((loc) => i18nChanges.push(loc));
    await I.initI18n(i18nApi);
    test("en 快速路径不发语言包请求", i18nRequests.length, 0);
    const setLocale = (loc) => i18nListeners.get("SettingChanged")(["Comfy.Locale", loc]);
    setLocale("zh"); setLocale("en"); await sleep(0);
    i18nRequests.shift().resolve(jsonResponse({ ok: true, messages: { Hello: "你好" } }));
    await sleep(0);
    test("切回 en 后旧中文响应不能生效", [I.locale(), I.t("Hello"), i18nChanges.length], ["en", "Hello", 0]);
    setLocale("zh"); setLocale("zh-TW"); await sleep(0);
    i18nRequests[1].resolve(jsonResponse({ ok: true, messages: { Hello: "繁體" } }));
    await sleep(0);
    i18nRequests[0].resolve(jsonResponse({ ok: true, messages: { Hello: "简体" } }));
    await sleep(0);
    test("只允许最新语言请求写 dict", [I.locale(), I.t("Hello"), i18nChanges], ["zh-TW", "繁體", ["zh-TW"]]);
    setLocale("zh"); await sleep(0);
    i18nRequests[2].reject(new Error("offline")); await sleep(0);
    test("语言包失败回落英文但仍通知生效语言", [I.locale(), I.t("Hello"), i18nChanges.length], ["zh", "Hello", 2]);
    setLocale("en"); await sleep(0);
    test("英文快速路径不请求且通知一次", [I.locale(), i18nRequests.length, i18nChanges.length], ["en", 3, 3]);
  } catch (e) {
    results.push({ name: "运行中抛异常", pass: false, actual: String(e && e.stack || e), expected: "无异常" });
  }

  const bad = results.filter((r) => !r.pass);
  out.textContent = "RESULT" + JSON.stringify({ total: results.length, failed: bad.length, bad, all: results });
})();
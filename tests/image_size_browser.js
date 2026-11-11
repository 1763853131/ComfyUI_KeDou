// 悬浮显示原图尺寸 —— 真浏览器里的交互断言（配 tests/serve_image_size.py 跑）
//
// 正向：/module.js（改动后）应当全绿。
// 反向：/before.js（改动前的备份）跑同一套，必须逐条失败 —— 证明这些断言真的在测新行为。
// 所有期望的像素值都来自 /fixtures.json（后端造图时的真实尺寸 + 后端 bucket_size 的结果），
// 不拿前端自己的计算当期望值。
(async function () {
  const T = window.__kdTools || {};
  const host = document.getElementById("host");
  const out = document.getElementById("out");
  const results = [];
  const test = (name, actual, expected = true) => results.push({
    name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
        images: images.map((f) => ({ filename: f })), batch: false, cursor: 0,
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
    T.ensureCss();
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
    await sleep(300);
    const lz = zoom();
    const lnm = lz ? lz.querySelector(".kd-zname") : null;
    test("长文件名也进同一条信息", lnm ? lnm.textContent : null, longName);
    test("长文件名走省略号，不撑宽悬浮层",
         lnm ? (lnm.scrollWidth > lnm.clientWidth &&
                lz.getBoundingClientRect().width <= 348.5) : false);
    test("长文件名时尺寸行仍完整可见", dim(cap()), "1600 × 900");
    longHost.dispatchEvent(new MouseEvent("mouseleave"));
    longHost.remove();
  } catch (e) {
    results.push({ name: "运行中抛异常", pass: false, actual: String(e && e.stack || e), expected: "无异常" });
  }

  const bad = results.filter((r) => !r.pass);
  out.textContent = "RESULT" + JSON.stringify({ total: results.length, failed: bad.length, bad, all: results });
})();
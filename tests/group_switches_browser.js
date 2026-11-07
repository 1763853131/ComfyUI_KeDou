export async function runGroupSwitchTests(before = false) {
  const { app: realApp } = await import("/scripts/app.js");
  const base = "http://127.0.0.1:8896";
  // 每轮用新应用名：sidecar 里上一轮存过的开关状态不该影响这一轮的「打包默认值」断言
  const appId = "group-ui-" + Date.now();
  const dict = await (await fetch(base + "/locale")).json();
  const graph = new realApp.graph.constructor();
  const source = LiteGraph.createNode("EmptyImage");
  const first = LiteGraph.createNode("ImageScaleBy");
  const second = LiteGraph.createNode("ImageScaleBy");
  const sink = LiteGraph.createNode("SaveImage");
  for (const node of [source, first, second, sink]) graph.add(node);
  [source, first, second, sink].forEach((node, index) => { node.pos = [index * 450, 400]; node.updateArea(); });
  source.connect(0, first, 0); first.connect(0, second, 0); second.connect(0, sink, 0);
  [first, second].forEach((node, index) => {
    const group = new LGraphGroup("处理组 " + (index + 1));
    graph.add(group);
    const r = node.boundingRect;
    group.setBounds(r[0] - 30, r[1] - 30, r[2] + 60, r[3] + 60);
  });
  window.__groupTestApp = {
    graph, rootGraph: graph, canvas: { selected_nodes: null },
    graphToPrompt: (other = graph) => realApp.graphToPrompt(other),
    workflowManager: { activeWorkflow: { name: appId } },
    extensionManager: {}, registerExtension() {},
  };
  const posted = [];
  window.__groupTestFetch = async (url, options) => {
    if (url === "/ps/pack/save") posted.push(JSON.parse(options.body));
    return fetch(base + url, options);
  };
  window.__groupTestTranslate = (key, args = {}) => {
    let value = dict[key] || key;
    for (const [name, replacement] of Object.entries(args)) value = value.replaceAll("{" + name + "}", replacement);
    return value;
  };
  const oldHost = document.getElementById("group-switch-test");
  if (oldHost) oldHost.remove();
  document.getElementById("kp-css-group-test")?.remove();
  const host = document.createElement("div");
  host.id = "group-switch-test";
  host.style.cssText = "position:fixed;right:0;top:0;width:400px;height:100vh;z-index:100000;background:var(--interface-panel-surface,#171718);overflow:auto";
  document.body.appendChild(host);
  await import(base + (before ? "/before.js" : "/module.js") + "?run=" + Date.now());
  const tools = window.__groupTools;
  // 页面里已有部署版插件注入的 #kp-css，ensurePackCss 会直接跳过；被测模块的样式单独挂一份
  const style = document.createElement("style");
  style.id = "kp-css-group-test";
  style.textContent = tools.kpCss;
  document.head.appendChild(style);
  tools.openPackPanel(host);
  const results = [];
  const test = (name, actual, expected = true) => results.push({ name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  test("分组框只收自己的节点", (tools.kpGroupCandidates || (() => null))()?.map((item) => item.nodes), [[String(first.id)], [String(second.id)]]);
  const add = host.querySelector(".kp-group-add");
  test("添加分组开关入口", !!add);
  if (!add) return { results, failed: results.filter((item) => !item.pass) };
  for (let i = 0; i < 2; i++) {
    add.click();
    const select = host.querySelector(".kp-group-select");
    test("候选排除已添加分组 " + i, select.options.length, 3 - i);
    select.value = select.options[1].value;
    select.dispatchEvent(new Event("change"));
  }
  test("两个分组行", host.querySelectorAll(".kp-group-row").length, 2);
  test("没有普通参数也可生成", host.querySelector(".kp-gen").disabled, false);
  const firstRow = host.querySelector(".kp-group-row");
  const label = firstRow.querySelector(".kp-group-name");
  label.value = "超分 <img src=x>";
  label.dispatchEvent(new Event("input"));
  const checkbox = firstRow.querySelector(".kp-group-default");
  checkbox.click();
  test("关闭默认值更新预览", host.querySelectorAll(".kp-pv-sw.kp-on").length, 1);
  test("名称不生成HTML", host.querySelectorAll(".kp-pv-group img").length, 0);
  const rowBox = firstRow.getBoundingClientRect();
  const delBox = firstRow.querySelector(".kp-pdel").getBoundingClientRect();
  test("分组行用网格布局", getComputedStyle(firstRow).display, "grid");
  test("删除按钮贴右边缘", Math.round(rowBox.right - delBox.right) <= 10);
  const swOn = host.querySelector(".kp-pv-sw.kp-on");
  const swOff = host.querySelector(".kp-pv-sw:not(.kp-on)");
  test("开关状态有视觉区分", !!swOn && !!swOff
    && getComputedStyle(swOn).backgroundColor !== getComputedStyle(swOff).backgroundColor
    && getComputedStyle(swOn, ":after").left !== getComputedStyle(swOff, ":after").left);
  const original = JSON.stringify(graph.serialize());
  const switches = Array.from(host.querySelectorAll(".kp-group-row"), (row) => ({
    id: row.dataset.group, label: row.querySelector(".kp-group-name").value,
    default: row.querySelector(".kp-group-default").checked,
    mode: row.querySelector(".kp-group-mode").value,
  }));
  first.mode = 4;
  const modeSnapshot = first.mode;
  const built = await tools.kpGroupPrompt(switches);
  test("默认已旁路节点仍完整打包", !!built.output[String(first.id)]);
  test("打包不改画布mode", first.mode, modeSnapshot);
  first.mode = 0;
  test("打包不改画布工作流", JSON.stringify(graph.serialize()), original);
  await tools.doGenerate({
    rows: [], groups: () => switches, nameInput: { value: appId }, descInput: { value: "分组执行回归" },
    err: host.querySelector(".kp-err"), gen: host.querySelector(".kp-gen"), editing: () => null,
  });
  test("保存已发送到隔离后端", posted.length, 1);
  const request = async (path, values) => (await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values }) })).json();
  const spec = await (await fetch(base + `/ps/apps/${appId}`)).json();
  test("应用显示两个开关", spec.params.length, 2);
  test("应用默认关闭保留", spec.params[0].default, false);
  test("应用复用布尔控件", spec.params.map((p) => p.widget), ["toggle", "toggle"]);
  const ids = switches.map((item) => "__group__:" + item.id);
  const active = await request(`/ps/apps/${appId}/graph`, { [ids[0]]: true, [ids[1]]: true });
  const bypass = await request(`/ps/apps/${appId}/graph`, { [ids[0]]: false, [ids[1]]: false });
  test("开启保留四个节点", Object.keys(active.graph).length, 4);
  test("关闭删除两个节点", Object.keys(bypass.graph).length, 2);
  test("串联旁路正确连回源节点", bypass.graph[String(sink.id)].inputs.images, [String(source.id), 0]);
  const native = new graph.constructor();
  native.configure(JSON.parse(JSON.stringify(graph.serialize())));
  native.getNodeById(first.id).mode = 4;
  native.getNodeById(second.id).mode = 4;
  const expected = await realApp.graphToPrompt(native);
  test("旁路结果等于原生ComfyUI图", bypass.graph, expected.output);
  native.clear();
  const saved = await request(`/ps/apps/${appId}/values`, { [ids[0]]: true, [ids[1]]: false });
  test("开关状态保存成功", saved.ok);
  const reloaded = await (await fetch(base + `/ps/apps/${appId}`)).json();
  test("重新打开应用恢复状态", reloaded.params.map((p) => p.default), [true, false]);
  const invalid = await request(`/ps/apps/${appId}/graph`, { [ids[0]]: "false" });
  test("字符串false不会被当作开启", invalid.ok, false);
  const pack = posted[0];
  pack.kapp.groups[0].mode = "mute";
  pack.target = `kedou_apps/${appId}.kapp.json`;
  await fetch(base + "/ps/pack/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pack) });
  const muted = await request(`/ps/apps/${appId}/graph`, { [ids[0]]: false, [ids[1]]: true });
  test("静音移除节点", String(first.id) in muted.graph, false);
  test("静音不误删下游节点", String(second.id) in muted.graph);
  test("静音移除断开的输入", "image" in muted.graph[String(second.id)].inputs, false);
  const unknown = await request(`/ps/apps/${appId}/graph`, { "__group__:missing": true });
  test("未知开关拒绝执行", unknown.ok, false);
  const postsBefore = posted.length;
  const editErr = document.createElement("div");
  await tools.doGenerate({
    rows: [], groups: () => [{ id: "group-new", label: "新组", default: true, mode: "bypass", nodes: [String(first.id)] }],
    nameInput: { value: appId }, descInput: { value: "" }, err: editErr,
    gen: { disabled: false, textContent: "" }, graphCb: { checked: false },
    editing: () => ({ kapp: pack.kapp, file: pack.target }),
  });
  test("不更新图时不写入新增分组", posted.length, postsBefore);
  test("不更新图时提示该勾哪个选项", editErr.textContent.includes("用当前工作流更新图"));
  const bounds = host.getBoundingClientRect();
  test("窄面板没有横向溢出", host.scrollWidth <= Math.ceil(bounds.width));
  window.__groupUiResult = { results, failed: results.filter((item) => !item.pass), fixtureGraph: graph, posted };
  return { total: results.length, failed: window.__groupUiResult.failed };
}

// 动态分组节点（LoadLoraModel）参数行的点选回归测试。
// 这类节点会把多行包在一个分组容器里：如果找行元素时一路走到分组外壳，
// 名称 / 强度 / 启用三个圆点会全映射到同一行，点哪个都只勾到 lora_name。

export async function runPackRowTests() {
  const widget = (name, type, value, options = {}, label) => ({ name, type, value, options, label });
  const node = {
    id: 901, type: "LoadLoraModel", title: "加载 LoRA（模型）", mode: 0,
    widgets: [
      widget("loras", "number", 1, { serialize: false }),
      widget("loras.$notice", "dynamic_group_notice", undefined, { serialize: false }),
      widget("loras.0", "dynamic_group_row", undefined, { serialize: false }),
      widget("loras.0.lora_name", "combo", "a.safetensors", { values: ["a.safetensors"] }, "LoRA #1 lora_name"),
      widget("loras.0.strength", "number", 1, { min: 0, max: 2, step: 0.01 }, "LoRA #1 strength"),
      widget("loras.0.enabled", "toggle", true, { on: "On", off: "Off" }, "LoRA #1 enabled"),
      widget("loras.$add", "button", undefined, {}),
    ],
    inputs: [
      { name: "loras.0.lora_name", widget: { name: "loras.0.lora_name" } },
      { name: "loras.0.strength", widget: { name: "loras.0.strength" } },
      { name: "loras.0.enabled", widget: { name: "loras.0.enabled" } },
    ],
  };
  const graph = {
    _nodes: [node], nodes: [node],
    getNodeById: (id) => (String(id) === String(node.id) ? node : null),
  };
  window.__groupTestApp = {
    graph, rootGraph: graph, canvas: {
      graph, canvas: document.createElement("canvas"),
      ds: { scale: 1, offset: [0, 0] },
    },
    graphToPrompt: async () => ({}),
    extensionManager: {}, workflowManager: {}, registerExtension() {},
  };
  window.__groupTestFetch = async () => new Response(
    JSON.stringify({ ok: true, apps: [] }),
    { headers: { "Content-Type": "application/json" } },
  );
  window.__groupTestTranslate = (key) => key;

  // 模仿真机 Vue 卡片：三个圆点分别在各自的行里，行外面还套着分组容器
  const card = document.createElement("div");
  card.setAttribute("data-node-id", String(node.id));
  card.innerHTML = '<div class="lg-node-widgets"><div class="lg-node-widget"><span>LoRA #1</span></div>'
    + ["名称", "强度", "启用"].map((text, i) =>
      '<div class="lg-node-widget"><span>' + text + '</span>'
      + '<div data-slot-key="' + node.id + '-in-' + i + '"></div></div>').join("")
    + "</div>";
  document.body.appendChild(card);

  const host = document.createElement("div");
  host.id = "pack-row-test";
  host.style.cssText = "position:fixed;left:0;top:0;width:380px;height:100vh;z-index:100000;overflow:auto";
  document.body.appendChild(host);

  const results = [];
  const test = (name, actual, expected = true) => results.push({
    name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected,
  });
  try {
    await import("http://127.0.0.1:8896/module.js?rows=" + Date.now());
    window.__groupTools.openPackPanel(host);
    const pick = host.querySelector(".kp-picktop .kp-tbtn");
    test("面板挂了点选开关", !!pick);
    pick.click();
    const rows = Array.from(card.querySelectorAll(".lg-node-widget"));
    for (const row of rows.slice(1)) {
      row.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true,
      }));
    }
    const keys = Array.from(host.querySelectorAll(".kp-pickrow")).map((el) => el.dataset.key).sort();
    test("三个圆点各自勾到自己那一行", keys,
      ["901|loras.0.enabled", "901|loras.0.lora_name", "901|loras.0.strength"].sort());
    pick.click();
  } finally {
    host.remove();
    card.remove();
  }
  return { total: results.length, failed: results.filter((item) => !item.pass) };
}

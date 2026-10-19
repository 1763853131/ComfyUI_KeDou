# ComfyUI_KeDou · 蝌蚪桥接

把 ComfyUI 里的工作流变成可点击的 **App**。

ComfyUI 本身没有"列出我的工作流和它们的参数"这样的接口，外部面板（启动器、Photoshop 面板等）拿不到数据。本插件补上这一层桥接：**列出应用 → 读取参数 → 持久化面板值（sidecar）→ 转成可直接提交的 API 格式 → 一键把工作流打包成应用包**。

> 纯 Python 标准库实现，无第三方依赖，一个文件夹即装即用。

---

## 安装

1. 把整个 `ComfyUI_KeDou/` 文件夹放进 `<ComfyUI>/custom_nodes/`
2. 重启 ComfyUI

```
custom_nodes/ComfyUI_KeDou/
├── __init__.py          # HTTP 路由 + 自定义节点
├── ui_to_api.py         # 界面格式 → API 格式转换
├── web/kedou_media.js   # 节点前端扩展（缩略图网格 / 媒体选择器）
├── pyproject.toml       # 节点元数据（Comfy Registry / Manager）
└── LICENSE
```

---

## 它提供什么

### 一、本地 HTTP 路由（挂在 ComfyUI 自己的端口上，默认 8188）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/ps/version` | GET | 协议握手：`schema_version` + 本版能力（sidecar / 转换缓存 / 写令牌） |
| `/ps/apps` | GET | 列出全部「应用」：`{id, name, desc, param_count, has_image_input, node_count, format}` |
| `/ps/apps/{app_id}` | GET | 取单个应用定义：参数列表 + 输出节点；参数默认值已叠加 sidecar 保存值 |
| `/ps/apps/{app_id}/values` | POST | 把面板上的编辑存到 sidecar 状态文件（**不改工作流文件**） |
| `/ps/apps/{app_id}/graph` | POST | 界面格式 → **API 格式**，返回可直接 `POST /prompt` 的图；转换结果按文件版本缓存 |
| `/ps/media` | GET | 列媒体文件：`?type=image\|video\|audio&tab=all\|input\|output&q=关键词` |
| `/ps/thumb` | GET | 真缩略图：`?filename=&subfolder=&type=&w=256`，webp 落盘缓存（ComfyUI 自带的 `/view?preview=` 只重编码不缩尺寸，一屏原图必卡） |
| `/ps/pack/candidates` | GET | 打包前：列出工作流里**可暴露成参数的控件候选** |
| `/ps/pack` | POST | 按已有工作流文件生成 `<stem>.kapp.json` 应用包 |
| `/ps/pack/save` | POST | 打包面板专用：前端已构好 API 图，这里只校验 + 落盘 |
| `/ps/prompts` | GET | 词库清单，连**实际读取的目录和它的来源**一起返回：`?use=文生图&q=关键词` |
| `/ps/prompts/save` \| `history` \| `delete` \| `use` | POST | 存条目 / 自动历史（hash 去重）/ 删除（进 `.trash`）/ 计次 |
| `/ps/prompts/vault` | POST | 改词库目录（写 `user/default/kedou_prompt_vault.txt`）；传空串回默认 |

### 二、自定义节点

| 节点 | 显示名 | 说明 |
|---|---|---|
| `KedouImageLoader` | 蝌蚪图片加载器 | 直接在节点上选图（缩略图网格，由 `web/kedou_media.js` 渲染），输出一批图像。 |
| `KedouPromptBox` | 蝌蚪提示词输入框 | 提示词输入 + 按用途过滤的词库（`web/promptlib.js`），直通输出 prompt。 |

---

## 提示词库

数据就是一条条 `.md`，没有数据库，Obsidian 装不装都不影响读写。

词库**逻辑**在 `prompt_vault/` 包里 —— 那是插件自带的一份 vendored 副本（上游是独立仓库，
改完用它的 `sync.py` 推过来），所以 clone 本插件即可用，不需要额外装什么。

词库**数据**的位置按这个顺序解析，谁装都先长在一个能用的地方，不写死任何人的盘符：

1. 环境变量 `KEDOU_PROMPT_VAULT`
2. `user/default/kedou_prompt_vault.txt` 首行 ← 词库面板底部「改路径」写的就是它
3. ComfyUI 设置项 `Kedou.PromptVault`（手改 `user/default/comfy.settings.json`）
4. 默认 `user/default/kedou_prompts`（第一次建库会投放 3 条示例讲格式）

面板底部常驻显示当前实际在读的目录和来源，指错了能立刻看出来。
排查或改逻辑时看 `prompt_vault/`，接口是上面那五个 `/ps/prompts*`。

---

## 两种「应用」来源

插件同时识别两种工作流，**同名时 `.kapp.json` 优先**：

|  | 官方应用模式 | 自研应用包 `.kapp.json` |
|---|---|---|
| **识别方式** | 文件名 `*.app.json`，或 `extra.linearMode == true` | `{"kedou_app": 1, ...}` |
| **参数定义** | `extra.linearData.inputs` 勾选（勾到哪个控件就叫什么名） | `params` 逐条声明 `node` + `input` + `widget` |
| **图格式** | 界面格式，每次运行都要做 UI→API 翻译 | **直接存 API 格式**，无翻译、无位置对位 |
| **参数** | `linearData` 勾选 | 显式声明 |
| **输出** | `extra.linearData.outputs` | 显式列出节点 id |

应用包长这样：

```json
{
  "kedou_app": 1,
  "name": "示例应用",
  "desc": "",
  "graph": { "3": { "class_type": "KSampler", "inputs": { } } },
  "params": [
    { "node": "6", "input": "text", "label": "提示词", "widget": "text", "default": "" }
  ],
  "outputs": ["9"]
}
```

> 设计取舍：官方应用模式有三笔"税"——参数靠勾选、`widgets_values` 按位置对位、每次运行都要翻译一遍。
> 应用包把这三样全部显式化，插件本身保持**纯通道**：声明是什么就是什么，不对任何具体应用做特判。

---

## 应用状态、缓存与写接口安全

**参数值不再写回工作流。** `/ps/apps/{id}/values` 保存在
`user/default/kedou_app_state/<相对路径hash>.json`（原子写入），工作流文件保持只读。
读取应用/构建执行图时会自动叠加这些值，请求里显式传的值优先级更高。
旧的 `.bak` 文件不再产生；已有 `.bak` 可以手动删除。

**UI→API 转换带缓存。** 转换结果按 `(文件 mtime, 文件大小, 节点注册表指纹)` 缓存，
运行期只做深拷贝 + 注值。工作流改动或节点增删后自动失效；每次返回里的 `cache`
字段是 `hit` / `miss` / `off`，便于排查。

**写接口默认拒绝外部网站来源。** 启动时会生成
`user/default/kedou_bridge_token.txt`。外部面板可以在 POST 请求里带
`X-Kedou-Token: <文件内容>`；本机无 Origin、`null`、loopback `http(s)`、
以及 `file://` / `plugin://` / `uxp://` / `app://` 这类本地面板来源仍可直接调用。
设置环境变量 `KEDOU_BRIDGE_REQUIRE_TOKEN=1` 后，所有写接口都必须带令牌。
如果面板发来的 Origin 不在上述范围，可用 `KEDOU_BRIDGE_ALLOWED_ORIGINS` 追加
（逗号分隔，例如 `plugin://com.adobe.photoshop`）。
如果 ComfyUI 暴露到局域网，建议同时开启严格模式，并只给可信面板分发令牌。

---

## 关于这个项目

这是个人自研工具链的**桥接层**，原本为了配合自己用的工作流启动器和 Photoshop 面板（把常用工作流做成"点一下就出图"的小应用）而写，现在把桥接部分单独开放出来。

**其他部分（启动器、PS 面板）暂未开源**，仅自用与小范围分发。如果你觉得这套思路有用、想聊聊——

<!-- CONTACT:START -->
> 想交流、想问工作流、想聊聊「把工作流做成应用」这套思路？
>
> **B 站：赛博唐僧** → https://space.bilibili.com/401403590
>
> 合集「comfyui 插件」里有这些节点的实际效果与踩坑记录，欢迎来聊。
<!-- CONTACT:END -->

---

## License

[MIT](LICENSE) —— 随便用、随便改、随便再分发，保留版权声明即可。

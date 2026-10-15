# 蝌蚪提示词库 · 轻量版设计稿 v1（2026-10-12）

> ⚠️ 本文是当时的设计记录，**代码位置已经变了**：词库逻辑现在是插件里的 `prompt_vault/` 包
> （vendored 副本，上游独立仓库 + `sync.py` 推送），本文提到的 `promptlib.py` 已删除；
> 库位置也不再写死 `D:\知识库\提示词库`，改成运行时解析（见 README「提示词库」）。
> 数据格式、去重、原子写这些设计决定至今没变，读本文仍然有效。

> 定位：**轻量**。Obsidian 从"运行时依赖"降级为"可选查看器"；不建索引库、不装新依赖、不加自定义节点、不要求 Obsidian 常开。
> 规模目标：后端 ~220 行 + 前端 ~400 行（旧 KedouPromptBox 594 行、ObsidianPromptBridge 4600 行，均被甩开）。

---

## 0. 三原则

1. **数据就是文件**：词库 = `D:\知识库\提示词库` 里的 .md，插件直接读写磁盘。Obsidian 开不开、装不装都不影响词库工作。
2. **不造轮子也不建系统**：无 SQLite/FTS5/jieba/同步线程/Composer/模型适配。几十上百条规模，纯 Python 循环过滤毫秒级，够用。
3. **一份后端，三处前端共用**：路由住在 ComfyUI_KeDou 插件（唯一真身），启动器 / PS 插件以后走同一套 API，不各写一份。

---

## 1. 数据层（沿用现有 vault，零迁移）

现有 12 条条目已经是理想格式，**原样保留**，新代码按它读写：

```
D:\知识库\提示词库\
├── 01_Character\灵汐.md
├── 05_Environment\废土.md
├── ...（分类目录 = 一级目录，可自由增删）
├── 12_Negative\通用负面词.md
└── .trash\            ← 删除不真删，移进来（归档习惯）
```

条目格式（现有条目已符合，不改一个字段）：

```markdown
---
id: character.lingxi        ← 稳定 ID，创建时生成一次，永不变（旧版"改标题即换 ID"的坑根治）
type: character             ← character / style / negative / history / 自定义
category: protagonist       ← 组内二级分类，可空
name: 灵汐                  ← 显示名，随便改，不影响 id 和文件名
models: [z-image-turbo, sdxl]
tags: [灵汐, 主角, 仙侠]
priority: 80                ← 排序权重（置顶=pinned 字段，不占用 priority）
pinned: false
enabled: true
uses: 0                     ← 插入一次 +1（只在真插入时 stamp，保存不算——抄 ComfyAssets 语义）
updated: 2026-10-12
---
# Positive
young female cultivator, ...

# Negative（可选段）
...

# Description（可选段）
...
```

规则：
- **文件名 = 显示名（slug 化），id 在 frontmatter 里**。Obsidian 里浏览文件名直观；程序只认 frontmatter id。
- 解析：`import yaml`（TE 便携版已内置 PyYAML 6.0.3），失败的文件跳过并记日志，不炸整个列表。
- 正文段约定沿用 `# Positive / # Negative / # Description / # Use / # Avoid / # Related`——与 ObsidianPromptBridge 及现有条目兼容，以后想回去用那个插件也无缝。

### 文件安全（抄 FranckyB，~50 行）
- **atomic_save**：写 `xxx.md.tmp` → `os.replace()`，断电不坏文件。
- **每日轮转备份**：ComfyUI 启动时，若今天还没备份过，把整个 vault 压成 `D:\知识库\.提示词库备份\YYYY-MM-DD.zip`，保留最近 7 份。词库坏了随时整库还原。
- **删除 = 移入 `.trash\`**，面板里不做"回收站 UI"（想捞回手动挪文件即可）。

---

## 2. 后端 API（4 条路由，~220 行，住 ComfyUI_KeDou）

新文件 `promptlib.py`，`__init__.py` 在 `_HAS_COMFY` 块里调 `register_promptlib_routes()`。

| 路由 | 作用 |
|---|---|
| `GET /ps/prompts?type=&cat=&tag=&model=&q=` | 递归 walk 全部 .md → 解析 → 过滤 → 排序（pinned 优先 → priority 降 → updated 降）。q 匹配 name/tags/正文 |
| `POST /ps/prompts/save` | 新建（生成 id、选分类目录、atomic_save）或按 id 更新（保留 created） |
| `POST /ps/prompts/delete` | 按 id 移到 `.trash\` |
| `POST /ps/prompts/use` | uses+1（前端插入成功后 fire-and-forget） |

性能：**mtime 缓存**——`{路径: (mtime, 解析结果)}`，文件没变不重复解析；全库 100 条首次解析 <50ms，之后每次列表只 stat 不 parse。

去重：save 时算正文 SHA256，与现有条目撞了直接返回已有条目（不新增）——历史区自动入库靠这个防刷屏。

自动历史（MVP 内含，~30 行）：前端监听 ComfyUI `executed` 事件，把本次运行用到的每个 prompt 文本存为 `type: history`（名称取前 20 字），hash 去重，**只保留最近 50 条**（超出按 mtime 删最旧）。

---

## 3. 前端（新文件 `web/promptlib.js`，~400 行，不再塞 kedou_media.js）

### 入口：右下角悬浮 pill「词库」
沿用打包面板已验证的悬浮 pill 模式（入口就近、不占顶栏）。任何工作流页都在，点一下弹模态。

### 没有自定义输入节点
**删掉 KedouPromptBox 思路**。正常用 ComfyUI 原生 CLIP 文本编码节点的输入框写词，词库只负责"调出来填进去"和"存回去"。

### 弹窗结构

```
┌─ 提示词库 ─────────────────────────── ✕ ─┐
│ [🔍 搜索…]                                │
│ [全部][角色][风格][负面][历史] ← 分类 chips│  ← 导航可折叠，内容永不折叠
│ ──────────────────────────────────────── │
│ ┌ ★灵汐 ────────────────── [角色] 80 ┐   │
│ │ young female cultivator, serene…    │   │  ← 两行预览
│ │ #灵汐 #主角 #仙侠        用过 12 次 │   │
│ │ [填入] [追加] [编辑] [置顶] [删除]  │   │
│ └─────────────────────────────────────┘   │
│ ┌ 电影剧照 ────────────…               │
│ …                                       │
│ ──────────────────────────────────────── │
│ 存当前提示词： [短名输入____] [保存]      │  ← 行内命名，不用 window.prompt
└──────────────────────────────────────────┘
```

- **填入/追加**：目标节点 = 当前选中的带 prompt 控件的节点；没选中则取画布第一个 CLIPTextEncode；都没有 → toast「先选一个提示词节点」。**追加** = 原文 + `, ` + 词库文本（角色卡往场景卡上叠的常用姿势）。成功后 `POST /ps/prompts/use`。
- **编辑**：卡片就地展开——短名、正文全文 textarea、tags、分类下拉、pinned 开关。保存走 save 路由。
- **删除**：两步确认（按钮变「确认删除?」再点一次），移入 .trash。
- **置顶**：pinned 字段翻转，卡片立刻跳到最顶（前端乐观更新 + 后台保存）。
- **存当前提示词**：从目标节点 prompt 控件读文本，行内输入短名，type 默认 `精选`（历史区则自动）。

### 视觉与动效（按 ui-motion-design 规矩）
- 模态入场：`opacity + translateY(12px→0) + scale(0.98→1)`，spring 约 250ms / bounce 0.1；离场 accelerate 150ms。只动 transform/opacity。
- 卡片进场 stagger 40ms，只 stagger 首屏前 8 张。
- 颜色全走 ComfyUI 主题令牌 + 兜底（`--fg-color / --descrip-text / --comfy-input-bg / --border-color`）——ObsidianPromptBridge 的 chip 对比度事故（浅色主题下 `--comfy-text` 为空）就是反面教材，浅色主题必须实测过。
- `prefers-reduced-motion`：去位移去缩放，只留 fade。
- 激活筛选常显为 chips；未用的筛选藏进搜索行。

---

## 4. 明确不做（防止又长成 4600 行）

| 不做 | 理由 |
|---|---|
| SQLite / FTS5 / jieba 索引 | 百条规模不需要，纯循环毫秒级 |
| Obsidian REST API 连接 / 证书 / API key | 直接读磁盘，Obsidian 不是运行时依赖 |
| Composer 槽位编排 / model_overrides | 想要时回去用 ObsidianPromptBridge，它专长这个 |
| 出图↔提示词关联（P2） | 需要 tracker+元数据解析，单独一期再做，接口预留 outputs 字段 |
| 启动器/PS 插件前端 | 后端 API 已通用，以后各端 30 行接一个弹窗即可 |
| 回收站 UI / 版本历史 UI | .trash 文件 + 每日 zip 兜底，够用 |

---

## 5. 文件与行数预算

```
ComfyUI_KeDou/
├── promptlib.py        ~220 行（解析/缓存/过滤/atomic_save/备份/4 路由）
├── __init__.py         +3 行（import + register）
└── web/promptlib.js    ~400 行（pill + 模态 + 插入/编辑/历史自动存）
```

## 6. 验收清单（按验证规程）

1. 路径对账：`D:\知识库\提示词库` 递归 walk 出 12 条现有条目，一条不少（旧版 listdir 只读根目录的 bug 反向验证）。
2. 真实运行时：便携 python 直调 promptlib 的 list/save/delete，断言命中 vault 真身。
3. 反向测试：临时改名 vault → 返回空库不炸；损坏一个 .md → 其余条目照常列出。
4. 改标题不换 id、不迁移动画断链（parent 字段以后可用）。
5. 前端真机：硬刷后 pill 出现 → 搜索 → 填入选中节点 → uses+1 落盘 → 运行一次 → 历史区出现自动条目 → 第 51 条把最旧的挤出去。
6. 浅色主题对比度探针扫一遍弹窗。

## 7. 待拍板（3 个小点）

1. **自动历史默认开还是关？** 建议开（30 行、hash 去重、50 条封顶），不想要时面板里一个开关关掉。
2. **新条目默认 type**：手动保存默认「精选」还是弹 type 选择？建议默认精选，编辑里可改。
3. **ObsidianPromptBridge 处置**：词库重做后它功能重叠（Composer 除外）。建议归档进 `D:\Git` 保紧 + 从 custom_nodes 挪走（避免两套词库路由并存打架），你确认。

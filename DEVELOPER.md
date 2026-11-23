# DEVELOPER.md —— 给"下一个接手的 AI"的开发规范

> 这份文档的目的：让另一个 AI（或未来的你）在不读完全部源码的情况下，
> 也能安全地改这个扩展、加新功能、不踩已经踩过的坑。
>
> **动手前请先读第 7 节的「不变量」。** 那几条是花了整轮调试才换来的，
> 违反了不会立刻报错，但会在某个特定场景下静默失效（图不出来、卡片重复、提示词泄漏）。

---

## 1. 这是个什么东西

一个 **SillyTavern 第三方扩展**（不是独立服务，不要做成独立服务）。
它让 AI 在写正文时顺手输出「配图块」，前端把配图块渲染成一张小卡片：

```
AI 正文里：<photo title="窗边的午后" kind="scene">午后的光斜着落在木桌上……</photo>

前端显示：  ┌──────────────────────┐
           │ 窗边的午后   [ 生图 ] │
           └──────────────────────┘

点按钮 → 排队 → 本地 ComfyUI → 图落回原来的位置
```

- **纯前端**，没有后端、没有构建步骤、没有 npm 依赖。改完刷新页面就生效。
- 目标模型是 **MOSS**（`UNETLoader` + `CLIPLoader(type=moss_image)` + 双 LoRA + KSampler 8 步）。
- 语言/框架：原生 ES Module + jQuery（只用 `jQuery(async () => …)` 做启动），
  样式是朴素 CSS，跟随酒馆主题变量。
- 运行环境：SillyTavern 1.13.x、Windows、ComfyUI 0.4x、Chrome 系浏览器。

---

## 2. 文件地图

```
manifest.json            扩展声明（display_name / loading_order: 120 / js / css）
index.js                 ★ 全部胶水逻辑：设置、事件、队列、出图、卡片渲染、面板
settings.html            设置面板的 HTML 片段（被 index.js fetch 进来注入扩展抽屉）
style.css                聊天内的卡片/图 + 设置面板样式
README.md                给用户的说明书
DEVELOPER.md             本文件
MOSS配图世界书.json       配套世界书（不算代码，但要跟着一起发）
LICENSE                  MIT

lib/comfy-client.js      ★ ComfyUI 通信 + 工作流检视/注入 + 错误翻译（纯逻辑，Node 可跑）
lib/prompt-pipeline.js   ★ 正文 → 配图块 → 提示词（纯逻辑，Node 可跑）
lib/image-store.js       IndexedDB 图片存取
lib/queue.js             串行出图队列
lib/workflow-default.js  内置 MOSS 工作流（字符串常量）
```

**仓库里只有上面这些**（运行所需的最小集合）。测试脚本、世界书生成脚本、调试截图
都属于开发用产物，不随仓库发布，见第 9 节。

**依赖方向是单向的**：`index.js → lib/*`，`lib/*` 之间互不引用（除了 `workflow-default` 只出常量）。
所以 `lib/` 里的东西可以被 Android 端、独立脚本直接 `import` 复用 —— 请不要往 `lib/` 里塞 DOM 代码。

---

## 3. 数据流

### 3.1 一次「点卡片生图」

```
用户点 .moss-card-btn
  └─ enqueue(mesId, {slot, kind, prompt, title, reason:'card'})
       ├─ ticket = `${mesId}:${slot}`，state.inflight 去重（按槽位，不是按楼层）
       ├─ setSlot(mesId, slot, 'loading', '排队中…')   → 卡片变转圈
       └─ queue.enqueue(spec)                          → 串行，间隔 intervalMs
            └─ doGenerate(job)
                 ├─ getWorkflow() + inspectWorkflow()  校验工作流
                 ├─ 组提示词：job.prompt（AI 写的，最准）
                 │            → decideTags()（模型解析 / 离线词典）
                 │   然后统一 buildPrompt({prefix, identity, tags, suffix, natural})
                 ├─ generate({...})                    提交 → 轮询 → dataUrl
                 │     onTick → setSlot(..., `渲染中… Ns`)   每 1 秒刷一次文案
                 ├─ dataUrlToBlob + measure()
                 ├─ meta = {id, prompt, seed, width, height, kind, createdAt, workflow, from, slot, title}
                 ├─ putImage({id, blob, ...})          IndexedDB
                 ├─ attachMetaToMessage(mesId, meta)   mes.extra.mossImages.push + saveChat
                 └─ finalizeSlot(mesId, meta, blobUrl) 槽位 0 的那张图替换掉 loading 卡片
```

失败时：`catch` → 有槽位 `setSlot(..., 'failed', '没画成：…')`，无槽位 `failPlaceholder(fig, …)`。

### 3.2 一次「渲染这一楼的卡片」

```
事件（MESSAGE_RECEIVED / CHARACTER_MESSAGE_RENDERED / MESSAGE_SWIPED / MESSAGE_EDITED）
或 #chat 的 MutationObserver（200ms 防抖）
  └─ applyMessage(mesId)
       ├─ ensureUrls(mesId)      IndexedDB → blob URL，缓存在 state.urls；取不到的记进 state.missing
       ├─ renderCards(mesId)     ★ 核心，幂等
       │    ├─ messageItems(mes)      parseImageBlocks(mes.mes).items  → 每块有 slot
       │    ├─ imagesBySlot(mes)      mes.extra.mossImages 里 slot 是数字的
       │    ├─ 对每一块决定"应该显示什么"：
       │    │    有图 → figureFor         (data-moss-kind="fig")
       │    │    loading 态 → loadingCardFor ("loading")
       │    │    failed 态 → failedCardFor   ("failed")
       │    │    否则 → cardFor             ("card")
       │    ├─ 找到现存节点 `.moss-card[data-moss-slot=N], .moss-fig[data-moss-slot=N]`
       │    │    kind 相同 → 只更新文案，不动节点（避免 observer 抖动）
       │    │    kind 不同 → replaceWith(desired)
       │    └─ 没有现存节点 → placeAt(root, item, desired)
       └─ attachImagesToMessage(mesId)   兼容老数据：slot 不是数字的 meta 挂到楼层末尾
```

---

## 4. 数据结构字典

### 4.1 设置 `extension_settings['st-moss-image']`

```js
{
  enabled: true,
  base: 'http://127.0.0.1:8188',
  stProxy: true,           // 直连失败时走酒馆 /proxy/ 中转
  workflows: [{ id, name, json }],   // json 是字符串
  activeWorkflowId: '',
  positiveNodeId: '', positiveMode: 'replace',   // replace | append
  negativeNodeId: '', negativeText: '',
  overrideSize: false, overrideModel: false, modelName: '',
  overrideSampling: false, steps: 8, cfg: 1, samplerName: 'euler', scheduler: 'simple',
  size: 'p9x16',           // p9x16 | p2x3 | square | w16x9 | w3x2
  trigger: 'card',         // card | auto | off
  parse: 'model',          // model | tag | dict（见 settings.html）
  llmMode: 'natural',      // natural | tags
  prefix: '', identity: '', suffix: '',
  caption: true,
  intervalSec: 1.5, timeoutSec: 600,
  __v: 2,                  // 配置版本，用于一次性迁移
}
```

`getSettings()` 会补齐缺失字段并做迁移，**新加字段一定要进 `DEFAULTS`**，否则老配置读出来是 undefined。

### 4.2 聊天记录里的元数据 `mes.extra.mossImages[]`

```js
{
  id: 'chatId:mesId:timestamp',   // 也是 IndexedDB 的主键
  prompt: '最终拼好的提示词',
  seed: 123456, width: 1088, height: 1920,
  kind: 'selfie' | 'scene' | 'private',
  createdAt: 1795422218421,
  workflow: 'MOSS 文生图',
  from: 'block' | 'tag' | 'model' | 'dict' | 'reuse',   // 提示词来源，调试用
  slot: 0,            // ★ 可选。这一楼第几块配图；没有就是老数据/手动按钮
  title: '窗边的午后',  // ★ 可选。卡片标题
}
```

> `slot` 是这套设计的枢纽：它同时是「卡片在楼里的位置」「meta 的归属」「in-flight 的去重键」。

### 4.3 配图块解析结果 `parseImageBlocks(text).items[]`

```js
{ title: '窗边的午后', prompt: '午后的光斜着……', kind: 'scene',
  tag: 'photo', raw: '<photo …>…</photo>', index: 123, slot: 0 }
```

### 4.4 运行时状态 `index.js` 里的 `state`

```js
state.urls      Map<imageId, blobUrl>   // 已加载的图，切聊天时整体 revoke
state.missing   Set<imageId>            // IndexedDB 里已经没有的，避免反复空查
state.inflight  Set<ticket>             // ticket = `${mesId}:${slot}` 或 `m:${mesId}`
state.server / state.inspect            // 连接信息、当前工作流检视结果
slotState       Map<`${mesId}:${slot}`, {phase:'loading'|'failed', note}>   // 模块级，不在 state 里
```

### 4.5 IndexedDB

库 `st-moss-image`，表 `images`，主键 `id`。
记录：`{ id, blob, chatId, mesId, prompt, seed, width, height, workflowName, elapsedMs, createdAt }`。
**图只存这里，绝不进聊天文件**，否则存档会被撑爆。

---

## 5. 模块 API

### 5.1 `lib/comfy-client.js`

```js
// 唯一推荐入口：检视 + 注入 + 提交 + 取图
generate({
  base, stProxy, workflow,              // workflow 是 JSON 字符串或对象
  positive, negative, seed,
  width, height,                         // 只有 overrideSize 为真才真的改
  modelName,                             // 只有 overrideModel 为真才改
  steps, cfg, samplerName, scheduler, overrideSampling,
  positiveNodeId, positiveMode,          // 'replace' | 'append'
  negativeNodeId,
  timeoutMs, onTick({elapsedMs}),
}) -> { promptId, images, image, dataUrl, seed, elapsedMs, warnings }

inspectWorkflow(rawWorkflow)
  -> { ok:true, workflow, nodeCount, placeholders, samplers, models, latents, outputs,
       textNodes, positiveTargets, negativeTargets, zeroNeg, warnings,
       inferred:{steps,cfg,samplerName,scheduler,seed}, size:{width,height}, model }
  -> { ok:false, error, isCanvasFormat? }

hydrateWorkflow(raw, options)    // 只注入不改网络；返回 { workflow, seed, warnings }
fetchServerInfo(t, {onStep})     // -> { version, device, vramTotal, unets, ckpts, loras, clips, samplers, schedulers }
makeTransport({base, stProxy})   // -> { request(path, init, timeoutMs) }，内含直连→代理兜底
normalizeBaseUrl(raw)            // 去掉多余斜杠、补协议
ComfyError                       // err.localOnly = true 表示"请求根本没发出去"
```

**注入优先级**：节点文字里的 `{{positive}}` 等占位符 > 面板手动指定的节点 ID > 从 KSampler 的输入连线反向定位。
负面词**默认一个字节都不动**（保住别人工作流里精调的负面）。

### 5.2 `lib/prompt-pipeline.js`

```js
parseImageBlocks(text) -> { items:[见 4.3], cleanText }   // 剥掉所有块之后的正文
parseControlTags(text, {stripOthers}) -> { cleanText, photo, items, removed }
buildPrompt({prefix, identity, tags, suffix, dedupe, natural}) -> string
   // natural=true：不按逗号切分，用「，」拼接；false：切成 tag 用 ", " 拼
detectKind(text) -> 'private'|'selfie'|null
ruleExtract(text) -> { tags:[], hits:[] }                 // 离线词典，150+ 词
parseWithLLM({text, kind, mode, llmCall}) -> string|null
extractPrompt({...}) -> { kind, prompt, tags, cleanText, notes, removedTags }  // 一站式
cleanTagOutput(raw, {asciiOnly}) -> string
SYS_TAGS / SYS_NATURAL / buildParserMessages({text, kind, mode})
```

`parseBlockInner` 认的写法（按优先级）：
`title=`/`caption=` 属性 → `prompt=`/`tags=`/`text=` 属性 → `【标题】` 开头 →
`标题｜提示词` → Grok 的 `【标题】image###提示词###` → 纯标签。

### 5.3 `lib/image-store.js` / `lib/queue.js`

```js
putImage({id, blob, chatId, mesId, prompt, seed, width, height, workflowName, elapsedMs})
getImage(id) -> {id, blob, …} | undefined
deleteImage(id) / deleteByChat(chatId) -> count / clearAll() / usage() -> {count, bytes}

new RenderQueue({intervalMs, run, onChange})   // run(spec) 是真正的执行函数
queue.enqueue(spec) -> { job, promise }
// 关键行为：err.localOnly 的失败不占用冷却（请求没发出去，不该让用户干等）
```

---

## 6. 渲染管线：最容易被改坏的地方

### 6.1 为什么"不改 mes.mes"

提示词原文必须留在聊天记录里。理由不是美观，是**跨轮一致**：

> 模型下一轮重读聊天记录时，要能看见上一轮给这个角色设定的发色、瞳色、配饰。
> 如果你把 `<photo>` 块删掉，它下一轮就会重新"想象"一遍这个人的长相，每张图一张脸。

所以本扩展的做法是：**文字一个字节不动，只在前端把那段文字替换成一个卡片元素**。
代价是"标签会被用户 F12 看到"，收益是人物一致性。这个取舍是有意的，别改。

### 6.2 卡片怎么定位到正文里的位置

酒馆渲染后 `<photo title="X">描述</photo>` 会变成一段普通正文（标签和属性都被吃掉）。
所以要靠**提示词原文**反查：

```js
findAnchor(root, prompt)   // TreeWalker 遍历文本节点，跳过已经在 .moss-card/.moss-fig 里的
                           // 先找完整 prompt；找不到（被渲染器插了空格/换行）再退到前 24 个字符
```

拿到锚点后 `placeAt()` 分四种情况：

| 情况 | 判断 | 处理 |
|---|---|---|
| 整段就是提示词，且独占一个 `<p>` | `start===0 && end>=len && parent 是 P/DIV && 只有一个子节点` | `parent.replaceWith(card)`，并给 card 加 `.moss-own-line`（独占一行） |
| 整段是提示词，但在行内 | 同上但 `ownLine` 为假 | Range `deleteContents()` + `insertNode(card)` |
| 提示词是段落的一部分 | `start>0` 或 `end<len` | 同上 Range 精确替换那一段文字 |
| 完全找不到 | 渲染器把文字改了 | 兜底挂到楼层末尾的 `.moss-figs` 容器 |

### 6.3 幂等（`renderCards` 的规矩）

`renderCards` 会被事件和 MutationObserver 反复调用，**必须幂等**：

- 节点用 `data-moss-slot` 认领，用 `data-moss-kind`（`card`/`loading`/`failed`/`fig`）判断状态
- kind 相同 → **只改文案，不换节点**。换节点会触发 observer → 再渲染 → 死循环
- kind 不同 → `replaceWith`，一次就够（下次调用时 kind 就相同了）
- 已经替换过的位置，原文已经不在了，`findAnchor` 会返回 null —— 这正好是幂等的天然保障

### 6.4 `cleanArtifacts`

Grok 那套多行格式渲染后会在正文里留下 `image###` 碎片和一个空的 `<h3 id="photo">`。
`cleanArtifacts` 负责擦掉这些，并删掉变空的 `<p>`。改渲染逻辑时注意别把它去掉。

### 6.5 为什么卡片是 `<span>` 不是 `<div>`

卡片可能被塞进 `<p>` 里（行内替换的情况）。往 `<p>` 里插 `<div>` 会被浏览器的标签修复逻辑
搬走，位置全乱。所以卡片和图都是 `<span class="moss-…">`，靠 CSS 给 `inline-flex` / `inline-block`。
**加新元素时同理，用 span + CSS，别用块级标签。**

---

## 7. 不变量（INVARIANTS）

改代码前逐条确认，这些不是风格问题，是正确性问题。

| # | 不变量 | 违反后的症状 |
|---|---|---|
| **I1** | 不改 `mes.mes`，不删正文里的配图块 | 人物每张图换一张脸（视觉锚点丢失） |
| **I2** | `renderCards` 幂等：先按 `data-moss-slot` 查现存节点，kind 相同就只改文案 | 卡片重复、DOM 抖动、浏览器卡死 |
| **I3** | 用 `mesid` 属性定位消息，**不要用 `#message0`** | 酒馆 1.13 的 `.mes` 没有 id，选择器全部落空，静默失效 |
| **I4** | 插进 `<p>` 的元素必须是 `<span>` 系 | 布局错乱、卡片跑到段落外面 |
| **I5** | `state.inflight` 用 `mesId:slot` 做键 | 同一楼第二张卡永远点不动（"这条消息正在生成中"） |
| **I6** | meta 里 `slot` 是数字才算"属于某个配图块" | 老数据和手动按钮的图会被错误塞进第一条卡的位置 |
| **I7** | 中文提示词用 `natural: true` 拼（全角逗号） | 中文句子被拆成 tag 串，MOSS 出图质量明显下降 |
| **I8** | blob URL 在切聊天 / 清缓存时必须 `revokeObjectURL` | 内存泄漏，长时间挂着会占几百 MB |
| **I9** | `ensureUrls` 失败要记进 `state.missing` | 每次 DOM 变动都回 IndexedDB 空查一遍，滚动都卡 |
| **I10** | 设置面板注入前检查 `$id('moss-enabled')` | 酒馆会激活扩展两次，面板出现两份，`getElementById` 指向废弃的那份 |
| **I11** | `lib/` 里不许出现 `document` / `window` / jQuery | 这些模块要被 Node 单测和别的端复用 |

---

## 8. 改动配方（照猫画虎）

### 8.1 换模型 / 换工作流
不用改代码。ComfyUI 里 Export (API)，设置面板「导入 JSON」，然后：
- 换底模：勾「覆盖模型」，在下拉里选
- 换尺寸：选预设，或勾「覆盖尺寸」
- 换采样：勾「覆盖采样参数」（MOSS 是 8 步 / cfg 1 / euler / simple，别乱调）
- 工作流用了 `{{positive}}` 占位符的话，注入会优先命中占位符，比自动定位可靠

### 8.2 加一种配图块语法
只改 `lib/prompt-pipeline.js` 的 `parseBlockInner(attrs, inner)`，按优先级插一段。
**别动 `parseImageBlocks` 的拆块逻辑** —— 它负责 index/slot 编号，改错了槽位全乱。
改完必须补一条解析用例（`pipeline` 那一组），否则新的写法会在某次渲染里静默失效。

### 8.3 改卡片外观
只改 `style.css` 的 `.moss-card` 一段。注意：
- 保持 `display: inline-flex`（行内替换时的前提）
- `.moss-own-line` 里是 `display: flex !important`，别删
- 别给卡片加固定宽度，酒馆主题的可读宽度会变

### 8.4 加一个「本楼全画」按钮
在 `cardFor()` 旁边加一个按钮，click 里遍历 `messageItems(mes)` 全部 `enqueue`。
注意 I5：in-flight 是按槽位的，所以连着点不会互相阻塞 —— 队列会自动串起来。
别用 `Promise.all`，`RenderQueue` 本身就是串行的。

### 8.5 改成并发出图
`lib/queue.js` 的 `_loop()` 现在是单条串行。要并发就把 for 循环改成"同时跑 N 个"。
**但要注意**：4070 12G 跑 MOSS 一次就吃满了，并发只会互相拖慢甚至 OOM。
真要并发，先把 `intervalMs` 降到 0，再考虑。

### 8.6 加"参考图 / 图生图"
1. `lib/comfy-client.js` 里加一个 `uploadImage(t, blob)` → `POST /upload/image`，拿到 `{name, subfolder}`
2. `hydrateWorkflow` 增加一个 `imageName` 选项，往 `LoadImage` 节点的 `image` 字段写
3. `index.js` 的 `doGenerate` 里把 `job.refImage` 传下去
4. 卡片上加一个「拿这张当参考」的入口，把 blob 存进 `job`

### 8.7 加 NSFW 开关
最省事的做法：在 `doGenerate` 里根据设置给 `prompt` 追加/剔除一段描述，
或者干脆用两套工作流（`activeWorkflowId` 切）。**不要**在提示词里写 "nsfw" 这种 tag —— MOSS 不吃 tag。

### 8.8 换掉"当前对话模型解析"这一层
`decideTags(job)` 里的 `makeLlmCall()` 就是 `generateQuietPrompt`。
换成别的模型（比如直接打 DeepSeek API）只要保持 `llmCall(system, user) -> Promise<string>` 签名即可，
`parseWithLLM` 不关心它怎么实现。

---

## 9. 调试与测试

### 9.1 控制台调试口

扩展启动后会挂 `window.__moss`：

```js
__moss.settings()                   // 当前设置
__moss.handleMessage(3)             // 等价于"酒馆收到第 3 条消息"
__moss.enqueue(3, {slot:0, prompt:'…', title:'测试'})   // 直接排一张
__moss.attachAll()                  // 强制重绘所有楼层
__moss.addManualButton()            // 补挂手动按钮
__moss.state                        // urls / missing / inflight
__moss.queue                        // 队列对象，看 waiting/active/cooldownLeft
```

### 9.2 跑测试

测试脚本不随仓库发布（避免把浏览器自动化和调试截图带进发行版），
但它们该覆盖什么、怎么组织，这里写清楚，需要时照着重搭即可：

| 用例 | 覆盖什么 | 成本 |
|---|---|---|
| `pipeline` | 纯逻辑：配图块解析、kind 判断、离线词典、`buildPrompt`（含 natural）、LLM 输出清洗。**改 `lib/` 之后必跑** | 秒级，不需要浏览器 |
| `reload` | `Page.reload` 后轮询 `#chat` 和 `window.__moss`，确认扩展起来了 | 几秒 |
| `st-load` | 面板只注入一份、状态连上、工作流摘要、模型列表、手动按钮挂上 | 十几秒 |
| `card --fast` | 造一条两块配图的消息，断言：只显示标题+按钮、提示词不进 DOM、`mes.mes` 未被改、槽位编号对 | 几秒 |
| `card` | 同上，再点第一张：只有该槽位进 loading → 出图 → 另一张仍是按钮 → 重绘不重复 | 约 30 秒 |
| `e2e` | 手动按钮（无槽位）路径：出图 → 入库 → 移除容器后从 IndexedDB 还原 | 约 30 秒 |
| `auto` | `trigger: 'auto'`：不点直接画，`from === 'block'`，卡片 0 张 | 约 30 秒 |

需要的环境：酒馆在 8000、ComfyUI 在 8188、带调试端口的 Chrome：

```bash
chrome --headless=new --remote-debugging-port=9222 http://127.0.0.1:8000/
```

### 9.3 两条测试纪律（血泪）

1. **不要主动导航页面**。这台机器上酒馆首屏要几十秒才响应渲染进程，
   带导航的测试会假失败。要跑新代码就 `Page.reload` 后轮询 `#chat` 和 `__moss`。
2. **求值只用短超时轮询**。`Cdp.probe` 默认 3 秒、失败返回 undefined，
   用 `cdp.waitFor(expr, predicate)` 轮询。写长超时的 `Runtime.evaluate` 会挂死在一次求值上，
   最后什么信息都拿不到。

### 9.4 常见故障对照表

| 症状 | 先查什么 |
|---|---|
| 面板显示连不上，但 curl 通 | 浏览器到 ComfyUI 的**第一条连接**要 9–70 秒，看状态里的计时，等它 |
| 卡片不出来，正文里裸着提示词 | `trigger` 是不是 `off`；`parseImageBlocks` 有没有认出块（控制台 `__moss.handleMessage(id)` 后看 DOM） |
| 图出来了但跑到消息最底下 | `meta.slot` 丢了；检查 `doGenerate` 有没有把 `job.slot` 写进 meta |
| 一张卡点不动 | `state.inflight` 里有同 ticket 的残留（生成被取消时），刷新页面 |
| 同一张卡重复出现两个 | 违反 I2：`renderCards` 没按 `data-moss-slot` 认领节点 |
| 人物每张图不一样 | 违反 I1：正文被改了；或者 `identity`（身份词）没配 |
| 图不显示但 meta 在 | IndexedDB 里 blob 没了（清过缓存），卡片会显示"已不在本地缓存" |
| 面板出现两份 | 违反 I10 |

---

## 10. 已知的坑（环境与平台事实）

这些都是实测踩出来的，不是猜测。改代码时不要"顺手优化"掉对应的处理。

### 10.1 酒馆 1.13 的 DOM 事实
- `.mes` 元素**没有 id**，只有 `mesid` 属性。`#message0` 不存在。
- `.mes` 的子元素：`.for_checkbox` `.del_checkbox` `.mesAvatarWrapper` `.swipe_left` `.mes_block` `.flex-container.swipeRightBlock`
- 消息操作栏是 `.extraMesButtons`，手动按钮要 `prepend` 进去
- `#chat` 的 DOM 顺序**不等于**视觉顺序（不要用 `.pop()` 拿"最后一条"）

### 10.2 酒馆 markdown 渲染器（实测 `messageFormatting` 的输出）
- **多行**的 `<photo>【标题】image###提示词###</photo>` → 被拆成
  `<p><br><br>【标题】<br><br>image###<br><br>提示词</p>` + 一个 `<h3 id="photo"></h3>`
- **单行**的 `<photo title="…">提示词</photo>` → 变成**一个干净的 `<p>`**，标签和属性全被吃掉

这就是为什么世界书里要求"必须写在一行、标题放属性里"。

### 10.3 事件时序
- `CHAT_CHANGED` 经常在扩展注册之前就触发了 → 收不到
- `setTimeout(attachAll, 1200)` 经常早于聊天渲染完成 → 一张图都挂不上

所以必须有 `#chat` 上的 `MutationObserver`（200ms 防抖）+ `needsButtons()` 判断，
这是首屏能补上按钮和卡片的唯一可靠时机。

### 10.4 浏览器到 ComfyUI 的首次连接
这台机器上，浏览器对 8188 的**第一条连接**要 9–70 秒（curl 只要 4ms，
换干净 profile 的 Chrome 也一样）。看起来像 Windows 首次 SYN 丢失/重传。

应对（都在 `lib/comfy-client.js` 里，别删）：
- 启动时先发一条最轻的 `/system_stats` 焐热连接
- `/system_stats` 给 120 秒，**超时了不要重试**（abort 后重试等于重新冷一次，更慢）
- 只有"明确连不上（拒连/404）"才重试一次
- `stProxy` 兜底：直连失败走酒馆 `/proxy/`；如果代理被禁用（404），错误信息要说明是"没有兜底通道"，
  而不是"连不上"

### 10.5 编码
- 往 IndexedDB 存 blob 用 `Blob` 对象，**不要** `btoa` 大字符串（几 MB 的 PNG 会炸栈）
- 图片真实尺寸要用 `new Image()` 读 `naturalWidth/naturalHeight`，
  不能信参数（1080×1920 实际出图 1088×1920，潜空间要对齐 16）

---

## 11. 版本

| 版本 | 变化 |
|---|---|
| **1.0** | 配图卡片模式（`<photo title>` → 「标题 + 生图」按钮，点了才画）；槽位化渲染；中文自然语言提示词；配套 MOSS 世界书；`buildPrompt` 增加 `natural`；配置 v2 迁移 |
| 0.x | 只能靠 `<photo>tags</photo>` 自动出图或手动按钮，图统一堆在楼层末尾（无槽位概念） |

加功能请更新这张表和第 7 节的不变量。

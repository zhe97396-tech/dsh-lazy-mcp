# dsh-lazy-mcp

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/zhe97396-tech/dsh-lazy-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zhe97396-tech/dsh-lazy-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的惰性加载 **MCP 网关**。启动时不启动任何 MCP server：每个 server 在首次使用时才连接，并在空闲窗口过后被释放。工具和资源会被桥接进模型的工具目录，Web UI 则展示各 server 的实时状态。

![MCP 状态面板](assets/panel.png)

<sub>状态面板：每个 server 的状态、生命周期、工具数量，以及可调整的空闲窗口。</sub>

## 为什么需要它

`@deepseek-ai/dsh-mcp-client` 会在插件激活期间连接每一个已配置的 server，并等待初始连接与工具发现完成，因此：

- 每个 server 在 Harness 的第一轮之前就已经在线；
- 一个缓慢或故障的 server 会拖慢启动；
- server 会一直驻留到 Harness 重启（它唯一一个形似 `idle` 的旋钮 `reconnect.maxDelayMs` 管的是重连退避，而不是空闲关闭）。

本网关在启动时什么都不启动。

| 行为 | `dsh-mcp-client` | 本插件 |
|---|---|---|
| Harness 启动时的 server 进程 | 已启动 | **未启动** |
| server 启动时机 | 插件激活时 | **首次需要它的工具调用时** |
| server 停止时机 | 仅在配置重载 / Harness 重启时 | **空闲 `idleDisconnectMs` 之后** |
| 常驻工具定义 | 每个 MCP 工具一个，每次请求都发送 | **3 个固定的网关工具** |
| 上下文中的工具 schema | 全部、始终 | **仅在调用 `mcp_tools` 时** |
| 描述处于休眠的 server | 需要建立连接 | **由缓存的元数据提供** |
| 每个 server 的生命周期 | 一种行为 | **`lazy` / `lazy-keep-alive` / `eager` / `keep-alive`** |

## 安装

要求：Node.js 20 或更高版本，以及一个 DSH profile（通常用 Web profile）。本包**不依赖任何 `@deepseek-ai/*` 包**，因此 Harness 的 peer-range 变化不会把它弄坏；它唯一的运行时依赖是 MCP TypeScript 客户端 SDK，也就是官方桥接所用的同一个 SDK。

### 方案 A — 从 GitHub 安装

```sh
dsh plugin --profile web add github:zhe97396-tech/dsh-lazy-mcp
```

然后**重启 `dsh web`**。Host 半边和浏览器半边都从已安装的包加载，而运行中的 Harness 不重启就无法拾取刚安装的模块。

### 方案 B — 安装 release tarball

从 [Releases](https://github.com/zhe97396-tech/dsh-lazy-mcp/releases) 页面下载 `dsh-lazy-mcp-<version>.tgz`，通过插件管理器安装（或 `dsh plugin --profile web add ./dsh-lazy-mcp-<version>.tgz`），然后重启 `dsh web`。

该插件由 profile 中的一行 `- id: lazy-mcp` 启用。仅配置的变更通常可以热重载，**但当它随一个被替换的包一起到达时，管理器会把它推迟到重启**（结果会显示 `application: "restart-required"`）。把该行关掉再打开——即插件管理器对 `include:lazy-mcp` 执行 `set_plugin`——会强制重新组合（re-compose）并立即应用新配置，无需重启。

### 两个半边

| 半边 | 文件 | 由谁加载 |
|---|---|---|
| Host | `index.js` | `cordis.patch.yml` 中的 bundle 行 |
| 浏览器 | `client.js` | `package.json` 中的 `dsh.client` 声明，由 `dsh-client-modules` 提供 |

浏览器半边**不导入任何 DSH Client 包**：React 来自浏览器模块表，所有颜色都是主题 token，因此它跟随浅色与深色主题而无需第二份样式表。它的 `__ModuleLoader__.load({ id })` 使用精确的包名，这就是为什么包名、Loader 行名和命名清单必须一起重命名。

两个半边仅通过 Host 半边在 `/lazy-mcp/state` 注册的只读 JSON 路由，以及共享的面板 id `lazy-mcp` 连接在一起。

### 它实际装在哪里

| 内容 | 位置 |
|---|---|
| profile 依赖 + bundle 列表 | `~/.dsh/profiles/web/package.json` |
| 已安装的包——一个带自己 `node_modules` 的**真实目录** | `~/.dsh/profiles/web/node_modules/dsh-lazy-mcp` |
| 内置的 tarball（仅在从 tarball 安装时存在） | `~/.dsh/profiles/web/.local-packages/dsh-lazy-mcp-<version>.tgz` |
| 插件管理器写入的启用覆盖 | `~/.dsh/profiles/web/cordis.patch.yml`（`- id: lazy-mcp`） |
| 源码 | 本仓库——**运行时不会被读取** |

插件的**设置**位于本包自己的 `cordis.patch.yml` 中，作为 bundle 的 patch 层加载——而不是 profile 的 `cordis.patch.yml`。若要从 profile 层覆盖某个设置，在那里添加一个带 `config` 的 `- id: lazy-mcp` 条目即可；profile 层优先。

### 代码改动后重新构建

```sh
cd dsh-lazy-mcp
pnpm install
pnpm run check      # syntax check of both halves
pnpm run lint       # package identity / manifest consistency
pnpm run verify     # self-check harness (starts a real MCP reference server)
pnpm pack           # dsh-lazy-mcp-<version>.tgz
```

先提升 `version`，好让新产物得到不同的名字、旧的可以被清理掉，然后通过插件管理器安装那个 tarball 并重启 `dsh web`。

## 配置

本包出厂时**没有配置任何 server**（`servers: []`），因此在向 `lazy-mcp` 行的 `config` 添加条目之前，什么都不会被启动：

```yaml
- id: lazy-mcp
  config:
    idleDisconnectMs: 600000        # disconnect a lazy server after 10 minutes idle
    connectTimeoutMs: 30000         # deadline for connect + tool discovery
    callTimeoutMs: 60000            # deadline for one tools/call
    # cachePath: !!js dshHomePath('lazy-mcp/tool-cache.json')   # default: <DSH_PROFILE_DIR>/lazy-mcp/tool-cache.json
    servers:
      - name: docs                  # ^[A-Za-z0-9_-]{1,32}$, unique
        transport: stdio
        lifecycle: lazy
        description: Documentation lookup
        command: npx
        args: ['-y', 'some-mcp-server']
        # env: { SOME_TOKEN: '...' }   # optional, merged over the scrubbed env
        # cwd: 'C:\path\to\project'    # optional
        # idleDisconnectMs: 120000     # optional per-server override

      - name: knowledge
        transport: streamable-http
        lifecycle: lazy
        description: Internal knowledge base
        url: https://mcp.example.com/rpc
        # headers: { Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`' }
```

除 server 的 `name`、`transport` 以及该 transport 的目标（stdio 用 `command`，streamable-http 用 `url`）之外，每个字段都是可选的。无效配置会让激活失败，并准确指出出错的具体路径。

### 环境变量清洗

stdio server 的子进程环境等于父进程环境**减去**所有匹配 `KEY|PASSWORD|SECRET|TOKEN`（不区分大小写）的名字，**再减去**所有 `DSH_*` 名字，然后与 server 显式的 `env` 合并。这与随包提供的子进程 seam 的定义一致，因此子 server 永远不会继承本进程的模型凭据。需要密钥的 server 必须通过自己的 `env` 映射获得它。**环境变量的值从不写入日志，也从不写入缓存**——只写入键集合，且仅用于检测配置变更。

## 导入已有的 MCP 配置

把 `configPaths` 指向任何包含标准 `mcpServers` 对象的 JSON 文件，其中的 server 就会出现在这里。已有的 **Pi**（`pi-mcp-adapter`）、**Claude Code**、**Cursor** 或 **`.mcp.json`** 配置就是这样变为可复用的，无需手工复制命令——另一个工具仍然是事实来源。

```yaml
- id: lazy-mcp
  config:
    configPaths:
      - '~/.config/mcp/mcp.json'          # Pi shared config
      - '~/.pi/agent/mcp-adapter.json'    # Pi adapter config
```

标准字段会被翻译：`command`/`args`/`env`/`cwd` 变成 stdio server，`url`/`headers` 变成 streamable-http server。路径开头的 `~/`，以及 `args`、`cwd`、`env`、`headers`、`url` 中的 `${VAR}` / `$VAR`，都会从环境中展开——未知的名字会按字面保留，而不是变成空字符串，这样错误就一直可见。

在存在等价物的地方，Pi 特有的调优会被沿用：

| Pi 字段 | 此处效果 |
|---|---|
| `lifecycle` | 直接使用（`lazy` / `lazy-keep-alive` / `eager` / `keep-alive`） |
| `idleTimeout` | Pi 中为**分钟**，会转换为 `idleDisconnectMs` |
| `disabled: true` / `enabled: false` | 跳过该 server |
| `type: "sse"` | 以明确的错误拒绝——不支持 SSE |

`directTools`、`includeTools`、`excludeTools` 和 `searchKeywords` 会被忽略；它们在这里没有等价物。

### 优先级与 overrides

名字冲突时，靠后的来源胜出：

1. 按顺序的每个 `configPaths` 文件
2. 行配置中的内联 `mcpServers` 映射
3. 原生的 `servers` 数组
4. 逐字段的 `overrides`

`overrides` 会修补某个已导入 server 的个别字段，因此你可以给它一个描述或一个生命周期，而无需重复它的命令：

```yaml
    overrides:
      chrome-devtools:
        description: Browser automation and debugging
        lifecycle: lazy-keep-alive
```

带有 `disabled: true` 的条目会彻底移除该名字，这就是在不编辑另一个工具的文件的前提下关闭某个已导入 server 的方式。

### 容错规则

导入的文件是活的数据源，可能在你脚下发生变化，因此那里出问题不能阻止 Harness 启动：

| 情形 | 行为 |
|---|---|
| `configPaths` 文件缺失 | **警告并跳过** |
| `overrides` 的键什么都没匹配到 | **警告并忽略** |
| `configPaths` 文件是畸形 JSON | **激活大声失败** |
| server 条目无效（没有 `command` 或 `url`、名字不合法） | **激活大声失败** |

规则是：缺失可容忍，损坏要大声。

## 生命周期模式

按 server 用 `lifecycle` 设置。默认值是 `lazy`。

| 模式 | 何时连接 | 空闲断开 | 适用场景 |
|---|---|---|---|
| `lazy` | 首次使用时 | 是，`idleDisconnectMs` 之后 | 默认值：启动成本低、偶尔使用 |
| `lazy-keep-alive` | 首次使用时 | **首次使用之后永不** | **启动成本高**——你不想每个空闲窗口都重付一次启动成本 |
| `eager` | 激活时开始 | 否，除非显式设置了 `idleDisconnectMs` | 你想让它保持热，但慢 server 不能拖慢启动 |
| `keep-alive` | 激活时开始 | 否，除非显式设置了 `idleDisconnectMs` | 需要始终可用的 server |

`eager` 和 `keep-alive` 在插件激活时开始连接，但激活**从不等待**它们，因此一个缓慢或故障的 server 无法拖延 Harness 启动。后台连接失败会被记录日志，而不会抛出。

首次成功连接之后，`lazy-keep-alive` server 会被报告为 `pinned=yes`，其空闲计时器不再被重新启动。

四种模式的恢复方式相同：如果连接断开，**下一次调用会重连**。没有后台健康检查，也没有重连循环。

## 元数据缓存

首次成功连接会把 server 的工具列表写入 `<DSH_PROFILE_DIR>/lazy-mcp/tool-cache.json`（原子性的"临时文件加重命名"写入）。当 server 处于休眠状态时，`mcp_tools` 从该缓存作答，且**不会启动 server**：

```
mcp_tools { server: "docs" }                  -> cached list, server stays dormant
mcp_tools { server: "docs", refresh: true }   -> connects and re-reads live metadata
```

缓存以 server 的 transport、command、arguments、工作目录、URL 以及 env **键集合**的指纹为键。改动其中任何一项都会让该条目不可用，因此过期的缓存永远无法描述一个此后已被重新配置的 server。缺失、不可读、畸形或版本不对的缓存永远不是错误；它只意味着还没有 server 缓存过元数据。

空闲断开之后，记录会回退到缓存，因此 `mcp_servers` 报告 `tools=13(cache)`，而不是声称拥有它已经不再拥有的实时元数据。如果缓存写入尚未落地，它会改为报告 `(memory)`——此时仍然使用进程内的列表，而不是强制重连。

## 工具

MCP 暴露三种原语：**tools**（模型调用的函数）、**resources**（它能读取的文档和数据）以及 **prompts**。本网关桥接前两种。prompts 不做桥接。

| 工具 | 是否连接？ | 用途 |
|---|---|---|
| `mcp_servers` | 从不 | 列出 server，含生命周期、状态、工具数量、元数据来源、最近错误、连接次数 |
| `mcp_tools` | 仅在 `refresh: true` 时 | 列出一个 server 的工具及其输入 schema；休眠时从缓存提供 |
| `mcp_call` | **是，按需** | 调用 `server` + `tool` + `arguments`，然后重置空闲计时器 |
| `mcp_resources` | **是，总是** | 列出一个 server 的资源和资源模板；报告"没有资源"而不是失败 |
| `mcp_read_resource` | **是，按需** | 按精确的 `uri` 读取一个资源，然后重置空闲计时器 |

典型流程：

```
mcp_servers                                        -> which servers exist, which are dormant
mcp_tools    { server: "docs" }                    -> cached list; server NOT started
mcp_tools    { server: "docs", refresh: true }     -> starts it; live list
mcp_call     { server: "docs", tool: "search",
               arguments: { query: "x" } }         -> runs it; resets the idle timer

mcp_resources      { server: "kb" }                -> what it can READ; connects
mcp_read_resource  { server: "kb",
                     uri: "kb://doc/42" }          -> the body; resets the idle timer
```

并发：需要同一个休眠 server 的两个调用会共享一次连接尝试；对不同 server 的调用彼此独立。

### 资源

`mcp_resources` 是读取的那半边。它之所以存在，是因为有些 server 几乎把全部价值都放在资源里——文件系统 server 暴露文件，知识库暴露文档，数据库 server 暴露 schema 和行——而只桥接工具的网关连接到这些 server 之后什么也展示不出来。

**它总是连接。** `mcp_tools` 可以在休眠时从缓存作答；资源列表不行，因为持有一份过期列表比付一次连接的代价更糟。因此休眠的 server 会在第一次 `mcp_resources` 调用时被唤醒，空闲计时器照常回收它。对 `resources/list` 回答"method not found"的 server 会得到一句说明这一点的话，而不是一个失败。

**二进制正文从不内联。** 资源携带 `text` 或 `blob` 之一。base64 正文会把上下文窗口花在模型无法使用的字节上，因此它会变成一条大小提示——与官方 `dsh-mcp-resources` 使用的同一种投影：

```
demo://resource/dynamic/blob/42  text/plain
[binary resource: 72 base64 characters; available to programmatic callers]
```

文本正文会完整返回，每个正文最多 8,000 个字符，其上方是 uri 和 mime 类型。

**模板只列出，不展开。** 像 `demo://resource/dynamic/text/{resourceId}` 这样的模板会按原样显示，并附注说明要替换其中的变量并读取结果 uri；网关从不猜测占位符里应该填什么。

这两个工具都通过工具侧所用的同一个 `ensureReady` 连接，因此资源读取共享惰性生命周期、空闲回收和投递语义。两者都不会被缓存到磁盘——只有工具元数据会被缓存。

## 状态面板

浏览器半边向侧边栏添加一个条目（`sidebar.panellist`，order 40，label `MCP`），以及它背后的面板（`main`，key `lazy-mcp`）。按钮由 shell 拥有：`sidebar.panellist` 的 id 会寻址同名的 `main` 面板，因此本插件不写任何导航代码，只提供一个图标（通过 slot 的 `{ size, active }` props）和一个面板主体。

面板每 5 s 轮询一次 `/lazy-mcp/state`，并按 server 展示：状态徽章、`lifecycle`、带元数据来源的工具数量、最近使用时间以及连接次数。打开它**无法唤醒 server**——该路由读取内存中的记录，从不触碰 transport。

| 徽章 | 含义 | 依据 | Token |
|---|---|---|---|
| 正在使用 (in use) | socket 打开，120 秒内使用过 | `status === 'ready'` **且**最近一次调用在 120 s 内 | `--dsw-alias-state-success-primary` |
| 已连接 (connected) | socket 打开，空闲 | `status === 'ready'`，空闲时间超过该阈值 | `--dsw-alias-brand-primary` |
| 连接中 (connecting) | 连接进行中 | `status === 'connecting'` | `--dsw-alias-state-warn-primary` |
| 休眠 (dormant) | 无进程，无错误 | `status === 'dormant'`，无已记录错误 | `--dsw-alias-state-idle-primary` |
| 连接失败 (failed) | 上次尝试失败 | `lastError` 存在——**优先于 transport 状态** | `--dsw-alias-state-error-primary` |

状态标签在 UI 中是中文；上方的含义列是本地化改动时的参照（见 [贡献指南](CONTRIBUTING.md)）。

最后一行才是关键：连接抛错的 server 会保持 `status: 'dormant'`，因此 Host 会在它旁边记录 `lastError`，面板报告失败，而不是一个让人安心的灰点。

**这五个里只有三个是真正的 Host 状态。** Host 恰好只有 `dormant`、`connecting` 和 `ready`；面板按新近程度把 `ready` 拆成两种颜色。正在使用与已连接是**同一种底层状态**——两者中 socket 都是打开的、工具列表都是实时的——它们之间那条 120 秒的线**纯粹是展示**：它不改变任何行为，也不改变 server 何时被丢弃。唯一真正起作用的线是 `idleDisconnectMs`。

因此，在默认设置下，一次使用会产生这样的时间线：

```
a call ──┬─ 0–120 s ────── 正在使用   (ready)
         ├─ 120–600 s ──── 已连接     (ready)
         └─ > 600 s ────── 休眠       (dormant, process released)
```

倒计时在连接时启动，并**被每次使用重置**，因此窗口是"距上次活动 10 分钟"，而不是"距连接 10 分钟"。活动指 `mcp_call` 或 `mcp_tools { refresh: true }`——两者都会触碰 server。`mcp_servers` 和走缓存的 `mcp_tools` **不**重置它，因为两者都不触碰 server；正是这一点让"看一眼工具列表"是免费的。

要在几分钟内看全三种状态，把窗口设为 `180`：120 s 的正在使用、60 s 的已连接，然后休眠。

该路由**只暴露名字、状态和计数**——从不暴露 transport 目标（它可能是一条命令行），也从不暴露环境变量的值。`GET` 是只读的，无法唤醒 server。`webServer` 是通过 `ctx.get` 读取的**软**依赖，因此 headless 和 SDK profile 会加载插件并获得三个网关工具，只是没有面板。

### 会话内的小徽章

面板只有一次点击之遥，但"现在有任何东西连接着吗？"这个问题不该花一次点击。因此浏览器半边还注册进 `conversation.session.header.utilities`——右对齐的 Session 工具区，位于会话日志下载（`order 0`）与 `dsh-better-sidebar` 的底部切换（`order 10`）之间——作为一个小徽章。

![会话内徽章](assets/chip.png)

<sub>会话头部的徽章：绿点与已连接的 server 名称。</sub>

| 情形 | 徽章 |
|---|---|
| 所有 server 都休眠 | **什么都不渲染** |
| ≥1 个 server `ready`，最近 120 s 内无使用 | 强调色圆点 + 已连接的名字 |
| ≥1 个 server `ready` 且在 120 s 内使用过 | 绿点 + 已连接的名字 |
| ≥1 个 server `connecting` | 强调色圆点 + 名字 |

**全部休眠时什么都不渲染是刻意为之。** 缺席本身就是信号，而每个会话里都放一个徽章——包括大量从不接触 MCP server 的会话——会变成不携带任何信息的永久杂物。详细信息由 tooltip 承载：已连接的名字、失败数量以及生效的空闲窗口。

徽章与面板共享**一个**轮询器：一个模块级 store 加一个监听器集合，因此两个消费者每个间隔只产生一次请求而不是两次，并且当最后一个消费者卸载时轮询完全停止。

### 空闲窗口可从面板调整

面板带有一个设置：空闲窗口，以**秒**为单位输入。存储的值是毫秒，Host 会校验范围（`MIN_IDLE_DISCONNECT_MS`…`MAX_TIMER_DELAY_MS`），但秒才是人能想象的——`600` 是一个窗口，`600000` 是一个会被看错的数字。

| 动词 | 效果 |
|---|---|
| `GET /lazy-mcp/state` | 快照 |
| `POST /lazy-mcp/state` `{ "idleDisconnectMs": 1800000 }` | 设置窗口，为每个已连接的 server 重新启动截止时间，并持久化 |
| `DELETE /lazy-mcp/state` | 丢弃覆盖值并恢复配置中的值 |

**优先级：面板胜过行配置。** 覆盖值持久化在 `<cache directory>/settings.json`——与元数据缓存相邻，这样插件只拥有一个目录，并复用缓存路径自身的回退链——它能经受重启。"恢复默认"会**删除**该文件，而不是写入一个空对象，因为文件不存在才是"没有覆盖"的规范表示。

两处刻意的限制：

- **配置中每个 server 的 `idleDisconnectMs` 不会被改动。** 这是刻意的逐 server 决定，因此只有没有该字段的 server 才跟随面板。快照会按行报告 `idleDisconnectMsExplicit`。
- **重新启动只触及 `ready` 记录。** 休眠的 server 没有可移动的截止时间，给它启动会显示一个并未运行的计时器。

两个动词都不会连接、断开或重新配置 server。请求体限制在 4 KiB 以内，并在写入任何内容之前完成校验。

## 投递类别

失败的 `mcp_call` 会报告**请求走到了哪一步**，因为重试一个可能已经执行过的调用，正是重复扣款或重复发布评论的由来。每条失败消息都带有 `[delivery=…]` 以及明确的指引。

| 类别 | 含义 | 给模型的指引 |
|---|---|---|
| `not_sent` | 请求从未到达 server；什么都没运行 | 修好原因后重试 |
| `server_error` | server 以 MCP 错误作答 | 工具可能已部分运行；先读错误 |
| `may_have_run` | 请求已发出，结果未知（超时、取消、传输丢失） | **不要自动重试**——确认效果或询问用户 |

`may_have_run` 失败还会重置连接，因此下一次调用从干净的 transport 开始。

设计上偏保守：在派发*之后*发生的拒绝会被归为 `may_have_run`，即使它很可能无害。MCP SDK 的客户端参数校验也落在 `may_have_run` 而非 `not_sent`，因为本插件无法证明什么都没发出。宁可悲观是安全的方向。

## 空闲生命周期

1. 激活时注册三个工具，并把每个 server 标记为 `dormant`（`eager` / `keep-alive` 除外，它们会在后台开始连接）。不启动任何进程，也不打开任何连接。
2. 对某个 server 的第一次 `mcp_tools { refresh: true }` 或 `mcp_call` 会连接它并启动空闲计时器。
3. 之后的每次使用都会重新启动计时器。不带 `refresh` 的 `mcp_tools` 不会，因为它从不与 server 对话。
4. 计时器触发时，transport/client 被关闭，子进程被释放，server 回到 `dormant`，缓存的元数据保持完好。
5. 插件卸载或 HMR 会通过 `ctx.effect` 处置每一个存活连接，并等待任何进行中的缓存写入。

## 验证

`verify.mjs` 在一个全新的 Node 进程中用桩 Cordis context 驱动插件真实的 `apply()`，演练的是实现本身而不是它的副本：

```sh
pnpm run verify   # or: node verify.mjs
```

它覆盖空配置；缓存往返（包括"提供缓存并没有重连"）；全部四种生命周期模式；全部三种投递类别；标准 `mcpServers` 导入及其优先级、overrides、`${VAR}` 展开和 Pi 的分钟到毫秒 `idleTimeout` 转换；容错规则；缓存路径回退；机器上存在真实 Pi 配置时的该配置（否则跳过）；以及资源半边（列出、读取、模板替换和二进制投影）。当前结果：**76 checks, 0 failures**。它通过 `npx` 启动 MCP reference server，因此首次运行会下载那个包，并且需要网络访问。

CI 在 Linux 和 Windows 上运行 check、lint、pack 以及完整的验证 harness。

旁边还有两个一次性探针，用于回答"*这个* server 究竟暴露了什么？"：

```bash
node probe-capabilities.mjs   # tools / resources / prompts capabilities, one server
node probe-resources.mjs      # full resource + template surface, plus one read
```

这个 harness 之所以存在，是因为 DSH Loader 会锁定已导入模块的代号：运行中的 Harness 不重启就无法拾取被编辑过的插件 JavaScript，因此宿主内测试看不到代码改动。见*开发说明*。

## 已知限制

- **仅文本结果。** 原始 MCP 块会被概括：文本透传，图像/音频/资源变成显式的 `[image omitted: …]` 标记。官方桥接还会通过附件服务做持久化的图像投影；这里刻意没有重新实现。
- **二进制资源只被报告，不被投递。** `blob` 正文会变成一条大小提示；字节留在 server 那边。需要它的程序化调用者得用官方桥接。
- **没有重新通知同步。** 如果已连接的 server 在会话中途改动工具列表，缓存列表会在下次连接时刷新，而不是通过 `list_changed` 订阅。资源列表从不缓存，因此总是实时读取。
- **不支持 OAuth。** 需要认证的 server 使用静态 `headers`。
- **没有 prompt 模板、资源订阅或基于任务的执行。**
- **没有 `directTools`。** 每个 MCP 工具都通过 `mcp_call` 到达；没有任何工具作为一等工具、带着自己的 schema 注册进工具目录。
- **没有 `includeTools` / `excludeTools` 过滤**，也没有 `searchKeywords`。
- **`mcp_servers` 报告缓存状态**，从不探测休眠的 server。
- **UI 状态标签是中文。** 行为不受影响；欢迎提交本地化 PR。

## 开发说明

DSH 插件系统的两个行为决定了本包必须如何被开发。

1. **在 workspace 中编写的 bundle 以符号链接方式安装，因此它的依赖必须与源码相邻。** `install_bundle` 把 workspace 目录链接进 profile 的 `node_modules`，而 Node 解析的是 *realpath*，所以它会到源文件旁边去找 `node_modules`。因此 `.npmrc` 里要有 `node-linker=hoisted`：pnpm 默认的隔离布局把依赖放在 `node_modules/.pnpm` 下，从被符号链接的路径无法到达那里。失败表现是 `failed to import` / `Cannot find package …`。安装打包好的 tarball 或从 GitHub 安装可以绕开整个问题。
2. **被编辑的 JavaScript 需要重启 `dsh web`。** Loader 会锁定已解析的模块代号，因此把该行关掉再打开只会重新应用*配置*（配置确实会热重载），但会重新导入*缓存的模块*。改动入口文件路径或包名也打不破这一点。改完就重启。

### 三个值得记住的缺陷

1. **元数据缓存在生产环境里静默地从未写入。** `resolveCachePath` 信任 `$DSH_PROFILE_DIR` / `$DSH_HOME`，但 Host 进程并不继承它们——那些变量是被注入到*shell 工具调用*中的，而不是注入到 Host。harness 之所以通过，是因为它显式提供了 `cachePath`。已通过 `~/.dsh` 回退修复，现在由一个先删掉这些变量的测试覆盖。**只有实机测试才可能抓到这个问题。**
2. **一条空闲断开的记录仍声称拥有实时元数据**，于是缓存从未被查询，`mcp_tools` 会重连而不是做描述。harness 抓到了这一个，但只是因为缓存测试断言的是*连接次数*，而不只是返回的文本。
3. **一个计时器断言不稳定。** 为 6s 的空闲窗口等 8s 在大多数运行中通过，但在负载下偶尔失败。现在每个空闲断言等待的时间都超过其窗口的两倍。与计时器赛跑的测试需要余量，而不是猜测。

这个插件带来的教训：对状态机断言，而不是对渲染文本断言；永远不要信任 Host 可能没有的环境变量；给每个计时器断言留出充裕的余量。

## 贡献

欢迎 bug 报告、修复和文档补丁——开发环境搭建和仓库不变量见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE) © 2026 zhe97396-tech

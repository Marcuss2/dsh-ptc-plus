# Program Capability Projection

> 本文描述当前已实现的 native binding 投影。它是过渡架构，不是最终的程序数据面边界；
> `ctx.fs` 平级 Consumer、内部值可见性和仅在模型出口实施 context budget 的目标决策见
> [Program Data Plane 与模型输出边界](program-data-plane.md)。

## 目标

严格 PTC 模式只保留一个模型直接调用的 DSH tool：`run_code`。程序中的外部能力使用程序化命名空间，而不是再次暴露一套看起来可由模型直接调用的 native tool 语法：

```ts
const page = await workspace.readLines({ path: "src/index.ts", offset: 1, limit: 200 })
const text = page.lines.map(line => line.text).join("\n")
const found = await workspace.findFiles({ pattern: "docs/**/*.md" })
const other = await host.invoke({ name: "third_party_tool", args: { key: "value" } })
const child = await code.run({ code: "return 1", description: "Evaluate generated source" })
```

`program-native` 只描述调用形状。它不允许绕过 DSH 使用 `node:fs`、`child_process` 或其他无治理宿主能力。

## 当前投影

当前版本实现文件读取与发现两个只读垂直切片：

| Program API | Host binding | 语义 |
| --- | --- | --- |
| `repl.state({ action, name? })` | PTC Plus session kernel | 查询 durable/volatile 状态，或保存、恢复、删除命名的 durable frontier；始终随当前 cell journal 一次提交 |
| `workspace.readLines({ path, offset?, limit? }) -> { path, offset, lines, totalLines }` | `read({ file_path, offset?, limit? })` | 双向翻译并校验 program-native 数据契约，同时保留 native `read` 的有界、逐行语义；不会把截断窗口冒充完整文件 |
| `workspace.findFiles({ pattern, root? }) -> { root, files }` | `glob({ pattern, path? }) -> { root, paths }` | program glob 采用 root-relative 直觉语义：无 `/` 的 pattern 由 adapter 加前导 `/`，只匹配搜索根；任意深度显式用 `**/*` / `**/name`；同时翻译输入根目录与结果字段，保留官方排序、hidden/ignored、VCS 排除及“只返回文件”语义 |
| `code.run({ code, description })` | 插件注入或宿主已有的 `run_code` binding | 在隔离 child runtime 中执行动态源码 |
| `host.invoke({ name, args })` | 当前 cell 中同名的未适配 host binding | 第三方和动态能力的显式兼容入口；严格 PTC SDK 按当前 native schema 为每个 `name` 生成参数类型 |
| `cordis.*` | 当前 RC7 已知 Cordis creator profile | 完整且无额外未知 `cordis_*` binding 时提供强类型翻译；typed domain transcript 可恢复 registry/Fiber effect，Client approval、异步 settlement 和失败/部分应用结果保持 volatile；未知/变更 binding 保留在 `host.invoke`，不猜测 domain schema，并因无法可靠分类读写而在调用前进入 volatile；数据映射规则见 [Full-access composition](full-access.md) |

只有当前 agent 的 request bindings 中存在对应 source binding 时才安装 `workspace.readLines` / `workspace.findFiles`。adapter 每个 cell 重新建立，旧 closure 不能越过 execution lease。一次 program call 只调用一次原 host binding，因此 authority、policy、approval、取消、并发调度、审计和原生 nested dispatch 内容仍由 DSH 拥有。

当前 request 注入的 namespace global 与 error class 名称是保留 binding，`repl` 始终保留。模型必须直接使用每格重绑的 namespace；不能在顶层重新声明、解构或赋值这些名称，也不应把 namespace/member 保存到另一个持久 binding。前者由 preflight 拒绝，后者在原 execution lease 结束后确定性失效，避免旧 authority 被后续 cell 误用。

projection 同时翻译调用名字和完整数据契约：程序侧使用 domain namespace、不同 member 名和 program-native 字段，避免模型把 familiar native tool grammar 预测成直接 tool call。adapter 负责把 program request 映射到 DSH source capability，并把 canonical host outcome 校验、重建为 program result。即使当前 host outcome 的若干字段恰好与 program result 同名，也不得直接透传对象；否则 native 后续新增字段、展示 metadata 或不兼容实现会悄悄成为 PTC ABI。authority、policy、effect 和底层 completeness 事实仍只有一个来源，但 native schema 中只服务于模型 tool/UI 的形状不得泄漏为 program API。

当前 `workspace.readLines` 的显式映射为：

```text
program request.path       -> native request.file_path
program request.offset     -> native request.offset
program request.limit      -> native request.limit

native outcome.path        -> program result.path
native outcome.offset      -> program result.offset
native outcome.lines[]     -> program result.lines[] { number, text }
native outcome.totalLines  -> program result.totalLines
native extra/missing/invalid fields -> WorkspaceError

program request.pattern    -> native request.pattern
pattern without "/"       -> native pattern prefixed with "/"
program request.root       -> native request.path
native outcome.root        -> program result.root
native outcome.paths[]     -> program result.files[]
native extra/missing/invalid fields -> WorkspaceError
```

这里复用的是 DSH 的 source semantics 和受治理执行链，不是 native tool 的 wire schema。输入、结果、错误、提示、留存和展示共同组成 projection；只改名称或只改参数都不算完成。

开放的 domain JSON 结果也必须投影。它可以保留官方版本化业务字段，但仍需校验为无环、无 accessor、无自定义 prototype 的 JSON tree，并重建为 detached program value；“开放”不能解释成 host object passthrough。

已适配的 raw alias 不再安装或宣传：存在 `workspace.readLines` 时，程序中没有 `tools.read`。其他能力不以 `tools.<native-name>` 形式出现，而由 `host.invoke` 显式表明这是兼容投影。`run_code` 的程序内元编程入口是 `code.run`；模型直接调用的外层 transport 名仍是 `run_code`。

当前不提供 `workspace.readText`。native `read` 有 line、单行字符和 byte ceiling，拼接其结果会静默得到不完整文本。完整 snapshot 需要独立 provider operation、明确的 PTC retention ceiling，以及大值 resource/blob 协议后才能加入。写入、编辑与 shell 也暂不建立专用 facade；它们与 native `read` 仍通过显式 `host.invoke` 可达，不用一个看似稳定但丢失 UI/domain 语义的 namespace 隐藏原始契约。

## Prompt 契约

PTC Plus 用 `system-prompt/assemble` 的最终 assembly 生成 program capability SDK：

- model-visible tools 仍只有 `run_code`；
- SDK 声明实际可用的 `workspace`、`code`、`host` 和条件性 `cordis` namespace；
- 已适配 native schema、`tools.read` alias 以及 `Use the read tool` guidance 不进入严格 PTC prompt；官方 `tool:glob` 的“使用文件发现而非 shell、pattern 深度、只返回文件”等约束会翻译为 `workspace.findFiles` guidance；当前已知 Cordis profile 精确匹配时，native `tool:cordis` guidance 会经过名称、调用形状和字段契约翻译后与 `cordis.*` SDK 一起保留，不匹配时整体移除；
- `host.invoke` 列出当前 scope 可见但未适配的 capability 名称，并从公开 `ctx.tools.schemas(scope)` 为每个名称生成 `HostCapabilityArgs` 参数映射；运行时仍由相应 host binding 做最终 JSON contract 校验；
- 其他 native tool guidance 中的 capability 引用会翻译为显式的 `` `host.invoke` capability "name" ``；行为约束保留，但不再暗示模型可以直接调用 native tool；SDK 参数注释中的跨 capability 引用执行同一翻译；
- 错误使用 `WorkspaceError`、`CodeExecutionError` 或 `HostCapabilityError`，不把高层 program face 描述为 native `ToolCallError`。

## 持久化与失败

journal 已按 `global + member + args` 记录调用，因此 namespace 投影不需要 replay 特例。冷重放校验 program-facing 名称和参数，并从 journal 返回已记录的结果，不重复 host effect。若历史依赖的 namespace/member 在当前插件实现中消失，重放必须失败，不得退回 direct Node I/O。

当前 RC7 的 nested event 仍记录底层 native tool 名；这保留真实 authority/audit 事实，但客户端尚不能为所有 program call 重建 native rich card。本文不声称已经解决该 RC7 presentation 限制。schema 投影也不改变 `workspace.readLines` 的窗口语义；完整 `fs.readText`、stream cursor 和大值 retention 仍属于未实现的 Program Data Plane 迁移目标。

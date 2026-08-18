# Program Data Plane 与模型输出边界

## 状态

本文记录 PTC Plus 的目标架构决策，**尚未描述当前已经完成的实现**。当前版本仍使用
`workspace.readLines`、`workspace.findFiles` 和 `host.invoke` 投影 native tool binding；严格 PTC 的 compatibility SDK
会从当前公开 tool schema 生成参数形状，并清理 native tool guidance，但这不改变 native read 的
窗口语义。现状及其限制见 [Program Capability Projection](capability-projection.md)。实现迁移完成前，
README、SDK 和测试不得把本文中的 `fs.*` API 宣称为可用能力。

## 决策

PTC 中的值默认属于程序数据面。值只有跨过显式模型输出边界后，才进入模型上下文：

```text
Service Definition / Provider (ctx.fs)
                 |
       governed program dispatch
  policy / scheduler / cancel / audit
                 |
       canonical program value
                 |
       REPL heap / stream / compute
                 |
          top-level return
                 |
      output budget / model context
```

因此，`fs.readText` 是程序读取文件；顶层 `return` 才是模型读取程序结果。读取、计算、过滤、
索引和聚合不会因为中间值可能超过模型 context window 而改变语义。

成功数据的初始设计只保留一个模型输出边界：顶层 `return`。普通 `console.*` 是调试遥测，
不得成为可绕过 `return` 的隐式模型输入。未捕获异常和 PTC 诊断属于独立的控制面输出；它们
必须有固定、受限的结构，不能携带任意程序值来绕过成功输出边界。只有确有多次增量输出需求时，
才考虑增加命名明确且使用同一输出预算的 `model.emit(value)`；它不是文件读取 API 的前置条件。

## 当前选择为何合理

当前 `workspace.readLines -> native read` 不是随意的绕路。native Tool dispatch 已经同时接入：

- scoped authority、pre/post policy、approval、scheduler、取消和并发规则；
- nested call start/settle event、audit 和 UI tool-call tree；
- canonical JSON value、错误归一化和 result materialization；
- PTC host-call transcript，因而可参与 durable replay。

复用 native `read` 因此保住了执行控制面和展示生命周期，而且其有界结果容易内联进 journal。
问题在于 native `read.execute` 在 canonical value 产生之前就建立 line/byte window；PTC 获得的已经是
展示窗口，不可能在 REPL 内恢复完整文本。给 `host.invoke` 补 schema 或重复调用 window 都不能消除
这个语义损失。

正确修复不是丢弃现有执行管线，而是只替换管线中的 operation Consumer：复用 ToolRuntime 的执行
外壳，不复用 native `read` 的模型展示结果。

## 两种 Consumer

DSH 的 filesystem Service Definition 已经负责 target identity、路径解析、完整文本读取、流式
解码、binary rejection 和 typed error。read window 明确属于 Consumer，而不属于 filesystem
本身。

native `read` 是面向模型和 UI 的 Consumer。它可以拥有行窗口、字符上限、展示 metadata、
tool schema 和 UI description。PTC 是另一个平级 Consumer；它应从同一个 `ctx.fs` 获取
filesystem semantics，并通过同一受治理 execution pipeline 取得 authority、policy、取消、audit
和 UI lifecycle，但不得继承 native `read` 的展示协议：

```text
                         +-> native read Consumer -> bounded result -> model
ctx.fs Service/Provider -|
                         +-> PTC fs Consumer ------> complete value -> program heap
                                      |                    |
                                      +-> UI projection    +-> return -> model
                                      +-> replay retention
```

这意味着 PTC program API 不是 native tool schema 的改名版本，也不是 `host.invoke("read", ...)`。
模型工具的 `description`、`file_path`、line window 和 rich card metadata 都不是 filesystem
domain contract。

## Governed program dispatch

一次 program capability 调用必须产生彼此独立的三个结果，不能再用一份 model-facing `content`
同时承担三种职责：

| 产物 | 消费者 | 语义 |
| --- | --- | --- |
| canonical value | PTC runtime | 完整领域值，返回 REPL heap |
| durable record | replay | canonical value 的 inline snapshot、session-owned blob，或明确的 volatile 决定 |
| presentation | UI/audit | 由 operation 和参数确定性派生的标题、位置、状态和有界 preview |

只有外层 `run_code` 的 completion renderer 能把程序 `return` 转成 model-facing content。nested
program operation 的 presentation event 是 log/UI-only；被 UI 看见不等于进入模型上下文。

最小实现应增加一个 program-only operation，例如 `fs.readText`，并让它走现有 ToolRuntime 的
prepare/dispatch/finalize/finish 生命周期。它直接消费 `ctx.fs`，但不是无治理的 service call：

```text
fs.readText(path)
  -> ToolRuntime program dispatch
  -> PTC filesystem Consumer
  -> ctx.fs.resolve/stat/readText + fs/observed
  -> canonical string to worker
  -> bounded read UI intent + replay retention
```

native `read` 保持不变，继续服务模型直接读取。program operation 可以定义 provider-neutral 的
`ToolCallView`，复用 read icon、file location、policy hooks 和 nested lifecycle；它不需要复用
native `read` 的 line-window output schema。nested result 不生成 top-level `presentationMeta`，因此
首版只能依赖参数派生 call view 与有界 logged content，不能直接宣称复刻 native read result card。
UI preview 是 presentation，不能反向决定 canonical value。

`ProgramOperation` 应首先作为 PTC Plus 自己拥有的 Consumer/内部 ToolDefinition 实现，通过现有
公共 `ctx.tools`、`tools/execute` 和 nested Code/PTC dispatch 复用治理管线。它必须只在允许的
Code/PTC execution 中可调用；native presentation 下不能泄漏为模型直接 tool。注册、scoping、
presentation event 和 retention 只能使用可分发的公共 API，不能修改或 fork DSH 源码，也不能复制
scheduler、approval 或 event protocol。若公共 API 无法满足这些条件，问题是插件实现的可分发性阻塞，
不是把 native model tool 继续当作 PTC ABI 的理由。

DSH 当前公开 Code Mode bridge 已经提供关键分离：nested tool 结算后，程序立即取得 canonical
`result.value`；`tools/code-dispatch-log` 只塑形 session 中的 content 副本，nested event 不进入模型
消息。剩余的隔离工作在注册表表面：`ctx.tools.register()` 的 definition 默认会进入 `schemas()`，
所以插件必须同时证明 raw internal name 不进入 native prompt、不接受无 parent 的 direct execution，
并且只由 PTC facade 投影。只隐藏 prompt 而不拒绝 direct execution 不构成 program-only。

## Program API

最小文本 API 应表达 filesystem 语义，而不是模型展示语义：

```ts
const source = await fs.readText("README.md")
const facts = analyze(source)
return facts
```

大文件使用流式 facade 在程序内完成消费：

```ts
const index = createIndex()

for await (const chunk of fs.streamText(path)) {
  index.consume(chunk)
}

return index.summary()
```

约束如下：

- `fs.readText(path)` 返回完整解码文本，或者以 typed error 失败；不得静默截断。
- `fs.streamText(path)` 提供完整文本流；chunk 边界不具有业务语义。
- 调用参数只包含 filesystem domain 所需信息，不包含 `description` 或 token/window 参数。
- adapter 使用 session cwd、当前 execution actor、取消信号以及适用的 sandbox/policy；它不能通过
  `node:fs` 绕开 DSH authority。
- adapter 必须经 governed program dispatch 调用 Consumer；直接调用 `ctx.fs` 只提供 provider
  semantics，本身不足以替代 ToolRuntime 的 policy、audit、UI 和 lifecycle。
- 若现有公共 seam 不足以携带 actor、policy 或 audit，应在插件内寻找可分发的 Consumer/ToolDefinition
  组合；不得修改或 fork DSH，也不得退回 native tool Consumer 作为 PTC ABI。

`CodeBindingFunction` 的公开 transport 只能返回 `Promise<CodeJsonValue>`，不能直接跨边界返回
`AsyncIterable`。因此上述 `fs.streamText()` 必须是 worker 内的 ergonomic facade，底层以插件拥有的
`open/next/close` JSON cursor protocol 调用 program operation，并在 `finally`/取消时关闭 cursor；
它不是 host `ctx.fs.streamText()` 对象的直接透传。没有 cursor 生命周期、backpressure 和取消测试
前，首版只实现 `fs.readText`，不得把示例当成现有能力。

该规则可以推广到 shell、web 和其他程序能力：program API 接收领域参数，UI 摘要应由 operation
和参数确定性派生，不要求程序为了 UI 再填写 `description`。

## 预算归属

不同预算必须留在各自边界，不能用模型 context budget 代替运行时资源治理：

| 边界 | 合法限制 | 禁止承担的职责 |
| --- | --- | --- |
| filesystem/provider | authority、sandbox、I/O、取消、typed resource error | token、模型 context、UI 行窗口 |
| PTC runtime | heap、wall time、stream backpressure、IPC/message resource | 模型展示截断 |
| durable retention | journal/blob 大小、session export 完整性、replay 校验 | 模型 context |
| model egress | value encoding、输出字节、token、context、render | 改写内部读取语义 |

`readText` 可能因真实的 heap 或 provider resource limit 失败；这与模型上下文无关。对预期较大的
输入，程序应使用 `streamText`，从而让内存由流和 backpressure 控制。

顶层 `return` 超出输出预算时必须整体拒绝并给出稳定诊断，要求程序返回投影、摘要或 artifact
引用。不得静默截断，也不得把完整值先塞入模型上下文再要求模型自行缩减。现有 `PTC-O001`
可以继续承担这个出口失败语义，但其 help 必须指向缩小返回值，而不是缩小内部读取窗口。

## Durable 与大值

“不进入模型上下文”不等于“不需要持久化”。如果文件内容影响后续可恢复 heap，精确重建就必须
保留同一内容或一个随 session 可迁移的稳定快照。完整值、精确 replay、零 retention 三者不能同时
成立。可恢复的外部输入仍须满足 session log completeness：

- 小结果可以继续以内联 value graph 记录；
- 大结果或 stream transcript 可以使用 session-owned、content-addressed blob/chunk 记录；完整 session
  export 必须包含这些内容，不能产生不可迁移的旁路依赖；
- 如果当前宿主不能可靠保留某次输入，cell 必须在完整值交给程序前进入 sticky volatile；live
  heap 仍获得完整值，但该后缀不再声称可冷恢复。不能为了 durable 而截断数据，也不能把缺失内容
  伪装成完整 replay；
- retention、IPC 和磁盘限制只决定 durable/volatile 或 resource failure，不决定模型能看到多少。

这保持了既有原则：session log 是所有可恢复状态的唯一真相；volatile heap 可以继续使用，但不被
伪装成可冷恢复状态。

## 当前迁移阻塞

目标边界与当前实现之间还有四个必须显式消除的差异：

1. `SessionRuntime.valueLimits()` 仍把 `maxOutputBytes` 同时用作 binding value 的
   `maxStringBytes`；大字符串会在进入 live heap 前失败。program transport/heap limit 必须与 model
   egress limit 分开，或由上述 cursor/chunk transport 绕开整值 IPC。
2. 当前 outer `run_code` renderer 会把 `logs` 与 `result` 一起写入模型 content。“只有 return 的成功
   值进入模型”仍是迁移验收条件；普通 `console.*` 必须另有有界 UI/telemetry 去向，诊断则保留封闭
   控制面契约。
3. 大值 inline journal、session-owned blob/chunk retention 和“完整值交给 heap 前先降级 volatile”
   尚未实现。不能把 output-limit 误称为 volatile fallback。
4. nested event 不携带 top-level `presentationMeta`。首版可使用 deterministic `presentCall` 与
   `tools/code-dispatch-log` preview；专用 read result card 必须另行证明 replay 后仍可重建。

## 迁移边界

当前 `workspace.readLines -> native read` 是保留 execution/replay/UI 能力的过渡实现，不是目标
filesystem API；`host.invoke("read", ...)` 只是兼容逃生口，也不能成为目标路径。迁移应满足以下
可观察结果后再删除旧投影：

1. 程序可读取超过模型输出预算的完整文本，并在内部计算后只返回小结果。
2. 同一完整文本若直接 `return`，只在模型输出边界失败，不影响已证明成功的内部读取语义。
3. 大文件可流式处理，不要求按 native `read` window 往返，也不产生隐式模型输出。
4. `fs.*` 不要求 `description`，prompt 不暴露 native `read` schema 或 guidance。
5. sandbox、authority、取消、audit 和 cwd 与同一 execution 的 DSH policy 一致。
6. durable replay 返回相同程序输入；无法保留时明确降级 volatile，绝不截断后冒充完整值。
7. 只有 `return` 的成功值进入模型；日志、journal、nested dispatch 和内部 capability result 不因被
   记录或展示在 UI 中而自动成为模型上下文。
8. UI 仍收到 read 类型、路径、运行状态和有界 preview；UI preview 的大小和内容不改变 canonical
   program value。

这组条件是一个统一边界的结果，不需要为每种文件大小、tool schema 或模型 context window 增加
特例。

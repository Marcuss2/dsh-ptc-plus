# Durable / Volatile 恢复协议

## 状态

本文描述 `dsh-ptc-plus` 的 journal、两阶段确认和冷恢复行为。代码事实源是 `internal/session-journal.js` 与 `internal/session-runtime.js`。

## 恢复承诺

PTC Plus 的正确承诺是：

> **精确恢复 durable 部分，完整运行 volatile 部分，不自动重放 volatile 副作用。**

- durable cell 的源码、tool transcript、结算顺序和 completion 足以精确重放；
- volatile cell 可使用 policy 允许但无法 journal 的 Node 能力，只保证当前 worker 生命周期内延续；
- 一旦进入 volatile，整个 live 后缀保持 volatile；
- restore 命名的 durable 状态可以显式丢弃 volatile 后缀；
- abort、timeout、worker exit、OOM 和进程恢复都回到最后一个 durable frontier；
- 被跳过的源码仍保存在原始 `tool/call` 中。

这避免了两个错误极端：既不为追求恢复而删除正常 REPL 能力，也不把无法迁移的 heap 伪装成可确定重建。

## Journal

每个进入 CodeRuntime 的 cell 创建 mutable tentative journal：

```ts
{
  version: 1,
  bindingMode: "loose" | "strict",
  status: "durable" | "volatile" | "discarded" | "noop",
  calls: HostCall[],
  operations: StateOperation[],
  confirms: string[],
  diagnostics: Diagnostic[],
  completion?:
    | { kind: "return", hasValue: false }
    | { kind: "return", hasValue: true, value: PtcValueGraphV1 }
    | { kind: "throw", error: { kind: string, message: string } },
  volatileReason?: string
}
```

字段含义：

- `durable`：创建可重放 node，推进 `durableHead`；
- `bindingMode`：记录该 cell 实际采用的顶层 binding 语义；冷重放读取每个 node 的记录值，不读取恢复时的 profile 配置；
- `volatile`：只推进 live heap，不推进 `durableHead`；
- `discarded`：基础设施失败，calls 和 operations 必须为空；若 opaque external capability 已越过 possible-effect boundary，则保留 `volatileReason`，恢复时不能把它折叠为 no-op；
- `noop`：程序未执行，calls 和 operations 必须为空；
- `confirms`：确认此前无 journal 的 call id 没有进入 runtime；
- `diagnostics`：本 cell 产生的封闭结构化诊断；
- `completion`：区分普通 return 与可重放的语义 throw；
- `volatileReason`：记录第一次触发降级的 capability。

journal、diagnostic、source、cause、call、operation、completion 和 completion error 都使用封闭字段集合；未知、symbol 或非枚举自有字段会使 journal 无效。host-call `args`/`value` 与 return completion `value` 都是封闭、规范化的 `ptc-value-graph/v1` envelope。诊断结构、source frame 依赖和稳定代码见[架构说明](architecture.md#诊断契约)。

当前实现只定义并接受本文这一种 `version: 1` schema；同一版本不存在其他历史形状或兼容迁移。包括 `bindingMode`、`diagnostics` 在内的必需字段缺失时 journal 必须失效，不能静默补默认值，否则会削弱最终持久值与 tentative journal 的严格一致性确认。profile 后续切换宽松/严格模式只影响新 cell，历史 node 始终按自身记录的模式重放。

## Host Transcript

每个 tool/repl binding call 保存：

```ts
{
  global: string,
  member: string,
  args: PtcValueGraphV1,
  ok: boolean,
  value?: PtcValueGraphV1,
  error?: string,
  settle: number
}
```

`settle` 必须是从 0 开始的连续序列。重放按源码产生调用，但按 recorded settlement order 释放结果；这同时校验调用提交顺序和异步完成顺序。

journal 的 host-call `args`/`value` 与 completion value 保存 `ptc-value-graph/v1` canonical envelope，不保存 decoded rich JS value，也不依赖递归 `JSON.stringify` 或 `structuredClone`。因此深层数组/对象、own `__proto__`、`undefined`、special number、BigInt、hole、shared identity 和 cycle 不会被外层 session JSON 改写。完整支持域和预算见 [PTC Value Graph V1](value-wire.md)。

## 两阶段确认

RC7 的真实流水线是：

```text
pre-execute -> tools/execute -> post-execute
            -> content finalization -> tools/result
            -> persistent tool/result event
```

插件采用：

1. `tools/execute` 保存 execution 对象与 session context；
2. `CodeRuntime.run` 真正进入 kernel 时创建 tentative journal；
3. 成功结果由 `presentationMeta` 投影 journal，失败结果由 around hook 附加；
4. `tools/result` 规范化最终 `meta.dshPtcPlus` 与 runtime tentative journal；
5. 两者语义完全相同时确认 tentative 状态；
6. cell 已执行但 metadata 缺失、损坏或被替换时，live kernel 单调降为 volatile；
7. 从未进入 runtime 时，把 call id 加入 pending no-op；
8. 下一个成功 journal 通过 `confirms` 持久确认 pending no-op。

真值表：

| 观察 | Live 行为 | 冷恢复行为 |
| --- | --- | --- |
| valid journal | 按 status 提交 | 按 journal 折叠 |
| 已执行，最终 journal 被删除 | cell 与后缀 volatile | unknown boundary |
| 未进入 runtime | pending no-op | 后续 `confirms` 存在时忽略 |
| 无法判断且未被确认 | 保守处理 | 回到此前 durable frontier |

比较先严格规范化 journal，再使用 PTC value graph 的扁平 wire 表示，不对深层参数做递归遍历。额外无关 metadata 不影响确认，但 `dshPtcPlus` 自身任何可观察差异都拒绝确认。

`tools/result` 不修改结果。若 pending no-op 尚未被后续 journal 确认进程就退出，冷恢复保守形成 unknown boundary。

## Nested run_code

只有模型直接发起的 top-level `run_code` 创建本 schema 的 cell journal。父 cell 的 `code.run` capability 在 upstream CodeRuntime 的隔离环境中执行 child，不创建 child PTC journal，也不产生可合并到父 heap 的 binding。

父 cell 把 `code.run` 当成普通 host call，记录其 graph-encoded arguments、canonical result/error 和 settlement order。父 cell 冷重放时核对同一个 binding call 并直接释放 transcript 中的结果，不再次执行 child 或其外部工具，因此 child side effect 至多发生在原始 live 执行。projection 继承当前 request 的可见 authority 与取消信号，并以配置深度限制递归；它不注册第二个模型工具，不伪造 DSH child UI、独立 policy hook、调用树或 code-dispatch events。宿主若已提供可调用的 `run_code` binding，`code.run` 使用该宿主路径。

## 日志折叠

恢复按 session event 顺序处理外层 `run_code`。触发本次恢复的 call id 作为 live boundary 传入折叠器；同 id 的在途 `tool/call` 不属于历史：

1. 用 `sourceEventSeqs[0]` 关联 `tool/result` 与 `tool/call`；
2. 预收集 valid journal 中的 `confirms`；
3. 排除当前在途 call，并让已确认 no-op 的无 journal call 不改变状态；
4. 缺失源码、缺失/损坏 journal 进入 untrusted suffix；
5. `noop` 与不含 `volatileReason` 的 `discarded` 不改变语言状态；带 `volatileReason` 的 `discarded` 表示 heap 已回滚但外部 effect 未知，进入 untrusted suffix；
6. `volatile` 进入 untrusted suffix，只应用可独立持久的 delete/restore 操作；
7. `restore` 命名状态重新建立 trusted durable head；
8. untrusted suffix 后的首个 `durable` journal从当前 durable head 建立新分支，并清除旧 suffix；
9. durable node 保存 parent link，命名状态保存 node index。

第 8 步是必要不变量：冷恢复已经实际丢弃 volatile/unknown heap，因此此后执行成功的 durable cell 不依赖该 heap。如果不把它作为可信重基点，旧 unknown 调用会在每次重启时永久吞掉所有后续状态。

## Completion 校验

普通异常可能已经建立或修改 binding，所以 durable `throw` 属于语言历史。重放接受的语义结果只有：

- recorded `return` 再次 return；
- recorded `throw` 再次产生相同 error kind 和 message；

以下结果永远是恢复基础设施失败，不能因为 recorded completion 也是 error 而接受：

- abort；
- compute/wall timeout；
- output limit；
- worker exit/OOM；
- recovery divergence；
- durable replay 触发 volatile capability。

基础设施失败会终止当前 worker，保留此前 durable frontier，并向当前 `run_code` 返回 recovery error。

## State Operations

```ts
type StateOperation =
  | { action: "save", name: string }
  | { action: "restore", name?: string }
  | { action: "delete", name: string }
```

- `save` 只可提交到 durable node；
- cell 静态判断 durable、但在 `save` 后运行时降级时，tentative save 会被删除；
- `delete` 可独立应用于命名索引；
- 无名称 `restore` 选择当前 cell 之前的最后 durable head，清除 volatile suffix；
- `restore` 把 head 切回已存在的 durable node，清除 volatile suffix；
- list 不写 operation，返回当前 checkpoint 名称、`mode` 和首次 `volatileReason`。

状态名称由 agent 选择，内部 node index、hash、revision 和日志位置不进入模型接口。

## Capability 规则

静态分类器理解 top-level、block、function、catch 和 loop binding。它只把实际未绑定的 ambient reference 作为降级候选；属性键和局部同名变量无影响。

运行时对以下访问标记 volatile。归因依据是 worker 当前 active execution，不使用异步回调继承的 `AsyncLocalStorage` store。active execution 从开始求值持续到 host calls 结算、返回值 PTC value graph 编码或异常归一化全部完成；这些阶段的 getter、Proxy 或字符串转换仍可能执行用户代码。最终 durability 必须在转换后采样，纯 wire message 构造完成后才在最外层 `finally` 清除 active execution。只有此后发生的访问才暂存 reason 并使下一 cell volatile：

- Date、performance、fetch、WebSocket、crypto、Intl；
- setTimeout、setInterval、setImmediate；
- eval、Function、除 `cwd()` 外的 process 能力、require；
- `Math.random()`；
- durable allowlist 之外的 dynamic import，包括 `node:path`。

普通 `Math` intrinsic 保持完整。`process.stdout/stderr.write` 被捕获为 cell log，不因输出本身降级。

worker 不继承 Electron 的工作目录语义。插件通过现有 `tools/execute` context 读取不可变的 `agent.session.header.cwd` 并注入 session worker；`process.cwd()` 返回该值且保持 durable。header 未记录 cwd 时才回退宿主值并在运行时标记 volatile。

直接访问 `worker_threads` 或 `cluster` 的常见 import/require 形式被拒绝，因为它们暴露 worker lifecycle control。该 gate 不是恶意代码安全沙箱；部署安全仍依赖 DSH policy、进程隔离和操作系统权限。

## 恢复通知

构造 kernel 时若折叠结果含 volatile/unknown suffix，第一次 `run_code` 记录并投影 `PTC-R002`。它只统计当前 call 之前的历史边界：

```text
warning[PTC-R002]: restored the durable head and skipped N historical cells
phase: recover
state: ...
help: ...
```

通知进入正常 CodeRuntime logs，结构化值进入当前 journal，因此成功结果和错误结果都能呈现并从 session log 重建。每个 kernel 只发送一次，避免污染后续上下文。

live kernel 首次进入 volatile 时记录并投影一次 `PTC-V001`，包含精确 `volatileReason`。消息先确认当前 live state 仍可继续复用，并按 execution outcome 说明 cell 成功或失败前 mutation 可能已生效，再说明 sticky 后缀不会在冷启动重放；它不得诱导模型重建环境。后续 volatile cell 不重复该诊断。post-execute confirmation 丢失导致的延迟降级在下一 cell 通知。当前状态也可通过 `repl.state({ action: "list" })` 查询，不需要解析 model-invisible metadata。

## 失败状态语义

诊断的 `stateEffect` 描述当前 cell 的 live/冷恢复状态事实，不由 severity 推断，也不表示当前 binding 是否仍可用：

- parse、无法安全放宽的跨 cell collision 在执行前失败，使用 `unchanged`，journal 为 `noop`；
- 求值开始后的普通 throw 使用 `partially-applied`，因为此前 binding mutation 可能已生效；
- PTC Value V1 输出超出支持域或预算时使用 `PTC-O001` 与 `partially-applied`，因为返回前的 binding/mutation 已经执行；`undefined`、special number、BigInt、hole、shared identity 和 cycle 属于受支持值，不要求模型为了 transport 改写；
- 首次 volatile transition 使用 `unknown`，表示 live heap 仍可继续使用但冷恢复不再有确定重放路径；文本必须先说明 live continuity，再说明后缀不会冷重放；
- 冷恢复丢弃不可信后缀使用 `rolled-back`；
- 只有已知外部 dispatch 发生但 completion 无法确定时才使用 `unknown` 并附 `dispatchState: "unknown"`，插件不得在 RC7 未提供该事实时猜测。

模型可见文本与 `diagnostics` 必须由同一个结构确定性生成。恢复不通过解析既有 message 重建诊断；session export/import 和 replay 均保留结构化 code、cause、dispatch state 与 state effect。源码 frame 使用 `@babel/code-frame` 的无色投影。

## 插件边界

协议只依赖：

- `tools/execute`；
- `tools/result`；
- `CodeRuntime.run`；
- 当前 `CodeRuntime.run` request 的 public bindings 与 signal；
- `run_code.output.presentationMeta`；
- 标准 `tool/call` 与 `tool/result.meta`。

任何 RC7 无法持久确认的状态都必须收缩为 volatile/unknown 边界。修改 DSH 源码、patch 私有 scheduler、伪造事件或增加 tool call 不属于本协议。

## 已验证场景

- durable continuation 和仅凭日志的跨进程恢复；
- tool call record/replay 与并发 settlement order；
- volatile live continuation、冷恢复跳过和 durable 重基；
- post-execute metadata 删除与 pre-dispatch no-op 确认；
- hard abort、冷 worker 启动取消和 pending host call 清理；
- replay timeout fail closed；
- Math intrinsic、局部 ambient 名称、CWD 相关 `node:path`；
- 命名状态 save/restore/delete 与 volatile restore；
- 深层 graph value、own `__proto__` key、`undefined`、special number、BigInt、hole、alias 与 cycle；
- 宽松变量重声明与严格/混合名称 collision preflight；
- runtime throw、invalid output、首次 volatile 和真实 recovery 的结构化诊断与模型可见投影；
- 未修改 RC7 的真实公共扩展面和两个独立 Node 进程恢复。

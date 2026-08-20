# Architecture

PTC Plus 把 DSH Code Mode 的顶层 `run_code` 变成与 session 绑定的连续 TypeScript REPL。它负责 cell 求值、binding continuity、诊断、journal 和 cold replay；权限、sandbox、工具调度、取消、审批和跨平台进程治理仍属于 DSH 与操作系统。

## 运行边界

| 层 | 所有者 | PTC Plus 的工作 |
| --- | --- | --- |
| Authority / policy | DSH / 宿主 | 不复制；每次 native tool dispatch 仍经过原流水线 |
| Capability view | DSH 当前 scope | 保留 native typed `tools.*`，为一个 cell 建立统一 lease |
| Evaluation | session worker | 连续求值、顶层 binding、预算与输出编码 |
| Journal / replay | PTC Plus + session log | 记录 call transcript、settlement、completion 和恢复边界 |
| Presentation | DSH + PTC Plus | 保留 native guidance，并追加 REPL 与探索声明 |

主入口接管模型直接发起的顶层 `run_code`，并在 session-bound strict Code Mode 的模型 wire 上固定投影
`edit_run_code` transport。非 agent runtime call、嵌套 DSH dispatch 以及其他 tool 继续走
上游实现。插件卸载时恢复仍由自己持有的 `CodeRuntime.run` 与 `presentationMeta` 属性；若外层插件仍持有旧 wrapper，已卸载 wrapper 会透明委托原 provider，不会恢复已释放的 session 状态。

严格 Code Mode request 始终按固定顺序向模型暴露 `[run_code, edit_run_code]`。若模型仍生成当前 scope
已知的顶层 native tool call，`llm/stream` middleware 会在 assistant chunk 持久化前把它规范为
`run_code` block；生成的
cell 用原始 JSON 参数调用同一个 `tools[name]`。插件不复制 schema validation，不适配参数或结果，
也不产生纠错 warning。call id、index、usage 和 finish reason 保留；内容改变后删除不再权威的
provider replay metadata。未知、畸形、不完整且没有正常 finish，或内部不一致的 block 原样透传。

`edit_run_code` 不注册到 DSH tool registry。它只对同一未结束 turn 中最近一个有 `noop`
journal 且诊断为 `PTC-C001`、`PTC-C002` 或 `PTC-N001` 的 `run_code` 生效。插件要求
`old_string` 在原源码中恰好出现一次，重建完整源码后在 stream middleware 中 lower 为
官方 `run_code`。无目标或不合法 edit 也 lower 为返回 `{ edited: false, reason }` 的成功
`run_code`，因此不生成 PTC warning。调查 cell 不会使未执行目标失效；修复后 cell 实际执行时消费目标。
已执行或 effect 不可证的目标 cell 不能重跑。宿主日志、执行、
journal 和结果仍只有官方 `run_code` transport；是否有可编辑目标不改变模型可见 tool surface。
若 live native registry 已占用该名称，assembly fail-fast，避免两个语义竞争。

prompt assembly 的 live schema snapshot 优先由同一 turn 的 `AbortSignal` 和 session identity 联合关联。
带 signal 的 request 必须精确命中；没有 signal 时才允许使用同 session 最近一次严格 assembly 作为
兼容回退。session/agent dispose 与插件 teardown 会清除回退状态，避免跨生命周期复用定义。

## 能力表面

cell 直接使用 DSH 为当前 request 提供的 `tools.*`，不按工具名过滤，不改写 program-call 参数或 canonical result。顶层误调用规范化只改变模型 transport 的入口形状，不改变这个 data-plane contract。所有 native member、`capabilities.*`、`repl.state` 和 `code.run` 共享 cell lease；cell 结束后，捕获的函数统一失效。调用时仍由 DSH 检查 scope、policy、取消和 scheduler。

`capabilities.tree/find/inspect` 是描述 API，不是反射调用入口。当前公共扩展面只提供 live tool schema，因此可证明的 metadata 包括名称、描述、输入/输出 schema、DSH dispatch authority 和 PTC 的 `recorded-value` replay；effect 与 result completeness 没有 owner 证据时保持 `unknown`。探索不会授予权限或触发模型调用。

当前公共扩展面没有跨 prompt assembly 与 cell dispatch 的冻结 view token。PTC Plus 使用同一 agent scope 分别读取 prompt 和 runtime view，并让实际 request binding 成为执行事实；能力在两阶段之间变化时，不伪造原子快照保证。

CodeRuntime request 已携带的 owner-provided program namespace 会被原样保留并共享 cell lease，PTC Plus 不翻译其参数或结果。与插件保留的 `capabilities`、`code` 或 `repl` 同名时 request fail-fast，避免主线程与 worker 绑定分叉。当前公共扩展面没有用于发现额外服务的 program-binding registry；插件不提供名称分发总线或私有 provider registry。若 DSH 以后提供统一 registry，PTC Plus 只消费实际 request 中的 live binding，不复制 authority 或 discovery。

## REPL 生命周期

每个顶层 `run_code` 是同一 session kernel 的下一格。顶层 binding 跨 cell 保留；默认宽松模式允许一个完整 declarator 全部替换已有变量，严格模式以及混合新旧名称的解构在执行前拒绝。cell 始终作为 async function body 求值，支持 block scope、top-level `await` 和普通控制流 return。

可确定的计算和 recorded-value capability call 可以推进 durable head。未进入 journal 的 Node/OS 能力、环境输入、时钟、随机数和 timer 进入 sticky `volatile`；live worker 继续可用，cold replay 回到最后 durable frontier。worker thread 是生命周期隔离，不是安全沙箱。

## Journal 与恢复

每个进入 evaluator 的 cell 写入版本化 journal：

```ts
{
  version: 1,
  bindingMode: "loose" | "strict",
  status: "durable" | "volatile" | "discarded" | "noop",
  calls: CallTranscript[],
  operations: StateOperation[],
  confirms: string[],
  diagnostics: Diagnostic[],
  completion?: Completion,
  volatileReason?: string
}
```

`calls` 只保存 global、member、PTC Value Graph 编码的 args/result 或 error，以及 settlement 序号。cold replay 校验调用名称、参数、数量和提交顺序，并按 recorded settlement order 释放 recorded result；不会重新 dispatch program binding 或重做外部 effect。该规则同样适用于 native tools、owner-provided namespace 和 `code.run`，不按名称分支。若基础设施终止时仍有未结算 binding，heap 回滚到 durable frontier，discarded journal 以最先观察到的 `global.member` 保留 possible-effect boundary。effect、completeness 和 source metadata 属于 capability explorer，不伪装成 journal 字段。

journal 通过 `run_code.output.presentationMeta` 附着到最终 result，再由 `tools/result` 做两阶段确认。缺失、损坏或被替换的 journal 形成 unknown/volatile 边界；未进入 runtime 的 call 由后续 `confirms` 证明为 no-op。volatile 源码保留在原 session log，但不参与 cold replay。

诊断由封闭结构确定性渲染，包括语法、preflight、绑定冲突、输出、运行异常和恢复边界。普通成功与首次进入 volatile 不投影 warning/note；恢复分类保留在 journal 和 `repl.state(list)` 中。

更详细的结果边界见 [Program Data Plane](program-data-plane.md)，能力元数据见 [Capability Surface](capability-projection.md)，恢复协议见 [Durable / Volatile](durability-design.md)。

## Decisions

- [Delegate Governance to DSH](adr/0001-delegate-governance-to-dsh.md)
- [Limit Work Map Scope](adr/0002-limit-work-map-scope.md)
- [Prefer Native Program Surfaces](adr/0003-prefer-native-program-surfaces.md)
- [Declare Program Bindings At The Owner](adr/0004-declare-program-bindings-at-the-host.md)
- [Use A Rejected-Cell Edit Transport As A Temporary Affordance](adr/0005-temporary-rejected-cell-edit-transport.md)

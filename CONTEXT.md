# PTC Plus Project Context

PTC Plus 是个人维护的社区实验插件。它把 DSH Code Mode 的顶层 `run_code` 变成 session-bound TypeScript REPL；它不复制 DSH 的权限、sandbox、nested dispatch、调度、取消、审批或跨平台进程治理。

## Core constraints

1. `danger-full-access` 是一等体验：保留模型熟悉的 Node、process、filesystem、network、shell、生态 SDK 与 DSH native typed `tools.*`。其他 profile 的 native tool surface 只按 live request 简单降级，不模拟缺失能力；更窄 tool view 不构成 Node ambient sandbox。
2. 后续 cell 直接复用 binding，不搬运源码、不嵌套转义、不增加普通继续求值的模型往返。
3. DSH/宿主拥有 authority 和 policy。PTC Plus 只使用公共扩展面，不 fork DSH、不接入私有 scheduler、不伪造 session event。当前集成验收版本是 DSH CLI `0.1.0-rc.8`，切换 prerelease 版本必须重新验收。
4. 无法由 session log 重建的 Node/OS 输入与 effect 进入 sticky volatile；live worker 继续可用，cold recovery 回到最后 durable frontier。volatile 是恢复分类，不是权限。
5. shell 是解释命令文本的通用入口，不是 REPL、权限系统或普通 argv spawn 的前置条件。PTY/ConPTY 只用于交互进程；Windows、WSL 与 POSIX execution world 必须分别探查。
6. 透明性要求 action、authority、effect、result completeness、replay 与 settlement 不被混淆；不要求暴露无决策意义的 provider 内部细节。

## Program surface

- cell 直接调用 DSH 原生 `tools.<name>(args)` / `tools["name"](args)`。该 program surface 不按工具名过滤，不改写参数、canonical result、错误或 owner guidance。严格 Code Mode 中误发的已知顶层 native call 只在模型 transport 层静默包装为调用同一 member 的 `run_code`；原始 JSON 文本、call identity 和 DSH 正式 validation 保持不变，未知或不一致输入不猜测修复。
- 每个 cell 创建统一 lease。native tools、`capabilities.*`、`repl.state` 和 `code.run` 在 cell 结束后一起失效；下一次 dispatch 仍由 DSH 重新治理。
- `capabilities.tree/find/inspect` 只描述当前 agent scope 的 live schemas，不调用 capability、不提升权限、不触发模型请求。
- PTC journal 为所有已结算的 program binding call 提供 `recorded-value` replay：cold replay 校验调用序列并返回 recorded canonical value，不重新 dispatch capability。这不表示外部 effect 被重做、撤销或验证。
- live tool schema 没有 owner-proven effect/completeness/source 注解时保持 `unknown`。不能从工具名、UI rendering 或自然语言摘要推测完整性。
- CodeRuntime request 已携带的 owner-provided program namespace 会原样保留并共享 cell lease；PTC Plus 不翻译其领域契约。与插件保留的 `capabilities`、`code` 或 `repl` 同名时明确失败，不能静默合并。当前公共 request surface 没有用于发现额外服务的 program-binding registry，因此插件不增加名称分发总线或私有 registry。

## Data boundaries

- `canonical` 表示程序收到的结构化值，不表示完整世界快照。结果必须区分 `complete`、`bounded`、`incremental`、`open-world` 和 `unknown`。
- 当前 DSH `tools.read` 契约是 bounded inspection，不是 lossless whole-file API；这项使用注意不构成 PTC metadata 注解。需要完整文件时，一等 profile 使用 `node:fs/promises.readFile` 或 stream；该直接 I/O 没有 call transcript，因此进入 volatile。
- model/UI rendering 与 canonical program value 是不同层；展示被裁剪不能证明 program value 被裁剪，反之亦然。
- `code.run` 在隔离 child runtime 执行 source，不合并父 binding。正常结算后记录并重放结果；若基础设施终止时调用仍未结算，discarded journal 以 `code.run` 记录 possible-effect boundary。该规则由所有 program binding 共用的 pending/settled 生命周期决定，不由 capability 名称决定。
- 严格 Code Mode 按固定顺序暴露 `[run_code, edit_run_code]`，不根据失败状态改变 tool surface。`edit_run_code({ old_string, new_string })` 只对同一未结束 turn 中最近一个确定未执行的 rejected cell 做唯一字面替换，再 lower 为完整的官方 `run_code`。后续调查 cell 不擦除目标，成功 edit 执行后才消费目标。已执行、超时、取消和 effect 不确定的目标 cell 不可重跑；无可修复目标时安静返回原因。该临时 transport 便利只减少局部错误后的长源码重发，不增加 authority，不扩展为编辑 DSL。

## Journal facts

`version: 1` journal 是封闭 schema，只包含：binding mode、status、call transcript、state operations、confirmed no-op ids、diagnostics、completion 与 optional volatile reason。call transcript 包含 namespace/member、PTC Value Graph 编码的 args/value 或 error，以及连续 settlement 序号；不包含推测的 effect、completeness 或 fingerprint。基础设施终止时 calls 清空；若仍有未结算 binding，`discarded.volatileReason` 保存最先观察到的 `global.member` possible-effect boundary。

两阶段确认通过 `run_code.output.presentationMeta` 与 `tools/result` 完成。已执行但最终 journal 缺失或变化时，live state 单调降为 volatile；未进入 runtime 的 call 由后续 `confirms` 证明为 no-op。损坏或缺失历史形成 unknown suffix，cold recovery 不越过它。

## Presentation

DSH 原生 tool guidance 与 typed SDK 保持 owner 提供的内容。PTC Plus 修改 `run_code` 的连续 REPL 说明，追加 `repl`、`capabilities` 与 `code` 声明，并在 session-bound strict Code Mode 增加固定的 `edit_run_code` schema。任何额外 Agent 语义增强都必须由用户主动触发，或由用户预授权且有硬预算、用量记录和取消能力的 policy 触发；当前运行时不包含这类增强。

普通顶层误调用的 transport recovery 是确定性协议归一化，不调用模型、不增加 authority，也不向 prompt 注入按错误定制的提示。它只在 request identity 与 live schema 可证明时生效；无法证明时保留原调用，由宿主报告真实错误。

普通成功 cell 不产生 PTC warning/note。宽松重声明和首次进入 volatile 都是正常运行状态；后者只进入 journal 与 `repl.state(list)`。只有执行失败或 cold recovery 实际跳过历史状态时才投影可行动诊断。

当前公共扩展面没有跨 prompt assembly 与 runtime dispatch 的冻结 capability token。插件在两个阶段使用同一 agent scope，但以实际 request binding 为执行事实，不承诺不存在定义漂移。

## Scope boundaries

- 插件不自建跨平台权限、安全沙箱、通用进程治理或命令 DSL；
- program binding 由 live request 直接提供，不经过名称反射或私有 adapter；
- bounded window 不拼接成伪 lossless reader，unknown metadata 不升级成 complete、durable 或 effect-free；
- capability map 的机械探索不消耗模型 token；语义增强必须由用户主动触发或预先授权并受硬预算约束；
- Work Map、跨插件聚合和统一 registry 属于上游协调层，不在本插件复制。

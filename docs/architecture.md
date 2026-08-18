# PTC Plus 架构

## 一句话定义

**PTC Plus 是 Agent 原生 REPL：一个与 DSH session 绑定、可增量定义、可继续求值、可由 session log 恢复可信状态的代码环境。**

工具数量、程序仓库、源码引用、hash、worker 寿命或某个特定 runtime 都不是产品本体。任何设计如果要求模型重新搬运已经建立的能力，或者把声称可恢复的状态留在 session log 之外，都不符合这个定义。

## 不变量

| 不变量 | 可观察结果 |
| --- | --- |
| 不搬运源码 | 后续 cell 直接使用已有 binding |
| 不嵌套转义 | 已定义代码不作为字符串嵌入下一次调用 |
| 不浪费 token | 模型不处理源码副本、hash、revision 或恢复协议 |
| 不增加往返 | 普通继续求值只调用一次 `run_code` |
| session isolation | 一个 session 不能观察另一个 session 的环境 |
| authority freshness | 每个 cell 使用当前 execution 的 tools 与权限 |
| durable log completeness | 仅凭完整 session log 可重建 durable 状态 |
| conservative recovery | 不自动重放 volatile、unknown 或基础设施失败的副作用 |

worker 与内存索引只是缓存。volatile heap 可以在当前 worker 中继续使用，但不会被描述成可恢复状态。

## 组件

```text
index.js
├── tools/execute around hook
│   └── AsyncLocalStorage(session identity)
├── CodeRuntime.run adapter
│   └── SessionRuntime
├── run_code.output.presentationMeta adapter
└── tools/result observer

SessionRuntime
└── SessionKernel per session
    ├── durable history / named states
    ├── live worker and volatile flag
    ├── tentative journals
    └── current tool lease

kernel-worker.js
├── Node REPL context
├── current tools / repl bindings
├── runtime durability markers
└── private MessageChannel
```

插件不注册新的模型工具。原生 `run_code` 仍是唯一模型直接调用的 Code Mode 入口。

## Agent 指令

系统提示首先建立执行模型，而不是罗列实现细节：模型直接发起的 `run_code` 是同一个 session REPL 的连续 cell，绝不是互相独立的脚本。随后只给出生成下一 cell 前必须知道的决策：复用已有语义 binding、默认宽松模式下顶层变量可自然重定义、通过 `tools.*` 获取可重放外部输入、理解 direct Node/process capability 只改变冷恢复属性而不影响当前 live REPL，以及看到 `[PTC-...]` 后只按 `help` 修复失败部分。提示同时声明插件注入的 `tools.run_code` 可执行当前程序构造或转换的隔离源码，但不规定编辑算法。

提示不得要求模型探测完整 namespace、维护编号别名、记录 journal id 或重发 setup source。这些都是 runtime 的 bookkeeping，转移给模型会破坏不搬运源码、不浪费 token 和不增加往返的不变量。

PTC Plus 在 `system-prompt/assemble` waterfall 的 `next()` 结果上不可变替换 model-visible `run_code` 的 tool description、`code.description` 和 `description.description`，其余字段全部保留。该 listener 不修改注册表 definition，也不字符串重写 `tools:sdk`。若 assembly 存在 `run_code` 但缺少预期的 object schema 或两个 string properties，则以 `ptc-plus: incompatible run_code schema` 失败，不能静默恢复 DSH 的 one-shot wording。PTC guidance section 使用 order 98，在 core order 99 的 Code Mode collapse 之前组装。

## RC7 公共扩展面

实现只使用 RC7 已有能力：

- `tools/execute`：取得 owning agent/session，并包住一次真实 dispatch；
- `CodeRuntime.run`：将属于 `run_code` 的程序路由到 session kernel；
- 当前 `CodeRuntime.run` request bindings：不可变增加插件拥有的 `tools.run_code` 元编程桥；
- `system-prompt/assemble`：不可变调整 detached `run_code` schema，使模型只看到持久 cell 契约；
- `run_code.output.presentationMeta`：把 tentative journal 投影到成功结果；
- `tools/result`：观察 post-execute 与 content finalization 之后的冻结结果；
- 标准 `tool/call` 与 `tool/result.meta`：提供持久日志。

错误结果由 `tools/execute` around hook 附加同一 journal。插件卸载时恢复原 runtime method 和 metadata projector。

禁止修改或 fork DSH、接入私有 scheduler、伪造 session event、注册内部 tool call，或要求宿主增加 metadata seam。

## Top-level 与 Nested run_code

模型直接发起的 top-level `run_code` 进入 `SessionKernel.tail`，保持 binding continuity、journal、durable/volatile、诊断和状态管理。进入 kernel 前，PTC Plus 不可变扩展本次 request 的 `tools` namespace：若宿主尚未提供同名 binding，就注入插件拥有的 `tools.run_code`。该 bridge 直接调用捕获的 upstream `CodeRuntime.run`，因此获得隔离的一次性语言环境，绝不能排入仍被父 cell 占用的同一个 kernel。

child 继承父 request 的当前可见 bindings 与取消信号；其中普通 `tools.*` 函数仍使用宿主为本次 execution 建立的 authority。bridge 不直接调用 tool definition、不接入私有 scheduler，也不创建 DSH child tool event。它返回与 `run_code` 一致的 `{ logs, result? }` 值，但不声称复刻原生 nested dispatch 的独立 UI、policy hook 或 start/settle event。若未来宿主已经提供自有 `tools.run_code` binding，插件保留宿主实现而不覆盖。

nested child 不创建 PTC Plus journal，也不修改父/子 REPL heap。对父 kernel 而言，它只是名为 `run_code` 的普通 host binding call：arguments、canonical success/error 和 settlement order 进入父 journal；冷重放从 transcript 返回记录结果，不再执行 child，因此不会重复 child tool side effect。每一级 child 都得到同样的 bridge，直到配置的 `maxNestedRunCodeDepth`；超限是普通 binding error，父 REPL 仍可继续。历史源码通过通用 session-event tools 读取并在 PTC 内转换，插件不提供专用源码编辑或寻址 API。

## Cell 生命周期

一次进入 REPL 的 live cell 按以下顺序执行：

1. `tools/execute` 将 session identity 放入 `AsyncLocalStorage`；
2. `SessionRuntime` 为 session 建立或取得 `SessionKernel`；
3. kernel 在需要时从 session log 重放 `durableHead`；
4. 创建本 cell 的 execution lease，绑定当前 DSH `tools` 和 `repl.state`；
5. 增量求值源码，记录 host-call transcript 与结算顺序；
6. worker 在同一个 active execution 内结算 host calls、编码返回值或归一化异常；
7. 用户可控转换全部完成后采样最终 durability，构造不再执行用户代码的 wire message，再解除 active execution；
8. `presentationMeta` 或错误 around hook 生成 tentative journal；
9. `tools/result` 只在最终 journal 可规范化且与 tentative journal 语义相同时确认，否则降级；
10. 当前 cell 的 tool lease 失效。

cell 的执行边界不止是 `evaluate()`。返回对象的 getter/Proxy、lossless-JSON 编码，以及被抛值的 stack/message/字符串转换都可能继续执行用户代码并访问 capability。worker 已禁止 cell 重叠，因此归因遵守一个单一不变量：从开始求值到生成纯 wire message，`activeExecution` 始终指向当前 cell，并只在最外层 `finally` 清除。没有 active cell 时发生的访问才进入 `pendingVolatileReason`，由下一 cell 继承。

### 完整 cell 与 Node REPL 边界

DSH 每次提供完整的 `run_code.code`；本项目的输入契约是 async function body，而不是 Node 终端 REPL 的逐行命令。Node `REPLServer` 仍作为当前执行后端，因为它已经提供跨 cell lexical binding、top-level await 声明提升、dynamic import、Promise completion 和 context 复用。直接替换为自有 `vm.Context` evaluator 在理论上可以完全移除 REPL 启发式，但必须同时重写并长期维护这些语言语义；这会显著扩大插件及重放验证面，因此当前不采用。

默认 `looseTopLevelRedeclarations` 只放宽跨 cell 的顶层变量声明。adapter 将首次出现的顶层 `const`/`let` 建立为 `let`；后续一个 declarator 的 binding 若全部已存在，则在原位置执行一次解构或标识符赋值，若全部为新名称则仍建立 `let`。这保留 initializer 的执行次数和 declarator 顺序，并使原始源码在冷重放时得到同一转换。同一 pattern 混合新旧名称、function/class 重声明和同一 cell 内语言级重复声明不猜测语义，继续以 `PTC-N001` 或 parser error 拒绝。配置设为 `false` 时恢复严格的跨 cell 冲突规则。

已知的后端冲突是：Node REPL 会把“以 `{` 开头且不以分号结束”的完整输入暂时猜成对象字面量。该猜测与 top-level-await 转换组合时，会把合法的块级 `const`/`let` 初始化误报为 syntax error。模型不得为此改变源码写法，adapter 也不得按 `{`、`await` 或声明种类增加条件分支。

当前选择是在所有已完成 TypeScript stripping 和 return 转换的 cell 后无条件追加 `"\n;"`，再交给 `REPLServer.eval()`。对于已经按 function body 成功解析的源码，这只增加一个末尾 `EmptyStatement`：不改变用户 AST 节点、directive prologue、作用域、控制流、completion 或源码行列，同时消除对象字面量猜测。它是固定的 evaluator framing，不是模型可见的源码改写或特例补丁。

worker 在对 host 宣告 ready 之前，必须用同一求值路径执行一个只含块级 binding 的 top-level-await conformance cell。若当前 Node runtime 不满足 framing 契约，worker 启动应 fail closed；不得进入用户 cell、不得要求模型重试或建议模型添加分号。契约测试还必须覆盖 `const`/`let`、destructuring、nested block、末尾注释、directive、top-level return 和冷重放。

语义异常前已经发生的 REPL 变更不会自动回滚，因此 durable `throw` 会记录 completion 并在恢复时重现。abort、timeout、output limit、worker exit 与 OOM 属于基础设施失败：journal 标为 `discarded`，清空未完成 calls/operations，终止 worker，并回到此前的 `durableHead`。

## 两阶段确认

RC7 的 post-execute policy 可以替换结果或删除 metadata，invalid args 和 pre-deny 也可能完全不进入 CodeRuntime。因此 live 提交分为两阶段：

```text
tools/execute + CodeRuntime.run
        │
        └── tentative journal
                 │
                 v
        frozen tools/result
          ├── journal identical -> confirm
          ├── absent/different  -> volatile
          └── never entered    -> pending no-op
```

后续成功 journal 的 `confirms` 字段确认此前未进入 runtime 的 call id。若进程在确认写入前退出，无 journal 调用在冷恢复时形成 unknown boundary；这是保守回退，不是假装知道它没有执行。

`tools/result` 是只读 observer。它只更新 live 内存状态，不修改冻结结果，也不伪造后续 session event。

## 诊断契约

PTC Plus 内部诊断使用一个封闭结构；它是 PTC adapter 的持久事实，不是另一个通用 DSH 错误框架：

```ts
interface Diagnostic {
  code: string
  severity: "error" | "warning" | "note"
  phase: "parse" | "preflight" | "execute" | "tool-dispatch" |
         "replay" | "recover"
  message: string
  stateEffect: "unchanged" | "partially-applied" | "rolled-back" | "unknown"
  dispatchState?: "not-dispatched" | "dispatched" | "completed" | "unknown"
  source?: {
    cell: "current" | string
    start: { line: number; column: number }
    end?: { line: number; column: number }
  }
  cause?: Diagnostic | { code?: string; message: string }
  help?: string[]
}
```

结构化值是事实源，并随 `meta.dshPtcPlus.diagnostics` 写入 session log；模型可见文本只是该值与可选 cell source 的确定性投影。`stateEffect` 描述 live/冷恢复状态，不描述 binding 是否还能在当前进程继续使用；因此 volatile transition 使用 `unknown`，但 message 必须先说明 live continuity。实现不得从旧错误字符串反向推断 phase、state effect 或 dispatch 状态。字段集合、枚举、位置和递归 cause 都必须严格验证，未知字段使 journal 无效。

Acorn 负责 syntax position；`@babel/code-frame` 负责源码片段、行号和 caret。PTC adapter 只做 cell source 与 wrapper offset 的映射，并默认使用 `highlightCode: false`，保证模型文本不含 ANSI。插件直接声明该依赖，不依赖 monorepo 的传递安装，也不引入完整 TypeScript compiler。

投影固定按以下顺序回答问题：

1. `severity[code]: message`；
2. 若有 source，只显示一个相关源码行、位置和 caret；
3. `phase:`；
4. `state:`；
5. 最多三个按最低修复成本排序的 `help:`。

诊断不转储整个 cell、完整 stack 或完整 binding namespace。主消息保持单行，domain/host 细节进入结构化 `cause`。运行时 plain error、logs 和持久 journal 使用同一 renderer，避免模型所见与冷恢复事实分叉。首批稳定代码为：

| Code | Phase | State effect | 触发条件 |
| --- | --- | --- | --- |
| `PTC-C001` | `parse` | `unchanged` | Acorn/TypeScript stripping 无法产生可执行 cell；使用 cell-relative source frame |
| `PTC-C002` | `preflight` | `unchanged` | cell 请求暴露 worker lifecycle control 的 module；在 worker 执行前拒绝 |
| `PTC-N001` | `preflight` | `unchanged` | 当前固定名称 runtime 检测到跨 cell 顶层声明冲突；在 worker 执行前报告全部冲突 |
| `PTC-O001` | `execute` | `partially-applied` | cell 已执行但返回值无法通过 lossless-JSON boundary；指出具体路径并建议使用 `null` 或省略 `undefined` 字段 |
| `PTC-V001` | `execute` | `unknown` | durable 后缀首次使用非 journalable capability；所有已生效 live binding 继续可用，只是不再冷重放 |
| `PTC-X001` | `execute` | `partially-applied` | 求值已开始后抛出语义异常；抛出前变更可能保留并按当前 durability 记录 |
| `PTC-R002` | `recover` | `rolled-back` | 冷恢复跳过历史 volatile/unconfirmed cell 并回到 durable head |

`PTC-V001` 必须先陈述 live continuity，再陈述 durability 降级，并依据实际 execution outcome 区分 cell 成功与异常；异常时只承诺失败前已经生效的 binding/mutation 仍可用。第一条 help 是继续复用当前 live state；restore 只作为需要回到可冷恢复状态时的显式选择，并必须说明它会丢弃 volatile 后缀。该 warning 不得把 volatile 本身描述成执行失败、binding 失效或后续必须停止使用 REPL。

`PTC-N001` 按源码顺序汇总所有未被宽松规则安全覆盖的冲突，并给出第一个相关声明的 cell span。严格模式拒绝所有跨 cell 重声明；默认宽松模式仍拒绝 mixed destructuring pattern 与 function/class 重声明。同一 cell 内的 JavaScript 重复声明始终由语言 parser 报告。

PTC Plus 负责 top-level `run_code` 的 parse/preflight、名称、volatility、persistence、replay divergence 和 recovery 诊断，也负责插件 bridge 的 arguments、递归深度与 child runtime failure。DSH core 继续负责外层 `run_code` dispatch 以及 child 内普通 `tools.*` 的 authority、policy、timeout/cancel 与 tool-result 诊断。社区插件不把 bridge 伪装成 DSH nested dispatch，不虚构 rejected-before-dispatch、dispatched-and-failed 或 completion unknown 等不可观察事实，也不为获得这些事实修改 DSH 源码。

## Session 状态

每个 kernel 维护：

```text
durableHead    最后一个可精确重放的 node
volatile       当前 live worker 是否已越过 durable frontier
volatileReason 首次越过 frontier 的原因
checkpoints    人类可读名称到 durable node 的映射
knownBindings  用于下一 cell 静态分类的 REPL binding 名
cwd             session header 中不可变的工作目录
worker         当前 live REPL 缓存
scratch        只含安全临时目录变量的 session kernel 临时目录
```

状态转换：

```text
Durable --durable cell--> Durable
   |
   +----volatile cell----> Volatile --later cell--> Volatile
   ^                          |
   +----restore durable head--+

abort / timeout / worker exit / cold recovery
                    -> last durable head
```

冷恢复跳过 unknown/volatile 后缀后，新成功的 durable cell 会建立新的可信分支。否则旧 unknown 边界会在每次重启时永久吞掉后续状态。

## Record / Replay

源码只保存在 DSH 原有 `tool/call.data.arguments`；journal 不复制源码。每个 live host call 记录：

```text
{ global, member, args, ok, value | error, settle }
```

重放仍执行原始语言代码，以重建变量、函数、闭包和模块对象，但 host bridge 不调用真实 tool。它逐项核对 binding 名与 lossless-JSON 参数，再按原 `settle` 顺序返回记录的值或错误。

以下情况使恢复失败：

- durable journal、call 或 settlement 序列无效；
- journal 找不到对应的 `run_code` source；
- 重放调用名称、参数、数量或结算顺序不同；
- recorded return/throw 与本次语义 completion 不同；
- 重放发生 abort、timeout、worker exit、output limit 或其他基础设施失败。

缺失或损坏 metadata 不会清空整个 session，也不会被猜成 durable。它形成 unknown boundary；恢复此前的可信 frontier，并在当前 kernel 第一次结果中报告被跳过的范围。触发 kernel 创建的当前 `run_code` 可能已经出现在 `session.events`、但结果尚未产生；恢复扫描必须用当前 call id 排除它，不能把在途调用当作历史断档。

## Durable 分类

静态分类器基于 AST 和词法作用域识别明显的 ambient capability。对象键 `{ Date: 1 }`、函数参数或局部变量名不会被当成全局访问。运行时 gate 是最终分类边界：

```text
deterministic / recorded        -> durable
allowed, non-journalable        -> monotonic downgrade to volatile
kernel-control direct path      -> reject
```

初始 durable 模块集合是 `node:assert`、`node:buffer`、`node:querystring`、`node:string_decoder`、`node:stream`、`node:url`、`node:util` 和 `node:zlib`。`node:path` 整体 volatile，因为 `path.resolve()` 等 API 读取进程 CWD。

`Date`、`performance`、fetch、WebSocket、crypto、Intl、timer、eval、Function、除 `cwd()` 外的 process 能力、require 与 `Math.random()` 在使用时标记 volatile。`process.cwd()` 返回 `agent.session.header.cwd`；该值存在时是 session 日志的一部分，因此可 durable，缺失时回退宿主 cwd 并标记 volatile。标记归属于覆盖求值、结算和结果/异常转换的当前 active execution，而不是异步回调继承的旧上下文；只有 cell 完整结束后发生的访问才由下一 cell 继承为 volatile。普通 `Math` 方法和常量保持原生行为。直接 `node:worker_threads`/`worker_threads` 与 `node:cluster`/`cluster` import/require 被拒绝。

worker thread 不是面向恶意代码的安全沙箱。运行普通 agent 代码时，capability gate 用于 durability 和 kernel 生命周期保护；如果部署要求抵抗刻意 sandbox escape，必须在插件之外采用进程级隔离和系统权限边界。

worker 的宿主环境仍为空，只显式设置 `TEMP`、`TMP`、`TMPDIR` 为 kernel 独立的 OS scratch 目录。这样 `os.tmpdir()` 不会落入 Node 的 `undefined\\temp` 相对路径兜底，同时不泄漏宿主凭据。scratch 路径和文件不进入 journal；相关 Node I/O 仍按 capability 规则进入 volatile，并在 kernel dispose 后尽力删除。

## 状态控制

`repl.state({ action, name? })` 通过同一私有 host channel 执行：

- `list` 返回排序后的 durable 名称、当前 `mode` 和首次 `volatileReason`；
- `save` 只在 cell 最终保持 durable 时提交；
- 无名称 `restore` 选择本 cell 之前的 `durableHead`，即使没有命名状态也可丢弃 live volatile 后缀；
- `restore` 在 cell 结算后切换 `durableHead` 并重建 worker；
- `delete` 删除名称，不删除 append-only history。

如果 cell 在调用 `save` 后才运行时降级为 volatile，tentative save 会从 journal 删除。volatile cell 可以 restore 已存在的 durable 名称，由此显式丢弃 live-only 后缀。

durability 对后缀单调生效：volatile 后续的 recorded `tools.*` 调用不能单独宣称可恢复。块作用域只影响 active name mapping，不删除源码、journal node 或 replay 成本。

首次从 durable 进入 sticky volatile 时，本次 `run_code` logs 前置一次状态通知，明确该 cell 与后续 live 后缀不会冷重放。若 post-execute 删除 journal、导致降级只能在 `tools/result` 阶段确定，通知延迟到下一 cell。通知与 `repl.state(list)` 都复用现有 `run_code`，不增加 DSH tool call。

## 权限和调用树

持久代码不等于持久权限。execution token、旧 tool closure、取消信号、凭据、policy decision 和 parent identity 永不写入 journal。每个 cell 重新绑定当前 DSH tools；先前函数可读取当前全局 `tools`，但保存的具体 tool function 在下一 cell 会得到 `PTC execution lease expired`。

真实子调用始终经过 DSH registry、policy、取消、事件和调用树管线。只有恢复重放读取已提交 transcript。

## 当前限制

- 只支持 TypeScript CodeRuntime；
- 执行后端仍依赖 Node `REPLServer` 的 lexical-state 与 top-level-await 语义，但通过统一 statement framing 和启动期 conformance gate 隔离其输入猜测；不兼容的 Node runtime 会在执行用户 cell 前拒绝启动；
- 每个 session 的 cell 串行，不同 session 使用独立 kernel；
- worker 保留到 agent/session/plugin disposal，没有 idle/LRU 驱逐；
- 恢复使用全量 journal replay，没有压缩 checkpoint；
- 不恢复 volatile heap、对象地址、文件句柄、socket、子进程或后台任务；
- 不做跨 session 状态共享或分布式 kernel。

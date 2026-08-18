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

插件不注册新的模型工具。原生 `run_code` 仍是唯一 Code Mode 入口。

## RC7 公共扩展面

实现只使用 RC7 已有能力：

- `tools/execute`：取得 owning agent/session，并包住一次真实 dispatch；
- `CodeRuntime.run`：将属于 `run_code` 的程序路由到 session kernel；
- `run_code.output.presentationMeta`：把 tentative journal 投影到成功结果；
- `tools/result`：观察 post-execute 与 content finalization 之后的冻结结果；
- 标准 `tool/call` 与 `tool/result.meta`：提供持久日志。

错误结果由 `tools/execute` around hook 附加同一 journal。插件卸载时恢复原 runtime method 和 metadata projector。

禁止修改或 fork DSH、接入私有 scheduler、伪造 session event、注册内部 tool call，或要求宿主增加 metadata seam。

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

## Session 状态

每个 kernel 维护：

```text
durableHead    最后一个可精确重放的 node
volatile       当前 live worker 是否已越过 durable frontier
checkpoints    人类可读名称到 durable node 的映射
knownBindings  用于下一 cell 静态分类的 REPL binding 名
worker         当前 live REPL 缓存
```

状态转换：

```text
Durable --durable cell--> Durable
   |
   +----volatile cell----> Volatile --later cell--> Volatile
   ^                          |
   +----restore named state---+

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

缺失或损坏 metadata 不会清空整个 session，也不会被猜成 durable。它形成 unknown boundary；恢复此前的可信 frontier，并在当前 kernel 第一次结果中报告被跳过的范围。

## Durable 分类

静态分类器基于 AST 和词法作用域识别明显的 ambient capability。对象键 `{ Date: 1 }`、函数参数或局部变量名不会被当成全局访问。运行时 gate 是最终分类边界：

```text
deterministic / recorded        -> durable
allowed, non-journalable        -> monotonic downgrade to volatile
kernel-control direct path      -> reject
```

初始 durable 模块集合是 `node:assert`、`node:buffer`、`node:querystring`、`node:string_decoder`、`node:stream`、`node:url`、`node:util` 和 `node:zlib`。`node:path` 整体 volatile，因为 `path.resolve()` 等 API 读取进程 CWD。

`Date`、`performance`、fetch、WebSocket、crypto、Intl、timer、eval、Function、process、require 与 `Math.random()` 在使用时标记 volatile。标记归属于覆盖求值、结算和结果/异常转换的当前 active execution，而不是异步回调继承的旧上下文；只有 cell 完整结束后发生的访问才由下一 cell 继承为 volatile。普通 `Math` 方法和常量保持原生行为。直接 `node:worker_threads`/`worker_threads` 与 `node:cluster`/`cluster` import/require 被拒绝。

worker thread 不是面向恶意代码的安全沙箱。运行普通 agent 代码时，capability gate 用于 durability 和 kernel 生命周期保护；如果部署要求抵抗刻意 sandbox escape，必须在插件之外采用进程级隔离和系统权限边界。

## 状态控制

`repl.state({ action, name? })` 通过同一私有 host channel 执行：

- `list` 返回排序后的 durable 名称；
- `save` 只在 cell 最终保持 durable 时提交；
- `restore` 在 cell 结算后切换 `durableHead` 并重建 worker；
- `delete` 删除名称，不删除 append-only history。

如果 cell 在调用 `save` 后才运行时降级为 volatile，tentative save 会从 journal 删除。volatile cell 可以 restore 已存在的 durable 名称，由此显式丢弃 live-only 后缀。

## 权限和调用树

持久代码不等于持久权限。execution token、旧 tool closure、取消信号、凭据、policy decision 和 parent identity 永不写入 journal。每个 cell 重新绑定当前 DSH tools；先前函数可读取当前全局 `tools`，但保存的具体 tool function 在下一 cell 会得到 `PTC execution lease expired`。

真实子调用始终经过 DSH registry、policy、取消、事件和调用树管线。只有恢复重放读取已提交 transcript。

## 当前限制

- 只支持 TypeScript CodeRuntime；
- 每个 session 的 cell 串行，不同 session 使用独立 kernel；
- worker 保留到 agent/session/plugin disposal，没有 idle/LRU 驱逐；
- 恢复使用全量 journal replay，没有压缩 checkpoint；
- 不恢复 volatile heap、对象地址、文件句柄、socket、子进程或后台任务；
- 不做跨 session 状态共享或分布式 kernel。

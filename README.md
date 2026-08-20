# dsh-ptc-plus

> A session-bound, agent-native REPL for DSH Code Mode.

> **非官方社区项目。** 本项目由个人独立开发和维护，与 DeepSeek / DSH 官方没有隶属或背书关系。

PTC Plus 把模型直接发起的 DSH Code Mode `run_code` 变成连续的 TypeScript REPL。后续 cell
直接使用已经建立的变量、函数、模块和计算结果，不需要搬运此前源码。

```ts
// Cell 1
function parseSessionLine(line: string) {
  return JSON.parse(line)
}
```

```ts
// Cell 2
import { readFile } from "node:fs/promises"
const text = await readFile("logs/session.jsonl", "utf8")
return text.split("\n").filter(Boolean).map(parseSessionLine).length
```

这里复用的是 live environment，不是源码副本、hash 引用或再次转义的代码字符串。

## 定位与边界

本插件是个人维护的社区实验插件，只使用 DSH 的公共扩展面，不修改或 fork DSH，不接入
私有 scheduler，也不伪造 session event。

`danger-full-access` 是一等运行方式：模型可以使用 DSH 原生 typed `tools.*`，以及它熟悉的
Node、进程、shell 和生态 SDK。PTC Plus 不复制这些 API，不维护工具参数或结果适配表，也不实现
第二套跨平台权限系统。native tool 的权限、审批、sandbox 与调度仍由 DSH 和当前 profile 负责；
直接 Node access 的 confinement 由 worker 进程与操作系统负责。

其他 profile 只保留当前 request 实际提供的 capability；缺失能力明确失败，不由插件模拟。
PTC Plus 的 worker thread 是 REPL 生命周期隔离，不是恶意代码安全边界，因此更窄的 tool view
不能被解释为对 Node ambient API 的额外安全承诺。

这组边界落实为四个用户可观察约束：

- 后续 cell 直接引用已有 binding，不搬运源码；
- 既有代码不作为另一个工具参数中的源码字符串；
- 普通继续求值仍只需一次 `run_code`；
- 能复用原生强类型接口时，不增加反射总线、命令 DSL 或权限抽象。

## 与 DSH 的集成

插件通过 `dsh.bundle.patch` 指向的 `cordis.patch.yml` 挂载到 DSH profile。它接管模型直接发起的
顶层 `run_code`，并在严格 Code Mode 的模型 wire 上固定提供 `edit_run_code`；其他 tool、
非 agent runtime call 和嵌套调度保留上游行为。

插件提供：

- **session REPL**：跨 cell 保留顶层 binding；
- **结构化诊断**：`[PTC-...]` 文本由 journal 中的封闭诊断结构确定性投影；
- **durable / volatile 恢复**：精确重放可信历史，保留但不自动重放不可证明的副作用；
- **原生 capability**：保留 DSH 当前 request 的 typed bindings，并为每个 cell 建立统一 lease；
- **静默入口纠错**：把严格 Code Mode 中误发的已知顶层 tool call 包装为等价 `run_code` cell；
- **描述性探索**：`capabilities.tree/find/inspect` 描述 live tool schema，不授予权限或调用能力；
- **状态控制**：`repl.state` 管理 durable 命名状态；
- **源码元编程**：`code.run` 在隔离 child environment 中执行动态源码。
- **被拒绝 cell 的局部编辑**：`edit_run_code` 用一次精确替换修复未执行的长 cell，避免模型重发全文。

插件保留 DSH 原有 tool schema、guidance、参数、canonical result、错误和 policy 语义。它只在严格
Code Mode SDK 后追加 `repl`、`capabilities` 与 `code` 的类型声明，并把 `run_code` 描述改为连续
REPL 语义。

如果模型仍在严格 Code Mode request 中误发了当前 agent scope 已知的顶层 native tool call，
插件会在写入 assistant message 前静默改写为一个调用 `tools[name]` 的 `run_code` cell。原始 JSON
参数文本进入 cell 后才由 `JSON.parse` 解析，正式参数验证、dispatch、结果和错误仍由同一个 DSH
tool contract 决定；插件不显示额外 warning/note，也不要求模型先失败再重试。call id、block index、
usage 和 finish reason 保持不变，已失效的 provider replay metadata 会被丢弃。未知、畸形或内部不一致
的调用不猜测修复，仍交给宿主诊断。该恢复默认开启，可用 `canonicalizeToolCalls: false` 关闭。

## 连续求值

每个顶层 `run_code` 都是同一 session kernel 的下一格。cell 按完整 async function body 解释，
支持块作用域、top-level `await` 和普通控制流 `return`。

默认宽松模式允许再次声明顶层 `const`/`let`：一个完整 declarator 的名称全部已存在时替换现值，
全部为新名称时建立新 binding。宽松重声明是普通 REPL 操作，不产生诊断。严格模式、同一解构中
混合新旧名称，以及 function/class 重声明会在执行前报告冲突。

能力 namespace 及其 member 只在当前 cell lease 内有效。不要把 `tools`、`capabilities`、`repl`、
`code` 或其中的函数保存到后续 cell；cell 结束后调用会得到 `PTC execution lease expired`。

常见诊断：

| Code | 含义 | 状态影响 |
| --- | --- | --- |
| `PTC-C001` | cell syntax 无法解析 | 未执行，REPL 不变 |
| `PTC-C002` | preflight 拒绝 kernel-control import | 未执行，REPL 不变 |
| `PTC-N001` | 顶层 binding 冲突 | 未执行，REPL 不变 |
| `PTC-O001` | 返回值不受支持或超过 value budget | 已执行；此前 mutation 可能生效 |
| `PTC-X001` | 未捕获运行异常 | 抛出前的 mutation 可能生效 |
| `PTC-R002` | 冷恢复跳过 volatile/unconfirmed 后缀 | 回到最后可信 durable head |

普通成功 cell 不产生 PTC warning/note。进入 volatile 只记录在 journal 的 `status` 和
`volatileReason` 中；只有真实执行失败或 cold recovery 已跳过历史状态时才向模型显示可行动诊断。

## Capability 使用

cell 直接调用当前 SDK 声明的 `tools.*`。不同结果可能是完整值、有界窗口、增量、开放世界查询
或未知完整性；模型/UI 的文本裁剪与程序收到的 canonical value 也是两个不同契约。

当前 DSH `tools.read` 契约返回有界 inspection window，不是无损整文件 API；PTC capability
metadata 缺少 owner 注解时仍会诚实显示 `unknown`，不会根据工具名补写这一事实。需要无损整文件
计算时，在 `danger-full-access` 下使用 `node:fs/promises.readFile` 或流式文件 API。直接 Node/OS
I/O 不经过 tool transcript，因此会让当前 live 后缀进入 `volatile`；当前进程仍可继续使用已有 binding。

按需探索当前 tool view：

```ts
const roots = await capabilities.tree()
const matches = await capabilities.find("session")
return capabilities.inspect({
  symbols: matches.slice(0, 8).map(item => item.symbol),
  budget: 8,
})
```

explorer 不调用 capability、不读取隐藏服务，也不发起模型请求。CodeRuntime request 已携带的
owner-provided program namespace 会原样保留并共享 cell lease；PTC Plus 不翻译其领域契约。当前
公共 CodeRuntime request 没有用于发现额外服务的跨插件 registry，非 tool API 不由插件猜测或
通过名称反射暴露。owner namespace 若与插件保留的 `capabilities`、`code` 或 `repl` 同名，request
会明确失败，而不是静默覆盖或合并两套实现。

## 源码元编程

`code.run({ code, description })` 在隔离 child environment 中执行动态源码，返回
`{ logs, result? }`。child 继承当前 request 的 tool view 与取消信号，但不读取或合并父 REPL
binding。父 journal 把它作为 program binding call 记录；调用正常结算后，cold replay 返回 recorded
result，不重新执行 child。若取消、超时或 worker failure 发生在调用结算前，journal 保留
`code.run` unknown-effect 边界并回到最近 durable frontier。相同的 pending/settled 规则适用于
所有 program binding，不按 capability 名称特判。

`edit_run_code({ old_string, new_string })` 只编辑同一未结束 turn 中最近一个确定在执行前被拒绝的
`run_code` cell。`old_string` 必须非空、与 `new_string` 不同，并在原 cell 中恰好出现一次。
替换完成后立即以官方 `run_code` 执行完整结果；模型只需生成变化片段。

可编辑对象必须有 `noop` journal，且诊断为 `PTC-C001`、`PTC-C002` 或 `PTC-N001`。
任何已进入 runtime 的 cell、运行时异常、超时、取消或未确定 effect 都不可编辑重跑，避免重复副作用。
同一 turn 中后续的调查 cell 不会擦除该目标；修复后的 cell 一旦实际执行，目标即被消费。
目标或替换不合法时，调用返回 `{ edited: false, reason }`，不产生 PTC warning。

严格 Code Mode 的每个 request 都按固定顺序暴露 `[run_code, edit_run_code]`；是否存在可编辑 cell 不改变
tool name、schema、顺序或提示，以保持 provider cache 稳定。`edit_run_code` 不注册为 DSH native tool；
插件在 assistant message 持久化前将它确定性 lower 为官方 `run_code`，完整修复后源码依然进入
session log，正式 validation、执行、journal 与结果投影不旁路。它不提供 cell ID、行号、
replace-all、多 patch、自动修复或 runtime retry。

该顶层入口是临时 transport 便利，用于缓解局部字符错误导致长源码全量重发的模型成本，不是第二套
编辑 DSL。理想终点是 PTC 与 tool transport 统一，已发出的结构化程序可被原生局部修正；达到该条件后应
删除此入口，而不是扩展它的语法。`code.run` 仍是 cell 内执行独立动态源码的 program binding，递归深度由
`maxNestedRunCodeDepth` 限制。

## Durable / Volatile

| 状态 | 当前进程 | 冷恢复 |
| --- | --- | --- |
| `durable` | 正常继续求值 | 从 session log 重放，recorded capability result 不重新 dispatch |
| `volatile` | 保留完整 live REPL | 跳过该后缀，回到最后 durable frontier |

确定性计算、受支持的 Node 模块和被 journal 记录的 capability result 可以推进 durable head。
未记录的 Node/OS 输入、时钟、随机数、timer 和其他不可证明资源进入 sticky volatile。
只有显式 restore、worker 重建或进程重启会丢弃该 live 后缀。

session log 是可恢复状态的唯一事实源；worker heap 与旁路文件不属于可迁移 checkpoint。详细协议见
[Durable / Volatile 恢复协议](docs/durability-design.md)。

## 状态管理

```ts
await repl.state({ action: "list" })
await repl.state({ action: "save", name: "before-refactor" })
await repl.state({ action: "restore" })
await repl.state({ action: "restore", name: "before-refactor" })
await repl.state({ action: "delete", name: "before-refactor" })
```

- 名称匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`；
- `list` 返回 `{ names, mode, volatileReason? }`；
- `save` 只在 durable cell 中提交；
- 无名称 `restore` 回到本 cell 之前的 durable head；
- 操作与当前 `run_code` journal 一次提交，不增加模型往返。

## 安装

要求 Node.js `>=22.19`。当前集成验收版本是 DSH CLI `0.1.0-rc.8`；DSH 仍处于 prerelease，切换
版本后应重新执行下述安装检查与项目验证。从本仓库目录安装：

```sh
dsh plugin --profile default add .
dsh --profile default --dump-config
```

从 `deepseek-harness` 源码 checkout 安装：

```sh
pnpm dsh plugin --profile default add ../dsh-ptc-plus
pnpm dsh --profile default --dump-config
```

Windows 本地开发可以运行 `scripts\install-dev.cmd`。脚本用 `npm pack` 创建基于内容 hash 的不可变
快照，再安装到目标 profile；默认 profile 是 `web`：

```bat
scripts\install-dev.cmd headless
```

可用 `DSH_PROFILE` 指定默认 profile。快照位于
`%DSH_HOME%\plugin-snapshots\dsh-ptc-plus\`；未设置 `DSH_HOME` 时使用用户目录下的 `.dsh`。

配置示例中的值也是当前默认值：

```yaml
- id: ptc-plus
  name: dsh-ptc-plus
  config:
    computeMs: 60000
    maxWallMs: 600000
    maxOutputBytes: 67108864
    maxOldGenerationSizeMb: 512
    maxValueNodes: 100000
    maxValueEdges: 1000000
    maxValueArrayLength: 1000000
    maxValueBigIntDigits: 100000
    maxNestedRunCodeDepth: 8
    canonicalizeToolCalls: true
    looseTopLevelRedeclarations: true
    durableReplay: true
```

`durableReplay: false` 是恢复故障的显式逃生开关：新 kernel 忽略历史 REPL heap，实际求值的 cell
都以 volatile 运行，但当前进程仍保留连续 binding。它不删除已有 session log。

## 当前限制

- 只支持 `codeRuntime.language === "typescript"`；
- durable import allowlist 是 `node:assert`、`node:buffer`、`node:querystring`、
  `node:string_decoder`、`node:stream`、`node:url`、`node:util` 和 `node:zlib`；
- `node:path` 和 allowlist 之外的动态 import 会进入 volatile；
- 直接 import/require `node:worker_threads` 与 `node:cluster` 会被拒绝；
- `process.exit`、`process.abort` 与 `process.kill` 在 REPL worker 中会被拒绝；
- worker 只继承 session cwd 与独立 scratch 对应的 `TEMP`、`TMP`、`TMPDIR`，不继承宿主环境；
- durable 恢复使用 journal 全量重放，没有压缩 checkpoint 或 worker LRU 驱逐；
- 插件没有自有 Client UI。

架构与协议文档：

- [Architecture](docs/architecture.md)
- [Capability Surface](docs/capability-projection.md)
- [Program Data Plane](docs/program-data-plane.md)
- [PTC Value Graph V1](docs/value-wire.md)
- [Publishing](docs/publishing.md)

## 验证

```sh
npm run check
```

该命令显式检查入口与 worker 语法，并对 Node 原生 coverage 实际报告的运行时模块设置行覆盖率
100%、分支覆盖率 95%、函数覆盖率 100% 门禁。worker thread 的行为由端到端 runtime 测试覆盖；
Node 的主测试进程不会把它纳入同一份 coverage 统计。默认验证不会调用模型。

在本仓库 source checkout 中，Windows 上安装了 DSH 且已配置模型凭据时，可显式运行真实模型验收：

```sh
npm run test:expensive
```

该命令单次安装当前 checkout，显式使用 `danger-full-access`，然后默认以 3 路并发运行随机夹具场景，覆盖 durable 跨 cell binding、
native `tools.*`、`capabilities.*`、`code.run`，以及普通 Node 文件/crypto API 进入 volatile 后的 live
连续性。硬门禁读取结构化 journal 与解码后的 canonical value，不依赖固定回答措辞，也不会自动重试。

场景由 `scripts/expensive-acceptance-scenarios.json` 声明。可用
`DSH_PTC_ACCEPTANCE_CONCURRENCY` 调整正整数并发数，用逗号分隔的
`DSH_PTC_ACCEPTANCE_SCENARIOS` 选择一个或多个场景，或用 `DSH_PTC_ACCEPTANCE_SCENARIO_FILE` 指向另一个
数据文件。provider、model、profile、permission mode 和单场景 wall timeout 也可通过同前缀环境变量调整。
验收产物写入 `artifacts/expensive/<run>/<scenario>/`，汇总位于该 run 根目录，不属于默认
`npm run check`。

普通任务下的插件开销与轨迹对比使用：

```sh
npm run test:ab
```

它不会在 system prompt 中加入任务提示，只把 `scripts/ab-trajectory-tasks.json` 中的普通短任务作为
user message。runner 先冻结当前 checkout，再为每条 session 复制独立 workspace；overlay 关闭用户
全局 workspace instructions 和无关 skill catalog，任何意外 model-visible 注入差异都会使配对无效。
相同模型、profile、Code Mode 和 `danger-full-access` 下，唯一 treatment 是是否禁用 `ptc-plus`。
默认覆盖项目理解、测试、Git 状态、精确事实、代码解释和小修改等任务族，两次重复、最多四路并发；
同一任务的两臂按稳定随机 AB/BA 顺序运行。报告分开记录机械 oracle、基础设施失败、top-level
调用错误、完整初始 context、token bucket 和轨迹指标，并生成去除 treatment 身份和启发式派生字段
的盲评 packet；评分在揭盲前独立完成，不把关键词计数当作正确率。

# dsh-ptc-plus

> **Agent 原生 REPL：一个与 DSH session 绑定、可增量定义、可继续求值、可由 session log 恢复可信状态的代码环境。**

PTC Plus 将 DSH Code Mode 的一次性 `run_code` 变成 session REPL。模型只需继续写下一段程序；已经建立的变量、函数、模块和计算结果直接作为 binding 使用。

```ts
// Cell 1
function parseSessionLine(line: string) {
  return JSON.parse(line)
}
```

```ts
// Cell 2：直接继续求值，不搬运 Cell 1
const result = await tools.read({ file_path: "G:/logs/session.jsonl" })
return result.lines.map(line => parseSessionLine(line.text)).length
```

这里被复用的是环境，不是源码仓库、hash 引用或需要重新转义的代码字符串。

## 产品约束

实现同时满足四个约束：

- **不搬运源码**：后续 cell 直接引用已有 binding；
- **不嵌套转义**：已有代码不作为另一个工具参数中的源码字符串；
- **不浪费 token**：模型不处理源码副本、SHA、revision 或恢复协议；
- **不增加往返**：普通继续求值仍只有一次 `run_code` 调用。

PTC Plus 是纯 RC7 社区插件：只使用 DSH 已有公共扩展面，不修改或 fork DSH，不接入私有 scheduler，不伪造 session event，也不用额外 tool call 补写状态。

## Durable / Volatile

任意 Node.js heap 和操作系统资源无法仅凭日志无副作用地重建，因此 REPL 明确区分两种状态：

| 状态 | 当前进程 | 冷恢复 |
| --- | --- | --- |
| `durable` | 正常继续求值 | 从 session log 精确重放，外部工具结果不重复执行 |
| `volatile` | 保留完整 REPL 能力并继续求值 | 不重放源码或副作用，回到最后一个 durable frontier |

确定性计算、受支持的 Node 模块和经 `tools.*` 记录的结果可以 durable。直接文件 I/O、CWD 相关模块、时钟、随机数、timer、进程能力和其他无法 journal 的能力会在同一次 `run_code` 中自动进入 volatile，不要求模型重试。

一旦进入 volatile，后续 live cell 保持 volatile，直到显式恢复命名的 durable 状态，或 worker 因取消、超时、退出或进程重启而回到 `durableHead`。被跳过的源码仍在 session log 中，首次恢复会向模型报告边界。

session log 是所有**可恢复状态**的唯一真相。复制完整日志到另一个进程或机器，可以恢复相同的 durable frontier、命名状态和工具 transcript；worker 内存与旁路文件不参与正确性。volatile 内存不会被伪装成可迁移 checkpoint。

详细协议见 [Durable / Volatile 恢复协议](docs/durability-design.md)。

## 状态管理

REPL 内提供控制原语，不新增模型可直接调用的 DSH tool：

```ts
await repl.state({ action: "list" })
await repl.state({ action: "save", name: "before-refactor" })
await repl.state({ action: "restore", name: "before-refactor" })
await repl.state({ action: "delete", name: "before-refactor" })
```

- 名称匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，模型不接触内部 node id；
- `save` 只接受 durable cell，运行时降级为 volatile 时 tentative save 会被丢弃；
- `restore` 可从 volatile 后缀回到命名的 durable 状态；
- 所有操作随当前 `run_code` 的 journal 一次提交，不增加模型往返。

## 恢复模型

源码只存在于 DSH 原有 `tool/call.data.arguments`。`tool/result.data.meta.dshPtcPlus` 保存 model-invisible journal：

```text
tool/call(run_code)             tool/result
└── source code                └── meta.dshPtcPlus
                                  ├── status / completion
                                  ├── host-call transcript
                                  ├── settlement order
                                  ├── state operations
                                  └── confirmed no-op call ids
```

冷恢复只重放 durable 路径。`tools.*` 调用读取已记录结果，并按原结算顺序释放，因此不会重复外部副作用，也保留 `Promise.race` 等可观察语义。重放调用名称、参数、数量、结算顺序或 completion 不一致时恢复失败，不带着错误 heap 继续。

RC7 不能为某次调用保留 journal 时，插件采用保守边界：

- 已确认未进入 runtime 的 invalid args、pre-deny 或 dispatch 前取消是 no-op；
- 已执行但最终 metadata 被 post policy 删除的 cell 降为 volatile；
- 冷启动无法判断的无 journal 调用形成 unknown boundary，恢复此前最后一个可信 frontier；
- 恢复后的首个 durable cell 建立新的可信分支，使 durable 状态可以继续前移。

实现细节见 [架构说明](docs/architecture.md)。

## 安装

在安装了 DSH CLI 的环境中，从本仓库目录运行：

```sh
dsh plugin --profile default add .
dsh --profile default --dump-config
```

从 `deepseek-harness` 源码仓库运行时：

```sh
pnpm dsh plugin --profile default add ../dsh-ptc-plus
pnpm dsh --profile default --dump-config
```

执行上限可通过 patch 配置：

```yaml
- id: ptc-plus
  name: dsh-ptc-plus
  config:
    computeMs: 60000
    maxWallMs: 600000
    maxOutputBytes: 67108864
    maxOldGenerationSizeMb: 512
```

## 当前边界

- 仅支持 `codeRuntime.language === "typescript"`；
- durable 模块包括 `node:assert`、`node:buffer`、`node:querystring`、`node:string_decoder`、`node:stream`、`node:url`、`node:util` 和 `node:zlib`；
- `node:path` 因相对路径读取进程 CWD 而整体进入 volatile；
- `node:worker_threads` 与 `node:cluster` 的直接 import/require 被拒绝；
- worker thread 是 REPL 生命周期隔离，不是抵抗恶意 sandbox escape 的安全边界；
- durable 恢复当前使用 journal 全量重放，尚无压缩 checkpoint 或 worker LRU 驱逐。

## 验证

```sh
npm run check
```

测试覆盖 live continuation、durable/volatile 转换、两阶段 metadata 确认、仅凭 session log 冷恢复、工具结果 record/replay、并发结算顺序、命名状态、取消与 worker 失败，以及深层 lossless JSON。

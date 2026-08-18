# dsh-ptc-plus

> **Agent 原生 REPL：一个与 DSH session 绑定、可增量定义、可继续求值、可由 session log 恢复可信状态的代码环境。**

PTC Plus 将模型直接发起的 DSH Code Mode `run_code` 变成 session REPL。模型只需继续写下一段程序；已经建立的变量、函数、模块和计算结果直接作为 binding 使用。

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

## 连续求值与诊断

每次模型直接发起的 `run_code` 都是同一个 session REPL 的下一格，而不是独立脚本。顶层 binding 会跨 cell 保留。默认宽松模式允许模型再次写顶层 `const`/`let`：完整 declarator 中的名称若全部已存在就替换现值，若全部为新名称就建立持久 binding。严格模式、同一解构里混合新旧名称，以及 function/class 重声明仍在执行前报告冲突。可重放的外部输入应通过 `tools.*` 获取；直接 Node/process capability 会开启 sticky volatile 后缀，但不会禁用或丢弃当前进程中的任何 live binding。

cell 始终按完整 async function body 解释，不采用 Node 终端 REPL 对 `{ ... }` 的对象字面量猜测。模型可以自然使用块作用域中的 `const`/`let`、top-level `await` 和末尾注释，无需添加分号、包装函数或遵守执行器特有的书写仪式；适配器负责无语义变化的 statement framing。

模型可见的 `[PTC-...]` 诊断给出失败阶段、REPL 状态影响和最小修复动作。诊断是 session journal 中结构化事实的确定性投影，不依赖模型解析普通异常文本。当前稳定代码包括：

| Code | 含义 | 状态影响 |
| --- | --- | --- |
| `PTC-C001` | cell syntax 无法解析 | cell 未执行，REPL 不变 |
| `PTC-C002` | preflight 拒绝 kernel-control capability | cell 未执行，REPL 不变 |
| `PTC-N001` | 与已有顶层 binding 冲突 | cell 未执行，REPL 不变 |
| `PTC-O001` | 返回值不满足 lossless-JSON | cell 已执行；此前 binding/mutation 可能生效 |
| `PTC-V001` | 首次进入 volatile 模式 | live binding 继续可用；该后缀不参与冷重放，cell 成败由实际执行结果单独说明 |
| `PTC-X001` | cell 执行中的未捕获异常 | 抛出前的变更可能已经生效 |
| `PTC-R002` | 冷恢复跳过历史 volatile/unconfirmed 后缀 | 回到最后可信 durable head |

出现诊断时只按 `help:` 修复失败部分，不要重发整个 cell，也不要重建已经存在的环境。`PTC-V001` 是持久性状态通知而非执行失败；除非确实要放弃 live 后缀并回到可冷恢复状态，否则继续复用当前 binding 即可。源码位置使用无 ANSI 的 code frame；完整诊断契约见 [架构说明](docs/architecture.md#诊断契约)。

PTC Plus 还通过 RC7 的 `system-prompt/assemble` 公共 waterfall，把模型可见的 `run_code` schema 改写为“下一 REPL cell”语义；注册表中的原始 tool definition 保持只读，其他 schema 字段原样保留，宿主结构不兼容时 prompt assembly 直接失败而不回退到误导性的一次性程序描述。

## 源码元编程

PTC Plus 在每个顶层 cell 的当前 `tools` binding 中注入 `tools.run_code({ code, description })`。cell 可以把历史 `run_code` 源码作为普通数据读取、用 TypeScript 转换，并直接执行转换后的源码。子调用使用捕获的 upstream CodeRuntime 创建隔离的一次性环境，继承当前可见 tools 与取消信号，但不读取或合并父 REPL binding。父 cell 返回后仍保留原环境，子声明不会进入父环境。

这种路径不把长源码搬回模型上下文：历史源码应通过可用的通用 session-event tools 读取，修改逻辑留在当前 PTC 程序中。PTC Plus 不增加 `repl.revise`、行编辑、cell id、源码 hash 或专用历史源码工具。

这个入口是已有 PTC 执行环境中的插件 host binding，不是第二个模型工具，也不依赖 RC7 把 `run_code` 加入原生 SDK projection。它不会伪造原生 nested tool card、独立 policy hook 或 `tool/code-dispatch-*` 事件；这些 UI/事件差异不改变代码中的元编程能力。递归深度由 `maxNestedRunCodeDepth` 限制，默认 8 层。

## Durable / Volatile

任意 Node.js heap 和操作系统资源无法仅凭日志无副作用地重建，因此 REPL 明确区分两种状态：

| 状态 | 当前进程 | 冷恢复 |
| --- | --- | --- |
| `durable` | 正常继续求值 | 从 session log 精确重放，外部工具结果不重复执行 |
| `volatile` | 保留完整 REPL 能力并继续求值 | 不重放源码或副作用，回到最后一个 durable frontier |

确定性计算、受支持的 Node 模块和经 `tools.*` 记录的结果可以 durable。`process.cwd()` 返回 session header 中不可变的工作目录，因此该调用本身可 durable；直接文件 I/O、依赖隐式 CWD 的模块、时钟、随机数、timer、其他进程能力和无法 journal 的能力会在同一次 `run_code` 中自动进入 volatile，不要求模型重试。

一旦进入 volatile，后续 live cell 保持 volatile，直到显式恢复最后或命名的 durable 状态，或 worker 因取消、超时、退出或进程重启而回到 `durableHead`。被跳过的源码仍在 session log 中，首次恢复会向模型报告边界。

session log 是所有**可恢复状态**的唯一真相。复制完整日志到另一个进程或机器，可以恢复相同的 durable frontier、命名状态和工具 transcript；worker 内存与旁路文件不参与正确性。volatile 内存不会被伪装成可迁移 checkpoint。

详细协议见 [Durable / Volatile 恢复协议](docs/durability-design.md)。

## 状态管理

REPL 内提供控制原语，不新增模型可直接调用的 DSH tool：

```ts
await repl.state({ action: "list" })
await repl.state({ action: "save", name: "before-refactor" })
await repl.state({ action: "restore" })
await repl.state({ action: "restore", name: "before-refactor" })
await repl.state({ action: "delete", name: "before-refactor" })
```

- 名称匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，模型不接触内部 node id；
- `list` 返回 `{ names, mode, volatileReason? }`，可直接核验当前 live 状态；
- `save` 只接受 durable cell，运行时降级为 volatile 时 tentative save 会被丢弃；
- 无名称 `restore` 丢弃 live 后缀并回到本 cell 之前的最后 durable head，不要求预先保存名称；
- `restore` 可从 volatile 后缀回到命名的 durable 状态；
- 所有操作随当前 `run_code` 的 journal 一次提交，不增加模型往返。

## 恢复模型

源码只存在于 DSH 原有 `tool/call.data.arguments`。`tool/result.data.meta.dshPtcPlus` 保存 model-invisible journal：

```text
tool/call(run_code)             tool/result
└── source code                └── meta.dshPtcPlus
                                  ├── status / completion
                                  ├── structured diagnostics
                                  ├── host-call transcript
                                  ├── settlement order
                                  ├── state operations
                                  └── confirmed no-op call ids
```

冷恢复只重放 durable 路径。`tools.*` 调用读取已记录结果，并按原结算顺序释放，因此不会重复外部副作用，也保留 `Promise.race` 等可观察语义。插件注入的 `tools.run_code` 也是普通 parent host call：其参数和规范结果进入父 journal，冷重放直接返回记录结果，不再次执行隔离 child。重放调用名称、参数、数量、结算顺序或 completion 不一致时恢复失败，不带着错误 heap 继续。

durability 属于整个 live 后缀，不属于单个工具结果：进入 volatile 后，即使后续 cell 只调用可记录的 `tools.*`，也不会重新变成 durable。块作用域只避免新增持久顶层名称；完整 durable cell 仍是 journal node，并在冷恢复时重放。

RC7 不能为某次调用保留 journal 时，插件采用保守边界：

- 已确认未进入 runtime 的 invalid args、pre-deny 或 dispatch 前取消是 no-op；
- 已执行但最终 metadata 被 post policy 删除的 cell 降为 volatile；
- 冷启动无法判断的无 journal 调用形成 unknown boundary，恢复此前最后一个可信 frontier；
- 正在触发本次恢复的当前 `run_code` 按 call id 从历史扫描中排除，不能被误判为旧断档；
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

### Windows 本地开发安装

双击仓库根目录的 `install-dev.cmd` 可将当前源码打包为脱离工作区的不可变快照，并安装到 dsh。脚本不会修改 `package.json` 的版本号，也不会把本项目当作已发布包处理。

默认安装到 `web` profile；可设置 `DSH_PROFILE`，或在命令行传入 profile 名称覆盖默认值：

```bat
install-dev.cmd headless
```

快照写入 dsh 约定的 `$DSH_HOME/plugin-snapshots/<package-name>/`；未设置 `DSH_HOME` 时使用 Windows 用户目录下的 `.dsh`。每个快照目录由 tarball 的 SHA-256 内容前缀标识，后续源码修改会生成新的快照，不会改变已安装的那一份。

执行上限可通过 patch 配置：

```yaml
- id: ptc-plus
  name: dsh-ptc-plus
  config:
    computeMs: 60000
    maxWallMs: 600000
    maxOutputBytes: 67108864
    maxOldGenerationSizeMb: 512
    maxNestedRunCodeDepth: 8
    looseTopLevelRedeclarations: true
```

## 当前边界

- 仅支持 `codeRuntime.language === "typescript"`；
- durable 模块包括 `node:assert`、`node:buffer`、`node:querystring`、`node:string_decoder`、`node:stream`、`node:url`、`node:util` 和 `node:zlib`；
- `node:path` 因相对路径读取进程 CWD 而整体进入 volatile；
- `node:worker_threads` 与 `node:cluster` 的直接 import/require 被拒绝；
- worker 不继承宿主环境；每个 session kernel 只获得独立安全 scratch 对应的 `TEMP`、`TMP`、`TMPDIR`，因此 `os.tmpdir()` 返回可写绝对路径，scratch 不属于 durable 状态并在 kernel dispose 后尽力清理；
- worker thread 是 REPL 生命周期隔离，不是抵抗恶意 sandbox escape 的安全边界；
- durable 恢复当前使用 journal 全量重放，尚无压缩 checkpoint 或 worker LRU 驱逐。

## 验证

```sh
npm run check
```

测试覆盖 live continuation、durable/volatile 转换、两阶段 metadata 确认、仅凭 session log 冷恢复、工具结果 record/replay、并发结算顺序、命名状态、取消与 worker 失败，以及深层 lossless JSON。

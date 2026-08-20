# dsh-ptc-plus

[English](README.md) | 简体中文

![dsh-ptc-plus 横幅](assets/dsh-ptc-plus-banner.webp)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) TypeScript PTC 模式提供与会话绑定的 REPL 和传输纠错层。

> [!NOTE]
> 这是独立维护的非官方社区插件，与 DeepSeek 或 DSH 项目无隶属或背书关系。

> [!IMPORTANT]
> PTC Plus 以 DSH 的 `danger-full-access` profile 为首要设计目标。它保留直接访问 Node.js 和操作系统的能力，不另加 sandbox。更窄的 DSH tool profile 只会减少 request 中提供的 native tools，不能单独约束 ambient Node/OS access。仅在可接受该权限范围的环境中使用 PTC Plus。

PTC Plus 让模型通过连续的 `run_code` cell 扩展同一个 live program，复用此前 binding，调用当前 DSH 强类型能力，并在不干扰普通任务的前提下恢复常见 PTC 模式传输错误。

![使用 edit_run_code 修复并执行被拒绝的长 TypeScript cell](assets/ptc-plus-repair.png)

在这次 DSH Web 会话中，`edit_run_code` 修复了被拒绝 cell 中的单字符错误，并在不重发完整源码的情况下运行。

## 模型获得什么

- **连续 cell**：变量、函数、模块和计算结果在同一会话后续 `run_code` 调用中继续可用。
- **原生强类型能力**：cell 获得 DSH 已为当前 request 授权的 `tools.*` binding；PTC Plus 不复制其 schema、结果、审批规则或调度逻辑。
- **静默传输纠错**：严格 PTC 模式中误发的已知顶层 native tool call 会在持久化前 lower 为等价 `run_code` cell。合法调用继续使用同一套 DSH 校验与执行路径，不增加 warning 或重试 turn。
- **被拒绝源码的局部修复**：`edit_run_code` 对最近一次符合条件的执行前拒绝做一次精确替换并立即运行，单个语法错误无需模型重新生成长程序。
- **durable 与 live 恢复**：确定性工作和已记录 capability 结果可以在 worker 重启后 replay；直接 Node 或操作系统输入在当前进程中仍可使用，但会标记为 `volatile`，不会伪装成可重放状态。
- **程序内探索与控制**：cell 内提供 `capabilities.tree/find/inspect`、`repl.state` 和隔离的 `code.run`，但不引入通用反射总线。

普通成功 cell 不产生 PTC warning 或 note。首次进入 `volatile` 只记录到 journal，也保持静默；只有可行动的失败和 cold recovery 状态损失才显示诊断。

## 实测结果

一组配对 A/B 实测使用 `opencode-go/deepseek-v4-flash`、DSH `0.1.0-rc.8`、严格 PTC 模式和 `danger-full-access`，覆盖 7 类普通任务、每类 2 次，共 28 个 session。每个配对只有插件启用状态不同。

| 指标 | PTC Plus | 基线 |
| --- | ---: | ---: |
| 盲评得分 | **105 / 126** | 91 / 126 |
| 模型调用次数 | **57** | 71 |
| 顶层 tool call 错误 | **1** | 19 |
| 确定性任务结果 | **10 pass / 0 fail / 4 unscored** | 9 pass / 1 fail / 4 unscored |
| PTC warnings | 0 | 0 |
| 每 session token traffic（中位数） | **43,509.5** | 48,916.5 |
| 配对中插件流量更低的 session | **11 / 14** | 3 / 14 |

Token traffic 是 input、cache read、cache write 与 output token 之和。表格只描述本次运行，不是通用 benchmark；样本只覆盖一个模型、每类任务两次。

## 安装

要求：

- Node.js `^22.19.0 || >=24.0.0`；
- 已安装支持 TypeScript PTC 模式的 DSH；
- 当前已验收的集成版本是 DSH CLI `0.1.0-rc.8`。

请安装到实际运行 DSH surface 的 profile。将 `<profile>` 替换为该 profile 名称；不要假设名为 `default` 的 profile 正在使用。

### npm

版本已在 npm registry 可用时，使用：

```sh
dsh plugin --profile <profile> add dsh-ptc-plus@0.1.0
dsh --profile <profile> --dump-config
```

所选版本尚未在 registry 可用时，请使用固定 Git revision、源码 checkout 或 tarball。

### 固定 Git revision

本包已包含可直接运行的 JavaScript，Git 安装无需构建脚本。请把 `COMMIT_SHA` 替换为已审查的 commit：

```sh
dsh plugin --profile <profile> add github:muyuanjin/dsh-ptc-plus#COMMIT_SHA
dsh --profile <profile> --dump-config
```

### 源码 checkout

```sh
git clone https://github.com/muyuanjin/dsh-ptc-plus.git
cd dsh-ptc-plus
dsh plugin --profile <profile> add .
dsh --profile <profile> --dump-config
```

DSH CLI 本身从 `deepseek-harness` 源码 checkout 运行时，通过它的 launcher 执行同一操作：

```sh
pnpm dsh plugin --profile <profile> add /absolute/path/to/dsh-ptc-plus
pnpm dsh --profile <profile> --dump-config
```

### Tarball

在源码 checkout 中运行：

```sh
npm pack
dsh plugin --profile <profile> add ./dsh-ptc-plus-0.1.0.tgz
dsh --profile <profile> --dump-config
```

Windows 开发 checkout 也可以使用基于内容 hash 的快照安装脚本。参数是目标 profile；省略时默认为 `web`：

```bat
scripts\install-dev.cmd headless
```

### DSH Desktop

在 Windows 或 macOS 上，从 Desktop 托盘选择 **Open DSH Terminal**。该终端中的裸 plugin 命令默认作用于当前 profile，因此可直接安装 registry 包或 tarball 的绝对路径，不必猜测 profile 名称：

```sh
dsh plugin add dsh-ptc-plus@0.1.0
dsh --dump-config
```

所选版本尚未在 registry 可用时，请在该终端安装 tarball 的绝对路径：

```sh
dsh plugin add /absolute/path/to/dsh-ptc-plus-0.1.0.tgz
dsh --dump-config
```

安装后重启 DSH Desktop。Linux 不是当前 DSH Desktop 的发布目标；Linux 请使用 DSH CLI/Web。

## 使用

无需单独命令或 UI 进入 REPL。正常使用 DSH PTC 模式；每个直接 `run_code` 调用都会成为当前 session environment 的下一个 cell。

```ts
// Cell 1
const rows = ['{"id":1}', '{"id":2}']
function parseRow(line) {
  return JSON.parse(line)
}
```

```ts
// Cell 2
const records = rows.map(parseRow)
return records.reduce((sum, record) => sum + record.id, 0)
```

第二个 cell 直接使用 `rows` 和 `parseRow`；它们的源码不会被复制到另一个 tool 参数中，也不需要模型重新生成。

原生 DSH tools 继续通过 cell 内的强类型 SDK 提供：

```ts
const roots = await capabilities.tree()
const matches = await capabilities.find('session')
return capabilities.inspect({
  symbols: matches.slice(0, 8).map(item => item.symbol),
  budget: 8,
})
```

`capabilities.*` 只提供只读元数据。Capability 调用仍使用 DSH 声明的强类型 `tools.*` member。

严格 PTC 模式的每个 request 都按顺序暴露 `run_code` 和 `edit_run_code`。`edit_run_code` 只接收 `old_string` 与 `new_string`，要求唯一精确匹配，并且只能编辑最近一个在执行前被拒绝的合格 cell；不能重试 runtime failure 或可能已经产生 effect 的 cell。

## 兼容性与权限

| 项目 | 当前契约 |
| --- | --- |
| DeepSeek Harness | 已验收 CLI `0.1.0-rc.8`；升级 prerelease 后需要重新验证 |
| PTC runtime | DSH TypeScript PTC 模式；cell 当前使用现代 JavaScript 语法 |
| Node.js | `^22.19.0 || >=24.0.0` |
| CLI/Web 平台 | 已完成 Windows DSH `0.1.0-rc.8` profile 安装与 Linux package runtime 本地验证；macOS 是 CI 目标 |
| DSH Desktop | 当前 Windows/macOS release 使用 active profile；安装后需要重启 |
| 推荐权限模式 | `danger-full-access` |
| Client UI | 无；产品表面是正常 DSH 对话与 PTC 模式卡片 |

`danger-full-access` 是一等体验。当前 DSH profile 和操作系统允许时，模型可以把 DSH 原生强类型 tools 与熟悉的 Node.js 文件、进程、网络、child process 和生态 API 组合使用。

native tool 的 scope、policy、approval、cancellation、sandbox 和 scheduling 仍由 DSH 负责。PTC Plus 不实现第二套跨平台权限系统、shell registry 或 tool adapter table。直接 Node 与操作系统访问由 worker 进程和宿主 OS 约束，不能把更窄的 DSH tool list 解释为额外安全边界。

其他权限 profile 按 request 中实际存在的 capability 简单降级。缺失的 native capability 通过原契约失败，direct ambient access 也可能被宿主限制或移除；插件不模拟缺失权限。

worker thread 用于隔离 REPL 生命周期，不是恶意代码安全沙箱。

## Runtime 模型

每个顶层 `run_code` 都按使用现代 JavaScript 语法的 async function body 解析。顶层 binding 跨 cell 保留，block scope、top-level `await` 和普通 `return` 均可使用。

默认宽松 binding 模式允许完整顶层 `const` 或 `let` declarator 替换全部已有名称；全新 declarator 建立新 binding。混合新旧名称的解构、function/class 重声明，以及严格模式下的任何重声明都会在执行前被拒绝。

所有 capability namespace 只租借给当前 cell。保存下来的 `tools`、`capabilities`、`repl`、`code` 或其 member function 会在 cell 结束后失效，防止旧 authority 被后续 cell 继续持有。

### Durable 与 Volatile

| 状态 | 当前进程 | Cold recovery |
| --- | --- | --- |
| `durable` | 正常继续 | replay 源码和已记录 capability 结果，不重新 dispatch effect |
| `volatile` | 保留完整 live REPL | 跳过 volatile 后缀，恢复到最后一个 durable frontier |

确定性计算、受支持的 Node module 和已结算的 program-binding result 可以推进 durable head。未记录的文件、进程、网络输入、时间、随机数、timer 和其他 ambient state 会使 live 后缀进入 sticky `volatile`。

`repl.state` 可以列出当前模式，并保存、恢复或删除命名 durable state。状态操作与当前 cell 一次提交，不增加模型往返。

### 诊断

| Code | 含义 | 状态影响 |
| --- | --- | --- |
| `PTC-C001` | cell 无法解析 | 未执行；REPL 不变 |
| `PTC-C002` | preflight 拒绝 kernel-control import | 未执行；REPL 不变 |
| `PTC-N001` | 顶层 binding 冲突 | 未执行；REPL 不变 |
| `PTC-O001` | 输出不受支持或超过 budget | cell 已执行；此前 mutation 可能存在 |
| `PTC-X001` | 未捕获 runtime exception | 抛出前的 mutation 可能存在 |
| `PTC-R002` | cold recovery 跳过 volatile 或未确认后缀 | 恢复最后一个 durable frontier |

未知、畸形或内部不一致的顶层 tool call 继续使用 DSH host 的诊断路径。

## 配置

bundle patch 只插入一个 `ptc-plus` row。以下是当前默认值：

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

`durableReplay: false` 是显式恢复逃生开关。新 kernel 会忽略历史 REPL state，实际求值的 cell 只保留 live 状态，但当前进程中的 binding 仍然连续。它不会删除 session log。

## 当前限制

- DSH 将 runtime 标识为 `typescript`，但 PTC Plus 当前使用 Acorn 解析 cell。类型注解、interface、enum、JSX、decorator 及其他不属于现代 JavaScript 的语法会在执行前被拒绝。
- 已验收 DSH 版本中的 `tools.read` 是有界 inspection window API，不是无损整文件 API。在 `danger-full-access` 下需要整文件计算时，使用 `node:fs/promises.readFile` 或 stream；direct I/O 会使 live 后缀进入 `volatile`。
- native capability result 可能是完整值、显式窗口、增量值或开放世界查询结果。PTC Plus 保留强类型 canonical contract，不根据 tool 名称猜测完整性。
- durable import allowlist 是 `node:assert`、`node:buffer`、`node:querystring`、`node:string_decoder`、`node:stream`、`node:url`、`node:util` 和 `node:zlib`；其他 Node import 仍可使用，但会使 cell 进入 volatile。
- REPL worker 内拒绝直接 import `node:worker_threads`、`node:cluster`，也拒绝 `process.exit`、`process.abort` 和 `process.kill`。
- cold recovery 从 session log replay journal；当前没有压缩 checkpoint 或 worker LRU 驱逐。
- 未作为 native tool 或 owner-provided program binding 暴露的 DSH service / plugin API，不会通过名称反射变成可调用接口。

## 深入文档

- [Architecture](docs/architecture.md)
- [Capability Surface](docs/capability-projection.md)
- [Program Data Plane](docs/program-data-plane.md)
- [Durable / Volatile Recovery](docs/durability-design.md)
- [PTC Value Graph V1](docs/value-wire.md)
- [Publishing](docs/publishing.md)

## 开发

安装依赖并运行默认的非模型门禁：

```sh
npm install
npm run check
```

`npm run check` 检查语法、行为和已配置的覆盖率阈值，不调用模型。

以下命令会消耗已配置的模型额度，永远不属于 `npm run check`：

```sh
npm run test:expensive
npm run test:ab
```

`test:expensive` 验证 capability 与恢复场景。`test:ab` 对比启用和禁用插件的普通任务。

## 许可证

使用 [MIT License](LICENSE)。

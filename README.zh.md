# dsh-ptc-plus

[![Node.js ^22.19.0 || >=24.0.0](https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-5fa04e?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-PTC%20mode-4b6bfb)](https://github.com/deepseek-ai/deepseek-harness)
[![Status: community plugin](https://img.shields.io/badge/Status-community%20plugin-lightgrey)](docs/publishing.md)

<p align="center">
  <img src="assets/dsh-ptc-plus-banner.webp" alt="dsh-ptc-plus 横幅">
</p>

**给 DeepSeek Harness PTC 模式一个会话级持久 TypeScript REPL。** 上一次 `run_code` 算出的变量、导入的模块和计算结果，下一次直接接着用——而不是每次都从零开始。

> [!NOTE]
> 社区插件，与 DeepSeek 或 DSH 无隶属、无背书。

> [!IMPORTANT]
> 面向 `danger-full-access` 设计：可直接访问 Node.js 与操作系统，不另加沙箱。仅在可接受此权限的环境使用。

## 为什么存在

DSH PTC 模式通常让每次 `run_code` 都在全新环境中求值。模型一遍遍地重发已算过的 setup 源码，出错后还要整段重发。PTC Plus 把 `run_code` 接进一个会记事的持久内核，让后续 cell 直接复用 binding，也让修复只传 delta，不再传完整源码。

## 一次配对实测

一次使用 `opencode-go/deepseek-v4-flash` 的身份盲化 A/B，对比了 PTC Plus 与未启用 PTC Plus 的 DSH PTC 模式。两边使用同一版本夹具、任务 prompt、权限，并对每个任务各重复两次，每个 arm 共 18 个 session：

| 9 个任务合计 | PTC Plus | DSH PTC 模式（未启用 PTC Plus） | 本次观测变化 |
| --- | ---: | ---: | ---: |
| 模型请求 | 66 | 88 | 减少 25.0% |
| 工具调用 | 50 | 79 | 减少 36.7% |
| Token 流量 | 729,642 | 942,901 | 减少 22.6% |
| 身份盲评量表得分 | 138 / 162 | 118 / 162 | 提高 12.3 个百分点 |

模块语法任务的区分最明显：PTC Plus 两次都只用一次 `run_code` 完成；未启用 PTC Plus 的 DSH PTC 模式两次都未满足静态 import 要求，尝试过程合计用了 8 次工具调用。

这只是一次有随机性的配对观测，不是性能保证，也不是发布 gate。预设机器预算在 PTC Plus 的 18 个 session 中有 2 个超限，未启用 PTC Plus 的 18 个 session 中有 5 个超限，因此整组矩阵没有通过 machine acceptance。Token 流量包含 input、cache-read、cache-write 和 output token。夹具、配对规则、指标与盲评流程见[评测说明](docs/evaluation.md)。

## 亮点

### 顶层工具误调用，静默修复

如果模型在顶层误发当前 live scope 中已知却不在 tool 注册列表中的 native tool，PTC Plus 会把这个无效 direct call 规范为等价 `run_code`，不浪费一个失败轮次：

```ts
// 无效顶层调用                                        // 规范化后的执行
goal({ session_id })                                   await tools.goal({ session_id })
```

这里会有意记录可执行的 `run_code`，因为原调用不属于声明的 direct protocol。合法的 `edit_run_code` 不同：其工具名和 delta 参数在历史中原样保留。

### 状态跨调用保持

```ts
// 第一次 run_code
import { readFile } from 'node:fs/promises'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const deps = Object.keys(manifest.dependencies ?? {})
return deps.length
```

```ts
// 第二次 run_code——第一次的东西都还在
return deps.map(dep => `${dep}@${manifest.dependencies[dep]}`)
```

### 修错,不重发

最近一个 cell 无论被拒、执行失败，还是成功但结果仍需微调，都能在自己的源码原文上原子修改：至多 16 处精确替换，或一组有界正则。

```ts
edit_run_code({ edits: [{ old_string: 'deps.length', new_string: 'deps' }] })
```

模型发出真实的 `edit_run_code` 调用，只传改动、不重发源码。派生源码只进入私有恢复元数据，不在下一轮模型上下文中重复。

### 还有

- **重启后恢复持久工作** — session log 重建可重放的 REPL 状态；后续历史无法安全恢复时，回到最后一个已验证的状态。
- **命名状态检查点** — 保存、恢复、列出和删除持久 REPL 状态，无需重建前置工作即可从旧状态继续探索。
- **相对项目目录执行** — 相对 import、文件系统路径和子进程都使用 session 记录的工作目录。
- **完整保留丰富 JavaScript 值** — 传输与重放支持 `undefined`、特殊数值、BigInt、稀疏数组、共享引用和循环引用。
- **模块语法，无需绕行** — `import`/`export` 自动适配，依赖从你的项目真实解析，导入的绑定保持只读。value import 与 direct `eval` 或 `with` 同处一个 cell 时，会在模块加载前拒绝，而不会带着错误的名称解析继续执行。
- **调用前先查工具** — `capabilities.tree/find/inspect` 只读描述当前 typed 工具面：零模型调用、不升级权限。
- **输出保持有界** — 日志按次计量，大打印在预算处截断而非淹没上下文；错误码稳定、定位回你写的源码行。
- **检查发起者的宿主工具** — goal 追踪等要求当前 agent 的工具，在一次执行内直接可调。

三个 `auto*` 改写开关（import / export / 混合重声明）默认全开、可单独关闭。

![被拒的 run_code 与随后的 edit_run_code 修复调用](assets/ptc-plus-repair.png)

*真实会话：长代码与真实的 `edit_run_code` 修复调用；修复从未重发源码。*

## 安装

要求 Node.js `^22.19.0 || >=24.0.0`，并已安装带 TypeScript PTC 模式的 DSH：

```sh
dsh plugin --profile <profile> add github:muyuanjin/dsh-ptc-plus#main
dsh --profile <profile> --dump-config
```

其他安装方法和兼容性说明见[安装指南](docs/installation.md)。

`danger-full-access` 是首要支持方式。worker 只隔离生命周期，不隔离恶意代码。

## 文档

[安装指南](docs/installation.md) · [运行时参考](docs/runtime-reference.md) · [架构](docs/architecture.md) · [全部文档](docs/README.md)

使用 [MIT License](LICENSE)。

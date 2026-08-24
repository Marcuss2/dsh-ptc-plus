# dsh-ptc-plus

[![Node.js ^22.19.0 || >=24.0.0](https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-5fa04e?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-PTC%20mode-4b6bfb)](https://github.com/deepseek-ai/deepseek-harness)
[![Status: community plugin](https://img.shields.io/badge/Status-community%20plugin-lightgrey)](docs/publishing.md)

<p align="center">
  <img src="assets/dsh-ptc-plus-banner.webp" alt="dsh-ptc-plus 横幅">
</p>

**PTC Plus 给 DSH 的 PTC 模式一个会话绑定的持久 TypeScript REPL。** 每次 `run_code` 都在同一个会话里继续。上一次 `run_code` 的变量、导入和结果，下一次还能直接用。

> [!NOTE]
> 社区插件，与 DeepSeek 或 DSH 无隶属、无背书。

> [!IMPORTANT]
> 面向 `danger-full-access` 设计：可直接访问 Node.js 与操作系统，不另加沙箱。仅在可接受此权限的环境使用。

## 默认 PTC 模式的问题

DSH 的 PTC 模式让每次 `run_code` 都从新环境开始。模型算过的东西，下一次还要重发。写错一行，整段代码重发。这个插件把 `run_code` 接到一个会话级环境里，后面的调用直接复用之前的东西。

| 场景 | 默认 PTC 模式 | PTC Plus 之后 |
| --- | --- | --- |
| 状态 | 每次从零开始，setup 重发 ❌ | 上一次 `run_code` 的结果直接能用 ✅ |
| 修错 | 结果不对或失败，整段重发 ❌ | 只发一行 diff ✅ |
| 模块 | `import` / `export` 不能写 ❌ | 照常写，后台 AST 重写 ✅ |
| 值 | JSON 改掉或丢失特殊值 ❌ | 这些值原样保留 ✅ |
| 重启 | 重启后一切丢失 ❌ | 能恢复的会回来 ✅ |
| 输出报错 | 大打印刷屏，报错指到别处 ❌ | 输出裁剪，报错回你写的行 ✅ |
| 工具 | 列表看不见，顶层误发失败 ❌ | 可查看；可确定的误发自动转 `run_code` ✅ |
| 路径 | 相对路径可能跑偏 ❌ | session 记住项目目录 ✅ |
| agent 工具 | 需要当前 agent 的工具被拒绝 ❌ | 恢复上下文，goal 等可调 ✅ |

## 三个最直接的场景

### 状态跨调用

第一个 `run_code` 算完：

```ts
import { readFile } from 'node:fs/promises'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const deps = Object.keys(manifest.dependencies ?? {})
return deps.length
```

第二个直接接着用：

```ts
return deps.map(dep => dep + '@' + manifest.dependencies[dep])
```

`deps` 和 `manifest` 还在。setup 代码只发一次。

### 修错不重发

默认情况下，结果不对或执行失败，模型只能把整个代码块再发一遍。

PTC Plus 下它只发这一行：

```ts
edit_run_code({ edits: [{ old_string: 'deps.length', new_string: 'deps' }] })
```

模型只发改动，完整源码留在对话之外。精确文本替换和正则替换都有限制，坏的正则不会卡住。

### 模块语法

DSH 的 PTC 模式把每个 `run_code` 当作 async function body 执行，所以 `import` 和 `export` 本来就不能写。这是 PTC 模式自身的限制，不是这个 REPL 带来的。

PTC Plus 在后台用 AST 重写。模型照常写：

```ts
import { readFile } from 'node:fs/promises'
```

依赖从你的项目解析，具名和默认导入保持 live 且只读。模型不需要知道 `run_code` 其实是一个函数体。

## 一次配对实测

一次身份盲化的配对实验使用了 `opencode-go/deepseek-v4-flash`。两个 arm 使用同一版本夹具、任务 prompt、权限，每个任务重复两次，每个 arm 共 18 个 session。

| 9 个任务合计 | PTC Plus | DSH PTC 模式（未启用 PTC Plus） | 本次观测变化 |
| --- | ---: | ---: | ---: |
| 模型请求 | 66 | 88 | 减少 25.0% |
| 工具调用 | 50 | 79 | 减少 36.7% |
| Token 流量 | 729,642 | 942,901 | 减少 22.6% |
| 身份盲评量表得分 | 138 / 162 | 118 / 162 | 提高 12.3 个百分点 |

模块语法任务的区分最清楚：PTC Plus 两次都只用一次 `run_code` 完成；未启用 PTC Plus 的 DSH PTC 模式两次都未满足静态 import 要求，尝试过程合计用了 8 次工具调用。

这是一次有随机性的配对观测，不是性能保证。预设机器预算在 PTC Plus 的 18 个 session 中有 2 个超限，未启用 PTC Plus 的 18 个 session 中有 5 个超限，因此整组矩阵没有通过 machine acceptance。Token 流量包含 input、cache-read、cache-write 和 output token。夹具、配对规则、指标与盲评流程见[评测说明](docs/evaluation.md)。

![被拒的 run_code 与随后的 edit_run_code 修复调用](assets/ptc-plus-repair.png)

*真实会话：长代码与真实的 `edit_run_code` 修复调用；修复从未重发源码。*

## 设置与开关

打开 **设置 → 插件配置** 就能看到 PTC Plus 卡片。它包含所有插件配置项，以及一个 `enabled` 开关。关闭后插件不再注册任何运行时、工具 surface、prompt section 或 session 状态，只保留设置卡片本身。折叠状态的卡片头部会说明它是会话级 TypeScript REPL，并明确展开/收起操作。卡片显示 **已启用** 或 **已停用**，稳定 REPL 指引保持协议文本而不携带 UI 品牌名。启用且会话选择 `code` preset 时，Client 会在会话头部单独显示 **PTC Plus**。所有配置项都会立即生效；运行时会在保留已有 session-bound binding 的前提下更新 owner，更新失败会回滚到上一次已应用配置。由于 Node 在 worker 创建时固定 V8 old-generation 上限，活动 session worker 存在时不能修改该上限；这类更新会被拒绝并回滚，待 session 释放后再修改。关闭后只有 `enabled` 勾选框可操作。实时启用失败时，运行时会回滚并把 `enabled` 持久化为停用。没有 TypeScript code runtime 的宿主也可以在停用状态加载 PTC Plus；尝试启用时会被拒绝，并持久化为停用。

`cordisToolsEnabled` 默认关闭，修改后立即生效。开启后，DSH 官方 Cordis 工具会进入 PTC agent 的 `tools.*`；顶层直接调用面仍是 `run_code` 与 `edit_run_code`。Cordis 可以在实时 DSH runtime 中运行模型编写的插件，因此开启它等同于授予 shell 级信任。

详见 [客户端 UI](docs/client-ui.md)、[ADR 0019](docs/adr/0019-plugin-settings-and-kill-switch.md) 与 [ADR 0020](docs/adr/0020-optional-cordis-tools-in-ptc-mode.md)。

## 这只是方向中的一步

PTC Plus 是走向 run-first 环境的一步，不是终点。在这个方向里，模型在一个会话绑定的状态化可计算环境里工作，文件、工具、命令、上下文都可以编程访问，用户看到的是运行后的结果。这个完整形态还需要模型、推理引擎和传输层一起演进。这个插件先做当前能落地的一部分：一个会话绑定、持久的 `run_code`。

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

# Program Capability Projection

## 目标

严格 PTC 模式只保留一个模型直接调用的 DSH tool：`run_code`。程序中的外部能力使用程序化命名空间，而不是再次暴露一套看起来可由模型直接调用的 native tool 语法：

```ts
const page = await workspace.readLines({ path: "src/index.ts", offset: 1, limit: 200 })
const other = await host.invoke({ name: "third_party_tool", args: { key: "value" } })
const child = await code.run({ code: "return 1", description: "Evaluate generated source" })
```

`program-native` 只描述调用形状。它不允许绕过 DSH 使用 `node:fs`、`child_process` 或其他无治理宿主能力。

## 当前投影

当前版本实现一个只读垂直切片：

| Program API | Host binding | 语义 |
| --- | --- | --- |
| `workspace.readLines({ path, offset?, limit? })` | `read({ file_path, offset?, limit? })` | 翻译为 program-native 数据契约，同时保留 native `read` 的有界、逐行语义；不会把截断窗口冒充完整文件 |
| `code.run({ code, description })` | 插件注入或宿主已有的 `run_code` binding | 在隔离 child runtime 中执行动态源码 |
| `host.invoke({ name, args })` | 当前 cell 中同名的未适配 host binding | 第三方和动态能力的显式兼容入口 |

只有当前 agent 的 request bindings 中存在 `read` 时才安装 `workspace.readLines`。adapter 每个 cell 重新建立，旧 closure 不能越过 execution lease。一次 program call 只调用一次原 host binding，因此 authority、policy、approval、取消、并发调度、审计和原生 nested dispatch 内容仍由 DSH 拥有。

projection 同时翻译调用名字和数据契约：程序侧使用 domain namespace、不同 member 名和 program-native 字段，避免模型把 familiar native tool grammar 预测成直接 tool call。adapter 负责映射到 DSH source capability；authority、policy、effect 和底层 completeness 事实仍只有一个来源，但 native schema 中只服务于模型 tool/UI 的形状不得泄漏为 program API。

已适配的 raw alias 不再安装或宣传：存在 `workspace.readLines` 时，程序中没有 `tools.read`。其他能力不以 `tools.<native-name>` 形式出现，而由 `host.invoke` 显式表明这是兼容投影。`run_code` 的程序内元编程入口是 `code.run`；模型直接调用的外层 transport 名仍是 `run_code`。

当前不提供 `workspace.readText`。native `read` 有 line、单行字符和 byte ceiling，拼接其结果会静默得到不完整文本。完整 snapshot 需要独立 provider operation、明确的 PTC retention ceiling，以及大值 resource/blob 协议后才能加入。写入、编辑与 shell 也暂不投影；在 nested UI 能稳定保留 diff/terminal presentation 前，不以 facade 降低可审查性。

## Prompt 契约

PTC Plus 用 `system-prompt/assemble` 的最终 assembly 生成 program capability SDK：

- model-visible tools 仍只有 `run_code`；
- SDK 声明实际可用的 `workspace`、`code` 和 `host` namespace；
- 已适配 native schema、`tools.read` alias 以及 `Use the read tool` guidance 不进入严格 PTC prompt；
- `host.invoke` 列出当前 scope 可见但未适配的 capability 名称，参数与结果仍受相应 host binding 的 JSON contract 约束；
- 错误使用 `WorkspaceError`、`CodeExecutionError` 或 `HostCapabilityError`，不把高层 program face 描述为 native `ToolCallError`。

## 持久化与失败

journal 已按 `global + member + args` 记录调用，因此 namespace 投影不需要 replay 特例。冷重放校验 program-facing 名称和参数，并从 journal 返回已记录的结果，不重复 host effect。若历史依赖的 namespace/member 在当前插件实现中消失，重放必须失败，不得退回 direct Node I/O。

当前 RC7 的 nested event 仍记录底层 native tool 名；这保留真实 authority/audit 事实，但客户端尚不能为所有 program call 重建 native rich card。本文不声称已经解决该 RC7 presentation 限制。

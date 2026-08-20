# Program Data Plane

程序取得数据、模型看到结果和 cold replay 重建值是三个不同问题。PTC Plus 保留这个区别，不用一个“安全工具”名单代替契约。

## Typed tools

浏览、搜索和 DSH 服务调用使用当前 scope 的 native `tools.*`。canonical result 直接进入 cell，不经过 PTC 参数翻译或结果裁剪。具体值可能 complete、bounded、incremental、open-world 或 unknown；模型/UI rendering 的裁剪不能反推 program value 的完整性。

严格 Code Mode 的顶层误调用恢复属于 transport normalization：它把已知 native call 包装为
`run_code`，cell 再用未经重序列化的原始 JSON 调用同一 `tools.*` member。参数只由 DSH owner
contract 做正式验证，返回值仍沿下述 data plane 流动；因此入口纠错不能被解释为第二套 tool API。

每次调用进入 journal：

```text
DSH authority/policy -> native dispatch -> canonical result
                                      |-> current cell
                                      `-> args/result + settlement transcript
```

cold replay 校验相同的调用序列并返回 recorded value，不重新执行工具。这保证 REPL 计算状态可重建，但不声称外部 effect 可逆或仍与历史相同。

同一 settlement 规则适用于当前 request 中的全部 program binding，包括 owner-provided namespace 与 `code.run`。已结算的 value/error 可进入 durable transcript；若取消、超时或 worker failure 发生时调用仍未结算，cell heap 回滚，discarded journal 以实际 `global.member` 保留 possible-effect boundary。分类来自可观察生命周期，不来自 capability 名称表。

直接 Node/OS 输入没有 binding transcript。worker 首次观察到这类 volatile 边界时立即通知主线程；即使 cell 随后 hard abort、timeout 或 worker exit，discarded journal 仍保留已观察原因。该恢复事实不作为普通成功任务的模型可见警告。

## Native Node and processes

在 `danger-full-access` 下，模型可以使用熟悉的 Node、filesystem、process、network、child-process 和
生态 SDK。直接 ambient access 受 worker 进程与操作系统的实际约束，不经过 DSH tool policy；
PTC Plus 不另造 filesystem Consumer、跨平台权限系统或命令 DSL。更窄 profile 中缺少某个 native
tool，也不能被解释为相应 Node API 已被隔离。

完整文件读取示例：

```ts
import { readFile } from "node:fs/promises"

const source = await readFile("README.md", "utf8")
return source.length
```

这类直接能力不经过 tool transcript，因此当前 cell 与后续 live suffix 进入 sticky volatile；当前进程继续使用既有 binding，cold recovery 回到最近 durable frontier。其他 profile 不具备入口时应明确失败，不能拼接 bounded `tools.read` 窗口伪造无损文本。

普通已知程序优先 argv spawn；只有命令本身需要 shell 语义时才使用 shell。shell 不是权限系统，也不是 REPL 前置条件；PTY/ConPTY 只用于交互进程。Windows、WSL 与 POSIX 环境的 executable、路径、resolver、signal 和 TTY 必须分别探查，不能由一个 execution world 推断另一个。

## Metadata boundaries

能力 explorer 分别报告：

- `completeness`：结果能证明多少；
- `effect` 与 `authority`：owner 声明的外部状态与治理边界；
- `replay`：recorded value、owner replay、volatile 或 unknown；
- schema/source/revision：存在证据时用于解释定义。

当前 live tool schema 只足以机械取得 name、description、parameters 和 output。PTC Plus 可证明自己的 `recorded-value` 行为与 DSH tool dispatch authority；其余字段保持 unknown，不通过自然语言摘要升级为事实。

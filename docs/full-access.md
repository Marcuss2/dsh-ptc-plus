# Full-access composition

## 产品定义

PTC Plus 不把文件 sandbox、approval policy、Agent capability roster 和 PTC presentation 混成一个权限布尔值。当前产品组合是：

```text
ptc
  = Code/PTC presentation
  + workspace-write / ask
  + ordinary scoped bindings

omnipotent
  = Code/PTC presentation
  + danger-full-access / never
  + deduplicated standard / Cordis / minimal tool union
  + Host/Client Cordis runner and Inspect Providers
```

`danger-full-access` 本身只改变文件 sandbox 与普通 tool approval policy。它不授予 Cordis capability，不创建 binding，也不证明当前 Agent 使用 creator roster。PTC Plus 始终以当前 `CodeRuntime.run()` request 的 binding snapshot 为唯一 capability authority；一次调用中的 `sandbox_permissions: "danger-full-access"` 更不能改变当前或下一 cell 的 namespace。

插件 bundle 安装时提供一个真实的 system Agent preset：`omnipotent`（显示名“全能模式”）。bundle
在官方 `agent-presets` provider 之后挂载一个 roster decorator。RC7 尚未提供注册额外 preset root
的 API，且 composition patch 明确禁止用同 ID 改换 provider package；decorator 因此只包装公开、
本就每次重新发现的 `agentPresets.list()`，在官方结果之后追加包内 system root 的 discovery 结果，
同 ID 时仍由官方结果优先。`resolve()`、mount、recompose、authoring 和 session 语义继续由官方
service 实现。decorator 卸载时仅在包装仍归自己所有时恢复原方法。bundle 从 profile 移除后，
decorator 不再组合，附加 discovery 不再存在，因此
`omnipotent` 与插件一起出现、一起消失，不向 `$DSH_HOME/.agent-presets` 写旁路副本。

`omnipotent` 不复制、解析或二次 mount 当前 RC7 的长 roster。它在 mount 时通过公开
`agentPresets.mount(ctx, "cordis")` 让全能 standing composition 加入官方创造模式的唯一 standing mount。父链因而是
`cordis -> omnipotent -> agent`，且由宿主 `agentPresets` service 持有真实 scope 实例；社区插件不直接导入 `dsh-scope`，避免开发链接安装与打包安装产生不同模块实例后读不到宿主 scope 标记。因此官方
工具、prompt、skills 和 scoped listeners 原位继承，进程级 Cordis Inspect Provider 不会被重复注册；
无论此前空 session 来自 `standard`、`code` 还是 `cordis`，切换都复用同一个官方 standing mount。
全能 scope 自身只调用 `tools.presentAs("code")` 选择 Code/PTC presentation。随后通过公开
`agentPresets.standingKeyFor()` 为官方 `cordis`、
`standard`、`minimal` standing composition 取得 scope，以 `tools.schemas(scope)` 和
`tools.get(name, scope)` 动态读取真实 definition；同时以已继承的官方 `cordis` scope 作为可见基线，
按 tool name 去重后只注册缺项。省略 `tools.get`/`tools.schemas` 的
scope 参数表示全局视图，绝不能用来判断当前 preset 是否已继承同名 scoped definition。创造模式优先，
标准模式补充，极简模式只补充尚未出现的工具；不解析 YAML、不维护工具名表，也不根据测试 fixture
猜 schema。这样官方 preset 增减工具时，全能模式及下一次 prompt 的 capability SDK 自动取得新集合。
这些 standing mount 不创建 agent、session 或 turn；tool definition 的执行 closure 仍由原官方 plugin
拥有，DSH policy/scheduler 仍是唯一 dispatch 路径。该 preset 的 scoped plugin 在 agent 创建及空 session 切入时
调用官方 `permissionPresets.set(session, "danger-full-access")`，把 sandbox 与 approval 原子设置为
`danger-full-access / never`。权限事实仍按 RC7 约定写入 session log；插件移除不会伪造逆向日志。

## Cordis program projection

当前 RC7 的已知 Cordis creator profile 由以下七个官方 Code Mode binding 组成；它是插件的兼容 profile，不是 RC7 的稳定 ABI：

```text
cordis_inspect_list
cordis_inspect_query
cordis_inspect_self
cordis_define
cordis_run
cordis_stop
cordis_undefine
```

插件只在这个已知 profile 完整且没有额外 `cordis_*` 成员时建立强类型 `cordis.*` namespace；
这里 fail-closed 的只是**语义翻译**，不是 capability authority。缺项、改名或出现未来成员时，
插件不猜测新的参数/结果契约，而是把这些本来就对当前 agent 可见的 binding 保留在显式
`host.invoke({ name, args })` compatibility 面。相同规则也覆盖 `read`：`workspace.readLines` 提供
受约束的稳定投影，`host.invoke` 仍保留 native binding 的完整可达性。任何未出现在当前 scoped
binding snapshot 中的能力都不会被补造。

程序 API 使用 qualified member，避免 native tool-call grammar：

```ts
const providers = await cordis.inspectList()
const service = await cordis.inspect({
  platform: "host",
  provider: "Service",
  method: "listService",
})
const owned = await cordis.inspectSelf({ pluginId, packageId })

const defined = await cordis.define({
  target: { kind: "new", prefix: "demo" },
  name: "Demo",
  purpose: "Provide one temporary capability.",
  source: { host: "return ctx => {}" },
})
const activation = await cordis.run({ pluginId: defined.pluginId, packageId: defined.packageId, mode: "run" })
await cordis.stop({ pluginId: defined.pluginId })
await cordis.undefine({ pluginId: defined.pluginId })
```

projection 明确翻译数据契约：`define.target.prefix -> cordis_define.plugin.idPrefix`，`define.target -> plugin`，`define.source -> code`；`inspectList()` 从 native `{ providers }` envelope 返回 provider array，`inspect(...)` 从 echoed native envelope 返回 `data`。固定输出由 adapter 校验并重建，native extra fields 不会悄悄成为 program ABI。`inspectSelf` 与 `run` 的 domain result 是开放 JSON，因为其 mode/status 对应官方 Inspect/runner 的版本化 domain 状态，而不是 UI metadata；“开放”仍要求严格 JSON tree 校验并 detached reconstruction，不表示直接透传 host 对象、getter、prototype 或 PTC rich value。

profile 不匹配时，`cordis` typed namespace 整体不可用，但当前 snapshot 已有的 native binding
仍可通过 `host.invoke` 调用。插件不从 sandbox mode 推断、补造或缓存缺失 capability。每个 cell
重新投影 immutable snapshot，新注册的 tool/service 最早在后续 DSH request 提供新 binding 时
可见。由于不匹配的 profile 没有可信语义 manifest，插件不能判断 raw `cordis_*` 是否只读；所有
此类 compatibility 调用都在 closure dispatch 前保守进入 sticky volatile，不能把可能的进程内
effect 记录为 durable。

严格 PTC prompt 不直接保留 native `tool:cordis` grammar。当前已知 profile 精确匹配时，插件把官方 section 作为行为事实源，严格翻译七个调用名、`inspectSelf` 调用形状以及 `idPrefix`、`code.host/client` 字段为 `cordis.*` program contract 后保留；翻译后残留未知 `cordis_*` 名称、或完整 profile 缺少该 section 时，prompt assembly fail-closed。profile 缺失或不匹配时才整体移除该 section。这样 plain JavaScript、先 Inspect、prefix 格式、Fiber 清理以及 `awaiting-approval`/`starting` 非完成态等官方约束不会因 presentation 改写而丢失，普通 `ptc` 也不会收到不可执行 Cordis 指令。

## 执行与 approval

adapter 每次只调用一次原始 Code Mode closure。ToolRuntime 继续拥有 scheduler、pre/post policy、ordinary approval、sandbox、cancellation、result normalization、nested audit 和 UI content。PTC Plus 不调用 tool definition、`ctx.fs`、`ctx.shell` 或 `ctx.approval`，也不维护 grant cache。

Cordis Client Package 使用 runner 自己的异步审批协议。`cordis.run(...)` 可以返回 `awaiting-approval`；即使 session 的普通 approval policy 是 `never`，PTC Plus 也不得自动批准、重试或模拟 `cordis/request-run-resolved`。

## Durable / volatile

`cordis.inspectList`、`cordis.inspect` 和 `cordis.inspectSelf` 是 read-only host calls，其 canonical result 可进入 journal。typed `cordis.define`、`cordis.stop` 和 `cordis.undefine` 的参数、结果和调用顺序同时构成 Cordis domain transcript；冷恢复会在新的 runner registry 中重新执行这些操作，并把日志中的逻辑 Plugin/Package/Run identity 映射到本次进程生成的 identity。它们不是“只返回历史结果”的普通 host replay，因此重放后 Plugin registry 与 Fiber retract 状态会重新存在。

`cordis.run` 仅在 Host-only activation 同步返回 `status: "running"` 时可进入 durable transcript。Client Package 的 `awaiting-approval`、`starting`、异步 settlement 或任何失败/部分应用结果都保持 volatile：session log 没有权限伪造用户批准、Client 页面或未完成 Fiber。typed mutation 的 adapter 在结果投影失败或无法证明该领域状态可重放时也会降级 volatile；这不是 Cordis 不可逆，而是缺少足够领域事实时的 fail-closed 边界。

上述读写分类只适用于精确匹配并完成数据契约翻译的 typed profile。经 `host.invoke` 调用的 raw
`cordis_*` 没有同等语义保证，因此全部按 possible mutation 处理。

该边界按可证明的领域结果收缩：`cordis.define` 的原始 closure 若明确 reject，表示 registry effect 尚未建立，可作为 durable semantic failure 重放；`run`、`stop`、`undefine` 的 reject，以及任何结果投影失败仍保持 volatile，因为公共 API 无法证明 effect 是否已部分发生。abort、timeout 或 worker reset 会回滚 REPL heap，但不会假装回滚 Cordis process state；原 execution 的外部 volatile 原因跨 worker replay 保留，并在下一 cell 显示一次状态通知。迟到 settlement 不归属下一 cell。显式 `repl.state({ action: "restore" })` 仍是用户主动丢弃 volatile suffix 的边界。

`code.run` child 不拥有独立 journal。top-level projection 捕获 owning execution token，并向所有递归 child projection 显式传递；child typed Cordis domain call 复用父 transcript，raw Cordis compatibility call 仍用该 token 降级父 cell。不得在 child 创建时重新读取 `AsyncLocalStorage`，因为递归发生在 kernel MessagePort 的 host-binding callback 中，该 callback 不保证携带外层 `tools/execute` store。

冷重放会重复执行已确认的 typed Cordis domain effect，并校验重建结果与历史 transcript 一致；不会重放 raw `host.invoke`，也不会把 approval 或 Client settlement 当成已完成。volatile live binding 继续可用；进程重启后恢复最后 durable frontier。插件不承诺访问任意 module-local lexical binding，也不提供 raw host `eval`。full access 指官方 Cordis context、service store、fibers、Inspect Providers、dynamic Package facade 和 Client slots 可达的 trusted in-process authority。

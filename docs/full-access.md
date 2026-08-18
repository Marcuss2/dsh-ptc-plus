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
  + official Cordis inspect/creator bindings
  + Host/Client Cordis runner and Inspect Providers
```

`danger-full-access` 本身只改变文件 sandbox 与普通 tool approval policy。它不授予 Cordis capability，不创建 binding，也不证明当前 Agent 使用 creator roster。PTC Plus 始终以当前 `CodeRuntime.run()` request 的 binding snapshot 为唯一 capability authority；一次调用中的 `sandbox_permissions: "danger-full-access"` 更不能改变当前或下一 cell 的 namespace。

RC7 的公开 Agent preset 负责 roster 与 Code presentation，permission preset 则是独立的 session 日志状态。当前公开 composition 没有把两者原子绑定成一个新的单选 Agent preset。因此本插件不声称安装了一个新的 RC7 preset id，也不在 cell 中动态切换权限。部署可以用官方/用户 Agent composition 选择 Code + Cordis roster，并在 session 创建时选择 `danger-full-access` permission preset；插件只消费最终得到的 scoped bindings。

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

插件只接受这个已知 profile 的完整、无额外 `cordis_*` 成员的 snapshot。缺少成员、出现未来未知成员、或官方改名时，插件不会猜测语义，直接不建立 `cordis` namespace，并且不经 `host.invoke` 暴露任何 `cordis_*` raw 名称。RC7 公共扩展面当前没有 capability-set 版本或语义 manifest，因此无法在不新增对应 plugin adapter 的前提下安全自动适配未来变更；fail-closed 是有意的稳定性边界。

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

profile 不匹配时，`cordis` 整体不可用；所有 native `cordis_*` 名称也不会通过 `host.invoke` 重新暴露。插件不从 sandbox mode 推断、补造或缓存缺失 capability。每个 cell 重新投影 immutable snapshot，新注册的 tool/service 最早在后续 DSH request 提供新 binding 时可见。

严格 PTC prompt 不直接保留 native `tool:cordis` grammar。当前已知 profile 精确匹配时，插件把官方 section 作为行为事实源，严格翻译七个调用名、`inspectSelf` 调用形状以及 `idPrefix`、`code.host/client` 字段为 `cordis.*` program contract 后保留；翻译后残留未知 `cordis_*` 名称、或完整 profile 缺少该 section 时，prompt assembly fail-closed。profile 缺失或不匹配时才整体移除该 section。这样 plain JavaScript、先 Inspect、prefix 格式、Fiber 清理以及 `awaiting-approval`/`starting` 非完成态等官方约束不会因 presentation 改写而丢失，普通 `ptc` 也不会收到不可执行 Cordis 指令。

## 执行与 approval

adapter 每次只调用一次原始 Code Mode closure。ToolRuntime 继续拥有 scheduler、pre/post policy、ordinary approval、sandbox、cancellation、result normalization、nested audit 和 UI content。PTC Plus 不调用 tool definition、`ctx.fs`、`ctx.shell` 或 `ctx.approval`，也不维护 grant cache。

Cordis Client Package 使用 runner 自己的异步审批协议。`cordis.run(...)` 可以返回 `awaiting-approval`；即使 session 的普通 approval policy 是 `never`，PTC Plus 也不得自动批准、重试或模拟 `cordis/request-run-resolved`。

## Durable / volatile

`cordis.inspectList`、`cordis.inspect` 和 `cordis.inspectSelf` 是 read-only host calls，其 canonical result 可进入 journal。`cordis.define`、`cordis.run`、`cordis.stop` 和 `cordis.undefine` 修改 process-memory Program/Package/Plugin state。RC7 只向 program projection 提供 opaque binding closure，插件看不到其内部 pre-policy、effect 与 post-policy 边界；因此最早可靠的 possible-effect boundary 是 program 参数校验完成、即将调用 creator closure 的时刻。当前 cell 从该时刻立即转为 sticky volatile，不能等 closure fulfilled 后再标记。

该边界有意保守：closure 随后 reject 也保持 volatile，因为 rejection 可能来自 effect 前拒绝，也可能来自 effect 后 policy/result conversion，公共 API 无法可靠区分。abort、timeout 或 worker reset 会回滚 REPL heap，但不会假装回滚 Cordis process state；原 execution 的外部 volatile 原因跨 worker replay 保留，并在下一 cell 显示一次状态通知。迟到 settlement 不归属下一 cell。显式 `repl.state({ action: "restore" })` 仍是用户主动丢弃 volatile suffix 的边界。

`code.run` child 不拥有独立 journal。top-level projection 捕获 owning execution token，并向所有递归 child projection 显式传递；child creator mutation 必须用该 token 降级父 cell。不得在 child 创建时重新读取 `AsyncLocalStorage`，因为递归发生在 kernel MessagePort 的 host-binding callback 中，该 callback 不保证携带外层 `tools/execute` store。

冷重放不会重复 Cordis effect。volatile live binding 继续可用；进程重启后恢复最后 durable frontier。插件不承诺访问任意 module-local lexical binding，也不提供 raw host `eval`。full access 指官方 Cordis context、service store、fibers、Inspect Providers、dynamic Package facade 和 Client slots 可达的 trusted in-process authority。

# PTC Value Graph V1

## 三个投影

PTC runtime value、持久 wire 与模型文本是三个不同契约：

```text
JavaScript value
  -> ptc-value-graph/v1 envelope     worker IPC / journal / replay identity
  -> structured JSON or TS-like text outer RC7 CodeRuntime projection
```

wire 从不使用 `eval` 或 `Function` 解码，模型文本也从不作为可执行序列化读取。

## 支持域

`PTCValueV1` 支持：

- `null`、boolean、string、普通 finite number；
- `undefined`、`NaN`、正负 Infinity、`-0`、BigInt；
- plain object 的 enumerable string-keyed data values；
- 普通 array，包括 hole；
- cycle 与 shared reference，identity 在 hydrate 后保持。

以下值明确拒绝：function/closure、Promise、WeakMap/WeakSet、symbol value 或 symbol key、accessor、arbitrary class prototype、Date、Map、Set、RegExp、ArrayBuffer、typed array 和其他 live/executable resource。encoder 读取 property descriptor，不调用 getter。writable/configurable flags 不属于 PTC Value V1 的值图语义，hydrate 后统一成为普通 data property；Proxy 仍属于 worker 隔离与执行预算问题，不因 codec 自动变安全。

## Canonical envelope

持久值使用封闭 JSON-safe envelope：

```ts
{
  codec: "ptc-value-graph/v1",
  root: Atom,
  nodes: Node[]
}
```

`Atom` 是 JSON primitive，或封闭 tag：`undefined`、special number、BigInt、node reference。object node 保存有序 `[key, Atom]` entries；array node 保存 `length` 与有序 `[index, Atom]` entries，因此 hole 与显式 `undefined` 不同。decoder 拒绝未知/额外字段、重复 key/index、越界或 dangling reference、不可达 node 和非 canonical 编码；`__proto__` 通过 data descriptor hydrate，不触发 setter。

graph 发现顺序与 ECMAScript own-key 顺序共同确定唯一编码。plain JSON tree 保持线性；shared object 只编码一次。结构预算为 `maxValueNodes`、`maxValueEdges`、`maxValueArrayLength` 和 `maxValueBigIntDigits`，总 IPC/journal/render byte ceiling 继续由 `maxOutputBytes` 约束。

## Completion 与外层投影

worker completion 显式携带 `hasValue`，协议字段缺失不能与已编码的 JavaScript `undefined` 混淆。显式 `return undefined` 有值；自然无输出的声明 cell 仍保持无值。

RC7 的公共 `CodeRuntime`/tool output 仍要求 lossless JSON。为保持社区插件边界：

- dense、无 shared identity 的 plain JSON tree 继续作为 structured result 返回；
- 包含 `undefined`、special number、BigInt、hole、shared identity 或 cycle 的合法 PTC value 使用确定性、有 byte ceiling 的 TS-like renderer，作为 string result 进入外层 RC7；
- renderer 只是模型展示，不参与 hydrate；需要继续计算时应保留 live REPL binding；
- journal 保存 canonical graph envelope，不保存 renderer 反解析结果，也不把 decoded rich value 交给外层 `JSON.stringify`。

unsupported value 或预算超限继续使用 `PTC-O001`，但帮助文本只要求返回受支持的 PTC value 或缩小结果；`undefined` 不再是错误，也不要求模型用 `null` 替换。

host capability 参数和结果也经过同一 graph IPC，但底层 RC7 host binding 当前仍要求 lossless JSON。program 在调用外部 capability 时传入 rich value 会得到 capability rejection；这不限制 REPL 内部值和最终 completion 的 `PTCValueV1` 能力。

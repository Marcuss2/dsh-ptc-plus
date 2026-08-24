/** Configuration fields shared by the Host schema and settings card. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Stable settings namespace used by both Host and browser halves. */
export const SETTINGS_NAMESPACE = 'ptc-plus'

/** Ordered field definitions for the plugin configuration card. */
export const CONFIG_FIELDS = Object.freeze([
  {
    key: 'enabled',
    type: 'boolean',
    default: true,
    label: '启用 PTC Plus',
    description: '关闭后 PTC Plus 不注册 run_code/edit_run_code、不修改系统提示、不创建 session runtime；设置 UI 仍保留且仅此开关可操作。',
  },
  {
    key: 'cordisToolsEnabled',
    type: 'boolean',
    default: false,
    label: '在 PTC 模式中启用 Cordis 工具',
    description: '在 PTC agent 的 tools.* 中即时加入或移除官方 Cordis 工具与指引。',
  },
  {
    key: 'computeMs',
    type: 'integer',
    default: 60_000,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: '单 cell 最大 CPU 时间 (ms)',
    description: '同步计算超过该预算的 cell 会被中断。',
  },
  {
    key: 'maxWallMs',
    type: 'integer',
    default: 600_000,
    min: 1,
    max: MAX_TIMER_DELAY_MS,
    label: '单 cell 最大墙钟时间 (ms)',
    description: '完整 cell 执行（含异步等待）的最长耗时。',
  },
  {
    key: 'maxOutputBytes',
    type: 'integer',
    default: 64 * 1024 * 1024,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: '最大输出字节',
    description: 'PTC Value Graph 编码、IPC、journal 和渲染共享的字节上限。',
  },
  {
    key: 'maxOldGenerationSizeMb',
    type: 'integer',
    default: 512,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: 'worker 旧生代内存上限 (MiB)',
    description: '每个 session worker 的 V8 old-generation 限制；活动 worker 存在时修改会回滚，待 session 释放后生效。',
  },
  {
    key: 'maxValueNodes',
    type: 'integer',
    default: 100_000,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: 'Value Graph 最大节点数',
    description: '单次返回值的图节点预算。',
  },
  {
    key: 'maxValueEdges',
    type: 'integer',
    default: 1_000_000,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: 'Value Graph 最大边数',
    description: '单次返回值的图边预算。',
  },
  {
    key: 'maxValueArrayLength',
    type: 'integer',
    default: 1_000_000,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: '数组最大声明长度',
    description: 'Value Graph 编码的数组长度预算。',
  },
  {
    key: 'maxValueBigIntDigits',
    type: 'integer',
    default: 100_000,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: 'BigInt 最大十进制位数',
    description: 'BigInt 编码的十进制位数上限。',
  },
  {
    key: 'maxNestedRunCodeDepth',
    type: 'integer',
    default: 8,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: 'code.run 最大递归深度',
    description: '隔离 code.run 的嵌套深度限制。',
  },
  {
    key: 'canonicalizeToolCalls',
    type: 'boolean',
    default: true,
    label: '规范顶层 native 误调',
    description: '把 live schema 可证明的顶层 native 调用规范成 run_code cell。',
  },
  {
    key: 'looseTopLevelRedeclarations',
    type: 'boolean',
    default: true,
    label: '宽松顶层重声明',
    description: '允许完整 const/let declarator 替换已有顶层 binding。',
  },
  {
    key: 'durableReplay',
    type: 'boolean',
    default: true,
    label: '持久重放',
    description: 'worker 重建时从 session log 重放 durable cell。',
  },
  {
    key: 'autoRewriteImports',
    type: 'boolean',
    default: true,
    label: '自动改写 import',
    description: '把静态 import 适配为 worker 预加载的 module namespace。',
  },
  {
    key: 'autoStripExports',
    type: 'boolean',
    default: true,
    label: '自动剥离 export',
    description: '移除顶层 export 修饰符并保留声明。',
  },
  {
    key: 'autoSplitRedeclarations',
    type: 'boolean',
    default: true,
    label: '自动拆分混合重声明',
    description: '将混合新旧名称的顶层解构拆为兼容写法。',
  },
  {
    key: 'tipsEnabled',
    type: 'boolean',
    default: true,
    label: '启用恢复提示',
    description: '在重复失败或 execution-world 诊断后注入有界 runtime context。',
  },
  {
    key: 'tipCooldownMessages',
    type: 'integer',
    default: 3,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: '恢复提示冷却步数',
    description: '两次同类提示之间的最小 model-context 步数。',
  },
  {
    key: 'tipEscalationFailures',
    type: 'integer',
    default: 2,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: '恢复提示升级失败次数',
    description: '连续未解决的相同触发达到该次数后提示才升级为详细版本。',
  },
])

/** Resolved defaults, derived once from the field definitions. */
export const CONFIG_DEFAULTS = Object.freeze(
  Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, field.default])),
)

/** Key of the runtime kill switch; all settings are applied live by the Host. */
export const ENABLED_KEY = 'enabled'

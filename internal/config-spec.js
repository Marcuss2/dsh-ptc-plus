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
    description: '',
  },
  {
    key: 'cordisToolsEnabled',
    type: 'boolean',
    default: false,
    label: '在 PTC 模式中启用 Cordis 工具',
    description: '即时为 PTC agent 加入或移除官方 Cordis 工具。',
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
    description: '限制单个 cell 的输出和结果数据总大小。',
  },
  {
    key: 'maxOldGenerationSizeMb',
    type: 'integer',
    default: 512,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: 'worker 旧生代内存上限 (MiB)',
    description: '每个 worker 的 V8 旧生代上限；活动 worker 存在时修改会被拒绝。',
  },
  {
    key: 'maxValueNodes',
    type: 'integer',
    default: 100_000,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: 'Value Graph 最大节点数',
    description: '限制单次返回值的节点数。',
  },
  {
    key: 'maxValueEdges',
    type: 'integer',
    default: 1_000_000,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: 'Value Graph 最大边数',
    description: '限制单次返回值的引用关系数。',
  },
  {
    key: 'maxValueArrayLength',
    type: 'integer',
    default: 1_000_000,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: '数组最大声明长度',
    description: '限制返回数组的最大长度。',
  },
  {
    key: 'maxValueBigIntDigits',
    type: 'integer',
    default: 100_000,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: 'BigInt 最大十进制位数',
    description: '限制返回值中 BigInt 的十进制位数。',
  },
  {
    key: 'maxNestedRunCodeDepth',
    type: 'integer',
    default: 8,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: 'code.run 最大递归深度',
    description: '限制 code.run 的嵌套层数。',
  },
  {
    key: 'canonicalizeToolCalls',
    type: 'boolean',
    default: true,
    label: '规范顶层 native 误调',
    description: '修正可以明确识别的顶层 native 误调。',
  },
  {
    key: 'looseTopLevelRedeclarations',
    type: 'boolean',
    default: true,
    label: '宽松顶层重声明',
    description: '允许顶层 const/let 重声明已有变量。',
  },
  {
    key: 'durableReplay',
    type: 'boolean',
    default: true,
    label: '持久重放',
    description: 'worker 重启后恢复可以重建的 REPL 状态。',
  },
  {
    key: 'autoRewriteImports',
    type: 'boolean',
    default: true,
    label: '自动改写 import',
    description: '允许在 run_code 中使用静态 import。',
  },
  {
    key: 'autoStripExports',
    type: 'boolean',
    default: true,
    label: '自动剥离 export',
    description: '允许在 run_code 中使用顶层 export。',
  },
  {
    key: 'autoSplitRedeclarations',
    type: 'boolean',
    default: true,
    label: '自动拆分混合重声明',
    description: '允许顶层解构声明同时包含新旧变量。',
  },
  {
    key: 'tipsEnabled',
    type: 'boolean',
    default: true,
    label: '启用恢复提示',
    description: '在符合条件的失败后显示恢复提示。',
  },
  {
    key: 'tipCooldownMessages',
    type: 'integer',
    default: 3,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: '恢复提示冷却步数',
    description: '同类恢复提示之间的最小间隔。',
  },
  {
    key: 'tipEscalationFailures',
    type: 'integer',
    default: 2,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    label: '恢复提示升级失败次数',
    description: '连续失败达到此次数后显示更详细的恢复提示。',
  },
])

/** Resolved defaults, derived once from the field definitions. */
export const CONFIG_DEFAULTS = Object.freeze(
  Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, field.default])),
)

/** Key of the runtime kill switch; all settings are applied live by the Host. */
export const ENABLED_KEY = 'enabled'

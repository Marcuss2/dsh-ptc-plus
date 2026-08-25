# Publishing

本仓库是普通 DSH bundle：`package.json` 声明 `dsh.bundle.patch`、入口、依赖、Node 范围和发布白名单，`cordis.patch.yml` 只插入 `dsh-ptc-plus`。插件自带的运行时依赖由 npm 包声明；必须与宿主共享实例的 DSH service 包声明为 peer dependencies，并由宿主按 `inject` 装配。

## 命名约定

项目在不同集成层使用不同名称：

| 名称 | 用途 |
| --- | --- |
| `dsh-ptc-plus` | 仓库和 npm 包名；浏览器 bundle 的 module name 也从 `package.json` 取得它。 |
| `ptc-plus` | DSH 插件 ID、运行时 loader name 和 settings namespace。 |
| `PTC Plus` | 面向用户的产品名。 |

在 `cordis.patch.yml` 和解析后的 DSH 配置中，`id: ptc-plus` 标识插件配置项，`name: dsh-ptc-plus` 标识待加载的包。内部错误前缀、runtime context 名称和 worker 临时路径会按所属子系统使用 `ptc-plus` 或 `dsh-ptc-plus`；它们不是另外的公开产品名。

## Release checklist

1. 在 Node `22.19.0` 与 Node 24.x 上运行 `npm ci`、`npm run build:check` 和 `npm run check`；Node 24.x 还应覆盖 Windows、Linux 与 macOS。仓库 CI 定义同一矩阵。
2. 运行 `npm audit`、`npx publint`、`git diff --check`、Markdown local-link check 和 `npm pack --silent --dry-run --json`。确认 tarball 只包含发布白名单内的运行时代码、文档和展示资产，不含凭据、本地路径、开发脚本或测试夹具，并从 tarball 安装到空目录执行 ESM import smoke。机器读取 `npm pack --json` 时保持 `--silent`，避免 lifecycle 输出混入 JSON stream。
3. 更新到最新可用 DSH release 并记录 `dsh --version`。分别从 npm 包、固定 Git commit、源码 checkout 和 tarball 安装到临时 profile，再执行 `dsh --profile <profile> --dump-config`，确认只新增 `ptc-plus` row。每个上游 release 都重新验证公共扩展面、CLI/Web 集成和 profile 装配，不设置版本白名单。
4. 在 Windows 与 Linux CLI/Web 实机启动临时 profile。macOS 由原生 runner 验证 CLI/Web；Windows 与 macOS Desktop 从托盘打开当前 profile 的 DSH Terminal 安装，重启 Desktop 后做一次 PTC 模式 smoke。Desktop 当前发布平台不包括 Linux。
5. 只有在明确授权模型消耗后才运行 `npm run test:expensive` 与 `npm run test:ab`。发布结论以结构化测试结果为准，不把一次模型样本推广为普遍保证。
6. 确认 npm 包名可用、待发布版本高于 registry 版本、README 截图来自真实 DSH 会话，并核对 repository、homepage、bugs、license 与 `dsh-plugin` topic。
7. 最后检查 `npm pack --silent --json` 的名称、版本、大小与文件列表，再创建并推送 release commit/tag，随后发布同一 commit 产生的 tarball。

远程仓库、registry、签名凭据、目标平台运行状态和模型额度都属于发布时事实，不能由本地 manifest 推断。

## Permission disclosure

PTC Plus 自身不配置外部 endpoint，也不读取 API key。它让模型代码使用当前 request 的 DSH native tools，并在 worker 进程和操作系统实际允许时直接使用 Node.js filesystem、process、network 与 child process API。DSH 负责 native-tool policy；ambient Node/OS access 不经过该 policy。worker thread 是生命周期隔离，不是恶意代码安全沙箱。

DSH 当前公共 bundle surface 未定义供插件使用的机器可读 permission-disclosure contract，因此这些权限边界记录在人类可读文档中。

## Client UI

发布包包含设置卡片和会话头部启用标识的 Client UI。发布截图必须来自 DSH Web 或 Desktop 中真实的 PTC 模式 surface；实现与构建边界见 [Client UI](client-ui.md)。

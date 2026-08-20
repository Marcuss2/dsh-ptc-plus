# Publishing

本仓库是普通 DSH bundle：`package.json` 声明 `dsh.bundle.patch`、入口、依赖、Node 范围和发布白名单，`cordis.patch.yml` 只插入 `dsh-ptc-plus`。运行时依赖由 npm 包声明，DSH/Cordis service 则由宿主按 `inject` 装配，不声明虚假的 peer dependency。

## Release checklist

1. 在 Node `22.19.0` 与 Node 24.x 上运行 `npm ci` 和 `npm run check`；Node 24.x 还应覆盖 Windows、Linux 与 macOS。仓库 CI 定义同一矩阵。
2. 运行 `npm audit`、`npx publint`、`git diff --check`、Markdown local-link check 和 `npm pack --dry-run --json`。确认 tarball 只包含发布白名单内的运行时代码、文档和展示资产，不含凭据、本地路径、开发脚本或测试夹具，并从 tarball 安装到空目录执行 ESM import smoke。
3. 记录 `dsh --version`。分别从 npm 包、固定 Git commit、源码 checkout 和 tarball 安装到临时 profile，再执行 `dsh --profile <profile> --dump-config`，确认只新增 `ptc-plus` row。切换 DSH prerelease 后重新验证。
4. 在 Windows 与 Linux CLI/Web 实机启动临时 profile。macOS 由原生 runner 验证 CLI/Web；Windows 与 macOS Desktop 从托盘打开当前 profile 的 DSH Terminal 安装，重启 Desktop 后做一次 Code Mode smoke。Desktop 当前发布平台不包括 Linux。
5. 只有在明确授权模型消耗后才运行 `npm run test:expensive` 与 `npm run test:ab`。发布结论以结构化测试结果为准，不把一次模型样本推广为普遍保证。
6. 确认 npm 包名可用、待发布版本高于 registry 版本、README 截图来自真实 DSH 会话，并核对 repository、homepage、bugs、license 与 `dsh-plugin` topic。
7. 最后检查 `npm pack --json` 的名称、版本、大小与文件列表，再创建并推送 release commit/tag，随后发布同一 commit 产生的 tarball。

远程仓库、registry、签名凭据、目标平台运行状态和模型额度都属于发布时事实，不能由本地 manifest 推断。

## Permission disclosure

PTC Plus 自身不配置外部 endpoint，也不读取 API key。它让模型代码使用当前 request 的 DSH native tools，并在 worker 进程和操作系统实际允许时直接使用 Node.js filesystem、process、network 与 child process API。DSH 负责 native-tool policy；ambient Node/OS access 不经过该 policy。worker thread 是生命周期隔离，不是恶意代码安全沙箱。

DSH `0.1.0-rc.8` 未定义供 bundle 使用的机器可读 permission-disclosure contract，因此这些权限边界记录在人类可读文档中。

## Client UI

`0.1.0` 不提供 Client UI。发布截图使用 DSH Web 或 Desktop 中真实的 Code Mode surface；重新评估条件见 [Client UI](client-ui.md)。

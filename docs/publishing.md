# Publishing

本仓库具备 DSH Cordis plugin 的包结构：`package.json` 声明 `dsh.bundle.patch`、repository URL、semver、files whitelist 与 disclosure；`cordis.patch.yml` 只插入 `dsh-ptc-plus`。插件不 import DSH/Cordis npm modules，运行能力由宿主按 `inject` 装配，因此不声明会让 profile-local 安装器产生缺失警告的虚假 peer dependencies。远程仓库是否公开必须在发布时核验，不能从 package metadata 推断。

## Release checklist

1. 运行 `npm run check`、`git diff --check`、Markdown link check 和 `npm pack --dry-run`。
2. 记录 `dsh --version`，在 Windows DSH profile 安装 pack 后的 tarball，再执行 `dsh --profile <name> --dump-config`，确认只有 `ptc-plus` row 被插入；切换 prerelease 版本后重新执行这一步。
3. 在明确授权模型消耗后运行 `npm run test:expensive`，检查并发真实 Code Mode 场景、native
   `tools.*`、capability explorer、nested `code.run`、Node full-access volatile 路径、journal 和解码值。
   每次运行使用随机夹具且不自动重试；发布证据保留 run 根目录的 `summary.md` 与各场景报告。
4. 在 README 中加入真实 DSH Web 会话截图或短 GIF；不得使用 mock、空 placeholder 或插件并不存在的设置 UI。
5. 确认 npm 包名未被占用，版本高于已发布版本，并检查 package tarball 不含 artifacts、凭据或本地路径。
6. 公开仓库并推送发布 commit/tag；为仓库设置必需的 `dsh-plugin` topic，可选增加 `dsh`、`deepseek-harness`、`cordis-plugin`、`code-mode` 和 `repl`。

远程设置、npm registry 状态、截图和发布凭据不属于仓库可自动证明的事实，发布者必须在每次 release 时重新核验。

## Disclosure

插件本身不连接云服务、不读取 API key、不持有外部 endpoint，状态保留范围为当前 DSH session。它允许模型代码在当前 DSH/OS profile 授权范围内使用 native tools、filesystem、process、network 与 child process；这些是执行权限，不应被 `cloud: false` 或 `offlineMode: true` 隐藏。`code.run` 使用隔离 child runtime 与 scratch，不合并父 REPL heap。

机器可读 disclosure 以 `package.json` 为事实源。权限或数据行为变化时必须先更新实现与该字段，再发布新版本。

## Client UI

`0.1.0` 不提供 Client UI。发布截图使用 DSH Web 的真实 Code Mode REPL；重新评估条件见 [Client UI](client-ui.md)。

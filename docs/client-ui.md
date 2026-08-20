# Client UI

`0.1.0` 不提供插件自有 Client UI。PTC Plus 的产品表面是 DSH PTC 模式中的 `run_code` cell、
用于局部修正未执行 cell 的 `edit_run_code` transport、输出、诊断和 `repl.state`。增加设置卡片不会改善核心连续求值
路径，却会引入独立的 React/client bundle、Host settings namespace、额外依赖和第二套验收面。

因此 package manifest 不声明 `dsh.client`，不导出 `./client`，bundle patch 也不注册 client half。文档与截图应展示真实 DSH Web 会话，而不是一个只复述配置的装饰面板。

只有出现下列需求之一时才重新评估：

- 用户需要在 UI 中观察或控制无法通过现有 PTC 模式表达的 session 状态；
- DSH 稳定提供 settings namespace、client slot 与第三方 bundle 构建/测试契约；
- 能在支持的 Web profile 中完成构建、加载、交互和截图验收。

重新评估时，Host half 必须使用 DSH 公共 settings API，Client half 必须遵守官方 `dsh.client` 与 `./client` bundle contract；依赖缺失不能使 Host plugin 加载失败。配置 schema 必须复用 runtime 的同一事实源，不能在 UI 中复制默认值和校验逻辑。

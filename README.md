# AI Tab Organizer

**把杂乱的 Chrome 标签，整理成原生标签组。**

一个轻量、隐私优先的 Manifest V3 扩展。先预览、再应用，随时撤销；支持本地规则、OpenAI / DeepSeek 兼容 API，以及实验性的独立 ChatGPT 计划授权。

> 本地 0.2.0-dev 新增实验性 SIWC companion，尚未发布或做真实 OAuth 验收。已发布的 0.1.0 只含离线规则和 API。默认离线运行，不启动或读取 Codex；不是 Chrome Web Store 上架版本。

## 功能

- **原生标签组**：直接使用 Chrome 自带的标签组与颜色。
- **先看再动**：生成分类预览后再应用；AI 请求失败或返回无效 ID 时不改动标签。
- **保守范围**：只整理当前窗口、未固定、未分组的 HTTP(S) 标签，每次最多 100 个。现有组、固定标签与隐身窗口不处理。
- **撤销**：取消最近一次创建的分组，尽量恢复标签顺序。撤销会暂停自动整理。
- **分类引擎**：默认本地关键词/域名规则；可切换 OpenAI、DeepSeek 或提供 Chat Completions JSON 模式的兼容服务。
- **自动整理**：明确开启后，在新标签加载完成后处理。15 秒静默窗口、每分钟检查、每窗口至少 5 分钟冷却。默认关闭。
- **域名排除**：可排除邮件、银行、内部系统等域名及其子域名。
- **最少数据**：AI 仅收到数值标签 ID、标题、域名，以及分类偏好。不会发送完整 URL、路径、查询参数或页面正文。
- **API Key 仅保留当前会话**：不提供明文持久保存；浏览器关闭后需重填，新版启动时会清除旧版持久保存的 Key。Key 与目标 API 地址绑定，不跟随地址变化复用。切换并保存本地模式会清除 Key。

## 安装开发版

1. 下载源码并解压，或克隆本仓库。
2. Chrome 打开 `chrome://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本仓库的 **extension** 文件夹。
4. 固定扩展图标，打开一些普通网页，点击「生成分类预览」。
5. 检查预览后点击「应用分组」。

扩展本身无需 npm 安装、构建或外部依赖，直接加载即可。最低 Chrome 120。

### 使用 AI API

打开扩展「设置」，选择「OpenAI / DeepSeek 兼容 API」。选择预设，或输入兼容服务的 Base URL、模型名与 Key，勾选数据发送确认，再保存。

- OpenAI 默认地址：`https://api.openai.com/v1`，预设模型 `gpt-4.1-mini`。
- DeepSeek 默认地址：`https://api.deepseek.com/v1`，预设模型 `deepseek-chat`。
- 模型需支持 Chat Completions 和 `response_format: {type: "json_object"}`。不同账户的模型可用性、费用和限额请以服务商为准。
- 远程服务必须为 HTTPS；本机兼容服务支持 `http://localhost:端口/v1` 或 `http://127.0.0.1:端口/v1`。当前 API 模式需要非空 Key，包括本机兼容服务要求的占位 Key。
- 仅申请所配置 API 站点的可选权限。默认安装不申请所有网站访问权限。
- API 请求在 25 秒内完成，否则保留标签不变并报错。请求不会跟随重定向，也不会携带浏览器 Cookie。
- **API Key 按服务商 API 计费，不使用 ChatGPT 订阅额度。**

### 独立 ChatGPT 计划授权（实验性）

本版刻意不使用 `codex exec` / `codex app-server`，不创建 Codex 会话，不读取 `~/.codex` 或浏览器中其他应用的凭据。

本地开发版新增独立 Python companion：系统浏览器 OAuth、PKCE/state/nonce、ID token 签名校验、macOS Keychain / Linux Secret Service、账户绑定与原生消息通信。默认关闭，需手动安装并单独授权。**只完成模拟测试，未通过真实登录、系统钥匙串和额度调用验收**；Windows 暂未实现。

它直接调用公开 Responses API，不创建 Codex 会话，但仍会消耗共享 ChatGPT 计划额度，可能影响其他应用剩余额度。Token 不进入扩展，无 API Key 自动计费回退。查看 [companion 安装与账户操作](companion/README.md) 和 [安全架构](docs/codex-integration.md)。

## 隐私与安全

标题本身也可能包含私人信息。启用 AI 前，请确认服务商和排除列表适合自己的浏览场景。详见 [隐私说明](PRIVACY.md) 和 [安全说明](SECURITY.md)。

没有遥测、广告、项目后端、远程脚本或网页内容脚本。API Key 不会写入日志、源码或同步存储；API Key 仅在会话存储中，ChatGPT OAuth token 仅在独立 companion 的系统钥匙串中。

## 开发与测试

需要 Node.js 22+；构建 ZIP 需要系统 `zip` 命令。

```sh
npm run check
npm test
npm run build
# companion 另需安装其 Python 依赖，然后：
npm run test:companion
```

输出：`dist/extension/`、扩展安装 ZIP、完整源码 ZIP 及各自的 SHA-256 文件。

可选真实浏览器冒烟（Playwright 只是开发测试工具，不会打包进扩展）：

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
# 或使用已有 Chromium：
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
```

冒烟使用临时浏览器资料目录和合成页面，不登录真实账户或调用付费 API。测试范围见 [测试说明](docs/testing.md)。

## 撤销和首版边界

- 只保留每个窗口最近一次整理的撤销记录，浏览器重启后清除。中断恢复无法确认归属的组会保留记录并提示手动解组，不会假报完全成功。
- 已关闭的标签不会重新打开，已移动到其他窗口的标签不会被拉回来；后来固定或手动移入其他组的标签不会被强制解组。
- 撤销会尝试恢复整理前的未分组标签顺序，因此可能覆盖你在整理后对这些标签的手动排序。存在新标签、关闭、移动或手动修改时，不保证完全恢复原顺序。
- 已有分组从不拆散，所以无需靠保存旧组 ID 重建其标题、颜色或折叠状态。
- 整理中断时保留恢复记录，后续应用/自动整理会被阻止，直到用户先撤销；对「创建组后、保存 ID 前」的窄窗口会按预存意图和精确成员尝试恢复。不要在恢复前手动修改该组，无法承诺任意崩溃与并发修改下完全原子恢复。
- 自动整理只处理加载事件之后的待处理窗口，不在安装后扫描所有窗口；批量同时加载多个窗口时会串行处理。
- 中文界面首发，分类提示可改语言。离线规则使用内置中文主题名称。
- 尚未做真实付费 API / 真实用户数据的端到端验收，也未提交应用商店审核。

## 项目结构

- `extension/core.js`：元数据最小化、排除规则、模型结果校验和离线分类。
- `extension/providers.js`：可扩展 provider 接口；实现本地规则、API Key 与实验性独立 SIWC。
- `extension/siwc.js`：可选 Native Messaging、独立账户与模型校验。
- `companion/`：独立 OAuth、系统钥匙串、受限 Responses 和 Python 安全测试。
- `extension/organizer.js`：分组、重验、撤销与中断恢复。
- `extension/background.js`：串行任务、设置、会话记录和自动整理。
- `extension/popup.*` / `options.*`：界面。
- `tests/`：无依赖 Node 单元与集成测试。

## 许可证

[MIT](LICENSE)。本项目独立开发，与 OpenAI、DeepSeek 或 Google 无隶属关系。

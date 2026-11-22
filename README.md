# dsh-chatgpt · ChatGPT 订阅

DSH Desktop 的独立原生模型插件，安装包名为 `@alcor/chatgpt`。在 DSH 的「插件 → 添加插件」中选择构建出的 `.tgz` 安装包。

在 DSH Desktop 的「设置 → 模型」中，找到「ChatGPT 套餐」并点击 **Continue with ChatGPT**，在浏览器完成 OpenAI 授权。返回客户端后，在 Alcor 或 DSH 对话的模型选择器中选择账号提供的模型。现有对话继续使用各自的历史、工具和确认设置。也可以从插件设置查看连接、重新登录或退出。

请求使用此账号授予的 ChatGPT 套餐额度。达到用量上限时，客户端显示 OpenAI 返回的限制。插件没有 API Key 或 API 按量付费路径。如果你在 ChatGPT 单独允许此应用使用额外积分，OpenAI 也可能扣除这些积分。可在 ChatGPT 的应用与网站连接设置中核对用量、调整许可或撤销授权。[OpenAI 套餐用量说明](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)

安装了 Alcor 时，可在「系统 → 日志」将来源选为 `ChatGPT`，查看模型请求结果。旧会话的推理强度发生转换时，日志会同时显示原档位和实际档位，例如 `ultra → max`。

设置页使用的 Blossom 标志归 OpenAI 所有。[OpenAI 品牌资源](https://openai.com/brand/)

## 独立开发

使用 Node.js 24.9 或更高版本，在本仓库运行：

```sh
npm ci
npm test
npm pack
```

`npm test` 使用模拟账号验证授权、模型调用和工具回传。`npm pack` 会构建服务端和客户端并生成原生插件安装包。在 DSH Desktop 0.2.2-rc.5 的插件管理页面选择此安装包即可。单独安装本插件即可在 DSH 中使用；已安装 Alcor 的 Profile 也能使用同一模型提供商。

## 两种对话模式的桌面验收

隔离验收使用官方 DSH Desktop、合成账号和 Alcor 的桌面测试辅助模块。为包含 Playwright 的 Python 环境设置 `ALCOR_SOURCE`（Alcor 源码目录）、`SECRETARY_ARCHIVE`（Alcor 原生安装包），然后执行：

```sh
STELLA_CHECK_DESKTOP_APP="/Applications/DeepSeek Harness.app" \
STELLA_CHECK_ARTIFACTS="$PWD/.local/desktop-check" \
PYTHONPATH="$ALCOR_SOURCE/product/tests" \
python3 -B tests/chatgpt-desktop-check.py "$SECRETARY_ARCHIVE" "$(npm pack --silent | tail -1)"
```

原始插件及测试来自 Alcor 提交 `705bdf01`，以 MIT 许可证发布。

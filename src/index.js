import { createPlanFetch } from './transport.js'
import { createAccount, registerAccount } from './account.js'
import { registerProvider } from './provider.js'
import { reportFailure } from './diagnostics.js'

export const inject = ['llm', 'credentials', 'typert']

export async function apply(ctx) {
  try {
    const account = createAccount(ctx, { fetch: createPlanFetch(ctx) })
    await registerAccount(ctx, account)
    registerProvider(ctx, account)
  } catch (error) {
    reportFailure(ctx, 'ChatGPT 插件启动失败', error, 'PLUGIN_START_FAILED', '请在插件设置中检查 DSH 与插件版本，并重新启用插件。')
    throw error
  }
  try { ctx.logger('ChatGPT').info('ChatGPT 模型提供商已就绪') } catch { /* Registration already succeeded. */ }
}

import { Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { methods, remote } from './account-contract.js'
import { reportFailure } from './diagnostics.js'

export async function register(ctx, account) {
  class ChatgptRemote extends TypertRemoteService {
    static inject = ['typert']
    constructor(inner) { super(inner, 'alcorChatgpt', { namespace: 'alcorChatgpt' }) }
    [Service.init]() {
      this.ctx.typert.register({ package: '@alcor/chatgpt', face: 'host', schemas: [],
        invocations: remote.descriptors, model: { services: [], events: [], objects: [] } })
    }
    async invokeAccount(method, request) {
      const call = this.ctx.invocation
      if (call?.peer?.principal?.kind !== 'owner' || call.signal.aborted || call.peer.signal.aborted) {
        const error = new Error('仅客户端所有者可管理 ChatGPT 账号。')
        if (!call?.signal?.aborted && !call?.peer?.signal?.aborted) {
          reportFailure(this.ctx, 'ChatGPT 账号管理权限', error, 'ACCOUNT_ACCESS_DENIED', '请由客户端所有者打开模型设置。', 'warn')
        }
        throw error
      }
      const input = methods[method][0].safeParse(request)
      if (!input.success) {
        const error = new Error('账号操作参数无效，请刷新模型设置后重试。')
        reportFailure(this.ctx, '验证 ChatGPT 账号操作', error, 'ACCOUNT_INPUT_INVALID', '请刷新模型设置后重试。', 'warn')
        throw error
      }
      return account[method](input.data)
    }
    @Remote accountState(input) { return this.invokeAccount('accountState', input) }
    @Remote beginLogin(input) { return this.invokeAccount('beginLogin', input) }
    @Remote cancelLogin(input) { return this.invokeAccount('cancelLogin', input) }
    @Remote signOut(input) { return this.invokeAccount('signOut', input) }
  }
  await ctx.plugin(ChatgptRemote).await()
}

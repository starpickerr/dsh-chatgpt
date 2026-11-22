import { randomUUID } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { exchange, openLogin, resource, revoke, signingKeys, tokens, verifyIdentity } from './account-oauth.js'
import { reportFailure } from './diagnostics.js'
import { safeRequestId, upstreamError } from './account-errors.js'

const key = credentialKey('alcor-chatgpt', 'accounts')
const admissionErrors = new Set(['subscription_sharing_invalid_user', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'])
const disconnected = () => Object.assign(new Error('请先在 DSH 设置 → 模型中连接 ChatGPT 套餐。'), { code: 'AUTH' })
function payload(record) {
  if (!record) return { accounts: [], activeId: null }
  if (record.kind !== 'grant' || !Array.isArray(record.payload?.accounts) || typeof record.payload.hostId !== 'string'
      || record.payload.accounts.some(row => !row || typeof row.id !== 'string')) {
    throw new Error('ChatGPT 账号凭据无法读取。')
  }
  return record.payload
}
const grant = value => ({ kind: 'grant', payload: value })
const selected = data => data.accounts.find(item => item.id === data.activeId)
const tag = data => selected(data)?.session ?? null

export function createAccount(ctx, { fetch: fetcher = globalThis.fetch } = {}) {
  const responseAccounts = new WeakMap()
  const credentials = ctx.credentials
  const lifetime = new AbortController()
  let accountLife = new AbortController(), currentTag
  let pending = null, signingOut = null
  let feedback = { notice: '', noticeKind: 'info' }
  function inform(notice, noticeKind = 'info') { feedback = { notice, noticeKind } }
  const report = (...args) => reportFailure(ctx, ...args)
  const storageHint = '请检查 DSH 本机凭据存储，再重新打开模型设置。'
  let readFailure
  async function read() {
    try {
      const data = payload(await credentials.readRecord(key))
      readFailure = undefined
      return data
    } catch (error) {
      // Polling the account panel must not evict other diagnostics during a storage outage.
      if (!readFailure) {
        readFailure = new Error('ChatGPT 账号凭据无法读取。', { cause: error })
        report('读取本机账号失败', readFailure, 'ACCOUNT_READ_FAILED', storageHint)
      }
      throw readFailure
    }
  }
  function observe(data) {
    const next = tag(data)
    const previous = currentTag
    currentTag = next
    if (previous === next || previous === undefined) return
    accountLife.abort()
    accountLife = new AbortController()
    ctx.emit('llm/models-updated', 'alcor-chatgpt')
  }
  function finish(attempt, message, kind = 'error') {
    if (pending !== attempt) return
    pending = null
    attempt.controller.abort()
    if (message) inform(message, kind)
  }
  ctx.on('credentials/record-updated', async changed => {
    if (changed === key && !lifetime.signal.aborted) observe(await read())
  })
  ctx.effect(() => () => { lifetime.abort(); accountLife.abort(); if (pending) finish(pending) })
  async function accountState() {
    const data = await read()
    observe(data)
    return { activeId: data.activeId, accounts: data.accounts.map(item => ({
      id: item.id, label: item.email || 'ChatGPT 账号', connected: !!item.session && !!item.tokens, canSignOut: !!item.tokens,
    })), pending: !!pending, ...feedback }
  }
  async function beginLogin({ accountId } = {}) {
    lifetime.signal.throwIfAborted()
    if (pending || signingOut) {
      const error = new Error('账号操作正在进行。')
      report('启动 ChatGPT 登录', error, 'ACCOUNT_BUSY', '请等待当前账号操作完成或取消登录。', 'warn')
      throw error
    }
    inform('')
    const attempt = { controller: new AbortController() }
    const signal = attempt.controller.signal
    pending = attempt
    let startupCode = 'ACCOUNT_STORAGE_FAILED'
    try {
      const record = await credentials.modifyRecord(key, async current => current ? undefined :
        grant({ ...payload(current), hostId: 'urn:uuid:' + randomUUID() }))
      signal.throwIfAborted()
      const data = payload(record)
      observe(data)
      const registration = accountId && data.accounts.find(row => row.id === accountId)
      if (accountId && !registration) {
        startupCode = 'ACCOUNT_NOT_FOUND'
        throw new Error('所选 ChatGPT 账号已移除。')
      }
      startupCode = 'LOGIN_LISTENER_FAILED'
      const browserUrl = await openLogin(attempt, registration, data.hostId, async ({ clientId, code, redirect, nonce, verifier }) => {
        attempt.stage = ['OpenAI 授权码交换失败', 'LOGIN_TOKEN_EXCHANGE_FAILED', '请检查网络后从 DSH 发起新的登录。']
        const body = await exchange(fetcher, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier }, signal)
        attempt.stage = ['获取 OpenAI 签名密钥失败', 'LOGIN_SIGNING_KEYS_FAILED', '请检查网络和 DSH 代理设置后重新登录。']
        const keys = await signingKeys(fetcher, signal)
        attempt.stage = ['OpenAI 登录身份校验失败', 'LOGIN_IDENTITY_FAILED', '请检查系统时间，再从 DSH 发起新的登录。']
        const identity = await verifyIdentity(keys, body.id_token, clientId, nonce)
        attempt.stage = ['OpenAI 返回的授权信息不完整', 'LOGIN_TOKEN_INVALID']
        const tokenSet = tokens(body)
        attempt.stage = ['在 DSH 保存账号连接失败', 'ACCOUNT_STORAGE_FAILED', storageHint]
        const result = await credentials.modifyRecord(key, async current => {
          signal.throwIfAborted()
          const live = payload(current)
          const previous = live.accounts.find(row => row.clientId === clientId)
          if (live.hostId !== data.hostId || (registration && (previous?.id !== registration.id || previous.session !== registration.session)) ||
              (previous && previous.subject !== identity.subject)) {
            attempt.stage = ['ChatGPT 账号身份已改变', 'ACCOUNT_IDENTITY_CHANGED', '请刷新模型设置，并选择正确的账号或工作区。']
            throw new Error('ChatGPT 账号身份已改变。')
          }
          const id = previous?.id ?? randomUUID()
          const updated = { id, clientId, ...identity, tokens: tokenSet, session: tokenSet ? randomUUID() : null, needsConsent: !tokenSet }
          return grant({ ...live, accounts: [...live.accounts.filter(row => row.id !== id), updated],
            activeId: tokenSet ? id : (live.activeId === id ? null : live.activeId) })
        })
        observe(payload(result))
        if (!tokenSet) report('ChatGPT 套餐授权不完整', undefined, 'LOGIN_SCOPE_MISSING', '请重新连接并允许共享套餐。', 'warn')
        inform(tokenSet ? '已连接 ChatGPT 套餐。' : '已登录，但未授权使用 ChatGPT 套餐。可重新连接并授权。', tokenSet ? 'info' : 'error')
      }, message => finish(attempt, message), report)
      return { browserUrl }
    } catch (error) {
      if (!signal.aborted) report('启动 ChatGPT 登录失败', error, startupCode,
        startupCode === 'ACCOUNT_STORAGE_FAILED' ? storageHint : '请重新打开模型设置并开始登录。')
      finish(attempt, '登录未能启动，请重试。')
      throw error
    }
  }
  async function cancelLogin() {
    if (pending) finish(pending, '已取消登录。', 'info')
    return accountState()
  }
  async function signOut({ accountId }) {
    if (signingOut) {
      const error = new Error('正在退出账号。')
      report('退出 ChatGPT', error, 'ACCOUNT_BUSY', '请等待当前退出操作完成。', 'warn')
      throw error
    }
    signingOut = accountId
    if (pending) finish(pending)
    let signOutCode = 'ACCOUNT_STORAGE_FAILED'
    try {
      if ((await read()).activeId === accountId) {
        accountLife.abort()
        accountLife = new AbortController()
      }
      let revoked = true
      const record = await credentials.modifyRecord(key, async current => {
        const live = payload(current), row = live.accounts.find(item => item.id === accountId)
        if (!row) {
          signOutCode = 'ACCOUNT_NOT_FOUND'
          throw new Error('所选 ChatGPT 账号已移除。')
        }
        let revocationError
        try { revoked = await revoke(fetcher, row, lifetime.signal) }
        catch (error) { revoked = false; revocationError = error }
        if (!revoked && !lifetime.signal.aborted) report('未确认远程撤销 ChatGPT 授权', revocationError, 'GRANT_REVOKE_FAILED',
          '请在 ChatGPT 安全与登录设置中断开连接。', 'warn')
        return grant({ ...live, accounts: live.accounts.map(item => item.id === accountId ? { ...item, tokens: null, session: null } : item),
          activeId: live.activeId === accountId ? null : live.activeId })
      })
      observe(payload(record))
      inform(revoked ? '已退出 ChatGPT。' : '已退出本机账号。未确认远程撤销，请在 ChatGPT 的安全与登录设置中断开连接。', revoked ? 'info' : 'error')
      return await accountState()
    } catch (error) {
      if (!lifetime.signal.aborted) report('退出本机 ChatGPT 账号失败', error, signOutCode,
        signOutCode === 'ACCOUNT_NOT_FOUND' ? '请重新打开模型设置。' : storageHint)
      throw error
    } finally { signingOut = null }
  }
  async function access(signal) {
    lifetime.signal.throwIfAborted()
    signal?.throwIfAborted()
    const data = await read()
    observe(data)
    const row = selected(data)
    if (!row?.tokens || !row.session || signingOut === row.id) return null
    const activeSignal = AbortSignal.any([accountLife.signal, lifetime.signal, ...(signal ? [signal] : [])])
    let tokenSet = row.tokens
    if (tokenSet.expires - Date.now() < 60000) {
      let fresh
      const recorded = await credentials.modifyRecord(key, async current => {
        activeSignal.throwIfAborted()
        const live = payload(current), now = selected(live)
        if (now?.id !== row.id || now?.session !== row.session || !now.tokens || signingOut === now.id) throw disconnected()
        fresh = now.tokens
        if (fresh.expires - Date.now() >= 60000) return undefined
        try {
          // A caller's cancelled generation must not lose an already rotating refresh token.
          const body = await exchange(fetcher, { grant_type: 'refresh_token', refresh_token: fresh.refresh, client_id: now.clientId }, lifetime.signal)
          fresh = tokens(body, fresh)
          if (!fresh) report('刷新 ChatGPT 授权', undefined, 'LOGIN_SCOPE_MISSING', '请重新连接并允许共享套餐。', 'warn')
        } catch (error) {
          if (!lifetime.signal.aborted) report('刷新 ChatGPT 授权失败', error, error.terminal ? 'GRANT_EXPIRED' : 'GRANT_REFRESH_FAILED',
            error.terminal ? '请重新连接 ChatGPT 套餐。' : '请检查网络后重试。')
          if (!error.terminal) throw error
          fresh = null
        }
        return grant({ ...live, activeId: fresh ? live.activeId : null, accounts: live.accounts.map(item => item.id === row.id ? { ...item, tokens: fresh, session: fresh ? item.session : null } : item) })
      }).catch(error => {
        if (!activeSignal.aborted) report('保存刷新后的账号失败', error, 'ACCOUNT_STORAGE_FAILED', storageHint)
        throw error
      })
      observe(payload(recorded))
      if (!fresh) { inform('ChatGPT 授权已失效，请重新连接。', 'error'); return null }
      tokenSet = fresh
    }
    activeSignal.throwIfAborted()
    return { token: tokenSet.access, session: row.session, signal: activeSignal }
  }
  async function invalidateResponse(response, code) {
    const auth = responseAccounts.get(response)
    if (!auth || (response.status !== 401 && !admissionErrors.has(code))) return
    const record = await credentials.modifyRecord(key, async current => {
      const live = payload(current), row = selected(live)
      if (!row || row.session !== auth.session || row.tokens?.access !== auth.token) return undefined
      // A rejected request pauses use. Keep the renewable grant available for explicit revocation.
      return grant({ ...live, activeId: null, accounts: live.accounts.map(item => item.id === row.id ?
        { ...item, session: null, needsConsent: code === 'chatpass_v2_scope_not_authorized' } : item) })
    }).catch(error => {
      // Surface the upstream rejection to the caller even if its follow-up credential write fails.
      report('保存 ChatGPT 暂停连接状态失败', error, 'ACCOUNT_STORAGE_FAILED', storageHint)
      inform('OpenAI 未接受账号授权。DSH 未能保存连接状态，请检查本机凭据存储并重新连接。', 'error')
      return null
    })
    if (!record) return
    const live = payload(record)
    observe(live)
    if (!live.activeId) inform('OpenAI 未接受本次授权，已暂停使用此账号。请检查 ChatGPT 登录连接。', 'error')
  }
  async function request(path, body, auth) {
    const response = await fetcher(resource + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: auth.signal,
      headers: { ...attributionHeaders(), Authorization: 'Bearer ' + auth.token, ...(body && { 'Content-Type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }) })
    responseAccounts.set(response, auth)
    if (!response.ok) {
      const error = await upstreamError(response)
      await invalidateResponse(response, error.code)
      throw error
    }
    return response
  }
  async function listModels({ signal } = {}) {
    const auth = await access(signal)
    if (!auth) return []
    const response = await request('/models', null, auth)
    let catalog
    try { catalog = await response.json() }
    catch (error) { auth.signal.throwIfAborted(); if (!(error instanceof SyntaxError)) throw error }
    auth.signal.throwIfAborted()
    if (!Array.isArray(catalog?.models)) throw Object.assign(new Error('无法读取 ChatGPT 模型列表。'), {
      code: 'MODEL_CATALOG_INVALID', status: response.status, requestId: safeRequestId(response.headers.get('x-request-id')),
    })
    return catalog.models.filter(row => row?.visibility === 'list' && typeof row.slug === 'string' && row.slug)
  }
  async function respond(body, { signal } = {}) {
    const auth = await access(signal)
    if (!auth) throw disconnected()
    return request('/responses', { ...body, store: false, stream: true }, auth)
  }
  return { accountState, beginLogin, cancelLogin, signOut, listModels, respond, invalidateResponse }
}

export async function registerAccount(ctx, account) {
  const { register } = await import('./account-remote.js')
  return register(ctx, account)
}

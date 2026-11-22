import React, { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { remote } from './account-contract.js'
import styles from './account.css'
import openaiBlossom from './openai-blossom.png'

const welcomeKey = 'alcor-chatgpt-welcome-shown'
async function unwrap(promise) {
  const result = await promise
  if (!result.ok) throw new Error(result.error?.message || '账号操作未完成。')
  return result.value
}

export function ChatgptSettings({ api, subscribe }) {
  const [state, setState] = useState(null)
  const [selection, setSelection] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState(false)
  const [details, setDetails] = useState(false)
  const [browserUrl, setBrowserUrl] = useState('')
  const [welcome, setWelcome] = useState(false)
  const [revision, setRevision] = useState(0)
  const version = useRef(0)
  const pending = !!state?.pending
  useEffect(() => subscribe(() => setRevision(v => v + 1)), [subscribe])

  useEffect(() => {
    let active = true, timer
    const current = version.current
    async function refresh() {
      try {
        const value = await unwrap(api.accountState({}))
        if (!active || current !== version.current) return
        setLoadError(false)
        setState(value)
        if (!value.pending) setBrowserUrl('')
        setSelection(selected => selected === 'new' || value.accounts.some(row => row.id === selected) ? selected : value.activeId || value.accounts[0]?.id || 'new')
        if (value.pending) timer = setTimeout(refresh, 900)
      } catch { if (active && current === version.current) setLoadError(true) }
    }
    refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [api, pending, revision])

  const activeId = state?.activeId
  useEffect(() => {
    if (!activeId) return
    setSelection(activeId)
    try {
      if (!localStorage.getItem(welcomeKey)) {
        localStorage.setItem(welcomeKey, '1')
        setWelcome(true)
      }
    } catch { /* Welcome is optional when the client disallows local storage. */ }
  }, [activeId])
  async function act(operation) {
    setBusy(true); setError(''); version.current++
    try { await operation() } catch (failure) { setError(failure.message || '账号操作未完成。') }
    finally { setRevision(v => v + 1); setBusy(false) }
  }
  const chosen = state?.accounts.find(row => row.id === selection)
  const current = state?.accounts.find(row => row.id === activeId)
  async function connect() {
    const { browserUrl } = await unwrap(api.beginLogin(chosen ? { accountId: chosen.id } : {}))
    setBrowserUrl(browserUrl)
    // The signed desktop opens HTTP links in the system browser. Keep a link for blocked browser pop-ups.
    window.open(browserUrl, '_blank', 'noopener,noreferrer')
  }

  const status = pending ? '等待授权' : current?.connected ? '已连接' : state ? '未连接' : '正在读取'
  const feedback = loadError ? '无法读取账号状态。' : error || state?.notice
  const failed = loadError || !!error || state?.noticeKind === 'error'

  return <section className="alcor-chatgpt-account" aria-label="ChatGPT 套餐">
    <div className="plan-body">
      <div className="plan-heading">
        <span className="plan-symbol" aria-hidden="true" style={{ maskImage: `url("${openaiBlossom}")` }} />
        <div className="plan-identity">
          <h3>ChatGPT 套餐</h3>
          <span>与 Codex 共用订阅额度</span>
        </div>
        <span className="plan-status" data-state={pending ? 'pending' : current?.connected ? 'connected' : 'idle'} role="status">
          {loadError ? '状态未知' : status}
        </span>
      </div>
      {state?.accounts.length > 0 && <label className="plan-field">
        <span>账号或工作区</span>
        <select disabled={busy || pending || loadError} value={selection} onChange={e => { setError(''); setSelection(e.target.value) }}>
          {state.accounts.map(row => <option key={row.id} value={row.id}>
            {row.label}{state.accounts.some(other => other.id !== row.id && other.label === row.label) ? ` · ${row.id.slice(0, 8)}` : ''}{row.id === activeId && row.connected ? '（使用中）' : ''}
          </option>)}
          <option value="new">添加账号或工作区</option>
        </select>
      </label>}
      {feedback && !pending && <div className="plan-feedback" data-error={failed} role={failed ? 'alert' : 'status'}>
        {failed && <span className="plan-alert-symbol" aria-hidden="true">!</span>}
        <span>{feedback}</span>
        {loadError && <Button disabled={busy} variant="outline" onClick={() => setRevision(v => v + 1)}>重新加载</Button>}
      </div>}
      <div className="plan-actions">
        {!loadError && (pending ? <>
          {browserUrl && <a className="plan-button" href={browserUrl} target="_blank" rel="noreferrer">打开登录页面 <span aria-hidden="true">↗</span></a>}
          <Button disabled={busy} variant="outline" onClick={() => act(() => unwrap(api.cancelLogin({})))}>取消登录</Button>
        </> : <>
          {state && (!chosen?.connected || chosen.id !== activeId) &&
            <button type="button" className="alcor-chatgpt-login" data-oai-siwc-button="" disabled={busy} onClick={() => act(connect)}>Continue with ChatGPT</button>}
          {(chosen?.canSignOut ?? chosen?.connected) && <Button disabled={busy} variant="outline" onClick={() => act(() => unwrap(api.signOut({ accountId: chosen.id })))}>退出此账号</Button>}
        </>)}
        <a className="plan-button" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">管理用量 <span aria-hidden="true">↗</span></a>
      </div>
    </div>
    <div className="plan-footer">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 6v5.4c0 4.2 3.2 7.5 7.5 9.6 4.3-2.1 7.5-5.4 7.5-9.6V6Z"/><path d="m9 12 2 2 4-4"/></svg>
      <span>使用此模型时，对话和工具数据会发送给 OpenAI。</span>
      <button type="button" className="plan-details" onClick={() => setDetails(true)}>授权说明</button>
    </div>
    <Modal open={details} title="授权与用量" onClose={() => setDetails(false)}>
      <dl className="alcor-chatgpt-disclosure">
        <dt>模型访问</dt><dd>授权后，可在 Alcor 和 DSH 的对话中选择当前账号提供的模型。</dd>
        <dt>数据范围</dt><dd>使用 OpenAI 模型时，当轮请求包含的对话、附件和工具结果会发送给 OpenAI。</dd>
        <dt>套餐与积分</dt><dd>请求计入与 Codex 共用的 ChatGPT 额度。只有你在 ChatGPT 中另行允许时，才会使用额外积分。插件不会切换到 API 按量付费。</dd>
      </dl>
      <Button variant="primary" onClick={() => setDetails(false)}>关闭</Button>
    </Modal>
    <Modal open={welcome} title="已开始使用 ChatGPT 套餐" onClose={() => setWelcome(false)}>
      <p>通过 ChatGPT 模型发送的请求将使用你的套餐额度，可在 ChatGPT 用量设置中管理。</p>
      <Button variant="primary" onClick={() => setWelcome(false)}>知道了</Button>
    </Modal>
  </section>
}
export const inject = ['slots', 'remote']
export async function apply(ctx) {
  await ctx.remote.$mount(remote)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = styles
    document.head.append(style)
    return () => style.remove()
  })
  ctx.inject(['remote.alcorChatgpt'], inner => {
    const subscribe = fn => inner.remote.$on('llm/models-updated', fn)
    const inject = () => ({ api: inner.remote.alcorChatgpt, subscribe })
    inner.slots.inject('plugins.bundle.config', () => inner.slots.register({ name: 'plugins.bundle.config', key: '@alcor/chatgpt', inject }, ChatgptSettings))
    inner.slots.inject('settings.models.footer', () => inner.slots.register({ name: 'settings.models.footer', id: 'alcor-chatgpt-account', inject }, ChatgptSettings))
  })
}

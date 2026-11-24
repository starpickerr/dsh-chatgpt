import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const proxyEnvironment = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']

// CFNetwork applies the active network service and its per-host proxy exclusions.
const lookup = `ObjC.import('CFNetwork')
function run(args) {
  const settings = $.CFNetworkCopySystemProxySettings()
  const routes = $.CFNetworkCopyProxiesForURL($.NSURL.URLWithString(args[0]), settings)
  const route = ObjC.castRefToObject(routes).objectAtIndex(0)
  const value = key => ObjC.unwrap(route.objectForKey(key))
  return JSON.stringify({type: value('kCFProxyTypeKey'), host: value('kCFProxyHostNameKey'), port: value('kCFProxyPortNumberKey')})
}`

async function macSystemProxy(origin, signal) {
  const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', lookup, origin], {
    signal, timeout: 5000, maxBuffer: 8192,
  })
  const { type, host, port } = JSON.parse(stdout)
  if (type === 'kCFProxyTypeNone') return null
  if (!['kCFProxyTypeHTTP', 'kCFProxyTypeHTTPS'].includes(type)) {
    throw new Error('当前系统代理类型需要在 DSH 中配置 HTTP 或 HTTPS 代理。')
  }
  if (typeof host !== 'string' || !/^[\w.:[\]-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('无法读取系统 HTTP 代理的地址或端口。')
  }
  // For HTTPS destinations macOS's Secure Web Proxy is an HTTP CONNECT proxy.
  return new URL('http://' + (host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host) + ':' + port).origin
}

const windowsLookup = `
$ErrorActionPreference = 'Stop'
$target = [Uri]$env:ALCOR_CHATGPT_PROXY_ORIGIN
$proxy = [System.Net.WebRequest]::GetSystemWebProxy()
if (-not $proxy.IsBypassed($target)) { $proxy.GetProxy($target).AbsoluteUri }
`

async function windowsSystemProxy(origin, signal) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsLookup], {
    env: { ...process.env, ALCOR_CHATGPT_PROXY_ORIGIN: origin },
    windowsHide: true, signal, timeout: 5000, maxBuffer: 8192,
  })
  if (!stdout.trim()) return null
  const proxy = new URL(stdout.trim())
  if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password) {
    throw new Error('当前系统代理类型需要在 DSH 中配置 HTTP 或 HTTPS 代理。')
  }
  return proxy.origin
}

async function systemDispatcher(proxy, env) {
  const { createRouteDispatcher } = await import('@deepseek-ai/dsh-http-proxy')
  // The signed host runs Node's built-in fetch against the SDK's newer undici dispatcher ABI.
  const { Dispatcher1Wrapper } = createRequire(import.meta.resolve('@deepseek-ai/dsh-http-proxy'))('undici')
  const dispatcher = await createRouteDispatcher({ get(key) {
    const value = key === 'https_proxy' ? proxy : env[key]
    return value ? { value } : undefined
  } }, { allowH2: false })
  return new Dispatcher1Wrapper(dispatcher)
}

export function createPlanFetch(ctx, { platform = process.platform, env = process.env,
  resolve = platform === 'win32' ? windowsSystemProxy : macSystemProxy,
  dispatcher = systemDispatcher, fetch = globalThis.fetch } = {}) {
  const pools = new Map()
  ctx.effect(() => () => {
    for (const pool of pools.values()) pool.then(value => value.close()).catch(() => {})
    pools.clear()
  })
  return async (url, init) => {
    const origin = new URL(url).origin
    if (origin !== 'https://auth.openai.com' && origin !== 'https://api.openai.com') throw new Error('无效的 OpenAI 地址。')
    const options = { ...init, redirect: 'error', credentials: 'omit' }
    options.signal?.throwIfAborted()
    // When DSH has a launch proxy it already installs its own global dispatcher and bypass rules.
    if (!['darwin', 'win32'].includes(platform) || proxyEnvironment.some(key => env[key]?.trim())) return fetch(url, options)
    try {
      const proxy = await resolve(origin, options.signal)
      options.signal?.throwIfAborted()
      if (proxy) {
        let pool = pools.get(proxy)
        if (!pool) {
          pool = dispatcher(proxy, env).catch(error => {
            pools.delete(proxy)
            throw error
          })
          pools.set(proxy, pool)
        }
        options.dispatcher = await pool
      }
    } catch (cause) {
      options.signal?.throwIfAborted()
      throw Object.assign(new Error('无法初始化系统代理，请检查代理设置。', { cause }), { code: 'PROXY_SETUP_FAILED' })
    }
    return fetch(url, options)
  }
}

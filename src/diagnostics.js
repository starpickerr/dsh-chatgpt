import { isPlanErrorCode, publicError, safeParameter, safeRequestId } from './account-errors.js'

const reported = new WeakSet()
const networkHint = '检查网络和 DSH 的代理设置后重试。'
const timeoutHint = '连接或读取超时，请检查网络及代理后重试。'
const tlsHint = '检查系统时间、代理证书和证书信任设置。'
const hints = new Map([
  ...['ENOTFOUND', 'EAI_AGAIN'].map(code => [code, '域名解析失败，请检查网络和 DNS 设置。']),
  ...['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_SOCKET'].map(code => [code, networkHint]),
  ...['TIMEOUT', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].map(code => [code, timeoutHint]),
  ...['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].map(code => [code, tlsHint]),
  ['PROXY_SETUP_FAILED', '无法读取或使用系统代理，请检查系统网络设置或在 DSH 中配置 HTTP 代理。'],
  ['AUTH', '账号连接状态已更改，请确认已登录并重新选择模型。'],
  ['UNKNOWN_MODEL', '请刷新模型列表并选择当前账号可用的模型。'],
  ['UNSUPPORTED_CONTENT', '请检查本轮附件与消息类型，或使用支持该输入的模型。'],
  ['CONTEXT_WINDOW_EXCEEDED', '请缩短输入或新建对话。'],
  ['EMPTY_RESPONSE', '上游返回空响应，请重试；反复出现时可更换模型。'],
  ['INVALID_RESPONSE', '响应格式无法解析，请重试并检查模型与插件版本。'],
  ['INCOMPLETE_RESPONSE', '模型未完成响应，请重试并检查模型限制。'],
  ['STREAM_CLOSED', '响应流在完成前断开，请检查网络和代理后重试。'],
  ['PROVIDER_ERROR', '请核对账号及模型状态后重试。'],
  ['MODEL_CATALOG_INVALID', '模型列表格式无法解析，请刷新列表并检查插件版本。'],
])
const identityCodes = new Set(['ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_INVALID', 'ERR_JWS_INVALID', 'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_INVALID', 'ERR_JOSE_ALG_NOT_ALLOWED'])

// Only trusted codes and operator-authored hints cross into the queryable host log.
function causeCode(error) {
  for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
    if (hints.has(error.code) || identityCodes.has(error.code) || isPlanErrorCode(error.code)) return error.code
    if (error.name === 'TimeoutError') return 'TIMEOUT'
  }
}

export function reportFailure(ctx, stage, error, fallbackCode, hint, level = 'error', response) {
  try {
    if (reported.has(error)) return
    const status = response?.status ?? error?.status
    const code = causeCode(error) ?? fallbackCode
    const fields = [stage]
    if (Number.isInteger(status) && status >= 100 && status <= 599) fields.push('HTTP ' + status)
    fields.push(code)
    const param = safeParameter(error?.param)
    if (param) fields.push('参数 ' + param)
    const id = safeRequestId(response?.headers.get('x-request-id') ?? error?.requestId)
    if (id) fields.push('请求 ID ' + id)
    const recovery = hints.get(code) ?? (isPlanErrorCode(code) ? publicError(code).message : undefined)
    fields.push(recovery ?? hint)
    ctx.logger('ChatGPT')[level](fields.join(' · '))
    if (error && typeof error === 'object') reported.add(error)
  } catch { /* The diagnostic sink is best effort. */ }
}

const terminal = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])
const errors = {
  context_length_exceeded: '对话超过模型上下文长度，请缩短输入或新建对话。',
  model_not_found: '当前账号无法使用所选模型，请刷新列表并重新选择。',
  invalid_value: '请求参数值不受支持，请检查模型设置和插件版本。',
  unsupported_value: '模型不支持此参数值，请检查模型设置和插件版本。',
  unsupported_parameter: '模型不支持此请求参数，请检查模型设置和插件版本。',
  missing_required_parameter: '请求缺少必要参数，请检查插件版本。',
  unsupported_reasoning_effort: '所选模型不支持这个推理强度。请在模型选择器中更换强度后重试。',
  subscription_sharing_usage_limit_exceeded: '已达到 ChatGPT 用量上限，请在 ChatGPT 用量设置查看。',
  subscription_sharing_user_not_eligible: '当前 ChatGPT 账号或工作区不能共享套餐。',
  subscription_sharing_usage_unavailable: 'OpenAI 暂时无法查询套餐用量，请稍后重试。',
  subscription_sharing_unsupported_capability: '当前 ChatGPT 套餐不支持这项请求。',
  chatpass_v2_scope_not_authorized: '此账号未授权使用 ChatGPT 套餐。',
  subscription_sharing_user_unavailable: 'OpenAI 暂时无法查询账号或工作区，请稍后重试。',
  subscription_sharing_route_not_supported: 'OpenAI 套餐不支持此请求接口。',
  chatpass_v2_invalid_authorization_context: 'OpenAI 未接受此账号的套餐授权，请重新连接。',
  subscription_sharing_invalid_user: 'OpenAI 无法验证此账号，请检查 ChatGPT 登录连接。',
}
export const isPlanErrorCode = code => typeof code === 'string' && Object.hasOwn(errors, code)

export function safeRequestId(value) {
  return typeof value === 'string' && /^req_[A-Za-z0-9_-]{1,120}$/.test(value) ? value : undefined
}

export function safeParameter(value) {
  // JSON paths may contain user-authored property names. Only expose known protocol fields.
  return typeof value === 'string' && /^(?:model|input|instructions|store|stream|reasoning(?:\.effort)?|tools(?:\[\d{1,3}\])?(?:\.(?:name|type|parameters))?)$/.test(value) ? value : undefined
}

export function publicError(code, status, param) {
  if (param === 'reasoning.effort' && (code === 'invalid_value' || code === 'unsupported_value')) {
    code = 'unsupported_reasoning_effort'
  }
  const known = isPlanErrorCode(code)
  const message = known ? errors[code] : ({
    401: 'OpenAI 未接受当前授权，请重新连接 ChatGPT。',
    403: 'OpenAI 拒绝了此请求，请检查账号授权、工作区或地区限制。',
    429: 'ChatGPT 请求受到限制，请稍后重试或查看用量。',
  })[status] ?? 'OpenAI 请求未完成，请稍后重试。'
  const error = new Error(status ? `${message}（HTTP ${status}）` : message)
  if (status) error.status = status
  if (known) error.code = code
  if (safeParameter(param)) error.param = param
  error.terminal = terminal.has(code)
  return error
}

export async function upstreamError(response) {
  const body = await response.json().catch(() => ({}))
  const code = typeof body?.error === 'string' ? body.error : body?.error?.code
  const error = publicError(code, response.status, body?.error?.param)
  const requestId = safeRequestId(response.headers.get('x-request-id'))
  if (requestId) error.requestId = requestId
  return error
}

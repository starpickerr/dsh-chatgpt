import { createHash } from 'node:crypto'
import {
  LlmAdapter, LlmError, offloadedImageText, requestImageHandleText, resolveImageAttachmentAccess,
} from '@deepseek-ai/dsh-llm'
import { responseChunks } from './response-stream.js'
import { isPlanErrorCode, safeRequestId } from './account-errors.js'

const provider = 'alcor-chatgpt'
const namespace = 'dsh'
// In ascending order. The ChatGPT catalog can also report levels outside the Responses wire enum.
const responseEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const localErrorCodes = new Set(['AUTH', 'UNKNOWN_MODEL', 'UNSUPPORTED_CONTENT', 'CONTEXT_WINDOW_EXCEEDED',
  'EMPTY_RESPONSE', 'INCOMPLETE_RESPONSE', 'INVALID_RESPONSE', 'PROVIDER_ERROR', 'STREAM_CLOSED'])

function logOutcome(ctx, level, outcome, model, requested, effective, response, error) {
  try {
    const safeModel = typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model) ? model : '未知'
    const effort = requested == null ? '自动' : requested === 'ultra' || responseEfforts.includes(requested) ? requested : '其他'
    const applied = effective ?? '自动'
    const fields = [outcome, '模型 ' + safeModel, '推理强度 ' + (effort === applied ? effort : effort + ' → ' + applied)]
    const status = response?.status ?? error?.status
    if (Number.isInteger(status) && status >= 100 && status <= 599) fields.push('HTTP ' + status)
    if (level === 'error') {
      const code = error?.code
      fields.push(isPlanErrorCode(code) || localErrorCodes.has(code) ? code : 'REQUEST_FAILED')
    }
    const id = safeRequestId(response?.headers.get('x-request-id') ?? error?.requestId)
    if (id) fields.push('请求 ID ' + id)
    ctx.logger('ChatGPT')[level](fields.join(' · '))
  } catch { /* Diagnostics must not interrupt the conversation. */ }
}

function wireName(name) {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name) && !name.startsWith('dshx_')) return name
  const readable = name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 34)
  return 'dshx_' + readable + '_' + createHash('sha256').update(name).digest('base64url').slice(0, 24)
}

function catalogEntry(model) {
  const info = { provider, id: model.slug, name: model.display_name || model.slug }
  if (typeof model.description === 'string') info.description = model.description
  if (Array.isArray(model.input_modalities)) {
    info.inputModalities = [...new Set(model.input_modalities.filter(value => value === 'text' || value === 'image'))]
  }
  if (Number.isSafeInteger(model.context_window) && model.context_window > 0) {
    info.context = { contextWindow: model.context_window }
  }
  const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []
  const advertised = new Set(levels.map(level => level?.effort).filter(value => typeof value === 'string' && value))
  const available = responseEfforts.filter(effort => advertised.has(effort))
  if (available.length) {
    const defaultEffort = model.default_reasoning_level === 'ultra' ? available.at(-1) : model.default_reasoning_level
    info.reasoning = { efforts: available.map(id => ({ id, name: id })) }
    if (available.includes(defaultEffort)) info.reasoning.defaultEffort = defaultEffort
  }
  // DSH validates persisted selections before invoking the adapter. Admit old IDs at
  // dispatch, while resolveModel exposes only currently selectable levels to the picker.
  const savedIds = new Set([...responseEfforts, 'ultra', ...advertised])
  const dispatchModel = { ...info, reasoning: { ...info.reasoning, efforts: [...savedIds].map(id => ({ id, name: id })) } }
  return { info, dispatchModel }
}

function wireEffort(requested, reasoning) {
  if (requested === undefined || !reasoning) return undefined
  if (requested === 'ultra') return reasoning.efforts.at(-1).id
  return reasoning.efforts.some(effort => effort.id === requested) ? requested : reasoning.defaultEffort
}

function assistantItems(message, model) {
  const replay = message.source?.provider === provider && message.source.model === model
    ? message.source.replayState?.blocks : undefined
  return message.content.flatMap((block, index) => {
    const meta = replay?.[index]
    if (block.type === 'reasoning') {
      if (typeof meta?.encrypted_content !== 'string') return []
      return [{ type: 'reasoning', id: meta.id, encrypted_content: meta.encrypted_content,
        summary: block.text ? [{ type: 'summary_text', text: block.text }] : [] }]
    }
    if (block.type === 'tool-call') {
      return [{ type: 'function_call', namespace, name: wireName(block.name),
        arguments: block.arguments, call_id: block.id, ...(meta?.id && { id: meta.id }) }]
    }
    if (block.type === 'text') {
      const phase = meta?.phase
      return [{ role: 'assistant', content: block.text, ...(phase === 'commentary' || phase === 'final_answer' ? { phase } : {}) }]
    }
    throw new LlmError('ChatGPT 无法读取这条历史助手消息的内容。', 'UNSUPPORTED_CONTENT')
  })
}

async function inputParts(ctx, blocks, signal) {
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      const store = ctx.get('attachments')
      const ref = block.attachment
      const access = store && resolveImageAttachmentAccess(store, path => ctx.get('fs')?.processPathFromHostPath(path), ref)
      if (block.offloaded) {
        parts.push({ type: 'input_text', text: offloadedImageText(ref, access) })
        continue
      }
      if (!store) throw new LlmError('DSH 附件服务未连接，无法读取本轮图片。', 'UNSUPPORTED_CONTENT')
      const file = await store.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: ref.bytes }, signal)
      parts.push({ type: 'input_text', text: requestImageHandleText(ref, file, access) })
      parts.push({ type: 'input_image', image_url: `data:${file.mediaType};base64,${Buffer.from(file.data).toString('base64')}` })
    } else {
      throw new LlmError('ChatGPT 无法读取这条消息的内容。', 'UNSUPPORTED_CONTENT')
    }
  }
  return parts
}

async function requestBody(ctx, options) {
  const input = []
  for (const message of options.messages) {
    options.signal?.throwIfAborted()
    if (message.role === 'assistant') {
      input.push(...assistantItems(message, options.model))
      continue
    }
    const parts = await inputParts(ctx, message.content, options.signal)
    if (message.role === 'tool') {
      if (message.isError) parts.unshift({ type: 'input_text', text: 'Tool execution failed.\n' })
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: parts.length ? parts : '' })
    } else if (parts.length) {
      input.push({ role: message.role === 'system' ? 'developer' : message.role, content: parts })
    }
  }
  const tools = (options.tools ?? []).map(tool => ({
    type: 'function', name: wireName(tool.name), description: tool.description, parameters: tool.parameters, strict: false,
  }))
  return {
    model: options.model, store: false, stream: true, input,
    ...(options.system && { instructions: options.system }),
    ...(options.reasoningEffort && { reasoning: { effort: options.reasoningEffort } }),
    ...(tools.length && { tools: [{ type: 'namespace', name: namespace, description: 'Tools available in this DSH conversation.', tools }] }),
  }
}

export function registerProvider(ctx, account) {
  let catalog
  let generation = new AbortController()
  ctx.on('llm/models-updated', id => {
    if (id === provider) {
      catalog = undefined
      generation.abort(new LlmError('ChatGPT 登录状态已更改，请重试。', 'AUTH'))
      generation = new AbortController()
    }
  })
  async function load(signal) {
    const started = generation
    const entries = (await account.listModels({ signal })).map(catalogEntry)
    if (generation !== started) throw new LlmError('ChatGPT 登录状态已更改，请重新选择模型。', 'AUTH')
    catalog = new Map(entries.map(entry => [entry.info.id, entry]))
    return entries.map(entry => entry.info)
  }
  async function lookup(model, signal) {
    if (!catalog) await load(signal)
    const entry = catalog?.get(model)
    if (!entry) throw new LlmError('当前 ChatGPT 账号未提供此模型，请检查登录状态并重新选择。', 'UNKNOWN_MODEL')
    return entry
  }
  class ChatGPTAdapter extends LlmAdapter {
    providerInfo() { return { id: provider, name: 'ChatGPT' } }
    listModels() { return load() }
    async resolveModel(_provider, model, signal) {
      return (await lookup(model, signal)).info
    }
    async prepareCall(_provider, model, signal) {
      const prepared = generation
      const { info, dispatchModel } = await lookup(model, signal)
      return { model: dispatchModel, stream: options => this.stream(options, prepared, info) }
    }
    async *stream(options, prepared = generation, boundModel) {
      // Credential lookup is asynchronous; a change during lookup must also cancel this prepared call.
      const signal = options.signal ? AbortSignal.any([options.signal, prepared.signal]) : prepared.signal
      let info = boundModel, effective, response
      let logged = false
      const record = (level, outcome, error) => {
        logged = true
        logOutcome(ctx, level, outcome, info?.id, options.reasoningEffort, effective, response, error)
      }
      try {
        signal.throwIfAborted()
        info ??= await this.resolveModel(provider, options.model, signal)
        effective = wireEffort(options.reasoningEffort, info.reasoning)
        const body = await requestBody(ctx, { ...options, signal, reasoningEffort: effective })
        signal.throwIfAborted()
        const names = new Map((options.tools ?? []).map(tool => [wireName(tool.name), tool.name]))
        response = await account.respond(body, { signal })
        for await (const chunk of responseChunks(response, namespace, names, signal)) {
          if (chunk.type === 'finish') {
            // The host may stop iterating immediately after this terminal chunk.
            if (chunk.reason.kind === 'max-tokens') record('warn', '模型输出已达长度上限')
            else record('info', chunk.reason.kind === 'tool-calls' ? '模型请求完成（等待工具结果）' : '模型请求完成')
          }
          yield chunk
        }
      } catch (error) {
        if (!logged && !options.signal?.aborted) record('error', '模型请求失败', error)
        if (response && typeof error?.code === 'string') await account.invalidateResponse(response, error.code)
        if (!response && Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) {
          throw new LlmError(error.message, error.code ?? `HTTP_${error.status}`, {
            status: error.status, ...(error.requestId && { requestId: error.requestId }),
          })
        }
        throw error
      } finally {
        if (!logged) record('info', '模型请求已取消')
      }
    }
  }
  return ctx.llm.registerAdapter([provider], new ChatGPTAdapter())
}

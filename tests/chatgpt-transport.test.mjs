import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlanFetch } from '../src/transport.js'

const endpoint = 'https://api.openai.com/v1/models'
function fixture(overrides = {}) {
  const routes = [], created = [], closed = [], calls = []
  let dispose, selected
  const fetch = createPlanFetch({ effect(fn) { dispose = fn() } }, {
    platform: 'darwin', env: {},
    async resolve(origin) { routes.push(origin); return selected },
    async dispatcher(proxy) {
      created.push(proxy)
      return { proxy, async close() { closed.push(proxy) } }
    },
    async fetch(url, init) { calls.push({ url, init }); return Response.json({}) },
    ...overrides,
  })
  return { routes, created, closed, calls, fetch, dispose, route(proxy) { selected = proxy } }
}

test('plan transport follows network changes and bypasses, sharing only matching proxy pools', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  f.route('http://first.invalid')
  await Promise.all([f.fetch(endpoint, { signal }), f.fetch(endpoint, { signal })])
  assert.deepEqual(f.created, ['http://first.invalid'])
  assert.equal(f.calls[0].init.signal, signal)
  assert.equal(f.calls[0].init.dispatcher, f.calls[1].init.dispatcher)
  f.route(null)
  await f.fetch(endpoint)
  assert.equal(f.calls[2].init.dispatcher, undefined)
  f.route('http://second.invalid')
  await f.fetch(endpoint)
  assert.equal(f.calls[3].init.dispatcher.proxy, 'http://second.invalid')
  assert.deepEqual(f.routes, Array(4).fill('https://api.openai.com'))
  f.dispose()
  await Promise.resolve()
  assert.deepEqual(f.closed.sort(), f.created.sort())
})

test('host proxy and other platforms retain their DSH transport and cookie-free redirect policy', async () => {
  for (const options of [{ env: { HTTPS_PROXY: 'http://configured.invalid' } }, { platform: 'win32' }]) {
    const f = fixture(options)
    await f.fetch(endpoint, { redirect: 'follow', credentials: 'include' })
    assert.equal(f.calls[0].init.redirect, 'error')
    assert.equal(f.calls[0].init.credentials, 'omit')
    assert.deepEqual(f.routes, [])
  }
})

test('unexpected destinations, failed route lookups and aborted requests never send credentials', async () => {
  const failure = fixture({ async resolve() { throw new Error('lookup failed') } })
  await assert.rejects(failure.fetch('https://example.invalid'), /无效/)
  await assert.rejects(failure.fetch(endpoint), /lookup failed/)
  assert.deepEqual(failure.calls, [])
  const f = fixture()
  await assert.rejects(f.fetch(endpoint, { signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.deepEqual(f.calls, [])
})

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createApp } from '../src/app.js'
import { OpenGymApi } from '../src/opengym/api.js'
import { MemoryStore } from '../src/storage/store.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export const origin = 'https://mcp.example.test'
export const clone = structuredClone
export function state(name = 'Test routine') {
  return { unit: 'kg', routines: [{ id: 'routine-a', name, ex: [] }], workouts: [], bodyweight: [], customEx: [], week: {}, dayPlan: {}, unrelated: { preserved: true }, _rev: 1, _wid: 'initial' }
}
export async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
// Pass openGymPublicUrl (including null) to override the link target the pages use.
export async function fixture(t, { store = new MemoryStore(), fetchImpl, trustProxyHops = 0, openGymPublicUrl } = {}) {
  const profiles = new Map([['test-a', { user: { id: 'user-a', name: 'Test A' }, state: state('A routine'), rev: 1 }], ['test-b', { user: { id: 'user-b', name: 'Test B' }, state: state('B routine'), rev: 1 }]])
  const codes = new Map()
  const counters = { puts: 0, pairs: 0, conflict: false, uncertain: false }
  // Authorization headers the fake openGym API received, kept only in memory so tests can
  // assert that a credential never reached it. Never print or log these.
  const seenAuthorizations = []
  const upstream = await listen(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (req.headers.authorization) seenAuthorizations.push(req.headers.authorization)
    const parts = []; for await (const part of req) parts.push(part)
    const body = parts.length ? JSON.parse(Buffer.concat(parts)) : {}
    if (req.url === '/api/pair/redeem' && req.method === 'POST') {
      counters.pairs++
      const token = codes.get(body.code); codes.delete(body.code)
      return token ? reply(200, { token, user: profiles.get(token).user }) : reply(400, { error: 'invalid code' })
    }
    const profile = profiles.get(String(req.headers.authorization || '').replace(/^Bearer /, ''))
    if (!profile) return reply(401, { error: 'not signed in' })
    if (req.url === '/api/me') return reply(200, { user: profile.user })
    if (req.url === '/api/data' && req.method === 'GET') return reply(200, { state: profile.state, rev: profile.rev })
    if (req.url === '/api/data' && req.method === 'PUT') {
      counters.puts++
      if (counters.conflict) {
        counters.conflict = false
        profile.state.fromAnotherDevice = 'preserve this concurrent edit'
        profile.rev++
      }
      if (body.baseRev !== profile.rev) return reply(409, { state: profile.state, rev: profile.rev })
      profile.rev++
      profile.state = { ...body.state, _rev: profile.rev, _wid: randomUUID() }
      if (counters.uncertain) { counters.uncertain = false; req.socket.destroy(); return }
      return reply(200, { ok: true, rev: profile.rev })
    }
    reply(404, { error: 'unknown route' })
  })
  const api = new OpenGymApi(upstream.base)
  const service = createApp({ origin, api, store, rateLimits: false, fetchImpl, trustProxyHops, ...(openGymPublicUrl === undefined ? {} : { openGymPublicUrl }) })
  const web = await listen(service.app)
  t.after(async () => { await web.close(); await upstream.close() })
  return { ...service, ...web, upstream, profiles, codes, counters, seenAuthorizations }
}
export async function clientFor(t, f, token = 'test-a') {
  const client = new Client({ name: 'integration-test-agent', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }))
  t.after(() => client.close())
  return client
}
export async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  return { ...result, value: result.structuredContent || JSON.parse(result.content[0].text) }
}

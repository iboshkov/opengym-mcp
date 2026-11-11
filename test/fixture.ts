import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createApp } from '../src/app.ts'
import type { AppOptions } from '../src/app.ts'
import { OpenGymApi } from '../src/opengym/api.ts'
import { MemoryStore } from '../src/storage/store.ts'
import type { Store } from '../src/storage/store.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export const origin = 'https://mcp.example.test'
export const clone = structuredClone

/** A workout as the fake openGym API stores it; only the fields the tests read are named. */
export interface WorkoutRecord {
  d: string
  start: number
  end: number
  entries: { sets: { r: number, w: number }[] }[]
  [key: string]: unknown
}
export interface BodyweightDay {
  ins: { id: string, w: number }[]
  [key: string]: unknown
}
/** The profile document held by the fake openGym API. Unnamed fields are kept as-is. */
export interface TestState {
  unit: string
  routines: { id: string, name: string, ex: unknown[] }[]
  workouts: WorkoutRecord[]
  bodyweight: BodyweightDay[]
  customEx: unknown[]
  week: Record<string, unknown>
  dayPlan: Record<string, unknown>
  unrelated: { preserved: boolean }
  _rev: number
  _wid: string
  fromAnotherDevice?: string
  [key: string]: unknown
}
export interface FakeProfile {
  user: { id: string, name: string }
  state: TestState
  rev: number
}
/** Switches the tests flip to make the fake API misbehave once. */
export interface Counters {
  puts: number
  pairs: number
  conflict: boolean
  uncertain: boolean
}
export interface Listener {
  server: http.Server
  base: string
  close: () => Promise<void>
}
export interface FixtureOptions {
  store?: Store
  fetchImpl?: AppOptions['fetchImpl']
  trustProxyHops?: number
  /** Pass a value (including null) to override the link target the pages use. */
  openGymPublicUrl?: string | null
}
/** What `fixture` needs from a test context; node:test's `t` and the Playwright shim both fit. */
export interface Cleanup {
  after: (fn: () => unknown) => void
}
export interface Fixture extends Listener, ReturnType<typeof createApp> {
  upstream: Listener
  profiles: Map<string, FakeProfile>
  /** Pairing code to the profile token it redeems. */
  codes: Map<string, string>
  counters: Counters
  /** Authorization headers the fake API received. In memory only; never print them. */
  seenAuthorizations: string[]
}
export interface ToolCall {
  isError?: boolean
  content: { type: string, text: string }[]
  _meta?: Record<string, unknown>
  /**
   * The tool's JSON output. Left loose on purpose: it is whatever the tool under test
   * returns and each test asserts on the fields it cares about.
   */
  value: any
}

export function state(name = 'Test routine'): TestState {
  return { unit: 'kg', routines: [{ id: 'routine-a', name, ex: [] }], workouts: [], bodyweight: [], customEx: [], week: {}, dayPlan: {}, unrelated: { preserved: true }, _rev: 1, _wid: 'initial' }
}
export async function listen(handler: http.RequestListener): Promise<Listener> {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
export async function fixture(t: Cleanup, { store = new MemoryStore(), fetchImpl, trustProxyHops = 0, openGymPublicUrl }: FixtureOptions = {}): Promise<Fixture> {
  const profiles = new Map<string, FakeProfile>([['test-a', { user: { id: 'user-a', name: 'Test A' }, state: state('A routine'), rev: 1 }], ['test-b', { user: { id: 'user-b', name: 'Test B' }, state: state('B routine'), rev: 1 }]])
  const codes = new Map<string, string>()
  const counters: Counters = { puts: 0, pairs: 0, conflict: false, uncertain: false }
  // Authorization headers the fake openGym API received, kept only in memory so tests can
  // assert that a credential never reached it. Never print or log these.
  const seenAuthorizations: string[] = []
  const upstream = await listen(async (req, res) => {
    const reply = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (req.headers.authorization) seenAuthorizations.push(req.headers.authorization)
    const parts: Buffer[] = []; for await (const part of req) parts.push(part as Buffer)
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}
    if (req.url === '/api/pair/redeem' && req.method === 'POST') {
      counters.pairs++
      const token = codes.get(body.code); codes.delete(body.code)
      return token ? reply(200, { token, user: profiles.get(token)!.user }) : reply(400, { error: 'invalid code' })
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
export async function clientFor(t: Pick<Cleanup, 'after'>, f: Pick<Listener, 'base'>, token = 'test-a'): Promise<Client> {
  const client = new Client({ name: 'integration-test-agent', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }))
  t.after(() => client.close())
  return client
}
export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as ToolCall['content']
  return { ...(result as Omit<ToolCall, 'value'>), value: result.structuredContent || JSON.parse(content[0].text) }
}
/** The text of the first content block of a raw `callTool` result. */
export function textOf(result: object): string {
  return ((result as { content: unknown }).content as ToolCall['content'])[0].text
}

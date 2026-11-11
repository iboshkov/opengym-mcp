import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixture, clientFor, call, origin } from './fixture.ts'
import type { Fixture } from './fixture.ts'
import { EncryptedStore } from '../src/storage/store.ts'
import { OpenGymAuth } from '../src/oauth/provider.ts'

const post = (url: string, body: Record<string, string>, extra: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams(body), redirect: 'manual' })
interface RegisteredClient { client_id: string, client_secret?: string, client_name?: string, token_endpoint_auth_method?: string, redirect_uris: string[] }
interface Tokens { access_token: string, refresh_token: string, scope: string }
async function register(f: Fixture, extra: Record<string, unknown> = {}): Promise<RegisteredClient> {
  const response = await fetch(f.base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test OAuth agent', redirect_uris: ['http://127.0.0.1:43210/callback'], token_endpoint_auth_method: 'none', ...extra }) })
  assert.equal(response.status, 201)
  return response.json() as Promise<RegisteredClient>
}
async function authorize(f: Fixture, client: RegisteredClient, { write = true, redirectUri = client.redirect_uris[0] }: { write?: boolean, redirectUri?: string } = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: origin + '/mcp', scope: 'opengym:read opengym:write', state: 'state-preserved' })
  const response = await fetch(f.base + '/authorize?' + query)
  assert.equal(response.status, 200)
  const text = await response.text(), cookie = response.headers.get('set-cookie')!.split(';')[0]
  assert.match(response.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Lax/)
  const ticket = /name="ticket" value="([^"]+)"/.exec(text)![1]
  f.codes.set('TESTCODE', 'test-a')
  const consent = await post(f.base + '/consent', { ticket, code: 'TESTCODE', decision: 'allow', ...(write ? { allow_write: 'yes' } : {}) }, { origin, cookie })
  assert.equal(consent.status, 302)
  const callback = new URL(consent.headers.get('location')!)
  assert.equal(callback.searchParams.get('iss'), origin)
  assert.equal(callback.searchParams.get('state'), 'state-preserved')
  assert.equal(callback.origin + callback.pathname, new URL(redirectUri).origin + new URL(redirectUri).pathname)
  return { verifier, code: callback.searchParams.get('code')!, cookie, ticket, redirectUri }
}
async function exchange(f: Fixture, client: RegisteredClient, authorization: { code: string, verifier: string, redirectUri?: string }, extra: Record<string, string> = {}) {
  return post(f.base + '/token', { grant_type: 'authorization_code', client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), code: authorization.code, code_verifier: authorization.verifier, redirect_uri: authorization.redirectUri || client.redirect_uris[0], resource: origin + '/mcp', ...extra })
}

test('unauthenticated MCP requests are challenged before disclosing tools or profile data', async t => {
  const f = await fixture(t)
  for (const method of ['GET', 'POST']) {
    const response = await fetch(f.base + '/mcp', { method })
    assert.equal(response.status, 401)
    assert.match(response.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/)
  }
  const metadata = await (await fetch(f.base + '/.well-known/oauth-authorization-server')).json() as { issuer: string, authorization_response_iss_parameter_supported: boolean, code_challenge_methods_supported: string[] }
  const resource = await (await fetch(f.base + '/.well-known/oauth-protected-resource/mcp')).json() as { resource: string }
  assert.equal(metadata.issuer, origin)
  assert.equal(metadata.authorization_response_iss_parameter_supported, true)
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'))
  assert.equal(resource.resource, origin + '/mcp')
})

test('authorization requires a bound browser cookie and same-origin consent', async t => {
  const f = await fixture(t), client = await register(f)
  const verifier = randomBytes(32).toString('base64url')
  const url = new URL(f.base + '/authorize')
  Object.entries({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: origin + '/mcp' }).forEach(([k,v]) => url.searchParams.set(k,v))
  const response = await fetch(url), text = await response.text()
  const ticket = /name="ticket" value="([^"]+)"/.exec(text)![1], cookie = response.headers.get('set-cookie')!.split(';')[0]
  assert.equal((await post(f.base + '/consent', { ticket, code: 'TESTCODE', decision: 'allow' }, { origin })).status, 400)
  assert.equal((await post(f.base + '/consent', { ticket, code: 'TESTCODE', decision: 'allow' }, { origin: 'https://attacker.example', cookie })).status, 400)
  assert.equal((await post(f.base + '/consent', { ticket, code: 'TESTCODE', decision: 'allow' }, { origin: 'null', cookie })).status, 400)
  assert.equal((await post(f.base + '/consent', { ticket, code: 'TESTCODE', decision: 'allow' }, { cookie })).status, 400)
  assert.equal(f.counters.pairs, 0)
  const badOrigin = await fetch(f.base + '/mcp', { headers: { origin: 'https://attacker.example', authorization: 'Bearer test-a' } })
  assert.equal(badOrigin.status, 403)
})

test('OAuth enforces PKCE, resource, client and redirect binding, plus one-use codes', async t => {
  const f = await fixture(t), client = await register(f), a = await authorize(f, client)
  assert.equal((await exchange(f, client, a, { code_verifier: 'wrong-verifier' })).status, 400)
  assert.equal((await exchange(f, client, a, { resource: 'https://another.example/mcp' })).status, 400)
  const other = await register(f)
  assert.equal((await exchange(f, other, a)).status, 400)
  const response = await exchange(f, client, a)
  assert.equal(response.status, 200)
  const tokens = await response.json() as Tokens
  assert.equal(tokens.scope, 'opengym:read opengym:write')
  assert.equal((await exchange(f, client, a)).status, 400)
  const mcp = await clientFor(t, f, tokens.access_token)
  assert.equal((await call(mcp, 'get_profile')).value.profile.id, 'user-a')
})

test('a read-only OAuth grant cannot write, and password-style DCR clients work', async t => {
  const f = await fixture(t), client = await register(f, { token_endpoint_auth_method: 'client_secret_post' }), a = await authorize(f, client, { write: false })
  const response = await exchange(f, client, a), tokens = await response.json() as Tokens
  assert.equal(response.status, 200)
  const mcp = await clientFor(t, f, tokens.access_token)
  const denied = await mcp.callTool({ name: 'create_routine', arguments: { name: 'Must not exist' } })
  assert.equal(denied.isError, true)
  assert.ok(denied._meta!['mcp/www_authenticate'])
  assert.equal(f.counters.puts, 0)
})

test('refresh tokens rotate, replay revokes the grant, and upstream revocation is honored', async t => {
  const f = await fixture(t), client = await register(f), a = await authorize(f, client)
  const tokens = await (await exchange(f, client, a)).json() as Tokens
  const refreshBody = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: origin + '/mcp' }
  const rotated = await (await post(f.base + '/token', refreshBody)).json() as Tokens
  assert.ok(rotated.access_token)
  assert.equal((await post(f.base + '/token', refreshBody)).status, 400)
  assert.equal((await fetch(f.base + '/mcp', { headers: { authorization: 'Bearer ' + rotated.access_token } })).status, 401)
  f.profiles.delete('test-a')
  assert.equal((await fetch(f.base + '/mcp', { headers: { authorization: 'Bearer test-a' } })).status, 401)
})

test('encrypted authorization store survives reload, hides secrets, and rejects the wrong key', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-mcp-test-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const file = path.join(temp, 'state.enc'), key = path.join(temp, 'key')
  fs.writeFileSync(key, randomBytes(32))
  const store = new EncryptedStore(file, key)
  const f = await fixture(t, { store }), client = await register(f), a = await authorize(f, client)
  const tokens = await (await exchange(f, client, a)).json() as Tokens
  const encrypted = fs.readFileSync(file, 'utf8')
  assert.equal(encrypted.includes('test-a'), false)
  assert.equal(encrypted.includes(tokens.access_token), false)
  const reloaded = new EncryptedStore(file, key)
  assert.equal(Object.keys(reloaded.data.grants).length, 1)
  assert.equal(reloaded.data.clients[client.client_id].client_id, client.client_id)
  const restartedAuth = new OpenGymAuth({ origin, api: f.api, store: reloaded })
  assert.equal(((await restartedAuth.verifyAccessToken(tokens.access_token)).extra!.user as { id: string }).id, 'user-a')
  const renewed = await restartedAuth.exchangeRefreshToken(client, tokens.refresh_token, undefined, new URL(origin + '/mcp'))
  assert.ok(renewed.access_token)
  fs.writeFileSync(path.join(temp, 'wrong-key'), randomBytes(32))
  assert.throws(() => new EncryptedStore(file, path.join(temp, 'wrong-key')))
})

test('ChatGPT CIMD uses the SDK metadata schema and rejects malformed client URLs', async t => {
  const fetched: string[] = []
  const clientId = 'https://chatgpt.com/oauth/client.json'
  const f = await fixture(t, { fetchImpl: async url => {
    fetched.push(url)
    return new Response(JSON.stringify({ client_id: clientId, client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'] }), { headers: { 'content-type': 'application/json' } })
  } })
  assert.equal(await f.auth.getClient('http://127.0.0.1/internal'), undefined)
  assert.equal(await f.auth.getClient('https://user:password@attacker.example/client.json'), undefined)
  assert.equal(await f.auth.getClient('https://attacker.example/'), undefined)
  assert.equal(fetched.length, 0)
  const client = (await f.auth.getClient(clientId))! as RegisteredClient
  assert.equal(client.token_endpoint_auth_method, 'none')
  const a = await authorize(f, client)
  const tokens = await (await exchange(f, client, a)).json() as Tokens
  assert.ok(tokens.access_token)
  assert.deepEqual(fetched, [clientId])
})

test('Claude web and Claude Code CIMD complete the browser OAuth flow, including dynamic callback ports', async t => {
  const docs = new Map<string, { client_name: string, redirect_uris: string[] }>([
    ['https://claude.ai/oauth/mcp-oauth-client-metadata', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }],
    ['https://claude.ai/oauth/claude-code-client-metadata', { client_name: 'Claude Code', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'] }]
  ])
  const f = await fixture(t, { fetchImpl: async url => new Response(JSON.stringify({ client_id: url, ...docs.get(url), token_endpoint_auth_method: 'none' }), { headers: { 'content-type': 'application/json' } }) })
  for (const [clientId, doc] of docs) {
    const client = (await f.auth.getClient(clientId))! as RegisteredClient
    assert.equal(client.client_name, doc.client_name)
    const redirectUri = doc.client_name === 'Claude Code' ? 'http://localhost:45831/callback' : doc.redirect_uris[0]
    const a = await authorize(f, client, { redirectUri })
    const response = await exchange(f, client, a)
    assert.equal(response.status, 200)
    const tokens = await response.json() as Tokens
    const mcp = await clientFor(t, f, tokens.access_token)
    assert.equal((await call(mcp, 'get_profile')).value.profile.id, 'user-a')
  }
})

test('CIMD validates document identity and never follows a metadata redirect', async t => {
  const calls: string[] = []
  const f = await fixture(t, { fetchImpl: async url => {
    calls.push(url)
    if (url.includes('redirect')) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal' } })
    return new Response(JSON.stringify({ client_id: 'https://other.example/client.json', client_name: 'Impersonated', redirect_uris: ['https://other.example/callback'], token_endpoint_auth_method: 'none' }))
  } })
  assert.equal(await f.auth.getClient('https://agent.example/client.json'), undefined)
  assert.equal(await f.auth.getClient('https://agent.example/redirect.json'), undefined)
  assert.equal(calls.length, 2)
})

test('loopback callback port relaxation does not permit changing the host or path', async t => {
  const f = await fixture(t, { fetchImpl: async url => new Response(JSON.stringify({ client_id: url, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' })) })
  const clientId = 'https://claude.ai/oauth/claude-code-client-metadata'
  for (const redirect of ['http://localhost:45831/other-path', 'http://localhost.attacker.example/callback', 'http://127.0.0.1:45831/callback']) {
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })
    const r = await fetch(f.base + '/authorize?' + query, { redirect: 'manual' })
    assert.equal(r.status, 400)
    assert.equal(r.headers.get('location'), null)
  }
})

test('authorization errors retain issuer/state and reject an unregistered callback', async t => {
  const f = await fixture(t), client = await register(f)
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'unsupported', state: 'preserve-on-error' })
  const response = await fetch(f.base + '/authorize?' + query, { redirect: 'manual' })
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!)
  assert.equal(location.searchParams.get('iss'), origin)
  assert.equal(location.searchParams.get('state'), 'preserve-on-error')
  query.set('redirect_uri', 'https://attacker.example/callback')
  const refused = await fetch(f.base + '/authorize?' + query, { redirect: 'manual' })
  assert.equal(refused.status, 400)
  assert.equal(refused.headers.get('location'), null)
})

test('a refresh token presented as a Bearer token is rejected and never reaches the openGym API', async t => {
  const f = await fixture(t), client = await register(f), a = await authorize(f, client)
  const tokens = await (await exchange(f, client, a)).json() as Tokens
  assert.match(tokens.refresh_token, /^ogmcpr_/)
  assert.match(tokens.access_token, /^ogmcp_/)
  const sawBefore = f.seenAuthorizations.length

  const response = await fetch(f.base + '/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + tokens.refresh_token,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })
  assert.equal(response.status, 401)
  assert.match(response.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/)
  assert.equal(f.seenAuthorizations.length, sawBefore)
  assert.equal(f.seenAuthorizations.some(value => value.includes(tokens.refresh_token)), false)
  assert.equal(f.seenAuthorizations.some(value => value.includes('ogmcpr_')), false)

  // The refresh token itself is still valid at the token endpoint, so the 401 did not burn it.
  const refreshed = await post(f.base + '/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: origin + '/mcp' })
  assert.equal(refreshed.status, 200)
})

test('refresh and authorization requests for a different resource are refused', async t => {
  const f = await fixture(t), client = await register(f), a = await authorize(f, client)
  const tokens = await (await exchange(f, client, a)).json() as Tokens
  const refresh = (resource: string) => post(f.base + '/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource })
  assert.equal((await refresh('https://another.example/mcp')).status, 400)

  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', code_challenge: createHash('sha256').update('v').digest('base64url'), code_challenge_method: 'S256', resource: 'https://another.example/mcp' })
  const wrongResource = await fetch(f.base + '/authorize?' + query, { redirect: 'manual', headers: { accept: 'application/json' } })
  assert.notEqual(wrongResource.status, 200)

  // The refusal above did not consume the refresh token.
  assert.equal((await refresh(origin + '/mcp')).status, 200)
})

test('denying consent returns access_denied, issues no code and never redeems a pairing code', async t => {
  const f = await fixture(t), client = await register(f)
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', code_challenge: createHash('sha256').update('v').digest('base64url'), code_challenge_method: 'S256', resource: origin + '/mcp', state: 's1' })
  const page = await fetch(f.base + '/authorize?' + query)
  const ticket = /name="ticket" value="([^"]+)"/.exec(await page.text())![1]
  const cookie = page.headers.get('set-cookie')!.split(';')[0]
  f.codes.set('TESTCODE', 'test-a')
  const denied = await post(f.base + '/consent', { ticket, code: 'TESTCODE', decision: 'deny' }, { origin, cookie })
  assert.equal(denied.status, 302)
  const location = new URL(denied.headers.get('location')!)
  assert.equal(location.searchParams.get('error'), 'access_denied')
  assert.equal(location.searchParams.get('code'), null)
  assert.equal(location.searchParams.get('state'), 's1')
  assert.equal(f.counters.pairs, 0)
})

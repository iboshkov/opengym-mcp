import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { fixture, origin } from './fixture.ts'
import type { Fixture } from './fixture.ts'
import { clientMetadataUrl, fetchClientMetadata } from '../src/oauth/client-metadata.ts'

test('browser connection guide contains UI-only Claude instructions, endpoint copy and working assets', async t => {
  const f = await fixture(t)
  const response = await fetch(f.base + '/'), html = await response.text()
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type')!, /text\/html/)
  assert.match(html, /Settings → Connectors/)
  assert.match(html, /Add custom connector/)
  assert.match(html, /No terminal commands/)
  assert.match(html, /Leave the advanced OAuth client ID and secret fields empty/)
  assert.match(html, /data-copy="mcp-url"/)
  assert.ok(html.includes(origin + '/mcp'))
  for (const asset of ['/assets/style.css', '/assets/connect.js']) assert.equal((await fetch(f.base + asset)).status, 200)
  assert.match(response.headers.get('content-security-policy')!, /script-src 'self'/)
})

test('browser authorization errors show recovery steps while programmatic clients keep OAuth JSON errors', async t => {
  const f = await fixture(t)
  const response = await fetch(f.base + '/authorize?client_id=missing', { headers: { accept: 'text/html' } })
  assert.equal(response.status, 400)
  assert.match(await response.text(), /Settings → Connectors → openGym → Connect/)
  const api = await fetch(f.base + '/authorize?client_id=missing', { headers: { accept: 'application/json' } })
  assert.equal((await api.json()).error, 'invalid_client')
})

test('failed code entry retains a read-only consent choice and shows callback identity', async t => {
  const clientId = 'https://claude.ai/oauth/claude-code-client-metadata'
  const f = await fixture(t, { fetchImpl: async url => new Response(JSON.stringify({ client_id: url, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'], token_endpoint_auth_method: 'none' })) })
  const verifier = randomBytes(32).toString('base64url')
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: 'http://localhost:3118/callback', response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'opengym:read opengym:write' })
  const start = await fetch(f.base + '/authorize?' + query), html = await start.text()
  assert.match(html, /claude.ai/)
  assert.match(html, /localhost:3118/)
  assert.match(html, /local agent on your device/)
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)![1]
  const failed = await fetch(f.base + '/consent', { method: 'POST', headers: { origin, cookie: start.headers.get('set-cookie')!.split(';')[0], 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket, code: 'WRONG', decision: 'allow' }) })
  const retry = await failed.text()
  assert.equal(failed.status, 400)
  assert.match(retry, /Create a new code/)
  assert.doesNotMatch(retry, /name="allow_write" value="yes" checked/)
})

test('metadata HTTP client rejects non-HTTPS URLs and blocks loopback connections with the maintained SSRF agent', async t => {
  for (const url of ['http://example.com/client.json', 'https://user:pass@example.com/client.json', 'https://example.com/client.json#fragment', 'https://example.com/']) assert.equal(clientMetadataUrl(url), null)
  let connections = 0
  const listener = net.createServer(socket => { connections++; socket.destroy() })
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => listener.close(() => resolve())))
  await assert.rejects(fetchClientMetadata(`https://127.0.0.1:${(listener.address() as net.AddressInfo).port}/client.json`), /blocked/i)
  assert.equal(connections, 0)
})

test('trusted proxy configuration cannot bypass the raw Host restriction', async t => {
  const f = await fixture(t, { trustProxyHops: 1 })
  assert.equal(f.app.get('trust proxy'), 1)
  const spoofed = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(f.base + '/healthz', { headers: { host: 'attacker.example', 'x-forwarded-host': 'mcp.example.test', 'x-forwarded-for': '203.0.113.10' } }, response => { response.resume(); resolve(response.statusCode) })
    request.on('error', reject)
  })
  assert.equal(spoofed, 421)
  assert.equal((await fetch(f.base + '/healthz', { headers: { 'x-forwarded-for': '203.0.113.10' } })).status, 200)
})

const PKCE_CHALLENGE = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url')

async function registerClient(f: Fixture, clientName = 'Test OAuth agent') {
  const response = await fetch(f.base + '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: ['http://127.0.0.1:43210/callback'],
      token_endpoint_auth_method: 'none'
    })
  })
  assert.equal(response.status, 201)
  return response.json() as Promise<{ client_id: string, redirect_uris: string[] }>
}

async function openConsentPage(f: Fixture, clientName?: string) {
  const client = await registerClient(f, clientName)
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: 'code',
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: 'S256',
    resource: origin + '/mcp',
    scope: 'opengym:read opengym:write'
  })
  const response = await fetch(f.base + '/authorize?' + query)
  assert.equal(response.status, 200)
  const html = await response.text()
  return {
    response,
    html,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
    ticket: /name="ticket" value="([^"]+)"/.exec(html)![1]
  }
}

function postConsent(f: Fixture, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(f.base + '/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
    redirect: 'manual'
  })
}

/** Every kind of page the service renders, as HTML strings. */
async function renderedPages(f: Fixture): Promise<Record<string, string>> {
  const consent = await openConsentPage(f)
  const expired = await postConsent(f, { ticket: 'unknown', decision: 'allow', code: 'X' }, { origin })
  const browserError = await fetch(f.base + '/authorize?client_id=missing', { headers: { accept: 'text/html' } })
  return {
    landing: await (await fetch(f.base + '/')).text(),
    help: await (await fetch(f.base + '/help')).text(),
    consent: consent.html,
    expired: await expired.text(),
    authorizationError: await browserError.text()
  }
}

test('landing page has the copy field, the MCP URL and linked assets with sensible content types', async t => {
  const f = await fixture(t)
  const response = await fetch(f.base + '/')
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.match(html, /<input id="mcp-url" value="https:\/\/mcp\.example\.test\/mcp" readonly/)
  assert.match(html, /<button type="button" class="btn small" data-copy="mcp-url">/)
  assert.ok(html.includes(origin + '/mcp'))
  assert.match(html, /<link rel="stylesheet" href="\/assets\/style\.css">/)
  assert.match(html, /<script src="\/assets\/connect\.js" defer><\/script>/)
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/assets\/icon\.svg">/)
  assert.match(html, /openGym/)
  assert.doesNotMatch(html, /OpenGym/)

  const expectedTypes = {
    '/assets/style.css': /^text\/css/,
    '/assets/connect.js': /javascript/,
    '/assets/icon.svg': /^image\/svg\+xml/
  }
  for (const [asset, type] of Object.entries(expectedTypes)) {
    const served = await fetch(f.base + asset)
    assert.equal(served.status, 200, asset)
    assert.match(served.headers.get('content-type')!, type, asset)
    assert.ok((await served.text()).length > 0, asset)
  }
})

test('unknown asset paths return 404 and every response carries a strict CSP', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(f.base + '/assets/missing.js')).status, 404)
  for (const path of ['/', '/help', '/assets/style.css', '/healthz', '/assets/missing.js']) {
    const csp = (await fetch(f.base + path)).headers.get('content-security-policy')!
    assert.ok(csp, `CSP header on ${path}`)
    assert.match(csp, /script-src 'self'/)
    assert.match(csp, /default-src 'none'/)
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/)
  }
})

test('pages contain no inline styles, event handlers or script bodies that the CSP would block', async t => {
  const f = await fixture(t)
  for (const [name, html] of Object.entries(await renderedPages(f))) {
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${name}: inline style attribute`)
    assert.doesNotMatch(html, /<style[\s>]/i, `${name}: inline style element`)
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${name}: inline event handler`)
    assert.doesNotMatch(html, /href\s*=\s*["']?javascript:/i, `${name}: javascript: URL`)
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    assert.ok(scripts.length > 0, `${name}: expected the external script`)
    for (const [, attributes, body] of scripts) {
      assert.match(attributes, /\ssrc="\/assets\/[^"]+"/, `${name}: script must be external`)
      assert.equal(body.trim(), '', `${name}: inline script body`)
    }
  }
})

test('without a public openGym address pages show no link to openGym and never reveal the internal API address', async t => {
  const f = await fixture(t, { openGymPublicUrl: null })
  const internal = f.upstream.base
  const pages = await renderedPages(f)
  for (const [name, html] of Object.entries(pages)) {
    assert.equal(html.includes(internal), false, `${name}: internal API address`)
    assert.equal(html.includes(new URL(internal).host), false, `${name}: internal API host`)
  }
  for (const name of ['landing', 'consent']) {
    assert.doesNotMatch(pages[name], /<a [^>]*>Open openGym<\/a>/, name)
    assert.match(pages[name], /Open openGym/, name)
  }
})

test('with a public openGym address the pages link to it and still hide the internal API address', async t => {
  const f = await fixture(t, { openGymPublicUrl: 'https://gym.example.test' })
  const pages = await renderedPages(f)
  for (const name of ['landing', 'consent']) {
    assert.match(pages[name], /<a href="https:\/\/gym\.example\.test" target="_blank" rel="noopener noreferrer">Open openGym<\/a>/, name)
  }
  for (const [name, html] of Object.entries(pages)) {
    assert.equal(html.includes(f.upstream.base), false, `${name}: internal API address`)
  }
})

test('the consent page escapes a hostile client name everywhere it is shown', async t => {
  const f = await fixture(t)
  const { html } = await openConsentPage(f, '<img src=x onerror=1>')
  assert.equal(html.includes('<img'), false)
  assert.ok(html.includes('&lt;img src=x onerror=1&gt;'))
  assert.match(html, /<h1>Connect &lt;img src=x onerror=1&gt;<\/h1>/)
  assert.match(html, /<title>Connect &lt;img src=x onerror=1&gt; · openGym MCP<\/title>/)

  const quoted = await openConsentPage(f, '"><script>alert(1)</script>')
  assert.equal(quoted.html.includes('<script>alert(1)'), false)
  assert.ok(quoted.html.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'))
})

test('the consent page names the product, the pairing field and the connect button', async t => {
  const f = await fixture(t)
  const { html } = await openConsentPage(f, 'Browser test agent')
  assert.match(html, /<h1>Connect Browser test agent<\/h1>/)
  assert.match(html, />Connect openGym<\/button>/)
  assert.match(html, /<label class="field-label" for="pair-code">One-time pairing code<\/label>/)
  assert.match(html, /<input class="code-input" id="pair-code"[^>]* required /)
  assert.match(html, /<button class="btn plain" name="decision" value="deny" formnovalidate>Cancel<\/button>/)
  assert.doesNotMatch(html, /OpenGym/)
})

test('failed POST /consent answers return HTML notice pages with a way forward, not plain text', async t => {
  const f = await fixture(t)
  const consent = await openConsentPage(f)
  const headers = { origin, cookie: consent.cookie }

  const expired = await postConsent(f, { ticket: 'no-such-ticket', decision: 'allow', code: 'X' }, headers)
  assert.equal(expired.status, 400)
  assert.match(expired.headers.get('content-type')!, /text\/html/)
  const expiredHtml = await expired.text()
  assert.match(expiredHtml, /<h1>This sign-in has expired<\/h1>/)
  assert.match(expiredHtml, /href="\/">Open the connection guide<\/a>/)

  const foreign = await postConsent(f, { ticket: consent.ticket, decision: 'allow', code: 'X' }, { origin: 'https://attacker.example', cookie: consent.cookie })
  assert.equal(foreign.status, 400)
  assert.match(await foreign.text(), /This sign-in has expired/)

  const undecided = await postConsent(f, { ticket: consent.ticket, code: 'X' }, headers)
  assert.equal(undecided.status, 400)
  assert.match(undecided.headers.get('content-type')!, /text\/html/)
  assert.match(await undecided.text(), /<h1>Nothing was chosen<\/h1>/)
  assert.equal(f.counters.pairs, 0)
})

test('repeated wrong pairing codes end in a "too many attempts" notice page', async t => {
  const f = await fixture(t)
  const consent = await openConsentPage(f)
  const headers = { origin, cookie: consent.cookie }
  for (let attempt = 1; attempt <= 5; attempt++) {
    const wrong = await postConsent(f, { ticket: consent.ticket, decision: 'allow', code: 'WRONG' + attempt }, headers)
    assert.equal(wrong.status, 400)
    assert.match(await wrong.text(), /That code was not accepted/)
  }
  const limited = await postConsent(f, { ticket: consent.ticket, decision: 'allow', code: 'WRONG6' }, headers)
  assert.equal(limited.status, 429)
  assert.match(limited.headers.get('content-type')!, /text\/html/)
  assert.match(await limited.text(), /<h1>Too many attempts<\/h1>/)
})

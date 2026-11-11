import { test, expect } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { fixture, listen, origin } from '../fixture.js'

// Route a real HTTPS browser origin to the isolated API fixture. The browser
// handles cookies, referrer policy and native form submissions itself.
for (const decision of ['allow', 'deny']) {
  test(`native browser consent can ${decision} without supplying verification headers`, async ({ page }) => {
    let cleanup
    const f = await fixture({ after: fn => { cleanup = fn } })
    const agent = await listen((req, res) => res.end('Agent callback received.'))
    try {
      const callback = agent.base + '/callback'
      await page.route(origin + '/**', async route => {
        const url = new URL(route.request().url())
        const response = await route.fetch({ url: f.base + url.pathname + url.search, maxRedirects: 0 })
        await route.fulfill({ response })
      })
      const registration = await fetch(f.base + '/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Browser test agent', redirect_uris: [callback], token_endpoint_auth_method: 'none' })
      })
      expect(registration.status).toBe(201)
      const client = await registration.json()
      const verifier = randomBytes(32).toString('base64url')
      const params = new URLSearchParams({
        client_id: client.client_id, redirect_uri: callback, response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        scope: 'opengym:read opengym:write', resource: origin + '/mcp', state: 'browser-state'
      })
      await page.goto(origin + '/authorize?' + params)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connect Browser test agent')
      f.codes.set('TESTCODE', 'test-a')
      // The code is required, so an empty form is stopped by the browser; Cancel skips validation.
      await expect(page.getByLabel('One-time pairing code', { exact: true })).toHaveAttribute('required', '')
      await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveAttribute('formnovalidate', '')
      if (decision === 'allow') {
        await page.getByLabel('One-time pairing code', { exact: true }).fill('WRONG')
        await page.getByRole('button', { name: 'Connect openGym', exact: true }).click()
        await expect(page.getByRole('alert')).toContainText('Create a new code')
        await page.getByLabel('One-time pairing code', { exact: true }).fill('TESTCODE')
      }
      const submission = page.waitForRequest(request => new URL(request.url()).pathname === '/consent')
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/consent')
      const returned = page.waitForRequest(request => request.url().startsWith(callback))
      await page.getByRole('button', { name: decision === 'allow' ? 'Connect openGym' : 'Cancel', exact: true }).click()
      expect((await submission).headers().origin).toBe(origin)
      expect((await response).status()).toBe(302)
      await page.waitForURL(callback + '**')
      expect((await returned).headers().referer).toBeUndefined()
      const result = new URL(page.url())
      expect(result.searchParams.get('state')).toBe('browser-state')
      expect(result.searchParams.get('iss')).toBe(origin)
      if (decision === 'deny') {
        expect(result.searchParams.get('error')).toBe('access_denied')
        expect(f.counters.pairs).toBe(0)
        return
      }
      expect(f.counters.pairs).toBe(2)
      const tokens = await fetch(f.base + '/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id,
          code: result.searchParams.get('code'), code_verifier: verifier, redirect_uri: callback, resource: origin + '/mcp' })
      })
      expect(tokens.status).toBe(200)
      expect((await tokens.json()).scope).toBe('opengym:read opengym:write')
    } finally { await cleanup?.(); await agent.close() }
  })
}

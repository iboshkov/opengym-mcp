import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js'
import { OAuthClientMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js'
import { clientMetadataUrl, fetchClientMetadata } from './client-metadata.js'
import { consentPage, expiredAuthorizationPage, noticePage, tooManyAttemptsPage } from '../web/pages.js'
import { ALL_SCOPES, READ, WRITE } from '../scopes.js'

const SECOND_MS = 1000
const HOUR_MS = 3600 * SECOND_MS
const DAY_MS = 24 * HOUR_MS

const FLOW_TTL_MS = 10 * 60 * SECOND_MS
const FLOW_COOKIE_MAX_AGE_SECONDS = 600
const CODE_TTL_MS = 2 * 60 * SECOND_MS
const ACCESS_TOKEN_TTL_MS = HOUR_MS
const GRANT_TTL_MS = 30 * DAY_MS

const MAX_PENDING_FLOWS = 1000
const MAX_CLIENTS = 1000
const MAX_CLIENT_CACHE_ENTRIES = 1000
const MAX_PAIRING_ATTEMPTS = 5

const MAX_REGISTERED_REDIRECT_URIS = 10
const MAX_METADATA_REDIRECT_URIS = 20
const MAX_CLIENT_NAME_LENGTH = 200
const MAX_METADATA_BYTES = 32768
const METADATA_FETCH_TIMEOUT_MS = 10 * SECOND_MS
const DEFAULT_METADATA_TTL_SECONDS = 300
const MAX_METADATA_TTL_SECONDS = 3600

const FLOW_COOKIE_NAME = '__Host-opengym-mcp-flow'
const FLOW_COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Lax'
const ACCESS_TOKEN_PREFIX = 'ogmcp_'
const REFRESH_TOKEN_PREFIX = 'ogmcpr_'
const PAIRED_SESSION_CLIENT_ID = 'opengym-paired-session'

const CLIENT_AUTH_METHODS = ['none', 'client_secret_post']
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]']
const DESKTOP_REDIRECT_SCHEMES = ['cursor:', 'vscode:', 'vscode-insiders:']

const sha256Hex = value => createHash('sha256').update(value).digest('hex')
const randomSecret = () => randomBytes(32).toString('base64url')

/** Constant-time string comparison; false for non-strings and different lengths. */
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (Buffer.byteLength(left) !== Buffer.byteLength(right)) return false
  return timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

/** Own-property lookup, so keys such as "__proto__" never reach the prototype chain. */
const ownValue = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined)

/** The flow cookie value, or '' when it is missing or repeated with conflicting values. */
function flowCookieFrom(req) {
  const prefix = `${FLOW_COOKIE_NAME}=`
  const values = String(req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith(prefix))
    .map(part => part.slice(prefix.length))
  const allIdentical = values.every(value => value === values[0])
  return values.length && allIdentical ? values[0] : ''
}

/** HTTPS, a loopback http callback, or a known desktop-app scheme; no credentials or fragment. */
function redirectAllowed(value) {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return false
    if (url.protocol === 'https:') return true
    if (url.protocol === 'http:') return LOOPBACK_HOSTNAMES.includes(url.hostname)
    return DESKTOP_REDIRECT_SCHEMES.includes(url.protocol)
  } catch {
    return false
  }
}

/** Auth methods a client metadata document advertises (singular field as a fallback). */
function advertisedAuthMethods(doc) {
  if (Array.isArray(doc.token_endpoint_auth_methods_supported)) return doc.token_endpoint_auth_methods_supported
  return [doc.token_endpoint_auth_method]
}

/** Cache lifetime in seconds for a fetched client metadata document. */
function metadataTtlSeconds(response) {
  const cacheControl = response.headers.get('cache-control') || ''
  if (/(?:no-store|no-cache)/i.test(cacheControl)) return 0
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl)
  return Math.min(maxAge ? Number(maxAge[1]) : DEFAULT_METADATA_TTL_SECONDS, MAX_METADATA_TTL_SECONDS)
}

/**
 * OAuth 2.1 authorization server for the MCP endpoint, implementing the SDK's
 * OAuthServerProvider contract. Consent is given by entering an openGym pairing
 * code, which also yields the upstream openGym session the grant is bound to.
 *
 * Pending flows, authorization codes and the client-metadata cache live in
 * memory (short lived, lost on restart). Clients, grants and tokens live in the
 * store, which keeps only token hashes.
 */
export class OpenGymAuth {
  constructor({ origin, api, store, openGymPublicUrl = api.base, fetchImpl = fetchClientMetadata, now = () => Date.now() }) {
    this.origin = new URL(origin).origin
    const hostname = new URL(this.origin).hostname
    if (!this.origin.startsWith('https://') && !LOOPBACK_HOSTNAMES.includes(hostname)) {
      throw new Error('PUBLIC_ORIGIN must be HTTPS.')
    }
    this.resource = `${this.origin}/mcp`
    this.api = api
    this.store = store
    this.openGymPublicUrl = openGymPublicUrl
    this.fetch = fetchImpl
    this.now = now
    this.flows = new Map()
    this.codes = new Map()
    this.clientCache = new Map()
    this.clientsStore = {
      getClient: clientId => this.getClient(clientId),
      registerClient: client => this.registerClient(client)
    }
  }

  // --- Discovery metadata ---

  metadata() {
    const sdkMetadata = createOAuthMetadata({
      provider: this,
      issuerUrl: new URL(this.origin),
      scopesSupported: [...ALL_SCOPES]
    })
    return {
      ...sdkMetadata,
      issuer: this.origin,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS
    }
  }

  resourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.origin],
      scopes_supported: ALL_SCOPES,
      resource_name: 'openGym'
    }
  }

  /** WWW-Authenticate challenge pointing clients at the protected resource metadata. */
  challenge(scopes = [READ]) {
    return `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp", scope="${scopes.join(' ')}"`
  }

  /** RFC 8707 resource binding: a request that names a resource must name this server. */
  checkResource(resource) {
    if (resource && resource.href !== this.resource) {
      throw new InvalidRequestError('The resource does not match this openGym MCP server.')
    }
  }

  /** Drop expired flows, codes, cached client metadata, grants and tokens. */
  prune() {
    const now = this.now()
    for (const map of [this.flows, this.codes, this.clientCache]) {
      for (const [key, value] of map) {
        if (value.expires <= now) map.delete(key)
      }
    }
    for (const kind of ['grants', 'access', 'refresh', 'spentRefresh']) {
      const entries = this.store.data[kind]
      for (const [key, value] of Object.entries(entries)) {
        if (value.expires <= now) delete entries[key]
      }
    }
  }

  // --- Clients ---

  /** Dynamic client registration (RFC 7591) with redirect URI and capacity limits. */
  registerClient(client) {
    this.prune()
    const redirectUris = client.redirect_uris
    if (!redirectUris?.length || redirectUris.length > MAX_REGISTERED_REDIRECT_URIS || !redirectUris.every(redirectAllowed)) {
      throw new InvalidClientMetadataError('Use HTTPS, a loopback callback, or a supported desktop callback scheme.')
    }
    if (!CLIENT_AUTH_METHODS.includes(client.token_endpoint_auth_method || 'client_secret_post')) {
      throw new InvalidClientMetadataError('Supported client authentication: none or client_secret_post.')
    }
    if (Object.keys(this.store.data.clients).length >= MAX_CLIENTS) {
      throw new InvalidClientMetadataError('The client registration limit has been reached.')
    }
    const saved = {
      ...client,
      client_id: client.client_id || randomUUID(),
      client_id_issued_at: client.client_id_issued_at || Math.floor(this.now() / SECOND_MS)
    }
    this.store.data.clients[saved.client_id] = saved
    this.store.save()
    return saved
  }

  /**
   * Look up a registered client, or resolve an HTTPS client_id as a client ID
   * metadata document. Any failure to fetch or validate it yields undefined.
   */
  async getClient(clientId) {
    const registered = ownValue(this.store.data.clients, clientId)
    if (registered) return registered
    if (!clientMetadataUrl(clientId)) return undefined

    const cached = this.clientCache.get(clientId)
    if (cached && cached.expires > this.now()) return cached.client

    let response
    let text
    try {
      response = await this.fetch(clientId, { redirect: 'manual', signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS) })
      if (!response.ok) return undefined
      text = await response.text()
    } catch {
      return undefined
    }
    if (Buffer.byteLength(text) > MAX_METADATA_BYTES) return undefined

    let doc
    try {
      doc = JSON.parse(text)
    } catch {
      return undefined
    }
    const parsed = OAuthClientMetadataSchema.safeParse(doc)
    if (!parsed.success) return undefined
    if (doc.client_id !== clientId) return undefined
    if (typeof doc.client_name !== 'string' || !doc.client_name.trim() || doc.client_name.length > MAX_CLIENT_NAME_LENGTH) return undefined
    if (!doc.redirect_uris.length || doc.redirect_uris.length > MAX_METADATA_REDIRECT_URIS) return undefined
    if (!doc.redirect_uris.every(redirectAllowed)) return undefined
    // Metadata-document clients are public clients: they must be able to use no secret.
    if (!advertisedAuthMethods(doc).includes('none')) return undefined

    const client = {
      ...parsed.data,
      client_id: clientId,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    }
    if (this.clientCache.size >= MAX_CLIENT_CACHE_ENTRIES) {
      this.clientCache.delete(this.clientCache.keys().next().value)
    }
    this.clientCache.set(clientId, { client, expires: this.now() + metadataTtlSeconds(response) * SECOND_MS })
    return client
  }

  // --- Authorization and consent ---

  /** SDK hook for GET /authorize: validate the request, open a flow, show the consent form. */
  async authorize(client, params, res) {
    this.prune()
    this.checkResource(params.resource)
    const scopes = params.scopes?.length ? [...new Set(params.scopes)] : [...ALL_SCOPES]
    if (!scopes.includes(READ) || scopes.some(scope => !ALL_SCOPES.includes(scope))) {
      throw new InvalidScopeError('Request opengym:read and optionally opengym:write.')
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) {
      throw new InvalidRequestError('S256 PKCE is required.')
    }
    if (!client.redirect_uris.some(registered => redirectUriMatches(params.redirectUri, registered))) {
      throw new InvalidRequestError('Unregistered redirect URI.')
    }
    if (this.flows.size >= MAX_PENDING_FLOWS) {
      throw new InvalidRequestError('Too many pending authorizations. Try again later.')
    }

    // The ticket travels in the form; the cookie nonce binds the flow to this browser.
    const ticket = randomSecret()
    const cookieNonce = randomSecret()
    const flow = {
      ticket,
      cookieHash: sha256Hex(cookieNonce),
      client,
      params,
      scopes,
      attempts: 0,
      expires: this.now() + FLOW_TTL_MS
    }
    this.flows.set(ticket, flow)
    res.setHeader('Set-Cookie', `${FLOW_COOKIE_NAME}=${cookieNonce}; ${FLOW_COOKIE_ATTRIBUTES}; Max-Age=${FLOW_COOKIE_MAX_AGE_SECONDS}`)
    return this.sendConsent(res, flow)
  }

  /**
   * Render the consent form. The page's CSP only allows form posts to 'self',
   * but Chromium also checks form-action against the redirect destination, so
   * this flow's callback origin (or app scheme) is added to the policy.
   */
  sendConsent(res, flow, error = '') {
    const callback = new URL(flow.params.redirectUri)
    const target = ['https:', 'http:'].includes(callback.protocol) ? callback.origin : callback.protocol
    if (!/^[a-zA-Z0-9:/.\[\]_-]+$/.test(target)) {
      throw new InvalidRequestError('Invalid callback origin.')
    }
    const policy = String(res.getHeader('Content-Security-Policy'))
    res.setHeader('Content-Security-Policy', policy.replace("form-action 'self'", `form-action 'self' ${target}`))
    return res.type('html').send(consentPage({ flow, openGymUrl: this.openGymPublicUrl, error }))
  }

  /** POST /consent: the user denies, or allows by supplying an openGym pairing code. */
  async consent(req, res) {
    this.prune()
    const flow = this.flows.get(req.body?.ticket)
    const sameSite = req.headers.origin === this.origin
    if (!flow || !sameSite || !safeEqual(sha256Hex(flowCookieFrom(req)), flow.cookieHash)) {
      return res.status(400).type('html').send(expiredAuthorizationPage())
    }

    if (req.body.decision === 'deny') {
      this.flows.delete(flow.ticket)
      return this.finish(res, flow, { error: 'access_denied' })
    }
    if (req.body.decision !== 'allow') {
      return res.status(400).type('html').send(noticePage({
        title: 'Nothing was chosen',
        message: 'Go back and choose Connect openGym or Cancel.'
      }))
    }

    // Limit guesses at the pairing code within one flow.
    flow.attempts += 1
    if (flow.attempts > MAX_PAIRING_ATTEMPTS) {
      this.flows.delete(flow.ticket)
      return res.status(429).type('html').send(tooManyAttemptsPage())
    }

    flow.allowWrite = flow.scopes.includes(WRITE) && req.body.allow_write === 'yes'
    let paired
    try {
      paired = await this.api.pair(String(req.body.code || ''))
    } catch {
      return this.sendConsent(res.status(400), flow, 'That code was not accepted. Create a new code in openGym and try again.')
    }

    // The flow is deleted only after the asynchronous pair call returns, so a
    // wrong code can be retried. If a concurrent request already consumed the
    // flow while we waited, delete() is false and no second code is issued.
    if (!this.flows.delete(flow.ticket)) {
      return res.status(400).type('html').send(expiredAuthorizationPage())
    }

    const code = randomSecret()
    const scopes = flow.scopes.includes(WRITE) && req.body.allow_write === 'yes' ? [...ALL_SCOPES] : [READ]
    this.codes.set(sha256Hex(code), {
      clientId: flow.client.client_id,
      redirectUri: flow.params.redirectUri,
      challenge: flow.params.codeChallenge,
      scopes,
      user: paired.user,
      upstreamToken: paired.token,
      expires: this.now() + CODE_TTL_MS
    })
    return this.finish(res, flow, { code })
  }

  /** Redirect back to the client with the result, `state` and the issuer (RFC 9207), clearing the flow cookie. */
  finish(res, flow, values) {
    const redirect = new URL(flow.params.redirectUri)
    for (const [name, value] of Object.entries(values)) {
      redirect.searchParams.set(name, value)
    }
    if (flow.params.state !== undefined) redirect.searchParams.set('state', flow.params.state)
    redirect.searchParams.set('iss', this.origin)
    res.setHeader('Set-Cookie', `${FLOW_COOKIE_NAME}=; ${FLOW_COOKIE_ATTRIBUTES}; Max-Age=0`)
    return res.redirect(302, redirect.href)
  }

  // --- Authorization codes and tokens ---

  /** The stored code (looked up by hash) if it is unexpired and belongs to this client. */
  codeFor(client, code) {
    const saved = this.codes.get(sha256Hex(code))
    if (!saved || saved.expires <= this.now() || saved.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code.')
    }
    return saved
  }

  /** SDK hook: the SDK verifies the PKCE verifier against this challenge. */
  async challengeForAuthorizationCode(client, code) {
    return this.codeFor(client, code).challenge
  }

  /** Exchange a single-use code for a new grant plus its first access and refresh tokens. */
  async exchangeAuthorizationCode(client, code, verifier, redirectUri, resource) {
    this.checkResource(resource)
    const saved = this.codeFor(client, code)
    if (redirectUri !== saved.redirectUri) {
      throw new InvalidGrantError('The redirect URI does not match the authorization.')
    }
    this.codes.delete(sha256Hex(code))
    const grant = {
      id: randomUUID(),
      clientId: client.client_id,
      uid: saved.user.id,
      upstreamToken: saved.upstreamToken,
      scopes: saved.scopes,
      resource: this.resource,
      expires: this.now() + GRANT_TTL_MS
    }
    this.store.data.grants[grant.id] = grant
    return this.issue(grant)
  }

  /** Mint an access and refresh token pair for a grant; neither outlives the grant. */
  issue(grant) {
    this.prune()
    const accessToken = `${ACCESS_TOKEN_PREFIX}${randomSecret()}`
    const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomSecret()}`
    const now = this.now()
    const accessExpires = Math.min(now + ACCESS_TOKEN_TTL_MS, grant.expires)
    this.store.data.access[sha256Hex(accessToken)] = { grantId: grant.id, expires: accessExpires }
    this.store.data.refresh[sha256Hex(refreshToken)] = { grantId: grant.id, expires: grant.expires }
    this.store.save()
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.floor((accessExpires - now) / SECOND_MS)),
      refresh_token: refreshToken,
      scope: grant.scopes.join(' ')
    }
  }

  /**
   * Refresh with rotation. A used refresh token moves to `spentRefresh` instead
   * of being forgotten, so that presenting it again is recognised as replay
   * (a likely stolen token) and the whole grant is revoked.
   */
  async exchangeRefreshToken(client, token, scopes, resource) {
    this.checkResource(resource)
    const tokenHash = sha256Hex(token)
    const saved = ownValue(this.store.data.refresh, tokenHash)
    const spent = ownValue(this.store.data.spentRefresh, tokenHash)
    if (!saved) {
      const replayedGrant = spent && ownValue(this.store.data.grants, spent.grantId)
      if (replayedGrant?.clientId === client.client_id) this.revokeGrant(replayedGrant.id)
      throw new InvalidGrantError('The refresh token expired, was revoked, or was already used.')
    }

    const grant = ownValue(this.store.data.grants, saved.grantId)
    if (!grant || saved.expires <= this.now() || grant.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid refresh token.')
    }
    if (scopes && (!scopes.includes(READ) || scopes.some(scope => !grant.scopes.includes(scope)))) {
      throw new InvalidScopeError('Refresh must retain read access and cannot broaden authorized scopes.')
    }

    // Confirm the upstream session still belongs to the same openGym profile.
    const me = await this.api.me(grant.upstreamToken)
    if (me.user.id !== grant.uid) {
      throw new InvalidGrantError('The openGym profile does not match this authorization.')
    }
    if (me.token) grant.upstreamToken = me.token
    if (scopes) grant.scopes = scopes

    delete this.store.data.refresh[tokenHash]
    this.store.data.spentRefresh[tokenHash] = { grantId: grant.id, expires: grant.expires }
    return this.issue(grant)
  }

  /**
   * Resolve a bearer token for the MCP endpoint. Tokens that are not issued by
   * this server are treated as paired-session bearer tokens and checked
   * against the openGym API, because non-OAuth MCP clients connect that way.
   */
  async verifyAccessToken(token) {
    // A refresh token is only valid at the token endpoint. It must never be forwarded upstream.
    if (token.startsWith(REFRESH_TOKEN_PREFIX)) {
      throw new InvalidTokenError('A refresh token cannot be used as an access token.')
    }
    if (!token.startsWith(ACCESS_TOKEN_PREFIX)) {
      const me = await this.api.me(token)
      return {
        token,
        clientId: PAIRED_SESSION_CLIENT_ID,
        scopes: [...ALL_SCOPES],
        resource: new URL(this.resource),
        extra: { user: me.user, upstreamToken: me.token || token }
      }
    }

    const access = ownValue(this.store.data.access, sha256Hex(token))
    const grant = access && ownValue(this.store.data.grants, access.grantId)
    if (!grant || !access || access.expires <= this.now() || grant.expires <= this.now() || grant.resource !== this.resource) {
      throw new InvalidTokenError('Invalid or expired openGym MCP token.')
    }

    const me = await this.api.me(grant.upstreamToken)
    if (me.user.id !== grant.uid) {
      throw new InvalidTokenError('The openGym profile does not match this authorization.')
    }
    if (me.token) {
      grant.upstreamToken = me.token
      this.store.save()
    }
    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      resource: new URL(this.resource),
      expiresAt: Math.floor(access.expires / SECOND_MS),
      extra: { user: me.user, upstreamToken: grant.upstreamToken }
    }
  }

  // --- Revocation ---

  /** Delete a grant and every access, refresh and spent-refresh record that belongs to it. */
  revokeGrant(grantId) {
    delete this.store.data.grants[grantId]
    for (const kind of ['access', 'refresh', 'spentRefresh']) {
      const entries = this.store.data[kind]
      for (const [key, value] of Object.entries(entries)) {
        if (value.grantId === grantId) delete entries[key]
      }
    }
    this.store.save()
  }

  /** RFC 7009 revocation: only the client that owns the grant may revoke it; otherwise a silent no-op. */
  async revokeToken(client, request) {
    const tokenHash = sha256Hex(request.token)
    const saved = ownValue(this.store.data.access, tokenHash) || ownValue(this.store.data.refresh, tokenHash)
    const grant = saved && ownValue(this.store.data.grants, saved.grantId)
    if (grant?.clientId === client.client_id) this.revokeGrant(grant.id)
  }
}

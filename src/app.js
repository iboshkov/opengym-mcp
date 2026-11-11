import express from 'express'
import { hostGuard, securityHeaders } from './http/security.js'
import { mcpRouter } from './mcp/endpoint.js'
import { OpenGymAuth } from './oauth/provider.js'
import { oauthRouter } from './oauth/routes.js'
import { MemoryStore } from './storage/store.js'
import { version } from './version.js'
import { webRouter } from './web/routes.js'

const MAX_TRUSTED_PROXY_HOPS = 5

/**
 * Assemble the HTTP service.
 *
 * @param {object} options
 * @param {string} options.origin              Public origin of this service, e.g. https://gym-mcp.example.com
 * @param {OpenGymApi} options.api             Client for the OpenGym API
 * @param {string|null} [options.openGymPublicUrl]  Address people open openGym at; defaults to the API base
 * @param {MemoryStore} [options.store]        Authorization store; in-memory unless one is supplied
 * @param {number} [options.trustProxyHops]    Reverse proxies in front of the service (0 to 5)
 * @param {boolean} [options.rateLimits]       Disable only in tests
 * @param {Function} [options.fetchImpl]       Client metadata fetcher override, for tests
 * @param {Function} [options.now]             Clock override, for tests
 */
export function createApp({ origin, api, openGymPublicUrl = api.base, store = new MemoryStore(), trustProxyHops = 0, rateLimits = true, fetchImpl, now } = {}) {
  const auth = new OpenGymAuth({ origin, api, store, openGymPublicUrl, fetchImpl, ...(now ? { now } : {}) })

  const app = express()
  app.disable('x-powered-by')
  if (Number.isInteger(trustProxyHops) && trustProxyHops > 0 && trustProxyHops <= MAX_TRUSTED_PROXY_HOPS) {
    app.set('trust proxy', trustProxyHops)
  }

  app.use(hostGuard(auth.origin))
  app.use(securityHeaders)
  app.get('/healthz', (req, res) => res.json({ ok: true, service: 'opengym-mcp', version }))
  app.use(webRouter({ origin: auth.origin, openGymPublicUrl }))
  app.use(oauthRouter({ auth, rateLimits }))
  app.use('/mcp', mcpRouter({ api, auth, store, rateLimits }))

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }))
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    const status = [404, 413].includes(error.status) ? error.status : error instanceof SyntaxError ? 400 : 500
    res.status(status).json({ error: status === 404 ? 'Not found.' : 'The request could not be processed.' })
  })

  return { app, auth, api }
}

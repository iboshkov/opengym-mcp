import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { hostGuard, securityHeaders } from './http/security.ts'
import { mcpRouter } from './mcp/endpoint.ts'
import { OpenGymAuth } from './oauth/provider.ts'
import { oauthRouter } from './oauth/routes.ts'
import type { OpenGymApi } from './opengym/api.ts'
import { MemoryStore } from './storage/store.ts'
import type { Store } from './storage/store.ts'
import { version } from './version.ts'
import { webRouter } from './web/routes.ts'

const MAX_TRUSTED_PROXY_HOPS = 5

export interface AppOptions {
  /** Public origin of this service, e.g. https://gym-mcp.example.com */
  origin: string
  /** Client for the openGym API */
  api: OpenGymApi
  /** Address people open openGym at; defaults to the API base */
  openGymPublicUrl?: string | null
  /** Authorization store; in-memory unless one is supplied */
  store?: Store
  /** Reverse proxies in front of the service (0 to 5) */
  trustProxyHops?: number
  /** Disable only in tests */
  rateLimits?: boolean
  /** Client metadata fetcher override, for tests */
  fetchImpl?: ConstructorParameters<typeof OpenGymAuth>[0]['fetchImpl']
  /** Clock override, for tests */
  now?: () => number
}

/** Assemble the HTTP service. */
export function createApp({ origin, api, openGymPublicUrl = api.base, store = new MemoryStore(), trustProxyHops = 0, rateLimits = true, fetchImpl, now }: AppOptions) {
  const auth = new OpenGymAuth({ origin, api, store, openGymPublicUrl, fetchImpl, ...(now ? { now } : {}) })

  const app = express()
  app.disable('x-powered-by')
  if (Number.isInteger(trustProxyHops) && trustProxyHops > 0 && trustProxyHops <= MAX_TRUSTED_PROXY_HOPS) {
    app.set('trust proxy', trustProxyHops)
  }

  app.use(hostGuard(auth.origin))
  app.use(securityHeaders)
  app.get('/healthz', (req: Request, res: Response) => res.json({ ok: true, service: 'opengym-mcp', version }))
  app.use(webRouter({ origin: auth.origin, openGymPublicUrl }))
  app.use(oauthRouter({ auth, rateLimits }))
  app.use('/mcp', mcpRouter({ api, auth, store, rateLimits }))

  app.use((req: Request, res: Response) => res.status(404).json({ error: 'Not found.' }))
  app.use((error: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error)
    const status = error.status !== undefined && [404, 413].includes(error.status) ? error.status : error instanceof SyntaxError ? 400 : 500
    res.status(status).json({ error: status === 404 ? 'Not found.' : 'The request could not be processed.' })
  })

  return { app, auth, api }
}

import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { ALL_SCOPES } from '../scopes.js'
import { authorizationErrorPage } from '../web/pages.js'

const CONSENT_ATTEMPTS_PER_15_MIN = 30

/**
 * Adapt the SDK's /authorize responses for people and for RFC 9207:
 * a browser gets a recovery page instead of a JSON error, and every redirect
 * back to the client carries the issuer (`iss`) and the client's `state`.
 */
function authorizeResponses(auth) {
  return (req, res, next) => {
    if (String(req.headers.accept || '').includes('text/html')) {
      const json = res.json.bind(res)
      res.json = body => (body?.error ? res.type('html').send(authorizationErrorPage()) : json(body))
    }
    const redirect = res.redirect.bind(res)
    res.redirect = (status, target) => {
      const url = new URL(typeof status === 'string' ? status : target)
      url.searchParams.set('iss', auth.origin)
      if (!url.searchParams.has('state') && typeof req.query.state === 'string') {
        url.searchParams.set('state', req.query.state)
      }
      return redirect(typeof status === 'number' ? status : 302, url.href)
    }
    next()
  }
}

/** Discovery metadata, the SDK's OAuth endpoints, and the pairing-code consent form. */
export function oauthRouter({ auth, rateLimits }) {
  const router = express.Router()
  const unlimited = { rateLimit: false }

  router.get('/.well-known/oauth-authorization-server', (req, res) => res.json(auth.metadata()))
  router.get(
    ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
    (req, res) => res.json(auth.resourceMetadata())
  )

  router.use('/authorize', authorizeResponses(auth))
  router.use(mcpAuthRouter({
    provider: auth,
    issuerUrl: new URL(auth.origin),
    resourceServerUrl: new URL(auth.resource),
    scopesSupported: ALL_SCOPES,
    clientRegistrationOptions: { clientSecretExpirySeconds: 0, ...(rateLimits ? {} : unlimited) },
    ...(rateLimits ? {} : { authorizationOptions: unlimited, tokenOptions: unlimited, revocationOptions: unlimited })
  }))

  const consentLimit = rateLimits
    ? [rateLimit({ windowMs: 15 * 60_000, limit: CONSENT_ATTEMPTS_PER_15_MIN, standardHeaders: 'draft-8', legacyHeaders: false })]
    : []
  router.post('/consent', ...consentLimit, express.urlencoded({ extended: false, limit: '4kb' }),
    (req, res, next) => auth.consent(req, res).catch(next))

  return router
}

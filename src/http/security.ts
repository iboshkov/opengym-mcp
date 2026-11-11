import type { NextFunction, Request, RequestHandler, Response } from 'express'

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1']

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ')

/**
 * Accept requests only for the public hostname or loopback. The raw Host
 * header is checked, so a trusted proxy's X-Forwarded-Host cannot widen it.
 */
export function hostGuard(publicOrigin: string): RequestHandler {
  const allowed = new Set([new URL(publicOrigin).hostname, ...LOOPBACK_HOSTS])
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const url = new URL('http://' + req.headers.host)
      const bareHost = !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      if (bareHost && allowed.has(url.hostname)) return next()
    } catch { /* an unparsable Host header is rejected below */ }
    res.status(421).send('Unrecognized host.')
  }
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.set({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // "no-referrer" would make native form posts send "Origin: null" and defeat the
    // same-origin consent check. "same-origin" still withholds referrers from other sites.
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY
  })
  next()
}

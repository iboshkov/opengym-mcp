import express, { type Router } from 'express'
import { fileURLToPath } from 'node:url'
import { connectionPage } from './pages.ts'

const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url))

/** The connection guide and its static assets. */
export function webRouter({ origin, openGymPublicUrl }: { origin: string, openGymPublicUrl?: string | null }): Router {
  const router = express.Router()
  router.get(['/', '/help'], (req, res) => {
    res.type('html').send(connectionPage({ mcpUrl: origin + '/mcp', openGymUrl: openGymPublicUrl }))
  })
  router.use('/assets', express.static(PUBLIC_DIR, {
    index: false,
    fallthrough: false,
    // Revalidate on every load so a page never pairs with a stylesheet from an older version.
    setHeaders: res => res.set('Cache-Control', 'no-cache')
  }))
  return router
}

import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ALL_SCOPES } from '../scopes.js'
import { instructions, toolDefinitions } from '../tools/index.js'
import { version } from '../version.js'
import { createToolRunner } from './tool-runner.js'

const BEARER = /^Bearer ([A-Za-z0-9._:~+/=-]{1,2048})$/
const REQUESTS_PER_MINUTE = 180

/**
 * The Streamable HTTP MCP endpoint. It is stateless: every POST is
 * authenticated, served by a fresh MCP server and answered with JSON.
 */
export function mcpRouter({ api, auth, store, rateLimits }) {
  const router = express.Router()
  const runTool = createToolRunner({ api, auth, store })

  const unauthorized = (res, message) => res
    .set('WWW-Authenticate', auth.challenge(ALL_SCOPES))
    .status(401)
    .json({ error: message })

  if (rateLimits) {
    router.use(rateLimit({ windowMs: 60_000, limit: REQUESTS_PER_MINUTE, standardHeaders: 'draft-8', legacyHeaders: false }))
  }

  router.use(async (req, res, next) => {
    // Browsers send Origin; a page on another site must not drive this endpoint.
    if (req.headers.origin && req.headers.origin !== auth.origin) {
      return res.status(403).json({ error: 'Unrecognized Origin.' })
    }
    const token = BEARER.exec(req.headers.authorization || '')?.[1]
    if (!token) return unauthorized(res, 'Connect your openGym profile using OAuth or a paired-session bearer token.')
    try {
      req.auth = await auth.verifyAccessToken(token)
    } catch {
      return unauthorized(res, 'Authorization expired or was revoked. Reconnect openGym.')
    }
    next()
  })

  router.get('/', (req, res) => res.set('Allow', 'POST').status(405)
    .json({ error: 'Use Streamable HTTP POST requests. This server returns JSON responses rather than an SSE stream.' }))
  router.delete('/', (req, res) => res.set('Allow', 'POST').status(405)
    .json({ error: 'This transport is stateless. Revoke the OAuth grant to disconnect.' }))

  router.post('/', express.json({ limit: '1mb' }), async (req, res, next) => {
    const server = new Server({ name: 'opengym', version }, { capabilities: { tools: {} }, instructions })
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolDefinitions }))
    server.setRequestHandler(CallToolRequestSchema, request => runTool(req.auth, request.params))

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void server.close() })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      next(error)
    }
  })

  return router
}

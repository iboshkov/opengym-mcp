import { z } from 'zod'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ApiError } from '../opengym/api.ts'
import type { OpenGymApi } from '../opengym/api.ts'
import { READ, WRITE, scopesFor } from '../scopes.ts'
import type { OpenGymAuth, AuthExtra } from '../oauth/provider.ts'
import type { Store } from '../storage/store.ts'
import { tools } from '../tools/index.ts'
import { WriteLimiter } from './write-limit.ts'
import { WriteReceipts } from './write-receipts.ts'

const toolsByName = new Map(tools.map(tool => [tool.name, tool]))

const failure = (text: string, extra: { _meta?: Record<string, unknown> } = {}): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text }],
  ...extra
})

function success(result: unknown): CallToolResult {
  const isObject = result && typeof result === 'object' && !Array.isArray(result)
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(isObject ? { structuredContent: result as Record<string, unknown> } : {})
  }
}

function describeError(error: unknown) {
  if (error instanceof z.ZodError) {
    return 'Invalid tool arguments: ' + error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
  }
  if (error instanceof ApiError) return `${error.code}: ${error.message}`
  // Anything else may carry internal detail, so the assistant gets a generic message.
  return 'The openGym operation could not be completed. Read the current record before retrying a write.'
}

export interface ToolRunnerOptions {
  api: OpenGymApi
  auth: OpenGymAuth
  store: Store
}

/** The `params` of an MCP tools/call request. */
export interface ToolCall {
  name: string
  arguments?: Record<string, unknown>
}

/** Executes one MCP tool call for an authenticated profile. */
export interface ToolRunner {
  (authInfo: AuthInfo, call: ToolCall): Promise<CallToolResult>
}

/**
 * Build the function that executes one MCP tool call for an authenticated
 * profile: scope check, argument validation, write limit, idempotent retries.
 */
export function createToolRunner({ api, auth, store }: ToolRunnerOptions): ToolRunner {
  const receipts = new WriteReceipts(store)
  const limiter = new WriteLimiter()

  return async function runTool(authInfo, { name, arguments: args }) {
    const tool = toolsByName.get(name)
    if (!tool) return failure('Unknown openGym tool.')

    const { user, upstreamToken } = authInfo.extra as unknown as AuthExtra
    const permitted = authInfo.scopes.includes(READ) && (!tool.write || authInfo.scopes.includes(WRITE))
    if (!permitted) {
      return failure('Reconnect openGym and authorize the required read/write permissions.', {
        _meta: { 'mcp/www_authenticate': [auth.challenge(scopesFor(tool))] }
      })
    }

    try {
      const params = z.object(tool.schema).strict().parse(args || {})
      const savesChanges = tool.write && params.dry_run !== true

      const execute = async () => {
        if (savesChanges) limiter.consume(user.id)
        const document = await api.document(upstreamToken)
        const context = { api, token: upstreamToken, user, state: document.state, revision: document.rev }
        return success(await tool.run(params, context))
      }

      if (!savesChanges || !params.request_id) return await execute()
      return await receipts.run({ userId: user.id, toolName: tool.name, requestId: params.request_id as string, params }, execute)
    } catch (error) {
      return failure(describeError(error))
    }
  }
}

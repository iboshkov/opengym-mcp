import { z } from 'zod'
import { ApiError } from '../opengym/api.js'
import { READ, WRITE, scopesFor } from '../scopes.js'
import { tools } from '../tools/index.js'
import { WriteLimiter } from './write-limit.js'
import { WriteReceipts } from './write-receipts.js'

const toolsByName = new Map(tools.map(tool => [tool.name, tool]))

const failure = (text, extra = {}) => ({ isError: true, content: [{ type: 'text', text }], ...extra })

function success(result) {
  const isObject = result && typeof result === 'object' && !Array.isArray(result)
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(isObject ? { structuredContent: result } : {})
  }
}

function describeError(error) {
  if (error instanceof z.ZodError) {
    return 'Invalid tool arguments: ' + error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
  }
  if (error instanceof ApiError) return `${error.code}: ${error.message}`
  // Anything else may carry internal detail, so the assistant gets a generic message.
  return 'The openGym operation could not be completed. Read the current record before retrying a write.'
}

/**
 * Build the function that executes one MCP tool call for an authenticated
 * profile: scope check, argument validation, write limit, idempotent retries.
 */
export function createToolRunner({ api, auth, store }) {
  const receipts = new WriteReceipts(store)
  const limiter = new WriteLimiter()

  return async function runTool(authInfo, { name, arguments: args }) {
    const tool = toolsByName.get(name)
    if (!tool) return failure('Unknown openGym tool.')

    const { user, upstreamToken } = authInfo.extra
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
      return await receipts.run({ userId: user.id, toolName: tool.name, requestId: params.request_id, params }, execute)
    } catch (error) {
      return failure(describeError(error))
    }
  }
}

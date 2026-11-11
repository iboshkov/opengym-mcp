/**
 * Wrappers that expose the vendored upstream openGym tools through this
 * service. Upstream handlers read the profile through an ambient API state, so
 * each call runs inside withApiState for the connected user.
 */
import { TOOLS as vendoredReads } from '../../vendor/opengym/mcp/src/tools.js'
import { WRITE_TOOLS as vendoredWrites } from '../../vendor/opengym/mcp/src/write-tools.js'
import { withApiState } from '../../vendor/opengym/mcp/src/state.js'
import type { z } from 'zod'
import type { ToolContext, ToolDefinition } from './shared.ts'

/** An upstream tool. The vendored modules are untyped JavaScript, so this is the shape they actually carry. */
interface UpstreamTool {
  name: string
  description: string
  schema: z.ZodRawShape
  handler(
    params: Record<string, unknown>,
    options?: { env: Record<string, string>, fetchImpl: ToolContext['api']['fetch'] }
  ): unknown
}

const upstreamReads = vendoredReads as unknown as UpstreamTool[]
const upstreamWrites = vendoredWrites as unknown as UpstreamTool[]

export const upstreamReadTools: ToolDefinition[] = upstreamReads.map(tool => ({
  ...tool,
  write: false,
  run: async (params: Record<string, unknown>, context: ToolContext) => withApiState(context.user, context.state, () => tool.handler(params))
}))

export const upstreamWriteTools: ToolDefinition[] = upstreamWrites.map(tool => ({
  ...tool,
  write: true,
  run: (params: Record<string, unknown>, context: ToolContext) => withApiState(context.user, context.state, () => tool.handler(params, {
    env: {
      OPENGYM_URL: context.api.base,
      OPENGYM_TOKEN: context.token,
      OPENGYM_ALLOW_HTTP: '1'
    },
    fetchImpl: context.api.fetch
  }))
}))

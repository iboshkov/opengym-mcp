/**
 * Wrappers that expose the vendored upstream openGym tools through this
 * service. Upstream handlers read the profile through an ambient API state, so
 * each call runs inside withApiState for the connected user.
 */
import { TOOLS as upstreamReads } from '../../vendor/opengym/mcp/src/tools.js'
import { WRITE_TOOLS as upstreamWrites } from '../../vendor/opengym/mcp/src/write-tools.js'
import { withApiState } from '../../vendor/opengym/mcp/src/state.js'

export const upstreamReadTools = upstreamReads.map(tool => ({
  ...tool,
  write: false,
  run: async (params, context) => withApiState(context.user, context.state, () => tool.handler(params))
}))

export const upstreamWriteTools = upstreamWrites.map(tool => ({
  ...tool,
  write: true,
  run: (params, context) => withApiState(context.user, context.state, () => tool.handler(params, {
    env: {
      OPENGYM_URL: context.api.base,
      OPENGYM_TOKEN: context.token,
      OPENGYM_ALLOW_HTTP: '1'
    },
    fetchImpl: context.api.fetch
  }))
}))

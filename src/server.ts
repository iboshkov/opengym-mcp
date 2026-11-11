import { createApp } from './app.ts'
import { ConfigError, loadConfig } from './config.ts'
import { OpenGymApi } from './opengym/api.ts'
import { EncryptedStore, ensureStorageKey } from './storage/store.ts'
import { version } from './version.ts'

const SHUTDOWN_GRACE_MS = 10_000

function start(): void {
  const config = loadConfig()
  if (config.generateKey && ensureStorageKey(config.keyFile, config.storePath)) {
    console.log(`Created a new storage key at ${config.keyFile}. Back it up together with the data directory.`)
  }

  const api = new OpenGymApi(config.openGymUrl, { allowInsecureHttp: config.allowInsecureHttp })
  const store = new EncryptedStore(config.storePath, config.keyFile)
  const { app } = createApp({
    origin: config.publicOrigin,
    openGymPublicUrl: config.openGymPublicUrl,
    trustProxyHops: config.trustProxyHops,
    api,
    store
  })

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`openGym MCP ${version} is listening on port ${config.port}.`)
    console.log(`MCP endpoint: ${config.publicOrigin}/mcp, openGym API: ${config.openGymUrl}`)
    if (!config.openGymPublicUrl) {
      console.log('OPENGYM_PUBLIC_URL is not set, so the connection pages cannot link to openGym.')
    }
    console.log('Tokens, pairing codes and workout data are never logged.')
  })
  server.headersTimeout = 15_000
  server.requestTimeout = 90_000

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref()
    })
  }
}

try {
  start()
} catch (error) {
  // Configuration and storage problems are operator errors: say what to fix, without a stack trace.
  const prefix = error instanceof ConfigError ? 'Configuration error' : 'openGym MCP could not start'
  console.error(`${prefix}: ${(error as Error).message}`)
  process.exit(1)
}

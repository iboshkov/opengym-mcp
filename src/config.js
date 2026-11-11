import path from 'node:path'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export const isLoopbackHost = hostname => LOOPBACK_HOSTS.has(hostname)

/**
 * A single-label hostname ("opengym", "api") only resolves on a private
 * network such as a Compose or Kubernetes network, never on the public internet.
 */
export const isPrivateServiceHost = hostname => isLoopbackHost(hostname) || /^[a-z0-9-]+$/i.test(hostname)

export class ConfigError extends Error {}

const read = (env, name) => String(env[name] ?? '').trim()
const isEnabled = value => ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
const withoutTrailingSlash = url => url.href.replace(/\/+$/, '')

function required(env, name) {
  const value = read(env, name)
  if (!value) throw new ConfigError(`${name} is required. See docs/CONFIGURATION.md.`)
  return value
}

function integer(env, name, fallback, { min, max }) {
  const raw = read(env, name)
  if (!raw) return fallback
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number between ${min} and ${max}.`)
  }
  return value
}

function httpUrl(name, raw) {
  let url
  try { url = new URL(raw) } catch { throw new ConfigError(`${name} is not a valid URL.`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConfigError(`${name} must be an http(s) URL without credentials, query or fragment.`)
  }
  return url
}

/**
 * Read and validate the service configuration from environment variables.
 * Every setting is documented in docs/CONFIGURATION.md.
 */
export function loadConfig(env = process.env) {
  const publicOrigin = httpUrl('PUBLIC_ORIGIN', required(env, 'PUBLIC_ORIGIN'))
  if (publicOrigin.pathname !== '/') {
    throw new ConfigError('PUBLIC_ORIGIN must be a bare origin such as https://gym-mcp.example.com. Subpath deployments are not supported.')
  }
  if (publicOrigin.protocol !== 'https:' && !isLoopbackHost(publicOrigin.hostname)) {
    throw new ConfigError('PUBLIC_ORIGIN must use HTTPS (plain HTTP is accepted for localhost only).')
  }

  const openGymUrl = httpUrl('OPENGYM_URL', required(env, 'OPENGYM_URL'))
  const allowInsecureHttp = isEnabled(read(env, 'OPENGYM_ALLOW_HTTP'))
  if (openGymUrl.protocol === 'http:' && !allowInsecureHttp && !isPrivateServiceHost(openGymUrl.hostname)) {
    throw new ConfigError('OPENGYM_URL must use HTTPS unless it is localhost or a private service name such as http://opengym:8080. Set OPENGYM_ALLOW_HTTP=true to accept plain HTTP to another trusted private address.')
  }

  // The address people open openGym at in their browser. When OPENGYM_URL is an
  // internal service address, the pages can only link to openGym if this is set.
  const explicitPublicUrl = read(env, 'OPENGYM_PUBLIC_URL')
  let openGymPublicUrl = null
  if (explicitPublicUrl) openGymPublicUrl = withoutTrailingSlash(httpUrl('OPENGYM_PUBLIC_URL', explicitPublicUrl))
  else if (openGymUrl.protocol === 'https:') openGymPublicUrl = withoutTrailingSlash(openGymUrl)

  const dataDir = path.resolve(read(env, 'DATA_DIR') || './data')
  const keyFile = read(env, 'AUTH_KEY_FILE')

  return {
    publicOrigin: publicOrigin.origin,
    openGymUrl: withoutTrailingSlash(openGymUrl),
    openGymPublicUrl,
    allowInsecureHttp,
    port: integer(env, 'PORT', 8082, { min: 1, max: 65535 }),
    trustProxyHops: integer(env, 'TRUST_PROXY_HOPS', 0, { min: 0, max: 5 }),
    storePath: read(env, 'AUTH_STORE_PATH') || path.join(dataDir, 'state.enc'),
    keyFile: keyFile || path.join(dataDir, 'storage.key'),
    // A key file the operator supplied (for example a Docker secret) is never created for them.
    generateKey: !keyFile
  }
}

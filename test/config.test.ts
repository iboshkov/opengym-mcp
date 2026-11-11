import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { ConfigError, loadConfig } from '../src/config.ts'

const base: Record<string, string> = { PUBLIC_ORIGIN: 'https://gym-mcp.example.com', OPENGYM_URL: 'https://gym.example.com' }
const load = (extra: Record<string, string> = {}) => loadConfig({ ...base, ...extra })

test('PUBLIC_ORIGIN and OPENGYM_URL are required', () => {
  assert.throws(() => loadConfig({}), (error: unknown) => error instanceof ConfigError && /PUBLIC_ORIGIN is required/.test(error.message))
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: base.PUBLIC_ORIGIN }), (error: unknown) => error instanceof ConfigError && /OPENGYM_URL is required/.test(error.message))
  assert.throws(() => loadConfig({ OPENGYM_URL: base.OPENGYM_URL }), (error: unknown) => error instanceof ConfigError && /PUBLIC_ORIGIN is required/.test(error.message))
  assert.throws(() => load({ PUBLIC_ORIGIN: '   ' }), ConfigError)
})

test('PUBLIC_ORIGIN must be an https origin without a path, except plain http on localhost', () => {
  assert.equal(load().publicOrigin, 'https://gym-mcp.example.com')
  assert.equal(load({ PUBLIC_ORIGIN: 'https://gym-mcp.example.com/' }).publicOrigin, 'https://gym-mcp.example.com')
  for (const local of ['http://localhost:8082', 'http://127.0.0.1:8082', 'http://[::1]:8082']) {
    assert.equal(load({ PUBLIC_ORIGIN: local }).publicOrigin, new URL(local).origin, local)
  }
  for (const plain of ['http://gym-mcp.example.com', 'http://192.168.1.10:8082', 'http://gym-mcp']) {
    assert.throws(() => load({ PUBLIC_ORIGIN: plain }), (error: unknown) => error instanceof ConfigError && /HTTPS/.test(error.message), plain)
  }
  for (const withPath of ['https://gym-mcp.example.com/mcp', 'https://example.com/gym', 'http://localhost:8082/app']) {
    assert.throws(() => load({ PUBLIC_ORIGIN: withPath }), (error: unknown) => error instanceof ConfigError && /bare origin/.test(error.message), withPath)
  }
  for (const invalid of ['not a url', 'ftp://gym-mcp.example.com', 'https://user:pass@gym-mcp.example.com', 'https://gym-mcp.example.com/?a=1', 'https://gym-mcp.example.com/#x']) {
    assert.throws(() => load({ PUBLIC_ORIGIN: invalid }), ConfigError, invalid)
  }
})

test('OPENGYM_URL accepts https, localhost and single-label private service names', () => {
  assert.equal(load().openGymUrl, 'https://gym.example.com')
  assert.equal(load({ OPENGYM_URL: 'https://gym.example.com/' }).openGymUrl, 'https://gym.example.com')
  assert.equal(load({ OPENGYM_URL: 'http://localhost:3000' }).openGymUrl, 'http://localhost:3000')
  assert.equal(load({ OPENGYM_URL: 'http://127.0.0.1:3000' }).openGymUrl, 'http://127.0.0.1:3000')
  assert.equal(load({ OPENGYM_URL: 'http://api:3000' }).openGymUrl, 'http://api:3000')
  assert.equal(load({ OPENGYM_URL: 'http://opengym' }).openGymUrl, 'http://opengym')
})

test('OPENGYM_URL rejects plain http to a public-looking host unless OPENGYM_ALLOW_HTTP is enabled', () => {
  for (const url of ['http://gym.example.com', 'http://10.0.0.5:3000', 'http://api.internal:3000']) {
    assert.throws(() => load({ OPENGYM_URL: url }), (error: unknown) => error instanceof ConfigError && /HTTPS/.test(error.message), url)
    assert.throws(() => load({ OPENGYM_URL: url, OPENGYM_ALLOW_HTTP: 'false' }), ConfigError, url)
    assert.throws(() => load({ OPENGYM_URL: url, OPENGYM_ALLOW_HTTP: '' }), ConfigError, url)
  }
  for (const flag of ['true', 'TRUE', '1', 'yes', 'on']) {
    const config = load({ OPENGYM_URL: 'http://gym.example.com', OPENGYM_ALLOW_HTTP: flag })
    assert.equal(config.openGymUrl, 'http://gym.example.com', flag)
    assert.equal(config.allowInsecureHttp, true, flag)
  }
  assert.equal(load().allowInsecureHttp, false)
})

test('OPENGYM_URL must be a plain http(s) URL', () => {
  for (const url of ['not a url', 'ftp://gym.example.com', 'https://user:pass@gym.example.com', 'https://gym.example.com/?token=1', 'https://gym.example.com/#frag']) {
    assert.throws(() => load({ OPENGYM_URL: url }), ConfigError, url)
  }
})

test('openGymPublicUrl: an explicit value wins, https is reused, an internal http address gives null', () => {
  assert.equal(load().openGymPublicUrl, 'https://gym.example.com')
  assert.equal(load({ OPENGYM_URL: 'https://gym.example.com/' }).openGymPublicUrl, 'https://gym.example.com')

  const explicit = load({ OPENGYM_PUBLIC_URL: 'https://app.gym.example.com/' })
  assert.equal(explicit.openGymPublicUrl, 'https://app.gym.example.com')
  assert.equal(explicit.openGymUrl, 'https://gym.example.com')

  const overridden = load({ OPENGYM_URL: 'http://api:3000', OPENGYM_PUBLIC_URL: 'https://gym.example.com' })
  assert.equal(overridden.openGymPublicUrl, 'https://gym.example.com')
  assert.equal(overridden.openGymUrl, 'http://api:3000')

  for (const internal of ['http://api:3000', 'http://localhost:3000', 'http://127.0.0.1:3000']) {
    assert.equal(load({ OPENGYM_URL: internal }).openGymPublicUrl, null, internal)
  }
  assert.equal(load({ OPENGYM_URL: 'http://api:3000', OPENGYM_PUBLIC_URL: '  ' }).openGymPublicUrl, null)
  assert.throws(() => load({ OPENGYM_PUBLIC_URL: 'gym.example.com' }), ConfigError)
  assert.throws(() => load({ OPENGYM_PUBLIC_URL: 'https://user:pass@gym.example.com' }), ConfigError)
})

test('defaults for port, proxy hops and storage paths', () => {
  const config = load()
  assert.equal(config.port, 8082)
  assert.equal(config.trustProxyHops, 0)
  assert.equal(config.storePath, path.join(path.resolve('./data'), 'state.enc'))
  assert.equal(config.keyFile, path.join(path.resolve('./data'), 'storage.key'))
  assert.equal(config.generateKey, true)
})

test('PORT and TRUST_PROXY_HOPS are parsed as bounded whole numbers', () => {
  assert.equal(load({ PORT: '9000' }).port, 9000)
  assert.equal(load({ PORT: '1' }).port, 1)
  assert.equal(load({ PORT: '65535' }).port, 65535)
  assert.equal(load({ TRUST_PROXY_HOPS: '2' }).trustProxyHops, 2)
  assert.equal(load({ TRUST_PROXY_HOPS: '5' }).trustProxyHops, 5)
  for (const port of ['0', '65536', '-1', '80.5', 'abc']) {
    assert.throws(() => load({ PORT: port }), (error: unknown) => error instanceof ConfigError && /PORT/.test(error.message), port)
  }
  for (const hops of ['6', '-1', '1.5', 'many']) {
    assert.throws(() => load({ TRUST_PROXY_HOPS: hops }), (error: unknown) => error instanceof ConfigError && /TRUST_PROXY_HOPS/.test(error.message), hops)
  }
})

test('DATA_DIR moves both default storage files', () => {
  const dataDir = path.resolve('some', 'data-dir')
  const config = load({ DATA_DIR: dataDir })
  assert.equal(config.storePath, path.join(dataDir, 'state.enc'))
  assert.equal(config.keyFile, path.join(dataDir, 'storage.key'))
  assert.equal(config.generateKey, true)
})

test('AUTH_STORE_PATH and AUTH_KEY_FILE override the defaults independently', () => {
  const dataDir = path.resolve('some', 'data-dir')
  const store = path.resolve('elsewhere', 'store.enc')
  const key = path.resolve('secrets', 'key')

  const storeOnly = load({ DATA_DIR: dataDir, AUTH_STORE_PATH: store })
  assert.equal(storeOnly.storePath, store)
  assert.equal(storeOnly.keyFile, path.join(dataDir, 'storage.key'))
  assert.equal(storeOnly.generateKey, true)

  const keyOnly = load({ DATA_DIR: dataDir, AUTH_KEY_FILE: key })
  assert.equal(keyOnly.storePath, path.join(dataDir, 'state.enc'))
  assert.equal(keyOnly.keyFile, key)
})

test('a supplied AUTH_KEY_FILE is never generated for the operator', () => {
  assert.equal(load({ AUTH_KEY_FILE: path.resolve('secrets', 'key') }).generateKey, false)
  assert.equal(load({ AUTH_KEY_FILE: '   ' }).generateKey, true)
})

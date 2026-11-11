import { randomUUID } from 'node:crypto'
import { isPrivateServiceHost } from '../config.js'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_SAVE_ATTEMPTS = 3

/** An error whose code and message are safe to show to the connected assistant. */
export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Client for the openGym HTTP API. Every call carries the profile's own session token. */
export class OpenGymApi {
  constructor(base, { fetchImpl = fetch, allowInsecureHttp = false } = {}) {
    const url = new URL(base)
    const webUrl = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    const insecure = url.protocol === 'http:' && !allowInsecureHttp && !isPrivateServiceHost(url.hostname)
    if (!webUrl || insecure) {
      throw new Error('OPENGYM_URL must be HTTPS, or HTTP to localhost or a private service name, without credentials or query parameters.')
    }
    this.base = url.href.replace(/\/+$/, '')
    this.fetch = fetchImpl
  }

  async request(path, token, { method = 'GET', body, allowConflict = false } = {}) {
    const headers = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'

    let response
    try {
      response = await this.fetch(this.base + path, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    } catch {
      throw new ApiError('EAPI', 'openGym could not be reached. A write may have completed; read the relevant record before retrying.')
    }

    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new ApiError('EAPI', 'openGym returned an oversized response.', response.status)
    }
    let data
    try { data = JSON.parse(text) } catch {
      throw new ApiError('EAPI', `openGym returned an unexpected response (${response.status}).`, response.status)
    }
    if (response.status === 401) {
      throw new ApiError('EAUTH', 'openGym authorization expired or was revoked. Reconnect using a new pairing code.', 401)
    }
    if (!response.ok && !(allowConflict && response.status === 409)) {
      throw new ApiError('EAPI', `openGym refused the request (${response.status}).`, response.status)
    }
    return { data, status: response.status }
  }

  /** Redeem a one-time pairing code for a profile session. */
  async pair(code) {
    const normalized = code.replace(/[\s-]/g, '').toUpperCase()
    const { data } = await this.request('/api/pair/redeem', null, { method: 'POST', body: { code: normalized } })
    if (!data.token || !data.user?.id) throw new ApiError('EAUTH', 'openGym did not return a profile session.')
    return data
  }

  /** Identify the profile behind a session token. Fails once the session is revoked. */
  async me(token) {
    const { data } = await this.request('/api/me', token)
    if (!data.user?.id) throw new ApiError('EAUTH', 'openGym did not identify the signed-in profile.')
    return data
  }

  /** The profile document and its revision. */
  async document(token) {
    const { data } = await this.request('/api/data', token)
    const validState = data.state === null || (typeof data.state === 'object' && !Array.isArray(data.state))
    if (!Number.isInteger(data.rev) || !validState) {
      throw new ApiError('EAPI', 'openGym returned an invalid profile document.')
    }
    return data
  }

  /**
   * Apply `operation` to a copy of the latest profile document and save it
   * against the revision it was read at. On a revision conflict the operation
   * is re-applied to the newer document, so edits from other devices survive.
   */
  async mutate(token, operation, { dryRun = false } = {}) {
    let current = await this.document(token)
    // One clock and one ID for every attempt: a retry files the same change, not a later one.
    const context = { now: Date.now(), id: `mcp-${randomUUID()}` }

    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
      if (!current.state) {
        throw new ApiError('ENOSTATE', 'Open the openGym app and sync this profile at least once before writing.')
      }
      const state = structuredClone(current.state)
      const result = operation(state, context)
      if (dryRun) return { saved: false, dry_run: true, result }
      if (JSON.stringify(state) === JSON.stringify(current.state)) {
        return { saved: false, unchanged: true, revision: current.rev, result }
      }

      const body = { state, baseRev: current.rev }
      if (typeof current.state._wid === 'string') body.baseWid = current.state._wid
      const put = await this.request('/api/data', token, { method: 'PUT', allowConflict: true, body })
      if (put.status !== 409) return { saved: true, revision: put.data.rev, result }
      if (!put.data.state || !Number.isInteger(put.data.rev)) {
        throw new ApiError('ECONFLICT', 'openGym returned a conflict without a usable current revision.')
      }
      current = put.data
    }
    throw new ApiError('ECONFLICT', 'The profile kept changing. Read the current records and try the change again.')
  }
}

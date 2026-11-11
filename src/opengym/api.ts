import { randomUUID } from 'node:crypto'
import { isPrivateServiceHost } from '../config.ts'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_SAVE_ATTEMPTS = 3

/** The fetch implementation the client calls, replaceable in tests. */
export type FetchLike = typeof fetch

/** The workout data blob. Its sections belong to the tools, so it is typed loosely. */
export type OpenGymState = { _wid?: string, [key: string]: any }

/** The signed-in profile, as returned by openGym. */
export interface Profile {
  user: { id: string, [key: string]: unknown }
  /** Present when openGym rotated the session token during this request. */
  token?: string
  [key: string]: unknown
}

/** The result of redeeming a pairing code. */
export interface PairResult extends Profile {
  token: string
}

/** The profile document: its revision and its workout data (null until the app first syncs). */
export interface OpenGymDocument {
  rev: number
  state: OpenGymState | null
  [key: string]: unknown
}

/** Per-attempt values shared by every retry of one mutation. */
export interface MutationContext {
  now: number
  id: string
}

export type MutationResult<T> =
  | { saved: false, dry_run: true, result: T }
  | { saved: false, unchanged: true, revision: number, result: T }
  | { saved: true, revision: number, result: T }

interface RequestOptions {
  method?: string
  body?: unknown
  allowConflict?: boolean
}

/** An error whose code and message are safe to show to the connected assistant. */
export class ApiError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Client for the openGym HTTP API. Every call carries the profile's own session token. */
export class OpenGymApi {
  base: string
  fetch: FetchLike
  constructor(base: string, { fetchImpl = fetch, allowInsecureHttp = false }: { fetchImpl?: FetchLike, allowInsecureHttp?: boolean } = {}) {
    const url = new URL(base)
    const webUrl = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    const insecure = url.protocol === 'http:' && !allowInsecureHttp && !isPrivateServiceHost(url.hostname)
    if (!webUrl || insecure) {
      throw new Error('OPENGYM_URL must be HTTPS, or HTTP to localhost or a private service name, without credentials or query parameters.')
    }
    this.base = url.href.replace(/\/+$/, '')
    this.fetch = fetchImpl
  }

  async request<T = Record<string, any>>(path: string, token: string | null | undefined, { method = 'GET', body, allowConflict = false }: RequestOptions = {}): Promise<{ data: T, status: number }> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'

    let response: Response
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
    let data: T
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
  async pair(code: string): Promise<PairResult> {
    const normalized = code.replace(/[\s-]/g, '').toUpperCase()
    const { data } = await this.request<Partial<PairResult>>('/api/pair/redeem', null, { method: 'POST', body: { code: normalized } })
    if (!data.token || !data.user?.id) throw new ApiError('EAUTH', 'openGym did not return a profile session.')
    return data as PairResult
  }

  /** Identify the profile behind a session token. Fails once the session is revoked. */
  async me(token: string): Promise<Profile> {
    const { data } = await this.request<Partial<Profile>>('/api/me', token)
    if (!data.user?.id) throw new ApiError('EAUTH', 'openGym did not identify the signed-in profile.')
    return data as Profile
  }

  /** The profile document and its revision. */
  async document(token: string): Promise<OpenGymDocument> {
    const { data } = await this.request<Partial<OpenGymDocument>>('/api/data', token)
    const validState = data.state === null || (typeof data.state === 'object' && !Array.isArray(data.state))
    if (!Number.isInteger(data.rev) || !validState) {
      throw new ApiError('EAPI', 'openGym returned an invalid profile document.')
    }
    return data as OpenGymDocument
  }

  /**
   * Apply `operation` to a copy of the latest profile document and save it
   * against the revision it was read at. On a revision conflict the operation
   * is re-applied to the newer document, so edits from other devices survive.
   */
  async mutate<T>(token: string, operation: (state: OpenGymState, context: MutationContext) => T, { dryRun = false }: { dryRun?: boolean } = {}): Promise<MutationResult<T>> {
    let current = await this.document(token)
    // One clock and one ID for every attempt: a retry files the same change, not a later one.
    const context: MutationContext = { now: Date.now(), id: `mcp-${randomUUID()}` }

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

      const body: { state: OpenGymState, baseRev: number, baseWid?: string } = { state, baseRev: current.rev }
      if (typeof current.state._wid === 'string') body.baseWid = current.state._wid
      const put = await this.request<Partial<OpenGymDocument>>('/api/data', token, { method: 'PUT', allowConflict: true, body })
      if (put.status !== 409) return { saved: true, revision: put.data.rev as number, result }
      if (!put.data.state || !Number.isInteger(put.data.rev)) {
        throw new ApiError('ECONFLICT', 'openGym returned a conflict without a usable current revision.')
      }
      current = put.data as OpenGymDocument
    }
    throw new ApiError('ECONFLICT', 'The profile kept changing. Read the current records and try the change again.')
  }
}

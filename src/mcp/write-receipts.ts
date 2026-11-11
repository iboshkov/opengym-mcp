import { createHash } from 'node:crypto'
import { ApiError } from '../opengym/api.ts'
import type { Store } from '../storage/store.ts'

const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000
const IN_FLIGHT_TTL_MS = 60 * 60 * 1000
const MAX_RECEIPTS = 2000

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** Identifies one intended change: the same user, tool and request ID name the same write. */
export interface WriteRequest {
  userId: string
  toolName: string
  requestId: string
  params: unknown
}

/** A write running in this process; a concurrent duplicate shares its promise. */
export interface InFlightWrite {
  fingerprint: string
  promise: Promise<unknown>
  expires: number
}

/** The persisted record of a write: pending until its result is known. */
export interface WriteReceipt {
  fingerprint: string
  expires: number
  status: 'pending' | 'complete'
  result?: unknown
}

/**
 * True when the error proves nothing was saved: the change was rejected before
 * any write, or openGym answered with a refusal. A network failure or an
 * unreadable success response leaves the outcome unknown.
 */
function nothingWasSaved(error: unknown) {
  if (!(error instanceof ApiError)) return false
  return error.code !== 'EAPI' || error.status >= 400
}

/**
 * Makes a write safe to retry. A caller that repeats a `request_id` gets the
 * original result instead of a second write. Receipts are kept in the encrypted
 * store, so this also holds across restarts: a write that was in flight when the
 * process stopped is reported as uncertain rather than repeated.
 */
export class WriteReceipts {
  store: Store
  now: () => number
  inFlight: Map<string, InFlightWrite>

  constructor(store: Store, now: () => number = () => Date.now()) {
    this.store = store
    this.now = now
    this.inFlight = new Map()
  }

  get #saved(): Record<string, WriteReceipt> { return this.store.data.requests }

  #prune() {
    const now = this.now()
    for (const [key, entry] of this.inFlight) if (entry.expires < now) this.inFlight.delete(key)
    for (const [key, entry] of Object.entries(this.#saved)) if (entry.expires < now) delete this.#saved[key]
  }

  #makeRoom() {
    if (this.inFlight.size >= MAX_RECEIPTS) this.inFlight.delete(this.inFlight.keys().next().value!)
    const keys = Object.keys(this.#saved)
    if (keys.length >= MAX_RECEIPTS) delete this.#saved[keys[0]]
  }

  /** Run `write` once for this user, tool and request ID; later calls reuse its outcome. */
  async run<T>({ userId, toolName, requestId, params }: WriteRequest, write: () => Promise<T>): Promise<T> {
    this.#prune()
    const key = sha256(`${userId}\0${toolName}\0${requestId}`)
    const fingerprint = sha256(JSON.stringify(params))
    const reused = new ApiError('EREQUEST', 'This request_id was used with different arguments. Use a new ID for a different intended change.')

    const running = this.inFlight.get(key)
    if (running) {
      if (running.fingerprint !== fingerprint) throw reused
      return running.promise as Promise<T>
    }
    const receipt = this.#saved[key]
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw reused
      if (receipt.result) return receipt.result as T
      throw new ApiError('EUNCERTAIN', 'A previous attempt may have completed. Read the affected record before deciding whether to retry with a new request_id.')
    }

    this.#makeRoom()
    this.#saved[key] = { fingerprint, expires: this.now() + RECEIPT_TTL_MS, status: 'pending' }
    this.store.save()

    const promise = write().then(result => {
      this.#saved[key] = { fingerprint, expires: this.now() + RECEIPT_TTL_MS, status: 'complete', result }
      this.store.save()
      return result
    }, (error: unknown) => {
      // An uncertain outcome keeps its pending receipt so the write is never repeated blindly.
      if (nothingWasSaved(error)) {
        delete this.#saved[key]
        this.inFlight.delete(key)
        this.store.save()
      }
      throw error
    })
    this.inFlight.set(key, { fingerprint, promise, expires: this.now() + IN_FLIGHT_TTL_MS })
    return promise
  }
}

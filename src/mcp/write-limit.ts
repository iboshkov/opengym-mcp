import { ApiError } from '../opengym/api.ts'

const WINDOW_MS = 60 * 60 * 1000
export const WRITES_PER_HOUR = 120

/** Caps the number of saved changes per profile in a sliding one-hour window. */
export class WriteLimiter {
  now: () => number
  writesByUser: Map<string, number[]>

  constructor(now: () => number = () => Date.now()) {
    this.now = now
    this.writesByUser = new Map()
  }

  /** Count one write for the profile, or throw ERATE when the hour's budget is spent. */
  consume(userId: string) {
    const now = this.now()
    const recent = (this.writesByUser.get(userId) || []).filter(time => time > now - WINDOW_MS)
    if (recent.length >= WRITES_PER_HOUR) {
      throw new ApiError('ERATE', `This profile reached ${WRITES_PER_HOUR} write requests in an hour. Wait before making more changes.`)
    }
    recent.push(now)
    this.writesByUser.set(userId, recent)
  }
}

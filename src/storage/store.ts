import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { AccessTokenRecord, Grant, RefreshTokenRecord } from '../oauth/provider.ts'
import type { WriteReceipt } from '../mcp/write-receipts.ts'

const KEY_BYTES = 32
const ASSOCIATED_DATA = Buffer.from('opengym-mcp-auth-v1')
const COLLECTIONS = ['clients', 'grants', 'access', 'refresh', 'spentRefresh']

/** The persisted authorization state. The records are defined by the modules that own them. */
export interface StoreState {
  version: number
  clients: Record<string, OAuthClientInformationFull>
  grants: Record<string, Grant>
  access: Record<string, AccessTokenRecord>
  refresh: Record<string, RefreshTokenRecord>
  spentRefresh: Record<string, RefreshTokenRecord>
  requests: Record<string, WriteReceipt>
}

/** What MemoryStore and EncryptedStore have in common. */
export interface Store {
  data: StoreState
  save(): void
}

const emptyData = (): StoreState => ({ version: 1, clients: {}, grants: {}, access: {}, refresh: {}, spentRefresh: {}, requests: {} })
const isRecord = (value: unknown): boolean => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Volatile store, used by tests and as the base of the encrypted store. */
export class MemoryStore implements Store {
  data: StoreState
  constructor() { this.data = emptyData() }
  save(): void {}
}

/**
 * Create the storage key on first start. Returns true when a key was created.
 * An existing store without its key is never given a new one: that would
 * only hide the loss until decryption fails.
 */
export function ensureStorageKey(keyFile: string, storePath: string): boolean {
  if (fs.existsSync(keyFile)) return false
  if (fs.existsSync(storePath)) {
    throw new Error(`${storePath} exists but its key ${keyFile} is missing. Restore the key, or remove the store to start over (every assistant must then reconnect).`)
  }
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(keyFile, randomBytes(KEY_BYTES), { mode: 0o600, flag: 'wx' })
  return true
}

/** OAuth clients, grants, token hashes and write receipts, AES-256-GCM encrypted in one file. */
export class EncryptedStore extends MemoryStore {
  file: string
  key: Buffer
  constructor(file: string, keyFile: string) {
    super()
    this.file = file
    this.key = fs.readFileSync(keyFile)
    if (this.key.length !== KEY_BYTES) throw new Error(`The MCP storage key must contain exactly ${KEY_BYTES} bytes.`)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    if (fs.existsSync(file)) this.data = this.#read()
  }

  #read(): StoreState {
    const envelope = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAAD(ASSOCIATED_DATA)
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.body, 'base64')), decipher.final()])
    const data: StoreState = JSON.parse(plaintext.toString('utf8'))
    if (data.version !== 1 || !COLLECTIONS.every(name => isRecord(data[name as keyof StoreState]))) {
      throw new Error('Invalid MCP authorization store.')
    }
    data.requests ||= {}
    return data
  }

  /** Write atomically: a crash leaves either the previous file or the new one, never a partial one. */
  save(): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(ASSOCIATED_DATA)
    const body = Buffer.concat([cipher.update(JSON.stringify(this.data), 'utf8'), cipher.final()])
    const envelope = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') }

    const temporary = this.file + '.tmp'
    const fd = fs.openSync(temporary, 'w', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(envelope))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, this.file)
  }
}

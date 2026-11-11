import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EncryptedStore, ensureStorageKey } from '../src/storage/store.ts'

function temporaryDirectory(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-mcp-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('ensureStorageKey creates a 32-byte key once and reports that it did', t => {
  const directory = temporaryDirectory(t)
  const keyFile = path.join(directory, 'nested', 'storage.key')
  const storePath = path.join(directory, 'nested', 'state.enc')
  assert.equal(ensureStorageKey(keyFile, storePath), true)
  assert.equal(fs.readFileSync(keyFile).length, 32)
})

test('ensureStorageKey returns false for an existing key and never overwrites it', t => {
  const directory = temporaryDirectory(t)
  const keyFile = path.join(directory, 'storage.key')
  const storePath = path.join(directory, 'state.enc')
  ensureStorageKey(keyFile, storePath)
  const original = fs.readFileSync(keyFile)

  assert.equal(ensureStorageKey(keyFile, storePath), false)
  assert.deepEqual(fs.readFileSync(keyFile), original)

  // Even when the store exists too, a present key is left alone.
  fs.writeFileSync(storePath, 'placeholder')
  assert.equal(ensureStorageKey(keyFile, storePath), false)
  assert.deepEqual(fs.readFileSync(keyFile), original)
})

test('ensureStorageKey does not replace the key of an operator-supplied file of another length', t => {
  const directory = temporaryDirectory(t)
  const keyFile = path.join(directory, 'supplied.key')
  fs.writeFileSync(keyFile, 'not thirty-two bytes')
  assert.equal(ensureStorageKey(keyFile, path.join(directory, 'state.enc')), false)
  assert.equal(fs.readFileSync(keyFile, 'utf8'), 'not thirty-two bytes')
})

test('ensureStorageKey refuses to invent a key when the store exists without one', t => {
  const directory = temporaryDirectory(t)
  const keyFile = path.join(directory, 'storage.key')
  const storePath = path.join(directory, 'state.enc')
  fs.writeFileSync(storePath, 'encrypted store from an earlier run')
  assert.throws(() => ensureStorageKey(keyFile, storePath), /exists but its key .* is missing/)
  assert.equal(fs.existsSync(keyFile), false)
  assert.equal(fs.readFileSync(storePath, 'utf8'), 'encrypted store from an earlier run')
})

test('a generated key round-trips data through EncryptedStore and keeps it encrypted at rest', t => {
  const directory = temporaryDirectory(t)
  const keyFile = path.join(directory, 'storage.key')
  const storePath = path.join(directory, 'state.enc')
  ensureStorageKey(keyFile, storePath)

  const store = new EncryptedStore(storePath, keyFile)
  store.data.clients.example = { client_id: 'example', client_name: 'Marker client name', redirect_uris: [] }
  store.data.requests.abc = { fingerprint: 'abc', status: 'complete', expires: Date.now() + 1000 }
  store.save()
  assert.equal(fs.existsSync(storePath + '.tmp'), false)
  assert.equal(fs.readFileSync(storePath, 'utf8').includes('Marker client name'), false)

  const reloaded = new EncryptedStore(storePath, keyFile)
  assert.deepEqual(reloaded.data.clients.example, { client_id: 'example', client_name: 'Marker client name', redirect_uris: [] })
  assert.equal(reloaded.data.requests.abc.status, 'complete')

  // The key is still the one created first, so the store stays readable on the next start.
  assert.equal(ensureStorageKey(keyFile, storePath), false)
  assert.equal(new EncryptedStore(storePath, keyFile).data.clients.example.client_id, 'example')
})

test('EncryptedStore rejects a key of the wrong length and a different key', t => {
  const directory = temporaryDirectory(t)
  const keyFile = path.join(directory, 'storage.key')
  const storePath = path.join(directory, 'state.enc')
  ensureStorageKey(keyFile, storePath)
  const store = new EncryptedStore(storePath, keyFile)
  store.save()

  const shortKey = path.join(directory, 'short.key')
  fs.writeFileSync(shortKey, Buffer.alloc(16))
  assert.throws(() => new EncryptedStore(storePath, shortKey), /exactly 32 bytes/)

  const otherKey = path.join(directory, 'other.key')
  ensureStorageKey(otherKey, path.join(directory, 'unused.enc'))
  assert.throws(() => new EncryptedStore(storePath, otherKey))
})

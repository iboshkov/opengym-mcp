// Run separately: npm run test:contract. This creates an isolated, disposable OpenGym API.
// It never mounts or calls the user's OpenGym data or service.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApp } from '../src/app.js'
import { OpenGymApi } from '../src/opengym/api.js'
import { listen } from './fixture.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-api-contract-'))
const container = 'opengym-mcp-contract-' + randomUUID()
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const key = randomBytes(32).toString('hex'), uid = 'mcp-contract-fixture'
const fixture = { unit: 'kg', routines: [], workouts: [], customEx: [], bodyweight: [], week: {}, dayPlan: {}, unrelated: { preserved: true }, _rev: 1 }
fs.writeFileSync(path.join(temp, 'secret'), key)
fs.writeFileSync(path.join(temp, 'db.json'), JSON.stringify({ users: [{ id: uid, name: 'Disposable API contract fixture', created: '2026-01-01T00:00:00.000Z' }], creds: [], subs: [], invites: [] }))
fs.writeFileSync(path.join(temp, `state-${uid}.json`), JSON.stringify(fixture))
let service, client
try {
  docker(['run', '-d', '--name', container, '--label', 'opengym-mcp.test=contract', '-p', '127.0.0.1::3000', '--mount', `type=bind,source=${temp},target=/data`, '-e', 'RP_ID=localhost', '-e', 'ORIGIN=http://localhost:8080', 'ghcr.io/duartesantos8/opengym-api:latest'])
  const port = docker(['port', container, '3000/tcp']).split(':').at(-1)
  const base = 'http://127.0.0.1:' + port
  let healthy = false
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(base + '/api/health')).ok) { healthy = true; break } } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  assert.equal(healthy, true, 'Disposable OpenGym API did not start.')
  const payload = `${uid}:${Date.now() + 3600000}:0:b`
  const token = payload + '.' + createHmac('sha256', key).update(payload).digest('base64url')
  const api = new OpenGymApi(base)
  const { app } = createApp({ origin: 'https://mcp.example.test', api, rateLimits: false })
  service = await listen(app)
  client = new Client({ name: 'disposable-contract-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(service.base + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + token } } }))
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    assert.notEqual(result.isError, true, `${name}: ${result.content[0].text}`)
    return result.structuredContent || JSON.parse(result.content[0].text)
  }
  const exercise = await call('create_exercise', { name: 'Disposable contract curl', body_part: 'upper arms', target_muscle: 'biceps', equipment: 'dumbbell' })
  const exerciseId = exercise.result.id
  const routine = await call('create_routine', { name: 'Disposable contract routine', exercises: [{ exercise_id: exerciseId, sets: 3, reps: 8, weight: 10, weight_unit: 'kg' }] })
  const routineId = routine.result.routine_id
  await call('add_routine_exercise', { routine_id: routineId, exercise: { exercise_id: exerciseId, sets: 2, reps: 12 } })
  await call('update_routine', { routine_id: routineId, name: 'Updated disposable routine' })
  await call('update_routine_exercise', { routine_id: routineId, position: 1, expected_exercise_id: exerciseId, changes: { reps: 10 } })
  await call('remove_routine_exercise', { routine_id: routineId, position: 2, expected_exercise_id: exerciseId, confirm: true })
  await call('set_weekday_routines', { weekday: 2, routine_ids: [routineId] })
  await call('update_exercise', { exercise_id: exerciseId, instructions: 'Disposable fixture only.' })
  const reading = await call('add_bodyweight', { date: '2026-01-01', weight: 80, unit: 'kg', time: '08:00' })
  await call('update_bodyweight', { date: '2026-01-01', reading_id: reading.result.reading_id, weight: 79, unit: 'kg' })
  const logged = await call('log_workout', { date: '2026-01-01', start: '10:00', name: 'Disposable contract workout', unit: 'kg', exercises: [{ exercise: exerciseId, sets: [{ reps: 8, weight: 10 }] }] })
  assert.equal(logged.logged, true)
  await call('update_workout', { workout_id: logged.workout_id, name: 'Corrected disposable workout', date: '2026-01-02', duration_min: 25, sets: [{ exercise_position: 1, set_position: 1, expected_exercise_id: exerciseId, reps: 9 }] })
  const view = await call('get_workout', { workout_id: logged.workout_id })
  assert.ok(JSON.stringify(view).includes('Corrected disposable workout'))
  await call('delete_workout', { workout_id: logged.workout_id, confirm: true })
  await call('delete_routine', { routine_id: routineId, confirm: true })
  await call('delete_exercise', { exercise_id: exerciseId, confirm: true })
  await call('delete_bodyweight', { date: '2026-01-01', reading_id: reading.result.reading_id, confirm: true })
  const final = await api.document(token)
  assert.equal(final.state.workouts.length, 0)
  assert.equal(final.state.routines.length, 0)
  assert.equal(final.state.customEx.length, 0)
  assert.equal(final.state.bodyweight.length, 0)
  assert.deepEqual(final.state.unrelated, { preserved: true })
  console.log('Official OpenGym API contract passed: isolated exercise, routine, schedule, workout and bodyweight CRUD.')
} finally {
  if (client) await client.close()
  if (service) await service.close()
  try { docker(['rm', '-f', container]) } catch {}
  // temp was allocated by mkdtemp under the explicitly named OS temporary directory.
  if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test cleanup path.')
  fs.rmSync(temp, { recursive: true, force: true })
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, clientFor, call, listen, origin } from './fixture.js'
import { createApp } from '../src/app.js'
import { MemoryStore } from '../src/storage/store.js'
import { EXDB } from '../vendor/opengym/frontend/src/lib/exercises-data.js'

const custom = { name: 'Test-only custom curl', body_part: 'upper arms', target_muscle: 'biceps', equipment: 'dumbbell' }

test('standard MCP handshake exposes instructions, read/write tools, and per-tool annotations', async t => {
  const f = await fixture(t), client = await clientFor(t, f)
  const result = await client.listTools()
  assert.ok(result.tools.length >= 27)
  assert.match(client.getInstructions(), /Only perform changes requested by the user/)
  assert.equal(result.tools.find(t => t.name === 'list_workouts').annotations.readOnlyHint, true)
  assert.equal(result.tools.find(t => t.name === 'create_exercise').annotations.readOnlyHint, false)
  assert.equal(result.tools.find(t => t.name === 'delete_exercise').annotations.destructiveHint, true)
  assert.deepEqual(result.tools.find(t => t.name === 'create_exercise')._meta.securitySchemes[0].scopes, ['opengym:read', 'opengym:write'])
  const wire = await (await fetch(f.base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer test-a', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }) })).json()
  assert.deepEqual(wire.result.tools.find(t => t.name === 'create_exercise').securitySchemes[0].scopes, ['opengym:read', 'opengym:write'])
})

test('concurrent profiles remain isolated without any filesystem state', async t => {
  const f = await fixture(t), a = await clientFor(t, f, 'test-a'), b = await clientFor(t, f, 'test-b')
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call(i % 2 ? a : b, 'list_routines')))
  results.forEach((result, i) => assert.equal(result.value.routines[0].name, i % 2 ? 'A routine' : 'B routine'))
  assert.equal((await call(a, 'get_profile')).value.profile.id, 'user-a')
})

test('custom exercise CRUD, routine edits and deletion guards preserve unrelated data', async t => {
  const f = await fixture(t), c = await clientFor(t, f)
  const created = await call(c, 'create_exercise', custom)
  assert.equal(created.value.saved, true)
  const exerciseId = created.value.result.id
  const routine = await call(c, 'create_routine', { name: 'MCP test routine', exercises: [{ exercise_id: exerciseId, sets: 3, reps: 8, weight: 10, weight_unit: 'kg' }] })
  const routineId = routine.value.result.routine_id
  await call(c, 'update_routine_exercise', { routine_id: routineId, position: 1, expected_exercise_id: exerciseId, changes: { reps: 12 } })
  const read = await call(c, 'get_routine', { routine_id: routineId })
  assert.equal(read.value.exercises[0].reps, 12)
  assert.equal(read.value.exercises[0].sets, 3)
  assert.equal(read.value.exercises[0].weight, 10)
  const blocked = await c.callTool({ name: 'delete_exercise', arguments: { exercise_id: exerciseId, confirm: true } })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content[0].text, /EINUSE/)
  const invalid = await c.callTool({ name: 'remove_routine_exercise', arguments: { routine_id: routineId, position: 1, expected_exercise_id: 'wrong', confirm: true } })
  assert.equal(invalid.isError, true)
  await call(c, 'update_exercise', { exercise_id: exerciseId, name: 'Renamed test curl' })
  assert.equal((await call(c, 'get_exercise', { exercise_id: exerciseId })).value.name, 'Renamed test curl')
  await call(c, 'set_weekday_routines', { weekday: 1, routine_ids: [routineId] })
  await call(c, 'delete_routine', { routine_id: routineId, confirm: true })
  assert.equal(f.profiles.get('test-a').state.week[1], undefined)
  await call(c, 'delete_exercise', { exercise_id: exerciseId, confirm: true })
  assert.equal(f.profiles.get('test-a').state.customEx.length, 0)
  assert.deepEqual(f.profiles.get('test-a').state.unrelated, { preserved: true })
  assert.equal(f.profiles.get('test-b').state.routines.length, 1)
})

test('dry runs do not write; request IDs prevent duplicate concurrent creates', async t => {
  const f = await fixture(t), c = await clientFor(t, f)
  const preview = await call(c, 'create_exercise', { ...custom, dry_run: true })
  assert.equal(preview.value.dry_run, true)
  assert.equal(f.counters.puts, 0)
  const args = { ...custom, request_id: 'repeatable-request-01' }
  const [a, b] = await Promise.all([call(c, 'create_exercise', args), call(c, 'create_exercise', args)])
  assert.equal(a.value.result.id, b.value.result.id)
  assert.equal(f.counters.puts, 1)
  const reused = await c.callTool({ name: 'create_exercise', arguments: { ...args, name: 'Different intent' } })
  assert.match(reused.content[0].text, /EREQUEST/)
})

test('revision conflicts reapply only the requested operation over the new profile', async t => {
  const f = await fixture(t), c = await clientFor(t, f)
  f.counters.conflict = true
  await call(c, 'create_exercise', custom)
  assert.equal(f.counters.puts, 2)
  assert.equal(f.profiles.get('test-a').state.fromAnotherDevice, 'preserve this concurrent edit')
  assert.equal(f.profiles.get('test-a').state.customEx.length, 1)
})

test('persisted write receipts prevent duplicate writes after service recreation', async t => {
  const store = new MemoryStore(), f = await fixture(t, { store }), c = await clientFor(t, f)
  const args = { ...custom, request_id: 'durable-request-0001' }
  const first = await call(c, 'create_exercise', args)
  const restarted = await listen(createApp({ origin, api: f.api, store, rateLimits: false }).app)
  t.after(() => restarted.close())
  const c2 = await clientFor(t, restarted)
  const second = await call(c2, 'create_exercise', args)
  assert.equal(first.value.result.id, second.value.result.id)
  assert.equal(f.counters.puts, 1)
})

test('an uncertain write is not repeated after service recreation', async t => {
  const store = new MemoryStore(), f = await fixture(t, { store }), c = await clientFor(t, f)
  f.counters.uncertain = true
  const args = { ...custom, request_id: 'uncertain-request-01' }
  const first = await c.callTool({ name: 'create_exercise', arguments: args })
  assert.equal(first.isError, true)
  assert.equal(f.profiles.get('test-a').state.customEx.length, 1)
  const restarted = await listen(createApp({ origin, api: f.api, store, rateLimits: false }).app)
  t.after(() => restarted.close())
  const c2 = await clientFor(t, restarted)
  const second = await c2.callTool({ name: 'create_exercise', arguments: args })
  assert.equal(second.isError, true)
  assert.match(second.content[0].text, /EUNCERTAIN/)
  assert.equal(f.counters.puts, 1)
})

test('bodyweight CRUD respects units and preserves other readings on the same day', async t => {
  const f = await fixture(t), c = await clientFor(t, f)
  const first = await call(c, 'add_bodyweight', { date: '2026-01-01', time: '08:00', weight: 176.37, unit: 'lb' })
  const second = await call(c, 'add_bodyweight', { date: '2026-01-01', time: '18:00', weight: 81, unit: 'kg' })
  assert.equal(first.value.result.weight, 80)
  await call(c, 'update_bodyweight', { date: '2026-01-01', reading_id: first.value.result.reading_id, weight: 79, unit: 'kg' })
  await call(c, 'delete_bodyweight', { date: '2026-01-01', reading_id: first.value.result.reading_id, confirm: true })
  const day = f.profiles.get('test-a').state.bodyweight[0]
  assert.equal(day.ins.length, 1)
  assert.equal(day.ins[0].id, second.value.result.reading_id)
  assert.equal(day.ins[0].w, 81)
})

test('upstream log_workout uses API writes and prevents duplicate sessions', async t => {
  const f = await fixture(t), c = await clientFor(t, f)
  const exercise = EXDB.find(e => e.n.toLowerCase().includes('barbell bench press')) || EXDB[0]
  const args = { date: '2026-01-01', start: '10:00', name: 'Fixture workout', unit: 'kg', exercises: [{ exercise: exercise.id, sets: [{ reps: 8, weight: 20 }] }] }
  const first = await call(c, 'log_workout', args)
  assert.equal(first.value.logged, true)
  const second = await call(c, 'log_workout', args)
  assert.equal(second.value.duplicate, true)
  assert.equal(f.profiles.get('test-a').state.workouts.length, 1)
  const edited = await call(c, 'update_workout', { workout_id: first.value.workout_id, date: '2026-01-02', duration_min: 30, name: 'Corrected fixture workout', sets: [{ exercise_position: 1, set_position: 1, expected_exercise_id: exercise.id, reps: 10, weight: 25, weight_unit: 'kg' }] })
  assert.equal(edited.value.saved, true)
  const saved = f.profiles.get('test-a').state.workouts[0]
  assert.equal(saved.d, '2026-01-02')
  assert.equal(saved.entries[0].sets[0].r, 10)
  assert.equal(saved.entries[0].sets[0].w, 25)
  assert.equal(saved.end - saved.start, 30 * 60000)
  assert.equal(new Date(saved.start).getHours(), 10)
  await call(c, 'delete_workout', { workout_id: first.value.workout_id, confirm: true })
  assert.equal(f.profiles.get('test-a').state.workouts.length, 0)
})

test('a write rejected before saving can be retried with the same request_id and then succeeds exactly once', async t => {
  const f = await fixture(t), c = await clientFor(t, f)
  const args = { exercise_id: 'c_added_later', name: 'Retried exercise name', request_id: 'retry-after-fix-0001' }

  const rejected = await c.callTool({ name: 'update_exercise', arguments: args })
  assert.equal(rejected.isError, true)
  assert.match(rejected.content[0].text, /ENOENT/)
  assert.equal(f.counters.puts, 0)

  // The cause is fixed: the exercise now exists in the profile.
  f.profiles.get('test-a').state.customEx.push({ id: 'c_added_later', custom: true, n: 'Original name', bp: 'upper arms', tg: 'biceps', sm: [], secondaries: [], eq: '', desc: '' })

  const retried = await call(c, 'update_exercise', args)
  assert.equal(retried.value.saved, true)
  assert.equal(retried.value.result.name, 'Retried exercise name')
  assert.equal(f.counters.puts, 1)
  assert.equal(f.profiles.get('test-a').state.customEx[0].n, 'Retried exercise name')

  // A further repeat returns the recorded result and does not write again.
  const repeated = await call(c, 'update_exercise', args)
  assert.deepEqual(repeated.value, retried.value)
  assert.equal(f.counters.puts, 1)
})

test('a retry after an upstream refusal that saved nothing is not blocked as uncertain', async t => {
  const f = await fixture(t), c = await clientFor(t, f)
  const args = { ...custom, request_id: 'retry-after-refusal-01' }
  const fetchOriginal = f.api.fetch
  let refuse = true
  f.api.fetch = async (...parameters) => {
    const [, init] = parameters
    if (refuse && init.method === 'PUT') return new Response(JSON.stringify({ error: 'busy' }), { status: 503 })
    return fetchOriginal(...parameters)
  }
  const refused = await c.callTool({ name: 'create_exercise', arguments: args })
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /EAPI/)
  assert.equal(f.counters.puts, 0)

  refuse = false
  const retried = await call(c, 'create_exercise', args)
  assert.equal(retried.value.saved, true)
  assert.equal(f.counters.puts, 1)
  assert.equal(f.profiles.get('test-a').state.customEx.length, 1)
})

test('the same request_id with different arguments is rejected with EREQUEST and writes nothing', async t => {
  const f = await fixture(t), c = await clientFor(t, f)
  const requestId = 'same-id-different-args-1'
  const first = await call(c, 'create_exercise', { ...custom, request_id: requestId })
  assert.equal(f.counters.puts, 1)

  const changed = await c.callTool({ name: 'create_exercise', arguments: { ...custom, equipment: 'barbell', request_id: requestId } })
  assert.equal(changed.isError, true)
  assert.match(changed.content[0].text, /EREQUEST/)
  assert.equal(f.counters.puts, 1)
  assert.equal(f.profiles.get('test-a').state.customEx.length, 1)

  // The original arguments still return the original result.
  const same = await call(c, 'create_exercise', { ...custom, request_id: requestId })
  assert.equal(same.value.result.id, first.value.result.id)
  assert.equal(f.counters.puts, 1)

  // A request_id belongs to one tool and one profile: other combinations start fresh.
  const other = await clientFor(t, f, 'test-b')
  const otherProfile = await call(other, 'create_exercise', { ...custom, request_id: requestId })
  assert.equal(otherProfile.value.saved, true)
  assert.equal(f.profiles.get('test-b').state.customEx.length, 1)
})

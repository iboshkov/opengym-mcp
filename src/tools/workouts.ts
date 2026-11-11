/** Logged workout mutation tools. Edits recompute volume and the affected PR history. */
import { z } from 'zod'
import { isoDate, withCustomsIndexed as vendoredWithCustomsIndexed } from '../../vendor/opengym/mcp/src/tools.js'
import { workoutVolume as vendoredWorkoutVolume } from '../../vendor/opengym/frontend/src/lib/history.js'
import * as vendoredWorkoutDate from '../../vendor/opengym/frontend/src/lib/workout-date.js'
import { array, controls, convert, defineMutation, deleteControls, fail, id, targetUnit, text, timeOfDay } from './shared.ts'
import type { ProfileState, Workout } from './shared.ts'

/*
 * The vendored helpers below are untyped JavaScript. These signatures state
 * what the tools rely on; the moves return a new workouts array, or null when
 * nothing changed.
 */
const withCustomsIndexed = vendoredWithCustomsIndexed as unknown as <T>(state: ProfileState, build: () => T) => T
const workoutVolume = vendoredWorkoutVolume as unknown as (workout: Workout) => number
const {
  moveWorkout, setWorkoutDuration, rebuildPrHistory, startTimeOf, durationMinOf, endsInFuture
} = vendoredWorkoutDate as unknown as {
  moveWorkout(workouts: Workout[] | undefined, workout: Workout, date: string | undefined, start: string, now: number): Workout[] | null
  setWorkoutDuration(workouts: Workout[] | undefined, workout: Workout, minutes: number, now: number): Workout[] | null
  rebuildPrHistory(workouts: Workout[] | undefined, exerciseIds: string[], moved?: Workout | null): Workout[]
  startTimeOf(workout: Workout): string
  durationMinOf(workout: Workout): number
  endsInFuture(date: string | undefined, start: string, durationMin: number, now: number): boolean
}

/** One performed-set correction, addressed by 1-based exercise and set position. */
const setChangeSchema = z.object({
  exercise_position: z.number().int().min(1).max(100),
  set_position: z.number().int().min(1).max(100),
  expected_exercise_id: id,
  reps: z.number().int().min(1).max(1000).optional(),
  seconds: z.number().positive().max(86400).optional(),
  weight: z.number().min(0).max(2000).optional(),
  weight_unit: z.enum(['kg', 'lb']).optional()
}).strict()

type SetChange = z.infer<typeof setChangeSchema>

/** Applies one set correction. Returns the exercise ID whose PR history is affected. */
function applySetChange(state: ProfileState, workout: Workout, change: SetChange): string {
  const entry = array(workout.entries)[change.exercise_position - 1]
  if (!entry || entry.id !== change.expected_exercise_id) {
    fail('ECONFLICT', 'The workout exercise position changed. Read the workout again.')
  }
  const row = array(entry.sets)[change.set_position - 1]
  if (!row) fail('ENOENT', 'Workout set not found.')
  if (change.reps !== undefined) {
    if (row.sec !== undefined || row.min !== undefined) {
      fail('EINVAL', 'A timed/cardio set cannot be changed into a rep set.')
    }
    row.r = change.reps
  }
  if (change.seconds !== undefined) {
    if (row.sec === undefined) fail('EINVAL', 'Only a timed set can have seconds edited.')
    row.sec = change.seconds
  }
  if (change.weight !== undefined) {
    const unit = targetUnit(state, entry.id)
    row.w = convert(change.weight, change.weight_unit || unit, unit)
  }
  return entry.id
}

export const updateWorkout = defineMutation({
  name: 'update_workout',
  description: 'Correct an existing workout name, note, date, duration, or specified performed sets. '
    + 'Read get_workout first. Set positions are 1-based and checked against the exact exercise ID; '
    + 'unspecified fields and other workouts remain intact. Recalculates volume and affected PR history.',
  schema: {
    workout_id: id,
    name: text.optional(),
    note: z.string().max(2000).optional(),
    date: isoDate().optional(),
    start: timeOfDay.optional(),
    duration_min: z.number().int().min(1).max(1440).optional(),
    sets: z.array(setChangeSchema).max(200).optional(),
    ...controls
  },
  operation: (state, params, context) => {
    const findWorkout = () => array(state.workouts).find(candidate => candidate.id === params.workout_id)
    let workout: Workout = findWorkout() || fail('ENOENT', 'Workout not found. Read workout history before editing.')

    const resultingDate = params.date || workout.d
    const resultingStart = params.start || startTimeOf(workout)
    const resultingDuration = params.duration_min || durationMinOf(workout)
    const timingChanged = params.date !== undefined || params.start !== undefined || params.duration_min !== undefined
    if (timingChanged && endsInFuture(resultingDate, resultingStart, resultingDuration, context.now)) {
      fail('EINVAL', 'A completed workout cannot end in the future.')
    }

    // The helpers below may return a new workouts array, so re-find the workout after each.
    if (params.date !== undefined || params.start !== undefined) {
      const moved = withCustomsIndexed(
        state,
        () => moveWorkout(state.workouts, workout, resultingDate, resultingStart, context.now)
      )
      if (moved) state.workouts = moved
      workout = findWorkout()!
    }
    if (params.duration_min !== undefined) {
      const changed = setWorkoutDuration(state.workouts, workout, params.duration_min, context.now)
      if (changed) state.workouts = changed
      workout = findWorkout()!
    }
    if (params.name !== undefined) workout.name = params.name
    if (params.note !== undefined) workout.note = params.note

    const touchedExerciseIds = new Set<string>()
    for (const change of params.sets || []) {
      touchedExerciseIds.add(applySetChange(state, workout, change))
    }
    if (touchedExerciseIds.size) {
      withCustomsIndexed(state, () => {
        workout.vol = workoutVolume(workout)
        state.workouts = rebuildPrHistory(state.workouts, [...touchedExerciseIds], workout)
      })
    }
    return { workout_id: params.workout_id, date: workout.d, name: workout.name, volume: workout.vol }
  }
})

export const deleteWorkout = defineMutation({
  name: 'delete_workout',
  destructive: true,
  description: 'Delete one historical workout after explicit user intent. Preserves other sessions and '
    + 'rebuilds PR history for the affected exercises.',
  schema: { workout_id: id, ...deleteControls },
  operation: (state, params) => {
    const workout = array(state.workouts).find(candidate => candidate.id === params.workout_id)
      || fail('ENOENT', 'Workout not found.')
    const remaining = array(state.workouts).filter(candidate => candidate.id !== params.workout_id)
    const affectedExerciseIds = array(workout.entries).map(entry => entry.id)
    state.workouts = withCustomsIndexed(state, () => rebuildPrHistory(remaining, affectedExerciseIds))
    return { deleted_workout_id: params.workout_id }
  }
})

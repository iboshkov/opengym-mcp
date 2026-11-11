/**
 * Building blocks shared by the tool modules: common zod fields, the error
 * helper, lookups into the profile state, and weight unit conversion.
 */
import { z } from 'zod'
import { EXDB } from '../../vendor/opengym/frontend/src/lib/exercises-data.js'
import { ApiError } from '../opengym/api.js'

export const text = z.string().trim().min(1).max(160)
export const id = z.string().min(1).max(160)

/** 24-hour HH:MM, as used for workout start times and bodyweight readings. */
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/** Fields accepted by every mutation tool. */
export const controls = {
  dry_run: z.boolean().optional(),
  request_id: z.string().min(8).max(128).optional()
    .describe('Reuse the same request ID when retrying this exact intended change.')
}

/** Mutation controls plus the explicit confirmation required by deletions. */
export const deleteControls = {
  ...controls,
  confirm: z.literal(true).describe('Set true only when the user explicitly requested this deletion.')
}

const POUNDS_PER_KILOGRAM = 2.20462262185

export function fail(code, message) {
  throw new ApiError(code, message)
}

export const array = value => (Array.isArray(value) ? value : [])

/** Finds an exercise among the profile's custom exercises, then the built-in catalogue. */
export function lookupExercise(state, exerciseId) {
  return array(state.customEx).find(exercise => exercise.id === exerciseId)
    || EXDB.find(exercise => exercise.id === exerciseId)
    || fail('ENOENT', 'Exercise not found. Search exercises before writing.')
}

export function lookupRoutine(state, routineId) {
  return array(state.routines).find(routine => routine.id === routineId)
    || fail('ENOENT', 'Routine not found. List routines before writing.')
}

/** The profile's default weight unit. */
export const profileUnit = state => (state.unit === 'lb' ? 'lb' : 'kg')

/** The unit an exercise's weights are stored in: its own setting, else the profile unit. */
export const targetUnit = (state, exerciseId) => state.exUnit?.[exerciseId] || profileUnit(state)

/** Converts a weight between kg and lb, rounded to two decimals. */
export function convert(value, from, to) {
  if (from === to) return value
  const converted = from === 'kg' ? value * POUNDS_PER_KILOGRAM : value / POUNDS_PER_KILOGRAM
  return Math.round(converted * 100) / 100
}

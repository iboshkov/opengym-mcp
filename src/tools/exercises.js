/** Custom exercise mutation tools. Built-in catalogue exercises are read-only. */
import { z } from 'zod'
import { BODY_PARTS } from '../../vendor/opengym/frontend/src/lib/log-workout.js'
import { array, controls, deleteControls, fail, id, targetUnit, text } from './shared.js'

const customFields = {
  name: text,
  body_part: z.enum(BODY_PARTS),
  equipment: z.string().trim().max(120).optional(),
  target_muscle: text,
  secondary_muscles: z.array(text).max(20).optional(),
  primary_muscles: z.array(text).min(1).max(12).optional(),
  muscle_groups: z.array(text).max(20).optional(),
  instructions: z.string().max(5000).optional(),
  aliases: z.array(text).max(30).optional()
}

/** Tool parameter name to stored exercise field, for fields that copy over directly. */
const SIMPLE_EXERCISE_FIELDS = {
  name: 'n',
  body_part: 'bp',
  equipment: 'eq',
  target_muscle: 'tg',
  instructions: 'desc',
  aliases: 'aliases',
  muscle_groups: 'muscleGroups'
}

/** Copies only the supplied parameters onto a stored exercise. */
function applyCustom(exercise, params) {
  for (const [key, destination] of Object.entries(SIMPLE_EXERCISE_FIELDS)) {
    if (params[key] !== undefined) exercise[destination] = params[key]
  }
  if (params.primary_muscles !== undefined) exercise.primaries = params.primary_muscles
  else if (params.target_muscle !== undefined) exercise.primaries = [params.target_muscle]
  if (params.secondary_muscles !== undefined) exercise.sm = exercise.secondaries = params.secondary_muscles
  return exercise
}

/** The exercise shape returned to clients. */
export function describeExercise(exercise, state) {
  return {
    id: exercise.id,
    name: exercise.n,
    body_part: exercise.bp,
    target_muscle: exercise.tg,
    secondary_muscles: exercise.sm || [],
    equipment: exercise.eq || '',
    instructions: exercise.desc || '',
    custom: exercise.custom === true,
    weight_unit: targetUnit(state, exercise.id)
  }
}

const isNamed = (exercise, name) => exercise.n?.toLocaleLowerCase() === name.toLocaleLowerCase()

/** True when any routine or logged workout refers to the exercise. */
function isReferenced(state, exerciseId) {
  const inRoutine = array(state.routines)
    .some(routine => array(routine.ex).some(entry => entry.id === exerciseId))
  const inWorkout = array(state.workouts)
    .some(workout => array(workout.entries).some(entry => entry.id === exerciseId))
  return inRoutine || inWorkout
}

export const createExercise = {
  name: 'create_exercise',
  description: 'Create a custom exercise in the connected openGym profile. Search first; create only when the user '
    + 'requests it or confirms that the catalogue has no suitable match.',
  schema: { ...customFields, ...controls },
  operation: (state, params, context) => {
    if (array(state.customEx).some(exercise => isNamed(exercise, params.name))) {
      fail('EEXISTS', 'A custom exercise with this name already exists. Search and update it instead.')
    }
    const exercise = applyCustom(
      { id: `c_${context.id}`, custom: true, sm: [], secondaries: [], eq: '', desc: '' },
      params
    )
    state.customEx ||= []
    state.customEx.push(exercise)
    return describeExercise(exercise, state)
  }
}

export const updateExercise = {
  name: 'update_exercise',
  description: 'Update only the supplied fields of an existing custom exercise. Preserves its ID, media and all '
    + 'unrelated fields. Built-in catalogue entries are read-only.',
  schema: {
    exercise_id: id,
    ...Object.fromEntries(Object.entries(customFields).map(([key, field]) => [key, field.optional()])),
    ...controls
  },
  operation: (state, params) => {
    const exercise = array(state.customEx).find(candidate => candidate.id === params.exercise_id)
      || fail('ENOENT', 'Custom exercise not found; built-in exercises cannot be edited.')
    return describeExercise(applyCustom(exercise, params), state)
  }
}

export const deleteExercise = {
  name: 'delete_exercise',
  destructive: true,
  description: 'Delete a custom exercise only after explicit user intent. Refuses deletion while any routine or '
    + 'historical workout references it, preserving history. Built-in exercises cannot be deleted.',
  schema: { exercise_id: id, ...deleteControls },
  operation: (state, params) => {
    if (!array(state.customEx).some(exercise => exercise.id === params.exercise_id)) {
      fail('ENOENT', 'Custom exercise not found.')
    }
    // Removing an exercise that history points at would orphan those entries, so refuse instead.
    if (isReferenced(state, params.exercise_id)) {
      fail('EINUSE', 'This exercise is used by a routine or workout. Its history was preserved; nothing was deleted.')
    }
    state.customEx = state.customEx.filter(exercise => exercise.id !== params.exercise_id)
    return { deleted_exercise_id: params.exercise_id }
  }
}

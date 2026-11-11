/** Routine mutation tools, including the weekly schedule of routines. */
import { z } from 'zod'
import { deleteRoutine as removeRoutineFromState } from '../../vendor/opengym/frontend/src/lib/routines.js'
import {
  array, controls, convert, deleteControls, fail, id, lookupExercise, lookupRoutine, targetUnit, text
} from './shared.js'

/** Per-exercise targets inside a routine. */
const exerciseConfigFields = {
  exercise_id: id,
  mode: z.enum(['reps', 'time', 'cardio']).optional(),
  sets: z.number().int().min(1).max(30).optional(),
  reps: z.number().int().min(1).max(1000).optional(),
  weight: z.number().min(0).max(5000).optional(),
  weight_unit: z.enum(['kg', 'lb']).optional(),
  seconds: z.number().min(1).max(86400).optional(),
  minutes: z.number().min(0.1).max(1440).optional(),
  speed: z.number().min(0).max(300).optional(),
  rest_seconds: z.number().int().min(0).max(3600).optional(),
  note: z.string().max(280).optional(),
  superset_group: z.string().max(80).optional(),
  reps_min: z.number().int().min(1).max(1000).optional(),
  reps_max: z.number().int().min(1).max(1000).optional()
}
const exerciseConfigSchema = z.object(exerciseConfigFields).strict()

/** The same fields without exercise_id, for editing an exercise already in a routine. */
const exerciseChangesSchema = z.object(Object.fromEntries(
  Object.entries(exerciseConfigFields)
    .filter(([key]) => key !== 'exercise_id')
    .map(([key, field]) => [key, field.optional()])
)).strict()

/** Tool parameter name to stored routine exercise field, for fields that copy over directly. */
const SIMPLE_CONFIG_FIELDS = {
  mode: 'mode',
  sets: 'sets',
  reps: 'reps',
  seconds: 'sec',
  minutes: 'min',
  speed: 'speed',
  rest_seconds: 'rest',
  note: 'note',
  superset_group: 'sg',
  reps_min: 'repsMin',
  reps_max: 'repsMax'
}

/**
 * Builds a stored routine exercise from tool parameters. When `existing` is
 * given it is the starting point, so fields the caller did not supply survive.
 */
function exerciseConfig(state, params, existing = null) {
  lookupExercise(state, params.exercise_id)
  const config = existing
    ? { ...existing, id: params.exercise_id }
    : { id: params.exercise_id, mode: params.mode || 'reps', sets: params.sets || 3, reps: params.reps || 10 }
  for (const [key, destination] of Object.entries(SIMPLE_CONFIG_FIELDS)) {
    if (params[key] !== undefined) config[destination] = params[key]
  }
  if (params.weight !== undefined) {
    const unit = targetUnit(state, config.id)
    config.weight = convert(params.weight, params.weight_unit || unit, unit)
  }
  if (config.repsMin !== undefined && config.repsMax !== undefined && config.repsMin > config.repsMax) {
    fail('EINVAL', 'reps_min must not exceed reps_max.')
  }
  if (config.mode === 'time' && !(config.sec > 0)) fail('EINVAL', 'Timed exercises require seconds.')
  if (config.mode === 'cardio' && !(config.min > 0)) fail('EINVAL', 'Cardio exercises require minutes.')
  return config
}

export const createRoutine = {
  name: 'create_routine',
  description: 'Create a named workout routine with exercise IDs and set targets. Resolve exercise IDs first. '
    + 'Weights use each exercise\'s configured unit unless weight_unit is supplied.',
  schema: {
    name: text,
    emoji: z.string().max(40).optional(),
    exercises: z.array(exerciseConfigSchema).max(100).default([]),
    ...controls
  },
  operation: (state, params, context) => {
    const name = params.name.toLocaleLowerCase()
    if (array(state.routines).some(routine => routine.name?.toLocaleLowerCase() === name)) {
      fail('EEXISTS', 'A routine with this name already exists. Read it before deciding whether to update it.')
    }
    const routine = {
      id: context.id,
      name: params.name,
      emoji: params.emoji || '\u{1F3CB}\u{FE0F}',
      ex: params.exercises.map(exercise => exerciseConfig(state, exercise))
    }
    state.routines ||= []
    state.routines.push(routine)
    return { routine_id: routine.id, name: routine.name, exercise_count: routine.ex.length }
  }
}

export const updateRoutine = {
  name: 'update_routine',
  destructive: true,
  description: 'Update a routine name or emoji. If exercises is supplied, it replaces the whole exercise list; '
    + 'read the routine first and preserve every exercise the user did not ask to change. '
    + 'Use the per-exercise tools for targeted edits.',
  schema: {
    routine_id: id,
    name: text.optional(),
    emoji: z.string().max(40).optional(),
    exercises: z.array(exerciseConfigSchema).max(100).optional(),
    ...controls
  },
  operation: (state, params) => {
    const routine = lookupRoutine(state, params.routine_id)
    if (params.name !== undefined) routine.name = params.name
    if (params.emoji !== undefined) routine.emoji = params.emoji
    if (params.exercises !== undefined) {
      // Carry over the stored settings of exercises that stay in the routine.
      routine.ex = params.exercises.map(exercise => exerciseConfig(
        state,
        exercise,
        array(routine.ex).find(previous => previous.id === exercise.exercise_id)
      ))
    }
    return { routine_id: routine.id, name: routine.name, exercise_count: array(routine.ex).length }
  }
}

export const addRoutineExercise = {
  name: 'add_routine_exercise',
  description: 'Add one exercise to a routine at a 1-based position, or append it. '
    + 'Preserves all existing exercises and their settings.',
  schema: {
    routine_id: id,
    exercise: exerciseConfigSchema,
    position: z.number().int().min(1).max(101).optional(),
    ...controls
  },
  operation: (state, params) => {
    const routine = lookupRoutine(state, params.routine_id)
    routine.ex ||= []
    if (routine.ex.length >= 100) fail('ELIMIT', 'The routine already has 100 exercises.')
    const index = params.position === undefined ? routine.ex.length : params.position - 1
    if (index > routine.ex.length) fail('EINVAL', 'Position is beyond the routine. Read it before editing.')
    routine.ex.splice(index, 0, exerciseConfig(state, params.exercise))
    return { routine_id: routine.id, position: index + 1, exercise_id: params.exercise.exercise_id }
  }
}

export const updateRoutineExercise = {
  name: 'update_routine_exercise',
  description: 'Change specified settings of a routine exercise at a 1-based position. Read the routine first; '
    + 'check expected_exercise_id so reordered exercises are not edited by mistake.',
  schema: {
    routine_id: id,
    position: z.number().int().min(1).max(100),
    expected_exercise_id: id,
    changes: exerciseChangesSchema,
    ...controls
  },
  operation: (state, params) => {
    const routine = lookupRoutine(state, params.routine_id)
    const exercise = array(routine.ex)[params.position - 1]
    if (!exercise || exercise.id !== params.expected_exercise_id) {
      fail('ECONFLICT', 'The routine position no longer contains the expected exercise. Read the routine again.')
    }
    routine.ex[params.position - 1] = exerciseConfig(state, { ...params.changes, exercise_id: exercise.id }, exercise)
    return { routine_id: routine.id, position: params.position, exercise: routine.ex[params.position - 1] }
  }
}

export const removeRoutineExercise = {
  name: 'remove_routine_exercise',
  destructive: true,
  description: 'Remove one exercise from a routine after explicit user intent. Checks its position and exact ID; '
    + 'does not delete the exercise or workout history.',
  schema: {
    routine_id: id,
    position: z.number().int().min(1).max(100),
    expected_exercise_id: id,
    ...deleteControls
  },
  operation: (state, params) => {
    const routine = lookupRoutine(state, params.routine_id)
    if (array(routine.ex)[params.position - 1]?.id !== params.expected_exercise_id) {
      fail('ECONFLICT', 'The exercise at this position changed. Read the routine again.')
    }
    routine.ex.splice(params.position - 1, 1)
    return { routine_id: routine.id, removed_exercise_id: params.expected_exercise_id }
  }
}

export const deleteRoutine = {
  name: 'delete_routine',
  destructive: true,
  description: 'Delete a routine and its weekly/per-date assignments after explicit user intent. '
    + 'Historical workouts remain intact.',
  schema: { routine_id: id, ...deleteControls },
  operation: (state, params) => {
    lookupRoutine(state, params.routine_id)
    removeRoutineFromState(state, params.routine_id)
    return { deleted_routine_id: params.routine_id }
  }
}

export const setWeekdayRoutines = {
  name: 'set_weekday_routines',
  description: 'Set the ordered routines for one weekday (0 Sunday through 6 Saturday). '
    + 'An empty list clears only that weekday. Does not change per-date overrides.',
  schema: {
    weekday: z.number().int().min(0).max(6),
    routine_ids: z.array(id).max(20),
    ...controls
  },
  operation: (state, params) => {
    for (const routineId of params.routine_ids) lookupRoutine(state, routineId)
    state.week ||= {}
    if (params.routine_ids.length) state.week[params.weekday] = [...new Set(params.routine_ids)]
    else delete state.week[params.weekday]
    return { weekday: params.weekday, routine_ids: state.week[params.weekday] || [] }
  }
}

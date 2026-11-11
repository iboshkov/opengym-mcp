/** Read tools added by this service on top of the vendored upstream read tools. */
import { z } from 'zod'
import { EXDB } from '../../vendor/opengym/frontend/src/lib/exercises-data.js'
import { describeExercise } from './exercises.js'
import { array, id, lookupExercise, text } from './shared.js'

const getProfile = {
  name: 'get_profile',
  description: 'Read the connected profile name, units and record counts. Use before making changes; '
    + 'never assume another profile or units.',
  schema: {},
  handler: (params, context) => ({
    profile: { id: context.user.id, name: context.user.name },
    unit: context.state?.unit || 'kg',
    revision: context.revision,
    workouts: array(context.state?.workouts).length,
    routines: array(context.state?.routines).length,
    custom_exercises: array(context.state?.customEx).length
  })
}

const searchExercises = {
  name: 'search_exercises',
  description: 'Search the built-in exercise catalogue and the connected profile\'s custom exercises. '
    + 'Resolve exact exercise IDs and ambiguity before creating routines or logging workouts.',
  schema: {
    query: text,
    limit: z.number().int().min(1).max(50).default(15),
    custom_only: z.boolean().default(false)
  },
  handler: (params, context) => {
    const state = context.state || {}
    const query = params.query.toLocaleLowerCase()
    const candidates = [...array(state.customEx), ...(params.custom_only ? [] : EXDB)]
    const matches = candidates.filter(exercise => {
      const names = [exercise.n, ...array(exercise.aliases), ...array(state.exAliases?.[exercise.id])]
      return names.some(name => String(name).toLocaleLowerCase().includes(query))
    })
    return { exercises: matches.slice(0, params.limit).map(exercise => describeExercise(exercise, state)) }
  }
}

const getExercise = {
  name: 'get_exercise',
  description: 'Read exercise details by exact ID, including whether it is custom. Built-in catalogue exercises '
    + 'cannot be edited or deleted through this service.',
  schema: { exercise_id: id },
  handler: (params, context) => {
    const state = context.state || {}
    return describeExercise(lookupExercise(state, params.exercise_id), state)
  }
}

export const extraReadTools = [getProfile, searchExercises, getExercise]
  .map(tool => ({ ...tool, write: false, run: tool.handler }))

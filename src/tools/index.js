/**
 * Assembles the tool catalogue: upstream reads, this service's extra reads,
 * the mutation tools, and upstream writes, in that order. Also builds the MCP
 * tool definitions and re-exports the server instructions.
 */
import { z } from 'zod'
import { READ, WRITE } from '../scopes.js'
import { addBodyweight, deleteBodyweight, updateBodyweight } from './bodyweight.js'
import { createExercise, deleteExercise, updateExercise } from './exercises.js'
import { instructions } from './instructions.js'
import { extraReadTools } from './reads.js'
import {
  addRoutineExercise, createRoutine, deleteRoutine, removeRoutineExercise,
  setWeekdayRoutines, updateRoutine, updateRoutineExercise
} from './routines.js'
import { upstreamReadTools, upstreamWriteTools } from './upstream.js'
import { deleteWorkout, updateWorkout } from './workouts.js'

export { instructions }

export const mutationTools = [
  createExercise,
  updateExercise,
  deleteExercise,
  createRoutine,
  updateRoutine,
  addRoutineExercise,
  updateRoutineExercise,
  removeRoutineExercise,
  deleteRoutine,
  setWeekdayRoutines,
  addBodyweight,
  updateBodyweight,
  updateWorkout,
  deleteWorkout,
  deleteBodyweight
]

/** Runs a mutation through the openGym API: read current revision, apply, save. */
const runMutation = tool => (params, context) => context.api.mutate(
  context.token,
  (state, mutationContext) => tool.operation(state, params, mutationContext),
  { dryRun: params.dry_run === true }
)

export const tools = [
  ...upstreamReadTools,
  ...extraReadTools,
  ...mutationTools.map(tool => ({ ...tool, write: true, run: runMutation(tool) })),
  ...upstreamWriteTools
]

export const toolDefinitions = tools.map(tool => {
  const securitySchemes = [{ type: 'oauth2', scopes: tool.write ? [READ, WRITE] : [READ] }]
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(z.object(tool.schema).strict()),
    annotations: {
      readOnlyHint: !tool.write,
      destructiveHint: tool.destructive === true,
      idempotentHint: !tool.write,
      openWorldHint: false
    },
    securitySchemes,
    _meta: { securitySchemes }
  }
})

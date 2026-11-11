/**
 * Assembles the tool catalogue: upstream reads, this service's extra reads,
 * the mutation tools, and upstream writes, in that order. Also builds the MCP
 * tool definitions and re-exports the server instructions.
 */
import { z } from 'zod'
import { READ, WRITE } from '../scopes.ts'
import { addBodyweight, deleteBodyweight, updateBodyweight } from './bodyweight.ts'
import { createExercise, deleteExercise, updateExercise } from './exercises.ts'
import { instructions } from './instructions.ts'
import { extraReadTools } from './reads.ts'
import {
  addRoutineExercise, createRoutine, deleteRoutine, removeRoutineExercise,
  setWeekdayRoutines, updateRoutine, updateRoutineExercise
} from './routines.ts'
import { upstreamReadTools, upstreamWriteTools } from './upstream.ts'
import { deleteWorkout, updateWorkout } from './workouts.ts'
import type { MutationDefinition, ToolContext, ToolDefinition } from './shared.ts'

export { instructions }

// Each mutation keeps its own params type; the list only needs the common shape.
export const mutationTools: MutationDefinition[] = [
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
const runMutation = (tool: MutationDefinition) => (params: Record<string, unknown>, context: ToolContext) => context.api.mutate(
  context.token,
  (state, mutationContext) => tool.operation(state, params, mutationContext),
  { dryRun: params.dry_run === true }
)

export const tools: ToolDefinition[] = [
  ...upstreamReadTools,
  ...extraReadTools,
  ...mutationTools.map((tool): ToolDefinition => ({ ...tool, write: true, run: runMutation(tool) })),
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

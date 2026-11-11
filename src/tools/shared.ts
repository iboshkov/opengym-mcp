/**
 * Building blocks shared by the tool modules: common zod fields, the error
 * helper, lookups into the profile state, and weight unit conversion.
 */
import { z } from 'zod'
import { EXDB as VENDORED_EXDB } from '../../vendor/opengym/frontend/src/lib/exercises-data.js'
import { ApiError } from '../opengym/api.ts'
import type { MutationContext, OpenGymApi, OpenGymState, Profile } from '../opengym/api.ts'

/** Weight units a profile or exercise can use. */
export type WeightUnit = 'kg' | 'lb'

/** An exercise as stored in the catalogue or in a profile's custom exercises. */
export interface StoredExercise {
  id: string
  n?: string
  bp?: string
  tg?: string
  sm?: string[]
  eq?: string
  desc?: string
  custom?: boolean
  aliases?: string[]
  primaries?: string[]
  secondaries?: string[]
  muscleGroups?: string[]
  /** Fields this service does not touch, such as media, are kept as they are. */
  [field: string]: unknown
}

/** One exercise inside a stored routine, with its targets. */
export interface RoutineExercise {
  id: string
  mode?: 'reps' | 'time' | 'cardio'
  sets?: number
  reps?: number
  weight?: number
  sec?: number
  min?: number
  speed?: number
  rest?: number
  note?: string
  sg?: string
  repsMin?: number
  repsMax?: number
  [field: string]: unknown
}

export interface Routine {
  id: string
  name?: string
  emoji?: string
  ex?: RoutineExercise[]
}

/** One performed set. Rep sets use r, timed sets sec, cardio sets min. */
export interface WorkoutSet {
  r?: number
  sec?: number
  min?: number
  w?: number
}

export interface WorkoutEntry {
  id: string
  sets?: WorkoutSet[]
}

export interface Workout {
  id: string
  d?: string
  name?: string
  note?: string
  vol?: number
  entries?: WorkoutEntry[]
}

/** One day of bodyweight readings; the readings themselves are managed by the vendored weigh-ins library. */
export interface BodyweightDay {
  d: string
}

/** The parts of the profile document that the mutation tools read or change. */
export interface ProfileState extends OpenGymState {
  unit?: WeightUnit
  exUnit?: Record<string, WeightUnit>
  customEx?: StoredExercise[]
  exAliases?: Record<string, string[]>
  routines?: Routine[]
  workouts?: Workout[]
  bodyweight?: BodyweightDay[]
  week?: Record<number, string[]>
}

/**
 * The built-in exercise catalogue. The vendored module is untyped JavaScript,
 * so this narrows what tsc infers to the fields this service reads.
 */
export const EXDB = VENDORED_EXDB as unknown as StoredExercise[]

/** What a tool handler receives besides its parameters. */
export interface ToolContext {
  api: OpenGymApi
  /** The connected profile's upstream openGym session token. */
  token: string
  user: Profile['user']
  /** The profile document as read when the call started, or null before the first sync. */
  state: OpenGymState | null
  revision: number
}

/** One tool as the runner sees it. */
export interface ToolDefinition<Params = Record<string, unknown>> {
  name: string
  description: string
  schema: z.ZodRawShape
  /** Whether the tool saves changes and so needs the write scope. */
  write: boolean
  destructive?: boolean
  run(params: Params, context: ToolContext): unknown
}

/** A mutation tool: an operation applied to a copy of the profile document. */
export interface MutationDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  destructive?: boolean
  schema: Shape
  operation(state: ProfileState, params: z.infer<z.ZodObject<Shape>>, context: MutationContext): unknown
}

/** A read tool: a handler over the document the call started with. */
export interface ReadDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  schema: Shape
  handler(params: z.infer<z.ZodObject<Shape>>, context: ToolContext): unknown
}

/** Declares a read tool so its handler's params follow its schema. */
export const defineRead = <Shape extends z.ZodRawShape>(
  definition: ReadDefinition<Shape>
): ReadDefinition<Shape> => definition

/** The schema shape with every field made optional. */
export type Optionalised<Shape extends z.ZodRawShape> = { [Key in keyof Shape]: z.ZodOptional<Shape[Key]> }

/** Declares a mutation tool so its operation's params follow its schema. */
export const defineMutation = <Shape extends z.ZodRawShape>(
  definition: MutationDefinition<Shape>
): MutationDefinition<Shape> => definition

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

export function fail(code: string, message: string): never {
  throw new ApiError(code, message)
}

export const array = <T>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : [])

/** Finds an exercise among the profile's custom exercises, then the built-in catalogue. */
export function lookupExercise(state: ProfileState, exerciseId: string): StoredExercise {
  return array(state.customEx).find(exercise => exercise.id === exerciseId)
    || EXDB.find(exercise => exercise.id === exerciseId)
    || fail('ENOENT', 'Exercise not found. Search exercises before writing.')
}

export function lookupRoutine(state: ProfileState, routineId: string): Routine {
  return array(state.routines).find(routine => routine.id === routineId)
    || fail('ENOENT', 'Routine not found. List routines before writing.')
}

/** The profile's default weight unit. */
export const profileUnit = (state: ProfileState): WeightUnit => (state.unit === 'lb' ? 'lb' : 'kg')

/** The unit an exercise's weights are stored in: its own setting, else the profile unit. */
export const targetUnit = (state: ProfileState, exerciseId: string): WeightUnit =>
  state.exUnit?.[exerciseId] || profileUnit(state)

/** Converts a weight between kg and lb, rounded to two decimals. */
export function convert(value: number, from: WeightUnit, to: WeightUnit): number {
  if (from === to) return value
  const converted = from === 'kg' ? value * POUNDS_PER_KILOGRAM : value / POUNDS_PER_KILOGRAM
  return Math.round(converted * 100) / 100
}

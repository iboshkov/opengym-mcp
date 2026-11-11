/** Bodyweight reading mutation tools. Readings are stored in the profile's unit. */
import { z } from 'zod'
import { isoDate } from '../../vendor/opengym/mcp/src/tools.js'
import { addWeighIn, editWeighIn, removeWeighIn, readingsOf } from '../../vendor/opengym/frontend/src/lib/weigh-ins.js'
import { array, controls, convert, deleteControls, fail, id, profileUnit, timeOfDay } from './shared.js'

const weightFields = {
  weight: z.number().positive().max(2000),
  unit: z.enum(['kg', 'lb'])
}

export const addBodyweight = {
  name: 'add_bodyweight',
  description: 'Add a bodyweight reading on an explicit date, optionally at HH:MM. Requires an explicit unit and '
    + 'converts into the profile unit. Multiple readings per day are supported.',
  schema: { date: isoDate(), time: timeOfDay.optional(), ...weightFields, ...controls },
  operation: (state, params, context) => {
    const day = array(state.bodyweight).find(entry => entry.d === params.date)
    if (params.time && readingsOf(day).some(reading => reading.at === params.time)) {
      fail('EEXISTS', 'A reading already exists at that time. Use update_bodyweight to correct it.')
    }
    const reading = addWeighIn(state, {
      d: params.date,
      at: params.time || null,
      w: convert(params.weight, params.unit, profileUnit(state)),
      t: context.now,
      id: context.id
    })
    return { date: params.date, reading_id: reading.id, weight: reading.w, unit: state.unit || 'kg' }
  }
}

export const updateBodyweight = {
  name: 'update_bodyweight',
  description: 'Correct an existing bodyweight reading by date and reading ID from get_bodyweight. '
    + 'Preserves other readings, including other readings on the same day.',
  schema: { date: isoDate(), reading_id: id, ...weightFields, time: timeOfDay.optional(), ...controls },
  operation: (state, params, context) => {
    const changes = { w: convert(params.weight, params.unit, profileUnit(state)) }
    if (params.time !== undefined) changes.at = params.time
    const result = editWeighIn(state, params.date, params.reading_id, changes, context.now)
    if (!result) fail('ENOENT', 'Bodyweight reading not found. Read bodyweight records before editing.')
    return { date: result.d, reading_id: result.id, unit: state.unit || 'kg' }
  }
}

export const deleteBodyweight = {
  name: 'delete_bodyweight',
  destructive: true,
  description: 'Delete one bodyweight reading by date and reading ID after explicit user intent. '
    + 'Other readings on that day remain.',
  schema: { date: isoDate(), reading_id: id, ...deleteControls },
  operation: (state, params, context) => {
    if (!removeWeighIn(state, params.date, params.reading_id, context.now)) {
      fail('ENOENT', 'Bodyweight reading not found.')
    }
    return { deleted_date: params.date, deleted_reading_id: params.reading_id }
  }
}

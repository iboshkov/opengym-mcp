# Tools

openGym MCP exposes 29 tools. The assistant receives server instructions on connect that tell it to read before writing, resolve ambiguous exercise names with you, respect units, never invent training data, change only what you asked for, and require explicit intent before deleting. Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) and declare the OAuth scopes they need.

Contents: [Scopes](#scopes) · [Read tools](#read-tools) · [Write tools](#write-tools) · [Write semantics](#write-semantics) · [Errors](#errors) · [Not available](#not-available)

## Scopes

| Scope | Allows |
| --- | --- |
| `opengym:read` | All read tools. Every connection has it. |
| `opengym:write` | Write tools, in addition to read. Optional at sign-in. |

A write call on a read-only connection returns an error telling the assistant to reconnect with write permission.

## Read tools

| Tool | What it returns |
| --- | --- |
| `get_profile` | Profile name, default unit, current revision, and counts of workouts, routines and custom exercises. |
| `search_exercises` | Matches from the built-in catalogue and the profile's custom exercises, by name or alias. Parameters: `query`, `limit` (1 to 50, default 15), `custom_only`. |
| `get_exercise` | One exercise by exact ID, including whether it is custom. |
| `list_routines` | The saved routines (the Plan screen's list). |
| `get_routine` | The full exercise list and stored set, rep and weight targets of one routine. |
| `preview_session` | The session a routine will actually open with after progression and history are applied. This can differ from the stored targets that `get_routine` reports. |
| `get_week_plan` | What is planned over the next seven dates and how each day was decided. |
| `get_programme` | Multi-week programmes and the one currently running. |
| `list_workouts` | Recent finished workouts, newest first, with optional `from` and `to` dates and a `limit`. |
| `get_workout` | The full breakdown of one workout, by `workout_id` or `date`. For filmed sets it reports only a count. |
| `get_bodyweight` | The bodyweight log with goal deltas, including several readings per day. |
| `estimate_1rm` | Estimated one-rep max for an exercise, or a table across exercises, using Epley, Brzycki or Lombardi. |
| `muscle_balance` | Which muscles were worked over a `week`, `month` or `all`, ranked by effective sets. |

The training calculations come from openGym's own code, vendored from upstream (see [DEVELOPMENT.md](DEVELOPMENT.md)).

## Write tools

All need `opengym:write`. Tools marked destructive also require `confirm: true`.

| Area | Tool | What it does |
| --- | --- | --- |
| Custom exercises | `create_exercise` | Creates a custom exercise. Refuses a duplicate name. |
| | `update_exercise` | Changes only the supplied fields of a custom exercise. |
| | `delete_exercise` | Destructive. Refused while any routine or workout still uses the exercise. |
| Routines | `create_routine` | Creates a routine from exercise IDs and set targets. Refuses a duplicate name. |
| | `update_routine` | Changes name or emoji. If `exercises` is given it replaces the whole list. |
| | `add_routine_exercise` | Inserts or appends one exercise at a 1-based `position`. |
| | `update_routine_exercise` | Changes settings of the exercise at a position. |
| | `remove_routine_exercise` | Removes one exercise. Checks both the position and the expected exercise ID. |
| | `delete_routine` | Destructive. Also clears its weekly and per-date assignments. History is kept. |
| | `set_weekday_routines` | Sets the ordered routines for one weekday, 0 (Sunday) to 6 (Saturday). An empty list clears that weekday. |
| Workouts | `log_workout` | Logs a workout from names, sets, reps and weights. Matches exercises by name or ID. |
| | `update_workout` | Corrects name, note, date, start, duration or specific sets. |
| | `delete_workout` | Destructive. Rebuilds PR history for the affected exercises. |
| Bodyweight | `add_bodyweight` | Adds a reading on an explicit date, with a required `unit`, optionally at `HH:MM`. |
| | `update_bodyweight` | Corrects a reading by date and reading ID from `get_bodyweight`. |
| | `delete_bodyweight` | Destructive. Other readings that day stay. |

Rules worth knowing:

- Built-in catalogue exercises are read-only. Only custom exercises can be created, changed or deleted.
- Routine positions are one-based. Weekdays run 0 for Sunday to 6 for Saturday.
- Weights are converted into the profile's unit (or the exercise's own unit). Bodyweight writes need an explicit `unit`.
- A completed workout cannot be moved so that it ends in the future.

## Write semantics

**Targeted changes.** Each write tool reads the profile's current revision through the openGym API, applies only the requested change to a copy, and saves it against that revision. Settings, history and everything else in the profile are left as they were. If another device saved in the meantime, the change is re-applied on top of the newer document, up to three attempts, so edits from other devices are preserved. If the profile keeps changing, the call fails with `ECONFLICT` and nothing is overwritten.

**Result shape.** A saved change reports `saved: true` and the new revision. If the profile already matches what was asked, it reports `saved: false, unchanged: true`.

**`dry_run`.** Every write tool accepts `dry_run: true`, which computes and returns the result without saving anything and without using up the hourly write budget.

**`request_id`.** Every write tool except `log_workout` accepts a `request_id` (8 to 128 characters) that makes retries safe. Use a stable ID for one intended change and reuse it when retrying:

- Repeating the same `request_id` with the same arguments returns the original result and does not write again, even across a service restart. A concurrent duplicate waits for the first call and shares its result.
- Reusing it with different arguments is an error (`EREQUEST`). Use a new ID for a different change.
- Receipts are encrypted in the service's store, kept for 24 hours, and capped at 2000.
- If an earlier attempt definitely saved nothing (a validation error or an explicit refusal from openGym), a retry simply runs again.
- If the outcome of an earlier attempt is unknown (the network failed mid-write, or the service crashed), a retry returns `EUNCERTAIN`. The assistant should read the affected record, then decide whether to retry with a new `request_id`.

**`log_workout`.** It does not take a `request_id`. It uses openGym's own duplicate-session detection instead: describing the same sets again does not log them twice, and `allow_duplicate` overrides it for a genuine second session. It also has an upstream limit of 20 saves per hour, counted across the whole service process rather than per profile.

**Deletion.** Delete tools refuse to run without `confirm: true`. They are annotated as destructive so assistants can ask you first. A custom exercise cannot be deleted while a routine or workout references it, and this check cannot be bypassed.

**Rate limit.** Each profile may make 120 write requests per hour (dry runs and replayed receipts excluded). The count is kept in memory and starts over when the service restarts.

**Profile must be synced.** If a profile has never been opened in the openGym app, writes fail with `ENOSTATE` until it has.

## Errors

Tool errors come back as MCP tool results with `isError` and a code at the start of the message.

| Code | Meaning |
| --- | --- |
| `ENOENT` | The exercise, routine, workout or reading was not found. |
| `EEXISTS` | A custom exercise or routine with that name, or a reading at that time, already exists. |
| `EINUSE` | A delete was refused because the exercise is still used. |
| `EINVAL` | The change is not valid, for example a workout ending in the future. |
| `ECONFLICT` | The profile kept changing, or a routine position no longer holds the expected exercise. Read again. |
| `EREQUEST` | A `request_id` was reused with different arguments. |
| `EUNCERTAIN` | An earlier attempt may or may not have saved. Read the record before retrying. |
| `ERATE` | A write limit was reached. Wait before changing more. |
| `EAUTH` | The openGym session was revoked or expired. Reconnect. |
| `EAPI` | openGym could not be reached, refused the request, or returned something unexpected. A write may have completed if the network failed. |
| `ENOSTATE` | The profile has no data yet. Open and sync it in the openGym app. |

Invalid arguments are reported as `Invalid tool arguments` with the offending fields. Unexpected internal errors give the assistant a generic message and are not detailed.

## Not available

- Exercise photos and videos. `get_workout` reports only how many sets were filmed.
- Changing account settings, passkeys, other profiles, or anything outside the tools above.
- Editing built-in catalogue exercises.

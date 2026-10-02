# WODin — the model

## The problem

An agent that coaches someone has to cross a gap twice: get a prescription into a human's
hands in a form they can actually use mid-workout, and get back what really happened in a
form it can compute on. Chat handles neither end well — a workout pasted into a chat window
is unreadable at the rack, and a workout recounted in prose is unparseable afterward.

WODin is that round trip and nothing else. It contains no coaching logic on purpose.

## Three documents

```
wod.json  ────────>  the page  ────────>  result.json
  plan                 log                  actuals
```

**The plan** (`schema/wod.schema.json`) is `sections → exercises → sets`. A *set* is one
prescription row; an *exercise* is the movement containing them. This nesting is what makes
barbell waves, cluster sets and partial cardio prescriptions all fall out of one structure
rather than needing special cases:

```json
{ "movement": "Barbell bent row", "kind": "weight_reps",
  "sets": [{ "reps": 5, "load": 135 }, { "reps": 5, "load": 155 }, { "reps": 3, "load": 175 }] }
```

**The page** renders it, prefilled, and saves to the device as you type.

**The result** (`schema/result.schema.json`) echoes the same keys with actuals.

## Why the plan prefills but the result doesn't

The athlete is *confirming* a prescription, not filling a blank form. Loads and reps arrive
filled in, so a session done exactly as written costs zero taps — and any edit is, by
definition, a deviation worth recording.

That logic inverts for anything only the athlete knows. Session RPE, notes and the summary
start **blank**, with the prescription shown as a ghost (`Rx 7`). A prefilled 7 can't be
told apart from an answered 7, and `rpe: null` — *they didn't say* — is a genuinely
different fact from `rpe: 7`.

## Why `log` is complete rather than a diff

A sparse result would only carry deviations, which is smaller but ambiguous: a missing set
could mean "did it exactly as prescribed" or "never logged it". Those must not collapse.

So `log` carries every non-skipped set, and `asPlanned` marks which matched. Absence means
skipped, always. About 1.5 KB for a 25-set session — cheap enough to be unambiguous.

Submitting asserts intent: untouched sets come back `asPlanned: true`, because tapping **Log
workout** is the athlete saying *this is what I did*.

## Five field layouts

`kind` decides which fields a row draws, and it's explicit rather than inferred. Inference
looks tempting — just draw whichever fields are non-null — but it breaks precisely where it
matters: a field the athlete is *meant to fill* is null in the plan too, so it would vanish.

| `kind` | Fields |
|---|---|
| `weight_reps` | load × reps |
| `reps` | reps |
| `time` | duration |
| `cardio` | pace + distance + time |
| `carry` | load × reps + distance |

Each is one row. Every field carries a persistent unit suffix — not a placeholder, which
would disappear on the first keystroke, taking the unit with it exactly when the number
needs it. Since the unit names the field, cardio needs no separate labels, which is what
lets three fields share a row.

## Partial prescriptions

Cardio is usually two knowns and a blank: distance and target pace given, the athlete
supplies the time they actually took.

```json
{ "distance": 500, "pace": "2:00/500m", "duration": null, "athleteFills": "duration" }
```

`athleteFills` names the expected blank. Time fields accept bare digits and format
themselves — typing `158` yields `1:58` — because an iOS numeric keypad has no colon key.

## One note per exercise

The athlete gets one note per movement, as a `+ note` pill. Not per set: how a movement went
is one thought, and five boxes fragment it. Not per exercise *and* per set: two levels means
neither gets used consistently.

The exercise also carries `cue` — but that runs the other way, agent to athlete. Two fields,
two directions, no overlap.

## Formats and rounds

`sections → exercises → sets` describes a strength session well and a conditioning piece
badly: "three rounds of run, swing, pull-up for time" is one effort, not three exercises
with one set each. So a section can carry four optional additions. A plan that uses none of
them is unchanged, and so is its result.

| Field | Shape | Does |
|---|---|---|
| `format` | `{ type, rounds?, workSec?, restSec?, intervalSec?, capSec?, score? }` | header above the block; score box after it |
| `rounds[]` | `[{ reps?, movements?, repeat? }]` | the round > movements hierarchy |
| `optional[]` | `[{ id, label, load? }]` | scaling pills at the top of the block |
| `modifiers[]` | `[{ id, label, load?, optional: true }]` | add-on pills, same look, recorded differently |

### `format`

`type` is one of `tabata`, `emom`, `intervals`, `for_time`, `amrap`, `circuit`. Spans are
seconds. `restSec` means two different things, and the type decides which: for `tabata` and
`intervals` it is the rest after each work interval; for `for_time` and `circuit` it is the
rest after each round. `score` is `time`, `rounds_reps`, `total_reps` or `none`; absent is
`none`.

```json
{ "type": "tabata", "rounds": 8, "workSec": 20, "restSec": 10, "score": "none" }
```

### `rounds[]`

A list compact enough to write 21-15-9 as three short entries:

```json
[
  { "reps": 21, "movements": [
    { "movement": "Barbell deadlift", "kind": "weight_reps", "load": 225 },
    { "movement": "Handstand push-up", "kind": "reps" } ] },
  { "reps": 15 },
  { "reps": 9 }
]
```

- An entry with `movements` starts a new round. One without reuses the previous round's
  movements, so the first entry must have them.
- A round's `reps` replaces the reps of every rep-based movement in it (`reps`,
  `weight_reps`, `carry`); cardio and time movements keep theirs.
- `repeat: n` adds n copies — of the previous round when the entry has neither `movements`
  nor `reps`, otherwise of the entry itself.
- When the list expands to fewer rounds than `format.rounds`, the last round is copied up to
  the count. One round written, five performed, is Barbara.
- `amrap` is never expanded. Its rounds are unbounded, so the list is a template, drawn once
  and read-only; the score carries the count.

A `tabata` or `emom` needs no list at all. With `format.rounds` and `exercises` and no
`rounds[]`, its rounds are **derived**: one round, a movement per exercise taken from that
exercise's first set (`intervalSlot` kept), padded to `format.rounds` like Barbara. A Tabata
is one movement done eight times, and writing it eight times would be the plan repeating
itself. The derived rounds replace the set rows, so those sets are not in `log` — the rounds
are the record. A chipper (`for_time` over exercises) and `intervals` stay exercise-based:
there the sets are the record.

A round movement is flat — a round is already one pass, so there are no `sets[]`. It takes a
set's fields directly, plus `movement`, `kind`, `tag`, `cue`, `link` and `partition`, and
kinds may mix within a round. `kind` stays mandatory for the same reason it is everywhere
else.

### The round check rule

Each movement and each round has a checkbox, and they are one fact stored two ways: a round
is done exactly when all its movements are. Ticking a round ticks every movement; ticking the
last movement closes the round; unticking any one reopens it. Both sides are always written
together, so a result can never say a round is done while a movement in it is not.

### Smaller fields

- `loadBwMult` (set or round movement) — load as a multiple of bodyweight. A chip shows
  `1.5× BW`; the load field stays open for the number actually lifted, which the plan
  cannot know.
- `partition` (exercise or round movement) — `"free"`, `"unbroken"` or `{ "max": n }`, a
  hint under the name.
- `intervalSlot` (exercise) — `"A"` / `"B"` for an EMOM that alternates; meaningless, and
  warned about, anywhere else.

Movement names stay plain here too: `Run`, `Pull-up`, `Push-up`, `Air squat`. A modifier such
as outdoors or bodyweight goes in the movement's `cue`; real equipment that makes it a
different lift (`Barbell deadlift`, `Kettlebell swing`, `Rowing machine row`) stays in the
name. A formatted block holds the working piece only; warm-up ramps go in a warm-up section.
The twelve example sections in `examples/format-test.json` each teach one distinct shape, and
`AGENT.md` has the decision guide, annotated examples and a do/don't list built on them.

### One footer per block

A section with `rounds[]` (written or derived), or a score other than `none`, is one
effort, so it is rated and annotated once: a score box, then a single RPE and a single note.
They go in the same `exerciseRpe` and `notes` maps, keyed by the **section id** instead of
an exercise id. Sections without a scored format keep one RPE and one note per exercise.

### When not to ask for RPE

Asking someone to rate Murph is noise: a girl or a hero is max effort by definition. So a
section may carry `benchmark: "girl" | "hero"`, and the plan or a section may carry
`rpe: "ask" | "hide" | 1–11`. `rpe` wins; a benchmark without one assumes 11; otherwise the
page asks, which is all a legacy plan ever does. The session follows the plan's `rpe`, and
assumes 11 when every section is a benchmark.

An assumed RPE is not an answer, so it is never put in a control — the pill is simply
absent, in keeping with the prefill rule above. It comes back as `rpe` plus
`rpeAssumed: true` (top level for the session, `sections[id]` for a block, never
`exerciseRpe`). 11 is off the 1–10 scale on purpose: even a consumer that ignores
`rpeAssumed` cannot mistake it for a tapped 10. The same goes for a section without a
block footer: its per-exercise RPE pills are drawn only when the section asks. A hidden
session RPE takes the select out of the closing row entirely, and duration spans it.

### The stopwatch beside a finish time

A `time` score box carries Start / Pause / Resume and Reset. It is a convenience for
filling the box, not a second record: the result still carries only `score.time` /
`timeSec`. Its state (`startedAt` epoch ms + accumulated ms) is saved with the log and
elapsed is computed from the clock on every repaint, never by counting ticks, so a reload,
a backgrounded tab or a phone that slept mid-metcon loses nothing and a throttled timer
cannot drift. Start runs from whatever the field shows; typing in the field stops the
stopwatch and takes the typed value; Reset clears both. Pausing — or opening Log workout,
which pauses every running clock — writes the time into the box, seconds floored.

### Typing times

Time fields that write their own colons — the session duration, set and round-movement
`duration` and `pace`, and the time score — take the digit keypad: `841` becomes `8:41`
as it is typed, `12542` becomes `1:25:42`, and a pace stops at `m:ss`. They use
`inputmode="numeric"`. The value stays the same `h:mm:ss` / `m:ss` string; the timer
still fills the session duration, and an already-stored value shows as it was saved.

### What the result adds

Nothing, for a section that uses none of this. Otherwise a `sections` map, keyed by section
id, holds one entry per such section:

| Key | Shape |
|---|---|
| `score` | `{ time, timeSec }`, `{ rounds, reps }` or `{ totalReps }`. `null` when scored and left blank — distinct from absent, which means not scored. |
| `optional` | `{ id: true }` for the pills switched on, and nothing else. |
| `modifiers` | `{ id: true \| false }` for every modifier offered. |
| `rounds` | `[{ done, movements: [{ movement, done, … }] }]`, one per round performed. Absent for `amrap`. |
| `rpe`, `rpeAssumed` | Only for an assumed block RPE: `11, true` for a benchmark. Never mirrored to the top level, where `rpe` is the session's. |

The asymmetry between `optional` and `modifiers` is deliberate. A scaling option unused is
the default and needs no record; a vest left off is a choice about the workout itself, so it
is recorded either way.

When exactly one section has an entry, its keys are also mirrored to the top level of the
result — the shape a single-WOD reader expects. With two or more, only `sections` exists,
which is why it is the canonical form.

Round movements live only here. `log` stays sets-only and keyed `"exId.setId"`, so
everything said above about it — complete, `asPlanned`, absence means skipped — still holds,
with one exception: a derived tabata / emom's sets are drawn as rounds, so they appear here
and not in `log`.

## Transport

The workout travels in the **URL fragment**: `#w=` (deflate-raw, base64url) or `#wj=`
(plain base64url JSON). A fragment is never sent to a server, so the workout isn't uploaded
anywhere — GitHub Pages serves a static shell that has no idea what it's displaying. A full
session is about 0.5 KB (the smallest plan) to about 2 KB (the twelve-section format test)
of URL.

Opening a link files the workout in the device's library, so it's reachable afterward
without the link. That matters more than it sounds: an installed PWA launches its manifest
`start_url`, not the URL you installed from, so a fragment-only design would open to nothing.
The home screen is that library.

Alternatives, same schema: commit `wods/<date>.json` and link `?d=<date>`; or `node cli/wodin.mjs serve`
for a local page that accepts a POST when the plan's `sink` points at `/submit`.

## Coming back

Four sinks, one payload:

| Sink | When |
|---|---|
| **POST** | `sink.url` set in the plan — closes the loop with no human in the middle |
| **Share** | the phone answer: one tap into any app |
| **Copy** | the digest, pasted into any chat |
| **Download** | desktop; the agent reads the file |

Copy and download always exist (share needs `navigator.share`, so it is offered only where
the browser has it), so the loop closes even with zero configuration.

Clipboard and share carry the **digest** rather than JSON — compact, readable by a human,
and cheaper for a model to parse than the equivalent JSON:

```
WODin 2026-09-13 · Routine 2 — Back + Biceps
47:12 · RPE 9

STRENGTH
  Barbell bent row   45×10, 75×6, 95×5, 95×5, 95×5
                     ↳ Added a little bounce on the last two reps
```

`node cli/wodin.mjs parse` turns a digest into a best-effort summary, not canonical result
JSON: the digest identifies exercises by name, so `log` is keyed by name with the raw entry
text. The JSON keeps exact ids, `exerciseRpe` and per-section scores.

## Offline

Gyms have no signal, so nothing in the logging path may touch the network after first load.
The service worker caches the shell; state autosaves to `localStorage` on every keystroke,
keyed by `workoutId`. A dropped connection mid-session must cost nothing.

## What it deliberately doesn't do

No progression logic, no volume tracking, no coaching. The agent owns all of that — WODin
renders what it's given and reports what happened. Keeping it dumb is what keeps it portable.

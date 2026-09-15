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

## Transport

The workout travels in the **URL fragment**: `#w=` (deflate-raw, base64url) or `#wj=`
(plain base64url JSON). A fragment is never sent to a server, so the workout isn't uploaded
anywhere — GitHub Pages serves a static shell that has no idea what it's displaying. A full
session is ~1.6 KB of URL.

Opening a link files the workout in the device's library, so it's reachable afterward
without the link. That matters more than it sounds: an installed PWA launches its manifest
`start_url`, not the URL you installed from, so a fragment-only design would open to nothing.
The home screen is that library.

Alternatives, same schema: commit `wods/<date>.json` and link `?d=<date>`; or `wodin serve`
for a local page with a real POST.

## Coming back

Four sinks, one payload:

| Sink | When |
|---|---|
| **POST** | `sink.url` set in the plan — closes the loop with no human in the middle |
| **Share** | the phone answer: one tap into any app |
| **Copy** | the digest, pasted into any chat |
| **Download** | desktop; the agent reads the file |

Share and copy always exist, so the loop closes even with zero configuration.

Clipboard and share carry the **digest** rather than JSON — compact, readable by a human,
and cheaper for a model to parse than the equivalent JSON:

```
WODin 2026-09-13 · Routine 2 — Back + Biceps
47:12 · RPE 9

STRENGTH
  Barbell bent row   45×10, 75×6, 95×5, 95×5, 95×5
                     ↳ Added a little bounce on the last two reps
```

`wodin parse` converts it back, so the two formats are equivalent rather than one being a
lossy shortcut. The digest identifies exercises by name; the JSON keeps exact ids.

## Offline

Gyms have no signal, so nothing in the logging path may touch the network after first load.
The service worker caches the shell; state autosaves to `localStorage` on every keystroke,
keyed by `workoutId`. A dropped connection mid-session must cost nothing.

## What it deliberately doesn't do

No progression logic, no volume tracking, no coaching. The agent owns all of that — WODin
renders what it's given and reports what happened. Keeping it dumb is what keeps it portable.

# WODin

**Hand a structured workout to a human. Get back what they actually did.**

An agent writes a workout as JSON. WODin turns it into a page the athlete opens on their
phone at the gym - offline, installable, prefilled with the plan. They log what really
happened and tap **Log workout**. By default they hand the result back with **Share**, **Copy**
(a compact text digest) or **Download** (the full result JSON). Add a `sink` to the plan and
the page grows a **Send to coach** button that POSTs the result JSON straight to your agent.

Agents: the quick start below is everything you need; [`AGENT.md`](AGENT.md) is the full protocol.

## Quick start: no clone, no install

**The endpoint is <https://beachmonkey-ai.github.io/WODin/>.** An agent posts a workout by
appending a fragment to it:

| Fragment | Payload |
|---|---|
| `#w=<frag>` | the plan JSON, raw-deflated, then base64url (preferred) |
| `#wj=<frag>` | the plan JSON, base64url only (no compression available) |

The fragment is the whole message: no server, account, API key, clone or package install. Send
the athlete the finished URL. (`#id=<workoutId>` re-opens a workout already on their device;
`?d=<date>` loads a committed `wods/<date>.json`.)

**1. Write the plan.** The smallest useful one:

```json
{
  "schema": "wodin/wod@1",
  "workoutId": "2026-10-03",
  "title": "Squat + row",
  "coach": "Your agent",
  "units": { "load": "lb", "distance": "m" },
  "sections": [
    {
      "name": "Strength",
      "type": "strength",
      "exercises": [
        {
          "movement": "Back squat",
          "kind": "weight_reps",
          "cue": "Brace before you unrack.",
          "sets": [{ "reps": 5, "load": 135 }, { "reps": 5, "load": 155 }]
        },
        {
          "movement": "Row",
          "kind": "cardio",
          "cue": "Steady pace; log the time.",
          "sets": [{ "distance": 500, "pace": "2:10/500m", "duration": null, "athleteFills": "duration" }]
        }
      ]
    }
  ]
}
```

**2. Encode it.** Node 18+:

```js
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
const wod = JSON.parse(readFileSync('wod.json', 'utf8'));
const frag = deflateRawSync(Buffer.from(JSON.stringify(wod))).toString('base64url');
console.log('https://beachmonkey-ai.github.io/WODin/#w=' + frag);
```

Python 3:

```python
import base64, json, zlib
wod = json.load(open("wod.json", encoding="utf-8"))
raw = json.dumps(wod, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
z = zlib.compressobj(9, zlib.DEFLATED, -15)   # -15 = RAW deflate, no zlib header
frag = base64.urlsafe_b64encode(z.compress(raw) + z.flush()).rstrip(b"=").decode()
print("https://beachmonkey-ai.github.io/WODin/#w=" + frag)
```

The Python gotcha: `zlib.compress()` and a default `compressobj()` write a zlib header, which
the page cannot read. The `-15` is what makes it raw deflate. No compression at all? Use
`#wj=` with `Buffer.from(JSON.stringify(wod)).toString('base64url')`, or in Python
`base64.urlsafe_b64encode(raw).rstrip(b"=").decode()`.

**3. The URL** is the endpoint plus the fragment (this one is the plan above, 433 characters;
typical plans run 0.5 to 2 KB, and past about 8000 characters some clients truncate):

```text
https://beachmonkey-ai.github.io/WODin/#w=ZZFPSwMxEMW_SpirW91tWQ_rRXoQvNqTiEiaHXfD5k9NJtZS-t2daYtVJBDIb2bee0z2kM2IXkMH29jbcMP3fQMVv9IUCz32XJnX89tZU8_qBRfIkkOGq4-iSV2pFLdMTdRmZPocS1J6wEAMS7CUoduDi1p03JphbzPpYETCw6GCjIZsDNz3soeg_VGbEoaBRrHbbYTkC8EvTMZmPE34-Ile7DpYajOpLLG4a7JBLLdoh5HeEm6ypCyitUzaoFrje0yodrGoEphM1yBh6CR7HOja6hy9WbSH6j9t28Or8F8hno7rOLsbnXobf4xXhLrfqQ3b3ykXB0UjKrIe_1hfFtTWdQXSLX_QNfUNAy8rLEnLzqALxbkKNI0OCR-scyxxKXM4Od8
```

**4. Check it** by opening the URL yourself (next section). **5. Send it.**

**What the athlete sees.** The page opens straight into the plan, titled "Squat + row" with
the date (Sat, Oct 3). Under **Strength**, "Back squat" has its cue and two set rows prefilled
(135 lb x 5, 155 lb x 5); "Row" has 500 m at 2:10/500m with the time left blank for them to
fill. They tap **Start** for the session timer, edit what they really did, and tap **Log
workout** to hand the result back (Share, Copy or Download). It is saved on their device and
works offline.

### Validate without the CLI

There is no safety net on this path: a bad plan fails quietly on the athlete's phone. **Opening
the link yourself is the check** - if you can't open a browser, decode your own fragment and
read the JSON back:

```bash
node -e "console.log(require('zlib').inflateRawSync(Buffer.from(process.argv[1],'base64url')).toString())" "$FRAG"
python3 -c "import sys,zlib,base64;f=sys.argv[1];print(zlib.decompress(base64.urlsafe_b64decode(f+'='*(-len(f)%4)),-15).decode())" "$FRAG"
```

Then run down the failure modes (the rules `wodin validate` and
[`schema/wod.schema.json`](schema/wod.schema.json) enforce):

- [ ] Top level has `workoutId` (a non-empty string; a date such as `2026-10-03` is the usual
  choice) and a non-empty `sections[]`. Only schema fields; unknown keys are not allowed.
- [ ] Every section has a `name` and `exercises[]` (or `rounds[]`).
- [ ] Every exercise has `movement`, `kind` and a non-empty `sets[]`.
- [ ] `kind` is one of `weight_reps`, `reps`, `time`, `cardio`, `carry`, set on every exercise
  and round movement. It cannot be inferred.
- [ ] No `"load": 0`; use `"loadType": "bodyweight"`.
- [ ] `movement` is the plain name (`Run`, cue `Outdoors`; not `Outdoor run`, `Row 500m` or
  `Pull-up (bodyweight)`). Equipment that changes the lift stays: `Barbell deadlift`.
- [ ] A `format` has a `type`; the first `rounds[]` entry has `movements`; a `sink` of type
  `post` has a `url`.
- [ ] The URL is complete: the whole fragment, not an ellipsised `#w=…` from a chat preview.

What a bad link looks like:

- **Can't be decoded** (cut short, zlib header instead of raw deflate, invalid JSON): the page
  opens on the empty "Your workouts" home with a brief "That link's workout could not be
  read" toast. Pasting the link into **Paste a workout link** says it is damaged.
- **Decodes but is wrong: nothing is flagged.** A missing `kind` is drawn as `weight_reps`, so
  a row or a plank gets load and reps boxes. A missing `workoutId` leaves the date blank and
  the autosave and the returned result with no id to key on. Missing `sections` is an empty page.

## How it works

```
  agent writes                 athlete uses                     agent reads
  ────────────                 ────────────                     ───────────
   wod.json    ─── link ───>   the page      ─ share / post ─>   result
  (the plan)                (phone, offline)                     (digest or JSON)
```

No server. No account. No API key. The workout travels in the URL fragment, so it is never
sent to a server (if you add a `sink`, its URL and headers travel in the link too). The page
keeps working with no signal, which matters because gyms don't have any.

Opening a link files the workout in a library on the device (the last 50) and the app's home
screen is that library, so an installed app doesn't open to nothing. Progress autosaves to
`localStorage` per `workoutId`.

## Why it exists

This started as Google Apps Script talking to a Sheet. That worked, but it welded the idea
to one runtime: an agent that isn't Apps Script couldn't generate a page, and an agent that
wasn't the author's couldn't read a result. WODin is the same idea with the protocol pulled
out of the plumbing, so OpenClaw, GrokBot, Claude or anything else can drive it.

## Power path (optional): the CLI

You never need a clone to use WODin. Clone only to validate before you send, render a
standalone file, or serve a page on your LAN. The CLI has no npm dependencies (node's own
`zlib` and `http`) but reads this repo's `src/`, `styles/`, `public/` and `index.html`, so
run it from a clone. Requirements: Node 22 (CI uses 22; `npm test` needs Node 21+ to expand
its glob). `npm install` is only needed for icon generation and the build (`sharp`).

```bash
git clone https://github.com/BeachMonkey-AI/WODin && cd WODin
node cli/wodin.mjs validate wod.json ...           # structural check, plus naming and sink warnings
node cli/wodin.mjs link     wod.json [--base URL]   # the same #w= URL the encoders above print
node cli/wodin.mjs render   wod.json [-o out.html]  # self-contained single file, no service worker
node cli/wodin.mjs serve    [wod.json] [--port N] [--out DIR]  # localhost + LAN, POST /submit → logs/
node cli/wodin.mjs parse    <file|->               # JSON passes through; a digest → best-effort summary
```

There is no published npm package, and `npx wodin` would fetch an unrelated package of that
name owned by someone else.

`parse` passes JSON through unchanged. A text digest becomes a best-effort summary (`log` keyed
by movement name with the raw entry text), not canonical result JSON. Use the JSON payload
when you need exact ids, `exerciseRpe` or per-section scores.

`serve` hosts the page from the source tree (no build) on localhost and the LAN (default port
5173) and accepts `POST /submit`, writing `logs/<workoutId>.json` (`--out DIR` to change it; a
resubmit overwrites). The page only shows **Send to coach** if the plan has a sink pointing at
it, e.g. `"sink": {"type": "post", "url": "/submit"}`; otherwise use Share, Copy or Download.
Plain-http LAN access has no service worker, clipboard or Web Share - test those on localhost
or a Pages preview. It's the tightest loop when the agent and the athlete share a machine or
wifi network.

## Getting the result back

Share needs a browser with `navigator.share` (most phones), so it isn't always shown; Copy and
Download always are. Share and Copy carry the text digest; Download and Send to coach carry the
JSON.

To have the result arrive on its own, add a `sink` to the plan:

```json
{ "sink": { "type": "post", "url": "https://hooks.example/log/8f3a9c2b1d4e" } }
```

`sink` is `{type: "post", url, mode?: "cors" | "blind", headers?}`. `cors` (the default)
confirms delivery but the endpoint must answer the preflight; `blind` is a no-cors POST that
reaches any endpoint but can only say "Sent - delivery not confirmed", and drops `headers`.
Everything in `sink` rides in the link, so it is public. If you need auth, mint a Bearer token
**per workout** (bound to its `workoutId`, about 72 h, single use). `wodin validate` warns on
credential-shaped headers. Details in [`AGENT.md`](AGENT.md) section 3b. The in-page
"Share workout" re-encodes the plan without its `sink`.

## For agents

**[`AGENT.md`](AGENT.md) is the protocol** - one file that teaches any agent the whole
thing. Point your agent at it.

The two documents it describes:

| | |
|---|---|
| [`schema/wod.schema.json`](schema/wod.schema.json) | the plan - what you prescribe |
| [`schema/result.schema.json`](schema/result.schema.json) | the result - what they did |

Structure is `sections → exercises → sets`; a section can instead (or also) hold `rounds[]`.
A **set** is one prescription row; an **exercise** is the movement containing them. Five
field layouts cover what a session actually needs, and `kind` is **required** on every
exercise and round movement (`wodin validate` fails without it):

| `kind` | Renders as |
|---|---|
| `weight_reps` | `95 lb x 5 reps` |
| `reps` | `10 reps` |
| `time` | `0:20 mm:ss` |
| `cardio` | `2:00 /500m` · `500 m` · `1:58 mm:ss` |
| `carry` | `50 lb x 1 reps` · `100 ft` |

Conditioning pieces get an optional second shape, a section `format` (Tabata, EMOM,
intervals, for time, AMRAP, circuit), with:

- a score box and a `rounds[]` round > movements hierarchy (derived automatically for a
  Tabata or EMOM from `format.rounds` and the exercises);
- scaling pills: `optional[]` options are recorded only when switched on, `modifiers[]` are
  recorded true or false;
- `benchmark: "girl" | "hero"` marking a named benchmark. Those are max effort by definition,
  so no RPE pill is drawn and the result records `rpe: 11, rpeAssumed: true` for that block
  (11 is off the 1-10 scale on purpose; if every section is a benchmark the session RPE is
  assumed 11 too). Override with `rpe: "ask" | "hide" | 1-11` on the plan or a section.

[`examples/format-test.json`](examples/format-test.json) has twelve blocks, one distinct shape
each - Tabata, an EMOM pair, Diane, Helen, Cindy, Murph and the rest. `AGENT.md` explains
which to use when. Plans that don't use formats are unchanged.

**Naming rule.** `movement` is the plain exercise name: `Run` with cue `Outdoors`, not
`Outdoor run`. Modifiers (outdoor, indoor, bodyweight) go in `cue`; equipment that changes
the lift stays (`Barbell deadlift`). `wodin validate` warns on violations.

### The result

`log` (keyed `exerciseId.setId`), `notes`, `exerciseRpe`, `skipped`, `rpe` / `rpeAssumed`,
`duration` / `durationSec`, `startedAt`, `planHash`, and a `sections{}` map (score, `optional`,
`modifiers`, `rounds[]`, `rpe`). The score is `{time, timeSec}`, `{rounds, reps}`,
`{totalReps}` or `null`. Top-level `score` / `optional` / `modifiers` / `rounds` mirror
`sections` only when exactly one section has an entry; read `sections`. See
[`schema/result.schema.json`](schema/result.schema.json).

## What the page does

- Format header and score box. A `time` score gets a stopwatch beside it (it runs from
  timestamps rather than a tick counter, and writes the score when stopped).
- Numeric time fields (session duration, `duration`, `pace`, score time) take digits and add
  the colon for you: `841` becomes `8:41`.
- Chips and hints: `loadBwMult` (`1.5× BW`), `partition` (how reps may be broken up),
  `intervalSlot` (the A/B chip on an alternating EMOM). `restSec` is the rest after each work
  interval (tabata, intervals) or after each round (for time, circuit).
- RPE dropdowns list 10 down to 1, each with an effort anchor.
- `coach` shows as attribution under the coach note, and the footer links the repo and shows
  the build hash.

## Three design decisions worth knowing

(The long version is in [`spec.md`](spec.md).)

**The plan prefills; the athlete overwrites.** Loads and reps arrive filled in, so logging a
session done as prescribed costs zero taps. Subjective fields - RPE, notes - start
*blank*, with the prescription shown only as a ghost (`Rx 7`). A prefilled 7 is
indistinguishable from an answered 7, and that distinction is the point.

**The result carries every set, not just the deviations.** Sets done as prescribed come back
with `asPlanned: true`. A sparse diff can't tell "did it exactly right" from "never logged
it", so `log` is complete: every set that was not skipped appears. Absence means skipped. The
exceptions are movements that live inside `rounds[]` (written, or derived for a Tabata or
EMOM) and AMRAP rounds. Round movements are recorded under `sections[id].rounds`, never in
`log`, and an AMRAP's rounds are never recorded at all (the score carries the count).

**One note per exercise, never per set.** The athlete gets one place to say how a movement
went. Per-row notes fragment the same thought across five boxes. A formatted block that is
scored or built from `rounds[]` is one effort, so it gets one RPE and one note for the whole
block, keyed by section id. Each exercise can also be given its own 1-10 RPE (`exerciseRpe`),
unless the plan's `rpe` policy hides it.

## Running it locally

```bash
npm install
npm run gen-icons        # public/icon.svg → PNG set (generated, gitignored)
npm run build            # → dist/
npm run serve            # or: node cli/wodin.mjs serve examples/minimal.json
npm test                 # node:test, 5 suites: format, rounds, timers, UI state, and the example set
npm run validate         # all 5 examples/*.json
```

`npm test` needs Node 21+ (CI uses 22). The example suite checks the naming rule, that every
schema addition is shown by some format-test section, and that the annotated blocks in
`AGENT.md` are verbatim copies. CI only builds - it never runs `npm test` or `validate` - so
run both before you push.

Offline: a service worker precaches the shell (app, fonts, icons) from an explicit `SHELL` list
in `public/sw.js`. If you add a module under `src/`, it must be inlinable by `wodin render` and
added to `SHELL`, or the installed app breaks offline. The build stamps one content hash into
the cache name and the page footer, so you can tell which version is cached. The manifest is
standalone with no orientation lock.

Deploys to GitHub Pages from `gh-pages` via thin callers of the reusable CI and Pages
workflows in `BeachMonkey-AI/app-template`. `main` publishes to
`https://beachmonkey-ai.github.io/WODin/`; each open PR gets `…/WODin/preview/pr-<N>/`, removed
when the PR closes. Every path in the app is relative, so the same build output is correct at
either location with no base-path parameter.

## Layout

```
AGENT.md              the protocol, written for an agent to read
spec.md               the model and the why
CLAUDE.md             maintainers' non-obvious rules
schema/               wod + result JSON Schemas
examples/             a real workout, two contrasting athletes, the smallest valid plan,
                      and format-test.json - every format shape on one page
wods/                 (optional) committed workouts, linked with ?d=<date>
index.html            app shell
src/                  main.js, app.css, icons.js, format.js (DOM-free format logic)
test/                 node:test suites: examples, format, round2, timer, ui-state
styles/               design tokens, self-hosted font faces
public/               manifest, service worker, icon source, font files
                      (public/icons/ and dist/ are generated, gitignored)
cli/wodin.mjs         link | render | serve | parse | validate
design/prototype.html the layout pass this app was built from
scripts/              build, icon generation, font fetch
explore.json          platform listing metadata, not app code
.github/              deploy workflow, CODEOWNERS
```

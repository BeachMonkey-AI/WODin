# WODin

**Hand a structured workout to a human. Get back what they actually did.**

An agent writes a workout as JSON. WODin turns it into a page the athlete opens on their
phone at the gym - offline, installable, prefilled with the plan. They log what really
happened and tap **Log workout**. By default they hand the result back with **Share**, **Copy**
(a compact text digest) or **Download** (the full result JSON). Add a `sink` to the plan and
the page grows a **Send to coach** button that POSTs the result JSON straight to your agent.

🏋️ **[beachmonkey-ai.github.io/WODin](https://beachmonkey-ai.github.io/WODin/)**

```
  agent writes                 athlete uses                     agent reads
  ────────────                 ────────────                     ───────────
   wod.json    ─── link ───>   the page      ─ share / post ─>   result
  (the plan)                (phone, offline)                     (digest or JSON)
```

No server. No account. No API key. The workout travels in the URL fragment, so it is never
sent to a server (if you add a `sink`, its URL and headers travel in the link too). The page
keeps working with no signal, which matters because gyms don't have any.

## Why it exists

This started as Google Apps Script talking to a Sheet. That worked, but it welded the idea
to one runtime: an agent that isn't Apps Script couldn't generate a page, and an agent that
wasn't the author's couldn't read a result. WODin is the same idea with the protocol pulled
out of the plumbing, so OpenClaw, GrokBot, Claude or anything else can drive it.

## Use it in 30 seconds

Requirements: Node 22 (CI uses 22; `npm test` needs Node 21+ to expand its glob). `npm install`
is only needed for icon generation and the build (`sharp`); the CLI, `serve`, `test` and
`validate` need no installed packages.

```bash
git clone https://github.com/BeachMonkey-AI/WODin && cd WODin
node cli/wodin.mjs link examples/routine-2-back-biceps.json
#  https://beachmonkey-ai.github.io/WODin/#w=zZbNbuM2EMdf...
```

Send that link. That's the whole integration.

The link is `…/WODin/#w=<deflate-raw + base64url JSON>`. `#wj=<base64url JSON>` is the
uncompressed form, for an agent with no compression available. Typical links run from about
0.5 KB (the smallest plan) to about 2 KB (`examples/format-test.json`, twelve sections);
`link` warns past 8000 characters. Alternatives: commit `wods/<date>.json` and link `?d=<date>`,
and `#id=<workoutId>` re-opens a workout already in the device's library.

Opening a link files the workout in a library on the device (the last 50) and the app's home
screen is that library, so an installed app doesn't open to nothing. Progress autosaves to
`localStorage` per `workoutId`.

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

## CLI

The CLI has no npm dependencies - node's own `zlib` and `http` - but it reads this repo's
`src/`, `styles/`, `public/` and `index.html`, so run it from a clone.

```bash
node cli/wodin.mjs link     wod.json [--base URL]   # shareable #w= URL - the phone path
node cli/wodin.mjs render   wod.json [-o out.html]  # self-contained single file, no service worker
node cli/wodin.mjs serve    [wod.json] [--port N] [--out DIR]  # localhost + LAN, POST /submit → logs/
node cli/wodin.mjs parse    <file|->               # JSON passes through; a digest → best-effort summary
node cli/wodin.mjs validate wod.json ...           # structural check, plus naming and sink warnings
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

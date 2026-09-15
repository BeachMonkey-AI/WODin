# WODin

**Hand a structured workout to a human. Get back what they actually did.**

An agent writes a workout as JSON. WODin turns it into a page the athlete opens on their
phone at the gym — offline, installable, prefilled with the plan. They log what really
happened, tap once, and the agent gets it back as structured data.

🏋️ **[beachmonkey-ai.github.io/WODin](https://beachmonkey-ai.github.io/WODin/)**

```
  agent writes                 athlete uses                  agent reads
  ────────────                 ────────────                  ───────────
   wod.json    ─── link ───>   the page      ─── submit ───>   result
  (the plan)                (phone, offline)                  (the log)
```

No server. No account. No API key. The workout travels in the URL fragment, so it never
touches a server at all — and the page keeps working with no signal, which matters because
gyms don't have any.

## Why it exists

This started as Google Apps Script talking to a Sheet. That worked, but it welded the idea
to one runtime: an agent that isn't Apps Script couldn't generate a page, and an agent that
wasn't the author's couldn't read a result. WODin is the same idea with the protocol pulled
out of the plumbing, so OpenClaw, GrokBot, Claude or anything else can drive it.

## Use it in 30 seconds

```bash
npx wodin link examples/routine-2-back-biceps.json
# → https://beachmonkey-ai.github.io/WODin/#w=dZFNT8MwDIb...
```

Send that link. That's the whole integration.

## For agents

**[`AGENT.md`](AGENT.md) is the protocol** — one file that teaches any agent the whole
thing. Point your agent at it.

The two documents it describes:

| | |
|---|---|
| [`schema/wod.schema.json`](schema/wod.schema.json) | the plan — what you prescribe |
| [`schema/result.schema.json`](schema/result.schema.json) | the result — what they did |

Structure is `sections → exercises → sets`. A **set** is one prescription row; an
**exercise** is the movement containing them. Five field layouts cover what a session
actually needs:

| `kind` | Renders as |
|---|---|
| `weight_reps` | `95 lb × 5 reps` |
| `reps` | `10 reps` |
| `time` | `0:20 mm:ss` |
| `cardio` | `2:00 /500m` · `500 m` · `1:58 mm:ss` |
| `carry` | `50 lb × 1 reps` · `100 ft` |

## CLI

Zero dependencies — node's own `zlib` and `http`.

```bash
wodin link     wod.json [--base URL]    # shareable #w= URL — the phone path
wodin render   wod.json [-o out.html]   # self-contained single file
wodin serve    [wod.json] [--port N]    # localhost + LAN; POST /submit → logs/
wodin parse    <file|->                 # digest or JSON → canonical result JSON
wodin validate wod.json ...             # structural check
```

`serve` is the tightest loop when the agent and the athlete share a machine or a wifi
network: a real Submit button, writing `logs/<workoutId>.json` where the agent can watch.

## Three design decisions worth knowing

**The plan prefills; the athlete overwrites.** Loads and reps arrive filled in, so logging a
session done as prescribed costs zero taps. Subjective fields — session RPE, notes — start
*blank*, with the prescription shown only as a ghost (`Rx 7`). A prefilled 7 is
indistinguishable from an answered 7, and that distinction is the point.

**The result carries every set, not just the deviations.** Sets done as prescribed come back
with `asPlanned: true`. A sparse diff can't tell "did it exactly right" from "never logged
it", so `log` is complete and absence always means skipped.

**One note per exercise, never per set.** The athlete gets one place to say how a movement
went. Per-row notes fragment the same thought across five boxes.

## Running it locally

```bash
npm install
npm run gen-icons        # public/icon.svg → PNG set
npm run build            # → dist/
npm run serve            # or: node cli/wodin.mjs serve examples/minimal.json
```

Deploys to GitHub Pages from `gh-pages`. `main` publishes to `/`; each open PR gets
`/preview/pr-<N>/`. Every path in the app is relative, so the same build output is correct
at either location with no base-path parameter.

## Layout

```
AGENT.md              the protocol, written for an agent to read
schema/               wod + result JSON Schemas
examples/             a real workout, and the smallest valid one
index.html            app shell
src/                  main.js, app.css, icons.js
styles/tokens.css     design tokens
public/               manifest, service worker, icon source
cli/wodin.mjs         link | render | serve | parse | validate
design/prototype.html the layout pass this app was built from
scripts/              build + icon generation
```

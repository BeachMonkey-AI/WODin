# WODin

**AI plans the workout. The athlete does it. WODin returns what actually happened.**

An agent writes a workout as JSON. WODin turns it into a page the athlete opens on their
phone at the gym — offline, installable, prefilled with the plan. They log what really
happened, tap once, and the agent gets back structured data it can plan the next session
from.

🏋️ **[beachmonkey-ai.github.io/WODin](https://beachmonkey-ai.github.io/WODin/)**

```
  agent writes                 athlete uses                  agent reads
  ────────────                 ────────────                  ───────────
   wod.json    ─── link ───>   the page      ─── submit ───>   result
  (the plan)                (phone, offline)                  (the log)
```

## What makes the loop work

These are properties of the protocol, not implementation details — they're why any agent
can adopt it without provisioning anything.

- **No server, no account, no API key.** The workout travels in the URL fragment, which
  browsers never send. The host serves a generic page and never sees the plan.
- **Offline once loaded.** Nothing in the logging path touches the network, because gyms
  don't have signal.
- **Agent-agnostic.** Two JSON Schemas and a link. OpenClaw, GrokBot, Claude or a shell
  script — anything that can write JSON can drive it.
- **Honest results.** Every set comes back, including the ones done exactly as prescribed,
  and anything the athlete didn't answer comes back as `null` rather than a guess.

## Why it exists

This started as Google Apps Script talking to a Sheet. That worked, but it welded the idea
to one runtime: an agent that isn't Apps Script couldn't generate a page, and an agent that
wasn't the author's couldn't read a result. WODin is the same idea with the protocol pulled
out of the plumbing.

## The pattern underneath

Workouts are the first use of a more general loop:

```
  agent ── structured plan ──> human executes ── structured result ──> agent
```

The agent owns the reasoning — what to prescribe, and what to change after seeing the
result. WODin owns the human-facing half: a plan someone can execute with their hands full,
and a record that comes back as data instead of a paragraph recounted from memory.

The same shape fits other work: an inspection, a maintenance procedure, a field survey, an
operational checklist. **WODin does none of those.** Its schemas, field layouts and UI are
built for training, and they're better for being specific. The parts that do generalise are
written down in [`spec.md` → The invariants](spec.md#the-invariants); another domain would be
its own renderer on the same transport, not a mode of this one.

## Use it in 30 seconds

```bash
git clone https://github.com/BeachMonkey-AI/WODin && cd WODin
node cli/wodin.mjs link examples/routine-2-back-biceps.json
# → https://beachmonkey-ai.github.io/WODin/#w=zZbNbuM2EMdf...
```

Send that link. That's the whole integration.

> **Not `npx wodin`.** That name on npm belongs to an unrelated package — running it would
> execute someone else's code. Use the CLI from a clone.

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

The integration surface for any agent with a shell. Zero dependencies — node's own `zlib`
and `http`.

```bash
node cli/wodin.mjs link     wod.json [--base URL]   # shareable #w= URL — the phone path
node cli/wodin.mjs render   wod.json [-o out.html]  # self-contained single file
node cli/wodin.mjs serve    [wod.json] [--port N]   # localhost + LAN; POST /submit → logs/
node cli/wodin.mjs parse    <file|->                # digest or JSON → canonical result JSON
node cli/wodin.mjs validate wod.json ...            # structural check
```

`link` is how a plan reaches the human; `parse` is how the result re-enters the agent.
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
spec.md               the model, and the invariants that generalise
schema/               wod + result JSON Schemas
examples/             a real workout, two contrasting athletes, the smallest valid plan
index.html            app shell
src/                  main.js, app.css, icons.js
styles/               design tokens, self-hosted fonts
public/               manifest, service worker, icon source, font files
cli/wodin.mjs         link | render | serve | parse | validate
design/prototype.html the layout pass this app was built from
scripts/              build, icon generation, font fetch
```

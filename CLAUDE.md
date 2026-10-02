# CLAUDE.md — WODin

- **What this app does:** Turns a structured workout (JSON) into a phone-first PWA the
  athlete logs against, then emits what they actually did as structured data an agent can
  read. The protocol — `AGENT.md` plus the two schemas — is the actual product; the PWA is
  the reference implementation and the CLI is convenience. Replaces a Google Apps Script +
  Sheets original that only Apps Script could drive.
- **Live:** https://beachmonkey-ai.github.io/WODin/
- **Model:** vanilla (no bundler, no framework, no runtime deps; `sharp` is dev-only for icons)
- **Token deviations from app-template:** `--accent` is `#cdf24a` (lime), ground is `#0d1011`
  with a faint green bias. Dark-committed on purpose — no light theme, no
  `prefers-color-scheme` block. The original app was dark and this lives in a garage gym.
  Type is Barlow Condensed / Barlow / JetBrains Mono rather than the template default.

## Things that aren't obvious from the code

- **There is no published npm package.** `package.json` is `private: true` and was never
  published, so never write `npx wodin` in docs — that name on npm belongs to an unrelated
  package and would run someone else's code. Every documented command is `node cli/wodin.mjs`
  from a clone.

- **Odin's taxonomy is load-bearing.** A **set** is one prescription row (`Set 1`, `Set 2`);
  an **exercise** is the movement containing them. The athlete's note attaches to the
  *exercise*, one per movement. This was gotten wrong once — an earlier pass put notes on
  the row — so don't "fix" it back.
- **`kind` cannot be inferred.** Which fields to draw can't be derived from which plan values
  are non-null, because a field the athlete is meant to fill is null in the plan too. Agents
  must set it; `wodin validate` fails without it.
- **Bodyweight is `loadType: "bodyweight"`, never `load: 0`.** The original app showed
  `0 × 12` for band pull-aparts, which is the wart this replaces.
- **Prefill rule:** prescribed values (load, reps, distance, pace) prefill; subjective values
  (session RPE, notes, summary) start blank with the Rx shown only as a ghost hint. Never
  prefill RPE — an answered 7 and a defaulted 7 must stay distinguishable in the result.
- **`log` in a result is complete, not sparse.** Every non-skipped set appears, including
  `asPlanned: true` ones. Absence means skipped, never compliance.
- **Listeners bind once, outside `render()`.** `render()` replaces `#app`'s innerHTML but not
  the element, so binding inside it stacks a listener per render — one tap then fires all of
  them. That shipped once and added hundreds of rows per click.
- **Every path is relative.** Prod (`/`) and PR previews (`/preview/pr-<N>/`) share one build
  output. Don't introduce root-absolute paths; that's the bug app-template exists to avoid.
- **The URL fragment is the transport.** `#w=` is deflate-raw + base64url, `#wj=` is plain
  base64url JSON. A fragment never reaches a server, so workouts aren't uploaded anywhere.
  A full session is ~1.6 KB of URL.
- **Offline is a requirement, not a nice-to-have.** Gyms have no signal. Nothing in the
  logging path may need the network after first load.
- **`sink` is public**, so the documented auth pattern is a **per-workout Bearer token** —
  bound to one `workoutId`, ~72h (athletes log late; expiry at the rack is the worst
  failure), single use. Bearer is what GrokBot and similar hosts actually speak, so
  steering people away from it was the wrong advice; scoping the token is the right one.
  A leaked link then costs one forged log rather than a standing credential.
  `wodin validate` warns on credential-shaped headers but deliberately does not fail —
  we can't prevent it, and a hard error would just get worked around.
- **`sink.mode: "blind"`** exists so an endpoint that knows nothing about CORS still works
  with zero server changes — no-cors POST, no preflight, opaque response. The UI must keep
  saying "delivery not confirmed"; never report success from a response we can't read.
- **The manifest carries no `orientation` lock.** It briefly had `"orientation":
  "portrait"`. Installed (standalone) apps honor that lock; a browser tab never
  does. On a wide/unfolded dual-screen phone that meant the installed PWA was
  held to a narrow portrait viewport while the same page in a browser tab spanned
  the full width — so the wide-viewport `--ui-scale` steps in `src/app.css` never
  matched in the installed app even though they matched in the tab. Don't
  reintroduce an orientation lock without checking it against that scaling.

- **Never report a send failure we cannot observe.** A cors-mode `fetch` rejects identically
  whether the request never left or it landed and the response merely omitted
  `Access-Control-Allow-Origin` — a very common server-side miss, since people set it on the
  preflight and forget the POST. WODin shipped claiming "Send failed" there, while payloads
  were arriving fine; a real smoke test caught it. Only `navigator.onLine === false` lets us
  say "nothing sent". Everything else that throws is "Sent — delivery not confirmed".

- **The round check rule lives in `src/format.js`, nowhere else.** Round done == all its
  movements done, and the reverse. `setRoundDone` / `setMovementDone` / `checkRound` /
  `checkMovement` each return a round with both sides already in sync — main.js only decides
  when to call them. Don't set `round.done` or a movement's `done` by hand in main.js; that
  is how the two drift apart.
- **AMRAP rounds are never expanded or checked.** They are unbounded, so `rounds[]` renders
  once as a read-only template, `seedRoundState` returns `[]`, and the result has no
  `rounds` — the score carries the count. `format.rounds` padding skips amrap too.
- **Footer sections key RPE and notes by section id.** A section with `rounds[]` or a score
  other than `none` gets one block footer, and its RPE/note go into the existing
  `exerciseRpe` / `notes` maps under the *section* id (RPE only when the section asks) (`sec1` … when the plan gave none).
  Per-exercise pills aren't drawn there. Don't add a separate map for them.
- **`result.sections` is canonical; the top-level `score` / `optional` / `modifiers` /
  `rounds` are a mirror** that exists only when exactly one section has an entry. Consumers
  reading the top level break on a two-scored-section plan — point them at `sections`.
  `optional` holds only pills that were on; `modifiers` holds every modifier as a bool.
- **Go through `roundsOf(section)`, never `section.rounds`.** A tabata/emom with
  `format.rounds` + `exercises` and no `rounds[]` derives one template round from the
  exercises' *first* sets (`isDerivedRounds`), padded to N by `expandRounds`. Its exercises
  are drawn as rounds, not set rows, and write **no** `log` entries — the one exception to
  complete-not-sparse; `sections[id].rounds` is the record. Chippers and `intervals` are
  never derived. Round ticks are optional; never validate them for completeness.
- **RPE policy lives in `sectionRpePolicy` / `sessionRpePolicy`.** `benchmark: girl|hero`
  assumes 11; `rpe: ask|hide|1–11` overrides it; a session assumes 11 only when every
  section is a benchmark. Assumed means *no pill* (prefill rule) and `rpe` + `rpeAssumed:
  true` in the result — never in `exerciseRpe`, never in the top-level mirror. 11 is off the
  1–10 scale on purpose; result.schema allows it only with `rpeAssumed`. No `rpe` and no
  `benchmark` anywhere = ask everywhere, exactly the old behaviour. A hidden or assumed
  RPE control is **not drawn at all** — never rendered-and-prefilled — and that covers the
  session select, block pills and per-exercise pills (`showExerciseRpe` is `ask` only).
- **Time inputs: auto-format ⇒ `inputmode="numeric"`, otherwise `"text"`.** 60483d8 moved
  time fields to text so Android shows a colon key. Fields in `AUTO_FORMAT_FIELDS`
  (`duration`, `pace`, `score-time`) insert their own colons via `fmtTimeDigits` /
  `fmtPaceDigits` and want the digit pad; the session `f-duration` doesn't auto-format and
  stays text. main.js derives both the mode (`timeMode`) and the formatter
  (`timeFormatterFor`) from that one list, so don't hard-code `mode` on a time field.
- **The section stopwatch is computed from timestamps, never ticks.** `sections[id].timer`
  is `{ running, startedAt, accMs }`, persisted with the log; elapsed is `timerElapsedMs`
  against `Date.now()` on every repaint, so reload / background / phone sleep lose nothing.
  One `runTick` interval paints the session clock and every running stopwatch and stops
  itself when nothing runs — call it after any render that might start one. Typing in the
  time field pauses it and adopts the typed value (`timerSetMs`), updating the buttons in
  place: no re-render, or focus and caret are lost. `openSheet` pauses all of them so the
  score is written. The timer never reaches the result.
- **Round movements are never written to `log`.** `log` stays sets-only (`"exId.setId"`) so
  the complete-not-sparse rule and `asPlanned` keep meaning what they mean. Exercises in a
  formatted section (Murph) still log their sets there as usual.
- **`src/format.js` is DOM-free and imported by three things:** main.js, the CLI validator
  (`validateFormat`, `movementNameWarning`) and the tests. Keep it that way — no DOM, no
  imports of its own. `wodin render` inlines main.js's `./x.js` imports by regex and dies on
  anything it can't inline; a new module must work with that inliner **and** be added to the
  `SHELL` precache list in `public/sw.js`, or the installed app breaks offline.
- **`wodin serve` serves the source tree, not `dist/`** — no build step, so it shows edits
  immediately but never proves the build. Opened from another device over LAN it's plain
  http, which is not a secure context: no service worker, no clipboard write, no Web Share.
  Those failures there are expected, not bugs; test them on localhost or the Pages preview.
- **`npm test` is `node --test "test/*.test.mjs"`** — node:test, no deps. The glob is quoted
  so node expands it rather than the shell, which keeps it working in PowerShell and cmd.

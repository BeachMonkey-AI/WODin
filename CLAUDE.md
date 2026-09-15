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

- **WODin is a workout app that demonstrates a general pattern — not a generic platform.**
  The agent → human → agent loop is named in the docs (issue #18) so other builders can see
  why the schemas are worth adopting. It is deliberately *not* reflected in the UI or the
  schema: no task types, checklists, photo capture or plugin architecture. The five set
  kinds and the gym UX are what make it work. If a second real domain ever appears, it gets
  its own renderer on the same transport; the four portable rules live in
  `spec.md` → The invariants.
- **Never document `npx wodin`.** `wodin` on npm is an unrelated package owned by someone
  else, so that command would run a stranger's code. Use `node cli/wodin.mjs` from a clone.
  Publishing would need a scoped name like `@beachmonkey-ai/wodin`, which is Odin's call.

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
- **Never report a send failure we cannot observe.** A cors-mode `fetch` rejects identically
  whether the request never left or it landed and the response merely omitted
  `Access-Control-Allow-Origin` — a very common server-side miss, since people set it on the
  preflight and forget the POST. WODin shipped claiming "Send failed" there, while payloads
  were arriving fine; a real smoke test caught it. Only `navigator.onLine === false` lets us
  say "nothing sent". Everything else that throws is "Sent — delivery not confirmed".

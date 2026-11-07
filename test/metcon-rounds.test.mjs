// display: "rounds" — a for_time block whose full prescription is drawn once,
// read-only, above one row per round with one tick. The round's own flag is
// the record: no movement values or movement ticks are drawn, stored or
// exported for it. Everything else (checklist, inputs, AMRAP) is untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isRoundsDisplay, roundsPrescription, expandRounds, seedSectionState, seedRoundState,
  checkRound, checkMovement, roundDone, buildSectionResult, withSections, digestSectionLines,
  sectionRpePolicy, showSectionRpe, scoreOf, hasBlockFooter, describeFormat, validateFormat, DISPLAYS
} from '../src/format.js';
import { openPage } from './helpers/page.mjs';

const root = new URL('../', import.meta.url);
const load = f => JSON.parse(readFileSync(new URL('examples/' + f, root), 'utf8'));
const plan = load('metcon-rounds.json');
const metcon = plan.sections[0];
const X = '×';

// 21-15-9 with a run that never changes, and a round list whose movements change.
const triplet = {
  id: 'dt', name: 'DT-ish', display: 'rounds', format: { type: 'for_time', capSec: 900 },
  rounds: [
    { reps: 21, movements: [
      { movement: 'Barbell deadlift', kind: 'weight_reps', load: 225 },
      { movement: 'Pull-up', kind: 'reps' },
      { movement: 'Run', kind: 'cardio', distance: 200, cue: 'Outdoors' }
    ] },
    { reps: 15 }, { reps: 9 }
  ]
};
const ladder = {
  id: 'lad', name: 'Ladder', display: 'rounds', format: { type: 'for_time' },
  rounds: [
    { movements: [{ movement: 'Burpee', kind: 'reps', reps: 10 }] },
    { movements: [{ movement: 'Air squat', kind: 'reps', reps: 20 }], repeat: 1 }
  ]
};
const wodOf = (...sections) => ({ workoutId: 'test-' + sections.map(s => s.id).join('-'), sections });

/* ── mode and rounds ─────────────────────────────────────────── */

test('mode: display "rounds" on a for_time block with rounds[]; nowhere else', () => {
  assert.ok(DISPLAYS.includes('rounds'));
  assert.ok(isRoundsDisplay(metcon));
  assert.ok(isRoundsDisplay(triplet));
  assert.equal(isRoundsDisplay({ ...metcon, display: undefined }), false);
  assert.equal(isRoundsDisplay({ ...metcon, display: 'checklist' }), false);
  assert.equal(isRoundsDisplay({ ...metcon, format: { type: 'amrap', capSec: 480 } }), false);
  assert.equal(isRoundsDisplay({ ...metcon, format: { type: 'circuit', rounds: 3 } }), false);
});

test('round count: format.rounds pads the one written round to 3', () => {
  assert.equal(expandRounds(metcon).length, 3);
  assert.equal(seedSectionState(metcon).rounds.length, 3);
  assert.equal(expandRounds(triplet).length, 3);
  assert.equal(expandRounds(ladder).length, 3);
  assert.equal(describeFormat(metcon).eyebrow, 'CONDITIONING · FOR TIME · 3 ROUNDS');
  assert.equal(describeFormat(metcon).line, 'Cap 8:00');
});

/* ── full prescription, once ─────────────────────────────────── */

test('Rx: the metcon movements in order with loads, reps and distance', () => {
  const groups = roundsPrescription(metcon, plan.units);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, null);
  assert.deepEqual(groups[0].movements.map(m => [m.movement, m.rx]), [
    ['Rowing machine row', '250 m'],
    ['Slam ball slam', `20 ${X} 8`],
    ['Single-under', '50 reps']
  ]);
});

test('Rx: per-round reps are kept as a scheme; unchanged movements read once', () => {
  const [g] = roundsPrescription(triplet);
  assert.deepEqual(g.movements.map(m => m.rx), [`225 ${X} 21-15-9`, '21-15-9 reps', '200 m']);
  assert.equal(g.movements[2].cue, 'Outdoors', 'cue travels with the movement');
});

test('Rx: rounds whose movements change are grouped and labelled', () => {
  assert.deepEqual(roundsPrescription(ladder).map(g => [g.label, g.movements.map(m => `${m.movement} ${m.rx}`)]), [
    ['Round 1', ['Burpee 10 reps']],
    ['Rounds 2–3', ['Air squat 20 reps']]
  ]);
  // A value that varies other than by reps shows every round's text.
  const odd = { ...ladder, rounds: [{ movements: [{ movement: 'Run', kind: 'cardio', distance: 400 }] },
    { movements: [{ movement: 'Run', kind: 'cardio', distance: 800 }] }] };
  assert.deepEqual(roundsPrescription(odd)[0].movements.map(m => m.rx), ['400 m / 800 m']);
});

/* ── ticking, independent of movements ───────────────────────── */

test('state: one flag per round, no movement state at all', () => {
  const st = seedSectionState(metcon);
  assert.deepEqual(st.rounds, [
    { done: false, movements: [] }, { done: false, movements: [] }, { done: false, movements: [] }
  ]);
});

test('check / uncheck: each round on its own, both directions, input not mutated', () => {
  const before = seedSectionState(metcon);
  const on = checkRound(before, 1, true);
  assert.deepEqual(on.rounds.map(roundDone), [false, true, false]);
  assert.deepEqual(on.rounds[1], { done: true, movements: [] }, 'no movement ticks made up');
  assert.equal(before.rounds[1].done, false);
  const two = checkRound(on, 0, true);
  assert.deepEqual(two.rounds.map(roundDone), [true, true, false]);
  const off = checkRound(two, 1, false);
  assert.deepEqual(off.rounds.map(roundDone), [true, false, false]);
  assert.equal(checkMovement(off, 0, 0, true), off, 'there are no movements to tick');
  assert.equal(checkRound(off, 7, true), off, 'out of range is a no-op');
});

test('persistence: a JSON round trip (reload) keeps exactly the ticks', () => {
  const st = checkRound(checkRound(seedSectionState(metcon), 0, true), 2, true);
  const reloaded = seedSectionState(metcon, JSON.parse(JSON.stringify(st)));
  assert.deepEqual(reloaded.rounds.map(r => r.done), [true, false, true]);
  assert.ok(reloaded.rounds.every(r => r.movements.length === 0));
});

test('legacy state: rounds saved with movements (inputs mode) load as round flags', () => {
  const legacy = seedSectionState({ ...metcon, display: undefined });
  assert.equal(legacy.rounds[0].movements.length, 3, 'the old shape carried movements');
  let st = checkRound(legacy, 0, true);
  st = checkMovement(st, 1, 0, true);   // round 2 only partly done
  const saved = JSON.parse(JSON.stringify(st.rounds));
  const now = seedRoundState(metcon, saved);
  assert.deepEqual(now, [
    { done: true, movements: [] }, { done: false, movements: [] }, { done: false, movements: [] }
  ], 'a partial round stays open; no movement values carried');
  // Missing, short or malformed saved state is tolerated.
  assert.deepEqual(seedRoundState(metcon, undefined).map(r => r.done), [false, false, false]);
  assert.deepEqual(seedRoundState(metcon, [{ done: true }]).map(r => r.done), [true, false, false]);
  assert.deepEqual(seedRoundState(metcon, [null, 'x', 3]).map(r => r.done), [false, false, false]);
  assert.deepEqual(seedRoundState(metcon, 'nope').map(r => r.done), [false, false, false]);
});

/* ── result and digest: truthful ─────────────────────────────── */

test('result: { done, checkOnly: true } per round and nothing about movements', () => {
  const st = checkRound(seedSectionState(metcon), 0, true);
  const res = buildSectionResult(metcon, st);
  assert.deepEqual(res, { rounds: [
    { done: true, checkOnly: true }, { done: false, checkOnly: true }, { done: false, checkOnly: true }
  ] }, 'no score, no rpe, no movements, no values');
  const top = withSections({ log: {} }, plan, { metcon: st });
  assert.deepEqual(top.rounds, res.rounds, 'single-section mirror');
  assert.equal('score' in top, false);
});

test('result: a legacy state with Rx-prefilled movement values exports none of them', () => {
  const legacy = checkRound(seedSectionState({ ...metcon, display: undefined }), 0, true);
  const res = buildSectionResult(metcon, legacy);
  assert.deepEqual(res.rounds[0], { done: true, checkOnly: true });
  assert.ok(!JSON.stringify(res).includes('movements'));
});

test('digest: one tick per round, no movement values', () => {
  const st = checkRound(seedSectionState(metcon), 0, true);
  assert.deepEqual(digestSectionLines(metcon, st, { note: 'Grip went', rpe: '9' }), [
    '  Round 1  ✓', '  Round 2  ○', '  Round 3  ○', '  ↳ Grip went'
  ], 'the stray RPE is ignored: the block hides it');
});

/* ── score and RPE only as configured ────────────────────────── */

test('score / RPE: none unless the plan configures them', () => {
  assert.equal(scoreOf(metcon), null);
  assert.deepEqual(sectionRpePolicy(metcon), { mode: 'hide' });
  const { rpe, ...noRpe } = metcon;
  assert.deepEqual(sectionRpePolicy(noRpe), { mode: 'hide' }, 'hidden by default in this mode, as for a checklist');
  assert.equal(showSectionRpe({ ...metcon, rpe: 'ask' }), true);
  assert.deepEqual(sectionRpePolicy({ ...metcon, rpe: 7 }), { mode: 'assume', value: 7 });
  const timed = { ...metcon, format: { ...metcon.format, score: 'time' } };
  assert.equal(scoreOf(timed), 'time');
  assert.deepEqual(buildSectionResult(timed, seedSectionState(timed)).score, null, 'scored, left blank');
  assert.ok(hasBlockFooter(metcon), 'the block keeps its one note');
});

/* ── validation ──────────────────────────────────────────────── */

const problems = s => validateFormat(s).problems;

test('validate: the example and the fixtures here are clean', () => {
  for (const s of [metcon, triplet, ladder]) {
    const v = validateFormat(s);
    assert.deepEqual([v.problems, v.warnings], [[], []], s.name);
  }
});

test('validate: unsupported display values and misplaced "rounds" fail', () => {
  for (const bad of ['round', 'Rounds', 'rx', true, 1, null]) {
    assert.match(problems({ ...metcon, display: bad }).join(), /display: .* is not one of inputs, checklist, rounds/, JSON.stringify(bad));
  }
  assert.match(problems({ ...metcon, format: { type: 'amrap', capSec: 480 } }).join(), /"rounds" needs format.type "for_time" — got "amrap"/);
  assert.match(problems({ ...metcon, format: { type: 'circuit', rounds: 3 } }).join(), /needs format.type "for_time"/);
  assert.match(problems({ ...metcon, format: undefined }).join(), /got no format/);
  const exercises = [{ movement: 'Push-up', kind: 'reps', sets: [{ reps: 10 }] }];
  assert.match(problems({ name: 'x', display: 'rounds', format: { type: 'for_time' }, exercises }).join(), /needs a rounds\[\] list/);
  assert.match(validateFormat({ ...ladder, rounds: [{ movements: [{ movement: 'Burpee', kind: 'reps', checkOnly: true }] }] })
    .warnings.join(), /checkOnly changes nothing in display "rounds"/);
  assert.match(problems({ ...metcon, cue: 5 }).join(), /cue: must be a string/);
});

test('validate (CLI): an invalid display fails the run, the example passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wodin-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ ...plan, sections: [{ ...metcon, format: { type: 'amrap', capSec: 480 } }] }));
    const cli = fileURLToPath(new URL('cli/wodin.mjs', root));
    const run = f => spawnSync(process.execPath, [cli, 'validate', f], { encoding: 'utf8' });
    const r = run(bad);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /display: "rounds" needs format.type "for_time"/);
    assert.equal(run(fileURLToPath(new URL('examples/metcon-rounds.json', root))).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AGENT.md: the opt-in snippet is the example section, verbatim', () => {
  const md = readFileSync(new URL('AGENT.md', root), 'utf8').replace(/\r\n/g, '\n');
  const block = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]).find(b => b.includes('"display": "rounds"'));
  assert.ok(block, 'AGENT.md shows how to opt in');
  assert.deepEqual(JSON.parse(block), metcon);
  assert.doesNotMatch(md, /"display": "rounds"[^\n]*movement checkbox/i);
});

/* ── the page itself ─────────────────────────────────────────── */

// The markup between a section's rule and the next section (or the closing card).
const sectionHtml = (html, name) => {
  const from = html.indexOf(`<div class="sec-head">${name}</div>`);
  assert.ok(from >= 0, `no section ${name}`);
  const rest = html.slice(from + 1);
  const ends = [rest.indexOf('<div class="sec-head">'), rest.indexOf('<section class="close">')].filter(i => i >= 0);
  return html.slice(from, from + 1 + Math.min(...ends));
};
const count = (s, needle) => s.split(needle).length - 1;

test('page: the Rx once, then one row and one tick per round, no movement controls', async () => {
  const page = await openPage(plan);
  const sec = sectionHtml(page.html(), 'Metcon');
  for (const name of ['Rowing machine row', 'Slam ball slam', 'Single-under']) {
    assert.equal(count(sec, `>${name}<`), 1, `${name} drawn exactly once`);
  }
  assert.match(sec, /<span class="mv-rx">250 m<\/span>/);
  assert.match(sec, /<span class="mv-rx">20 × 8<\/span>/);
  assert.match(sec, /<span class="mv-rx">50 reps<\/span>/);
  assert.match(sec, /FOR TIME · 3 ROUNDS/);
  assert.match(sec, /Cap 8:00/);
  assert.match(sec, /<p class="cue sec-cue">Steady row, unbroken slams/);
  assert.match(sec, /<p class="cue">Jump rope<\/p>/);

  assert.equal(count(sec, 'data-round-check='), 3, 'one tick per round');
  assert.equal(count(sec, '<input'), 3, 'and no other input in the block');
  for (const hook of ['data-mv-check', 'data-rm=', 'data-round-toggle', 'round-sum', 'class="mv "', 'class="mv-fields']) {
    assert.equal(count(sec, hook), 0, `no ${hook}`);
  }
  assert.equal(count(sec, 'class="round open template"'), 1, 'one prescription block');
  assert.equal(count(sec, 'class="mv rx"'), 3, 'three Rx lines in all, none repeated per round');
  assert.equal(count(sec, 'class="round tick '), 3);
  for (const n of [1, 2, 3]) assert.match(sec, new RegExp(`Round ${n}</span>\\s*<span class="round-of">${n} of 3`));
  // No score box, stopwatch or RPE; the block note stays.
  for (const hook of ['class="score"', 'data-score', 'data-sw', 'data-rpe', 'pill-rpe']) assert.equal(count(sec, hook), 0, hook);
  assert.equal(count(sec, 'data-opennote="metcon"'), 1);
});

test('page: ticking persists across a reload and exports truthfully', async () => {
  const first = await openPage(plan);
  first.tick({ roundCheck: 'metcon:1' }, true);
  assert.equal(count(sectionHtml(first.html(), 'Metcon'), ' checked'), 1);
  const saved = JSON.parse(first.storage.get('wodin:log:' + plan.workoutId));
  assert.deepEqual(saved.sections.metcon.rounds, [
    { done: false, movements: [] }, { done: true, movements: [] }, { done: false, movements: [] }
  ]);

  const again = await openPage(plan, { storage: first.storage });
  const sec = sectionHtml(again.html(), 'Metcon');
  assert.match(sec, /data-round-check="metcon:1" checked/);
  assert.doesNotMatch(sec, /data-round-check="metcon:0" checked/);
  assert.match(sec, /class="round tick done"/);

  again.tick({ roundCheck: 'metcon:0' }, true);
  again.tick({ roundCheck: 'metcon:1' }, false);
  const res = await again.result();
  assert.deepEqual(res.sections.metcon, { rounds: [
    { done: true, checkOnly: true }, { done: false, checkOnly: true }, { done: false, checkOnly: true }
  ] });
  assert.deepEqual(res.log, {}, 'round movements never reach log');
  assert.equal(res.rpe, null);
  assert.deepEqual(res.exerciseRpe, {});
  assert.match(again.digest(), /METCON\n {2}Round 1 {2}✓\n {2}Round 2 {2}○\n {2}Round 3 {2}○/);
});

test('page: a log saved before the switch to display "rounds" still opens', async () => {
  const storage = new Map();
  const legacyPlan = { ...plan, sections: [{ ...metcon, display: undefined }] };
  const old = await openPage(legacyPlan, { storage });
  old.tick({ roundCheck: 'metcon:0' }, true);
  assert.equal(JSON.parse(storage.get('wodin:log:' + plan.workoutId)).sections.metcon.rounds[0].movements.length, 3);
  const now = await openPage(plan, { storage });
  assert.match(sectionHtml(now.html(), 'Metcon'), /data-round-check="metcon:0" checked/);
  const res = await now.result();
  assert.deepEqual(res.sections.metcon.rounds[0], { done: true, checkOnly: true });
});

test('page: RPE and score boxes appear when the plan asks for them', async () => {
  const asked = { ...plan, sections: [{ ...metcon, rpe: 'ask', format: { ...metcon.format, score: 'time' } }] };
  const sec = sectionHtml((await openPage(asked)).html(), 'Metcon');
  assert.equal(count(sec, 'data-rpe="metcon"'), 1);
  assert.equal(count(sec, 'data-score="metcon"'), 1);
  assert.equal(count(sec, 'data-sw="go"'), 1);
});

test('page: varying reps draw once as a scheme, labelled groups when movements change', async () => {
  const html = (await openPage(wodOf(triplet, ladder))).html();
  const dt = sectionHtml(html, 'DT-ish');
  assert.equal(count(dt, '>Barbell deadlift<'), 1);
  assert.match(dt, /<span class="mv-rx">225 × 21-15-9<\/span>/);
  assert.match(dt, /<span class="mv-rx">21-15-9 reps<\/span>/);
  const lad = sectionHtml(html, 'Ladder');
  assert.match(lad, /<div class="rounds-cap">Round 1<\/div>/);
  assert.match(lad, /<div class="rounds-cap">Rounds 2–3<\/div>/);
  assert.equal(count(lad, '>Air squat<'), 1);
  assert.equal(count(lad, 'data-round-check='), 3);
});

/* ── other modes unchanged ───────────────────────────────────── */

test('page: checklist and inputs warm-ups still draw a tick (and boxes) per movement', async () => {
  const cl = load('lower-b-warmup-checklist.json');
  const sec = sectionHtml((await openPage(cl)).html(), 'Warm-up');
  assert.equal(count(sec, 'data-mv-check='), 5);
  assert.equal(count(sec, 'data-rm='), 0);
  assert.equal(count(sec, 'data-round-toggle='), 1);
  assert.equal(count(sec, 'class="round tick'), 0);

  const inp = sectionHtml((await openPage(load('lower-b-warmup-inputs.json'))).html(), 'Warm-up');
  assert.equal(count(inp, 'data-mv-check='), 5);
  assert.ok(count(inp, 'data-rm=') > 0);
});

test('page: the same block without display "rounds" draws the default rounds', async () => {
  const plain = { ...plan, sections: [{ ...metcon, display: undefined }] };
  const sec = sectionHtml((await openPage(plain)).html(), 'Metcon');
  assert.equal(count(sec, 'data-round-toggle='), 3);
  assert.equal(count(sec, 'data-mv-check='), 3, 'the open round shows its movement ticks');
  assert.equal(count(sec, 'class="round open template"'), 0);
  assert.equal(count(sec, 'pill-rpe'), 0, 'rpe: hide still hides it');
  const asks = { ...plan, sections: [{ ...metcon, display: undefined, rpe: undefined }] };
  assert.equal(count(sectionHtml((await openPage(asks)).html(), 'Metcon'), 'pill-rpe'), 1, 'default rounds still ask');
});

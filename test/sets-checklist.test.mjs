// Round-movement `sets` / `sides`, section `display: "checklist"` and per-line
// `checkOnly`. The page draws these from the helpers tested here (doseText,
// rxText, roundSummary, isCheckOnly), so a plan without the new fields must
// come out of every one of them exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  movementSets, movementSides, doseText, rxText, roundSummary, isChecklist, isCheckOnly,
  expandRounds, seedSectionState, checkMovement, checkRound, buildSectionResult,
  digestSectionLines, sectionRpePolicy, showSectionRpe, validateFormat
} from '../src/format.js';

const load = f => JSON.parse(readFileSync(new URL('../examples/' + f, import.meta.url), 'utf8'));
const fixture = load('format-test.json');
const byLetter = l => fixture.sections.find(s => s.name.startsWith(l + ' '));
const checklist = load('lower-b-warmup-checklist.json').sections[0];
const inputs = load('lower-b-warmup-inputs.json').sections[0];
const X = '×';

/* ── dose ────────────────────────────────────────────────────── */

test('dose: sets × prescription with U+00D7 and spaces, sets: 1 included', () => {
  assert.equal(doseText({ kind: 'time', sets: 2, duration: '0:45' }), `2 ${X} 0:45`);
  assert.equal(doseText({ kind: 'reps', sets: 1, reps: 20 }), `1 ${X} 20`);
  assert.equal(doseText({ kind: 'weight_reps', sets: 2, reps: 10, load: 35 }), `2 ${X} 35 ${X} 10`);
  assert.equal(doseText({ kind: 'cardio', sets: 1, duration: '2:00', pace: '2:35/500m' }), `1 ${X} 2:00`);
  assert.equal(doseText({ kind: 'reps', sets: 2, reps: null }), '2 sets', 'no prescription to multiply');
});

test('dose: sides above 1 make the prescription per side; sides: 1 adds nothing', () => {
  assert.equal(doseText({ kind: 'reps', sets: 1, reps: 3, sides: 2 }), `1 ${X} 3/side`);
  assert.equal(doseText({ kind: 'time', sets: 2, duration: '0:30', sides: 2 }), `2 ${X} 0:30/side`);
  assert.equal(doseText({ kind: 'reps', reps: 3, sides: 2 }), '3/side', 'sides without sets');
  assert.equal(doseText({ kind: 'reps', sets: 1, reps: 3, sides: 1 }), `1 ${X} 3`);
});

test('dose: absent or invalid sets and sides draw no dose at all', () => {
  for (const extra of [{}, { sets: 0 }, { sets: 1.5 }, { sets: '2' }, { sides: 0 }, { sides: '2' }]) {
    const m = { kind: 'reps', reps: 10, ...extra };
    assert.equal(doseText(m), null, JSON.stringify(extra));
  }
  assert.equal(movementSets({ sets: 1 }), 1);
  assert.equal(movementSets({}), null);
  assert.equal(movementSides({ sides: 2 }), 2);
  assert.equal(movementSides({ sides: -1 }), null);
});

test('AMRAP template and collapsed summary show the dose only when the plan gives one', () => {
  assert.equal(rxText({ kind: 'reps', reps: 5 }), '5 reps', 'unchanged without sets');
  assert.equal(rxText({ kind: 'reps', reps: 5, sets: 1 }), `1 ${X} 5`);
  assert.equal(roundSummary(expandRounds(checklist)[0]),
    `Rowing machine row 1 ${X} 2:00 · Leg swing 1 ${X} 20 · World's greatest stretch 1 ${X} 3/side · ` +
    `Cat-camel 1 ${X} 8 · Kettlebell Asian squat hold 2 ${X} 0:45`);
});

/* ── backward compatibility ──────────────────────────────────── */

test('a circuit without the new fields reads exactly as before', () => {
  const L = byLetter('L');
  const strip = ({ sets, sides, checkOnly, ...m }) => m;
  const plain = { ...L, rounds: [{ movements: L.rounds[0].movements.map(strip) }] };
  const st = seedSectionState(plain);
  assert.equal(roundSummary(expandRounds(plain)[0]), `Dumbbell row 35 ${X} 10 · Push-up 10`);
  assert.equal(digestSectionLines(plain, st)[0], '  Round 1  ○ Dumbbell row 35×10 · Push-up 10');
  assert.deepEqual(buildSectionResult(plain, st).rounds[0].movements, [
    { movement: 'Dumbbell row', done: false, load: 35, reps: 10 },
    { movement: 'Push-up', done: false, reps: 10 }
  ]);
  assert.equal(isCheckOnly(plain, plain.rounds[0].movements[0]), false);
  assert.deepEqual(sectionRpePolicy(plain), { mode: 'ask' });
});

test('sets on a fixture circuit line: dose in the summary, count in digest and result', () => {
  const L = byLetter('L');
  const st = seedSectionState(L);
  assert.equal(expandRounds(L)[2].movements[0].sets, 2, 'sets survives padding up to format.rounds');
  assert.equal(roundSummary(expandRounds(L)[0]), `Dumbbell row 2 ${X} 35 ${X} 10 · Push-up 10`);
  assert.equal(digestSectionLines(L, st)[0], '  Round 1  ○ Dumbbell row 2×35×10 · Push-up 10');
  const [row, push] = buildSectionResult(L, st).rounds[0].movements;
  assert.deepEqual(row, { movement: 'Dumbbell row', done: false, sets: 2, load: 35, reps: 10 });
  assert.equal('sets' in push, false, 'absent in the plan, absent in the result');
});

/* ── checklist ───────────────────────────────────────────────── */

test('checklist: every line is check-only; checkOnly on a line overrides the section', () => {
  assert.ok(isChecklist(checklist));
  assert.ok(checklist.rounds[0].movements.every(m => isCheckOnly(checklist, m)));
  assert.equal(isCheckOnly(checklist, { checkOnly: false }), false, 'a line can opt back into inputs');
  assert.equal(isChecklist(inputs), false);
  assert.ok(inputs.rounds[0].movements.every(m => !isCheckOnly(inputs, m)));
  assert.equal(isCheckOnly(inputs, { checkOnly: true }), true, 'one check-only line in a normal section');
});

test('checklist: block RPE is hidden unless the section asks; the one note stays', () => {
  assert.deepEqual(sectionRpePolicy(checklist), { mode: 'hide' });
  assert.equal(showSectionRpe(checklist), false);
  assert.deepEqual(sectionRpePolicy({ ...checklist, rpe: 'ask' }), { mode: 'ask' });
  assert.deepEqual(sectionRpePolicy({ ...checklist, benchmark: 'girl' }), { mode: 'assume', value: 11 });
  const lines = digestSectionLines(checklist, seedSectionState(checklist), { note: 'Hips tight', rpe: '6' });
  assert.equal(lines.at(-1), '  ↳ Hips tight');
  assert.ok(!lines.some(l => /RPE/.test(l)), 'a stray RPE is ignored');
});

test('checklist result: ticks only, marked checkOnly, sets and sides copied', () => {
  let st = seedSectionState(checklist);
  st = checkMovement(st, 0, 0, true);
  const res = buildSectionResult(checklist, st);
  assert.equal(res.rounds[0].done, false);
  assert.deepEqual(res.rounds[0].movements[0], { movement: 'Rowing machine row', done: true, sets: 1, checkOnly: true });
  assert.deepEqual(res.rounds[0].movements[2], { movement: "World's greatest stretch", done: false, sets: 1, sides: 2, checkOnly: true });
  assert.deepEqual(res.rounds[0].movements[4], { movement: 'Kettlebell Asian squat hold', done: false, sets: 2, checkOnly: true });
  assert.equal(res.score, undefined, 'score: none draws and records no score');

  const all = buildSectionResult(checklist, checkRound(seedSectionState(checklist), 0, true));
  assert.ok(all.rounds[0].done && all.rounds[0].movements.every(m => m.done), 'round rule holds');
});

test('checklist digest shows the planned dose; a partial round marks each line', () => {
  let st = seedSectionState(checklist);
  assert.equal(digestSectionLines(checklist, st)[0],
    `  Round 1  ○ Rowing machine row 1 ${X} 2:00 · Leg swing 1 ${X} 20 · World's greatest stretch 1 ${X} 3/side · ` +
    `Cat-camel 1 ${X} 8 · Kettlebell Asian squat hold 2 ${X} 0:45`);
  st = checkMovement(st, 0, 0, true);
  assert.match(digestSectionLines(checklist, st)[0], /^ {2}Round 1 {2}✓ Rowing machine row 1 × 2:00 · ○ Leg swing/);
});

test('inputs variant: same lines with boxes; values recorded per set', () => {
  const st = seedSectionState(inputs);
  const [row, , wgs, , hold] = buildSectionResult(inputs, st).rounds[0].movements;
  assert.deepEqual(row, { movement: 'Rowing machine row', done: false, sets: 1,
    distance: null, pace: '2:35', duration: '2:00', durationSec: 120 });
  assert.deepEqual(wgs, { movement: "World's greatest stretch", done: false, sets: 1, sides: 2, reps: 3 });
  assert.deepEqual(hold, { movement: 'Kettlebell Asian squat hold', done: false, sets: 2, duration: '0:45', durationSec: 45 });
  assert.equal(digestSectionLines(inputs, st)[0],
    "  Round 1  ○ Rowing machine row 1×2:00 · Leg swing 1×20 · World's greatest stretch 1×3/side · " +
    'Cat-camel 1×8 · Kettlebell Asian squat hold 2×0:45');
});

test('the two warm-up examples carry the same lines and differ only in display', () => {
  assert.deepEqual(checklist.rounds, inputs.rounds);
  assert.equal(checklist.display, 'checklist');
  assert.equal(inputs.display, undefined);
});

/* ── validation ──────────────────────────────────────────────── */

const circuit = (extra, sec = {}) => ({ name: 'x', format: { type: 'circuit' }, ...sec,
  rounds: [{ movements: [{ movement: 'Push-up', kind: 'reps', reps: 10, ...extra }] }] });
const problems = s => validateFormat(s).problems;
const warnings = s => validateFormat(s).warnings;

test('validate: sets and sides must be integers of 1 or more', () => {
  for (const bad of [0, -1, 1.5, '2', [{ reps: 10 }], null, true]) {
    assert.match(problems(circuit({ sets: bad })).join(), /sets must be an integer/, JSON.stringify(bad));
    assert.match(problems(circuit({ sides: bad })).join(), /sides must be an integer/, JSON.stringify(bad));
  }
  for (const ok of [1, 2, 4]) {
    assert.deepEqual(problems(circuit({ sets: ok, sides: ok })), [], String(ok));
  }
});

test('validate: checkOnly must be a boolean', () => {
  for (const bad of ['yes', 1, 0, null, {}]) {
    assert.match(problems(circuit({ checkOnly: bad })).join(), /checkOnly must be true or false/, JSON.stringify(bad));
  }
  for (const ok of [true, false]) assert.deepEqual(problems(circuit({ checkOnly: ok })), []);
});

test('validate: display must be inputs or checklist', () => {
  for (const bad of ['list', 'Checklist', true, 1, null]) {
    assert.match(problems(circuit({}, { display: bad })).join(), /display: .* is not one of inputs, checklist/, JSON.stringify(bad));
  }
  for (const ok of ['inputs', 'checklist']) {
    const v = validateFormat(circuit({}, { display: ok }));
    assert.deepEqual([v.problems, v.warnings], [[], []], ok);
  }
});

test('validate: warns where the new fields change nothing', () => {
  const exercises = [{ movement: 'Push-up', kind: 'reps', sets: [{ reps: 10 }] }];
  assert.match(warnings({ name: 'x', display: 'checklist', exercises }).join(), /only changes round movements/);
  assert.match(warnings({ name: 'x', format: { type: 'amrap', capSec: 600 }, display: 'checklist',
    rounds: circuit({}).rounds }).join(), /amrap changes nothing/);
  assert.match(warnings({ name: 'x', exercises: [{ ...exercises[0], sides: 2 }] }).join(), /sides is a round-movement field/);
  assert.match(warnings({ name: 'x', exercises: [{ ...exercises[0], checkOnly: true }] }).join(), /checkOnly is a round-movement field/);
});

test('validate: both warm-up examples are clean', () => {
  for (const sec of [checklist, inputs]) {
    const v = validateFormat(sec);
    assert.deepEqual([v.problems, v.warnings], [[], []], sec.name);
  }
});

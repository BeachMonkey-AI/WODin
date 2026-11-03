// Exercise `setCheck`: a tick at the end of every set row, a rest count-up
// under the most recently ticked set, and `done` on each of the exercise's
// log entries. On by default: absent means ticks; only `setCheck: false`
// opts an exercise out, and then nothing here is drawn or recorded for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  hasSetCheck, setCheckProblem, checkSetState, setValuesOnly, restSetKey, restElapsedMs, restText,
  setDoneResult, validateFormat, roundsOf
} from '../src/format.js';

const load = f => JSON.parse(readFileSync(new URL('../examples/' + f, import.meta.url), 'utf8'));
const T = 1_700_000_000_000;

const bench = (extra = {}) => ({ movement: 'Barbell bench press', kind: 'weight_reps', ...extra,
  sets: [{ id: 's1', reps: 5, load: 135 }, { id: 's2', reps: 5, load: 155 }] });
const section = ex => ({ name: 'Strength', exercises: [ex] });

/* -- default on; setCheck: false opts out --------------------- */

test('setCheck is on by default: absent or true draws ticks and logs done', () => {
  for (const ex of [bench(), bench({ setCheck: true })]) {
    assert.equal(hasSetCheck(ex), true);
    assert.deepEqual(setDoneResult(ex, { load: '135', reps: '5' }), { done: false });
    assert.deepEqual(setDoneResult(ex, { done: true, doneAt: T }), { done: true });
  }
  assert.equal(hasSetCheck(undefined), false, 'no exercise, no ticks');
});

test('setCheck: false opts out: no ticks and no done in the log entry', () => {
  const ex = bench({ setCheck: false });
  assert.equal(hasSetCheck(ex), false);
  assert.deepEqual(setDoneResult(ex, { load: '135', reps: '5' }), {}, 'no done key in the log entry');
  // A stray tick in saved state (setCheck since turned off) still adds nothing.
  assert.deepEqual(setDoneResult(ex, { done: true, doneAt: T }), {});
});

test('old saved set state (no done / doneAt) loads as unticked', () => {
  const ex = bench();
  const old = { load: '135', reps: '5', distance: '', duration: '', pace: '' };
  assert.deepEqual(setDoneResult(ex, old), { done: false });
  assert.equal(restSetKey({ 'ex1.s1': old }, ['ex1.s1']), null);
  assert.deepEqual(setDoneResult(ex, undefined), { done: false });
});

/* ── ticking ─────────────────────────────────────────────────── */

test('ticking stamps the set and keeps its values; unticking drops both', () => {
  const v = { load: '135', reps: '5' };
  const on = checkSetState(v, true, T);
  assert.deepEqual(on, { load: '135', reps: '5', done: true, doneAt: T });
  assert.deepEqual(v, { load: '135', reps: '5' }, 'input not mutated');
  const again = checkSetState(on, true, T + 5000);
  assert.equal(again.doneAt, T + 5000, 're-ticking restamps');
  assert.deepEqual(checkSetState(on, false, T + 9000), { load: '135', reps: '5' });
  assert.deepEqual(checkSetState(undefined, true, T), { done: true, doneAt: T });
});

/* ── which set shows the rest clock ──────────────────────────── */

test('the rest clock sits under the most recently ticked set', () => {
  const keys = ['b.s1', 'b.s2', 'b.s3', 'b.s4'];
  let sets = {};
  assert.equal(restSetKey(sets, keys), null, 'nothing ticked, no clock');
  sets['b.s1'] = checkSetState({}, true, T);
  assert.equal(restSetKey(sets, keys), 'b.s1');
  sets['b.s2'] = checkSetState({}, true, T + 120_000);
  assert.equal(restSetKey(sets, keys), 'b.s2', 'ticking another moves it there');
  // Ticked out of order: latest by time, not by row.
  sets['b.s4'] = checkSetState({}, true, T + 60_000);
  assert.equal(restSetKey(sets, keys), 'b.s2');
  sets['b.s3'] = checkSetState({}, true, T + 240_000);
  assert.equal(restSetKey(sets, keys), 'b.s3');
});

test('unticking the latest hands the clock back by timestamp, then removes it', () => {
  const keys = ['b.s1', 'b.s2', 'b.s3'];
  const sets = {
    'b.s1': checkSetState({}, true, T + 200_000),
    'b.s2': checkSetState({}, true, T),
    'b.s3': checkSetState({}, true, T + 300_000)
  };
  assert.equal(restSetKey(sets, keys), 'b.s3');
  sets['b.s3'] = checkSetState(sets['b.s3'], false);
  assert.equal(restSetKey(sets, keys), 'b.s1', 'the latest still ticked, not the row above');
  sets['b.s1'] = checkSetState(sets['b.s1'], false);
  assert.equal(restSetKey(sets, keys), 'b.s2');
  sets['b.s2'] = checkSetState(sets['b.s2'], false);
  assert.equal(restSetKey(sets, keys), null);
});

test('only keys offered count; ties go to the later row; a tick without a stamp shows no clock', () => {
  const sets = { 'a.s1': checkSetState({}, true, T), 'b.s1': checkSetState({}, true, T + 1000) };
  assert.equal(restSetKey(sets, ['a.s1']), 'a.s1', 'b is not drawn with a tick (skipped / no setCheck)');
  assert.equal(restSetKey({ x: { done: true, doneAt: T }, y: { done: true, doneAt: T } }, ['x', 'y']), 'y');
  assert.equal(restSetKey({ x: { done: true } }, ['x']), null);
  assert.equal(restSetKey({ x: { done: true, doneAt: 'soon' } }, ['x']), null);
  assert.equal(restSetKey({ x: { doneAt: T } }, ['x']), null, 'a stamp without done is not ticked');
  assert.equal(restSetKey(undefined, ['x']), null);
  assert.equal(restSetKey({}, undefined), null);
});

/* ── added sets ──────────────────────────────────────────────── */

test('an added set copies the last set\'s values, never its tick', () => {
  const last = checkSetState({ load: '155', reps: '5' }, true, T);
  assert.deepEqual(setValuesOnly(last), { load: '155', reps: '5' });
  assert.deepEqual(setValuesOnly(undefined), {});
});

test('an added set takes the clock when ticked, and removing it hands the clock back', () => {
  const keys = ['b.s1', 'b.s2', 'b.a1'];
  const sets = {
    'b.s1': checkSetState({}, true, T),
    'b.s2': checkSetState({}, true, T + 60_000),
    'b.a1': setValuesOnly(checkSetState({ load: '155' }, true, T + 60_000))
  };
  assert.equal(restSetKey(sets, keys), 'b.s2', 'the fresh added set starts unticked');
  sets['b.a1'] = checkSetState(sets['b.a1'], true, T + 180_000);
  assert.equal(restSetKey(sets, keys), 'b.a1');
  // Remove: main.js deletes the set's state and drops its key.
  delete sets['b.a1'];
  assert.equal(restSetKey(sets, ['b.s1', 'b.s2']), 'b.s2');
  assert.deepEqual(setDoneResult(bench({ setCheck: true }), sets['b.a1']), { done: false });
});

/* ── rest text ───────────────────────────────────────────────── */

test('rest is now minus the stamp, as m:ss, never negative', () => {
  assert.equal(restElapsedMs(T, T + 61_500), 61_500);
  assert.equal(restElapsedMs(T, T - 5000), 0, 'clock wound back');
  assert.equal(restText(T, T), '0:00');
  assert.equal(restText(T, T + 92_999), '1:32');
  assert.equal(restText(T, T + 3_725_000), '1:02:05');
});

/* ── result ──────────────────────────────────────────────────── */

test('result: done flags only when set ticks are on', () => {
  const ex = bench();
  assert.deepEqual(setDoneResult(ex, checkSetState({ load: '135' }, true, T)), { done: true });
  assert.deepEqual(setDoneResult(ex, { load: '135' }), { done: false });
  assert.deepEqual(setDoneResult(bench({ setCheck: false }), checkSetState({ load: '135' }, true, T)), {});
  const entry = { load: 135, reps: 5, asPlanned: true, ...setDoneResult(ex, checkSetState({}, true, T)) };
  assert.equal(JSON.stringify(entry).includes(String(T)), false, 'stamps never reach the result');
  const schema = JSON.parse(readFileSync(new URL('../schema/result.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$defs.entry.properties.done.type, 'boolean');
});

/* ── validation ──────────────────────────────────────────────── */

const problems = s => validateFormat(s).problems;
const warnings = s => validateFormat(s).warnings;

test('validate: exercise setCheck must be a boolean', () => {
  for (const bad of ['yes', 1, null, {}]) {
    assert.match(problems(section(bench({ setCheck: bad }))).join(), /setCheck must be true or false/, JSON.stringify(bad));
  }
  for (const ok of [true, false]) {
    const v = validateFormat(section(bench({ setCheck: ok })));
    assert.deepEqual([v.problems, v.warnings], [[], []], String(ok));
  }
  assert.equal(setCheckProblem(bench(), 'x'), null);
});

test('validate: setCheck on a round movement is an error, whatever its value', () => {
  const circuit = setCheck => ({ name: 'Circuit', format: { type: 'circuit' }, rounds: [{ movements: [
    { movement: 'Goblet squat', kind: 'weight_reps', reps: 8, load: 53, sets: 3, setCheck }
  ] }] });
  for (const v of [true, false]) {
    assert.match(problems(circuit(v)).join(), /setCheck applies to exercises only/, String(v));
  }
});

test('validate: setCheck in a derived tabata / emom warns that it changes nothing', () => {
  const emom = { name: 'EMOM', format: { type: 'emom', rounds: 10, intervalSec: 60 },
    exercises: [{ movement: 'Push-up', kind: 'reps', setCheck: true, sets: [{ reps: 10 }] }] };
  assert.match(warnings(emom).join(), /setCheck changes nothing in a derived emom/);
  assert.equal('setCheck' in roundsOf(emom)[0].movements[0], false, 'not carried into derived rounds');
});

/* ── the sample ──────────────────────────────────────────────── */

test('sample: bench press ticks by default (no field); the row opts out with setCheck: false', () => {
  const wod = load('set-rest-timer.json');
  const [benchEx, other] = wod.sections[0].exercises;
  assert.equal(benchEx.movement, 'Barbell bench press');
  assert.equal('setCheck' in benchEx, false, 'the default, not written');
  assert.equal(hasSetCheck(benchEx), true);
  assert.equal(benchEx.kind, 'weight_reps');
  assert.equal(benchEx.sets.length, 4);
  assert.equal(other.setCheck, false);
  assert.equal(hasSetCheck(other), false);
  for (const sec of wod.sections) {
    const v = validateFormat(sec);
    assert.deepEqual([v.problems, v.warnings], [[], []]);
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.validate, /examples\/set-rest-timer\.json/);
});

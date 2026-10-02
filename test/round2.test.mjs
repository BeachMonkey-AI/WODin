import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  roundsOf, isDerivedRounds, isRoundsSection, expandRounds, describeFormat, roundSummary,
  seedSectionState, checkRound, checkMovement, buildSectionResult, withSections,
  sectionNotesAndRpe, digestSectionLines, validateFormat, validatePlanRpe, hasBlockFooter,
  usesFormatFeatures, fmtTimeDigits, fmtPaceDigits, buildScore, isAutoFormatField,
  timeFormatterFor, AUTO_FORMAT_FIELDS, rpePolicy, sectionRpePolicy, sessionRpePolicy,
  showSectionRpe, showExerciseRpe, showSessionRpe, sessionRpeResult, sessionRpeText
} from '../src/format.js';

const root = new URL('../', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('examples/format-test.json', root), 'utf8'));
const byLetter = l => fixture.sections.find(s => s.name.startsWith(l + ' '));
const mv = { movement: 'Push-up', kind: 'reps', sets: [{ reps: 10 }] };

/* ── R1+R2: derived rounds for emom / tabata ─────────────────── */

test('tabata and the A/B emom pair derive their rounds from exercises', () => {
  const D = byLetter('C'), F = byLetter('D');
  for (const s of [D, F]) assert.ok(isDerivedRounds(s) && isRoundsSection(s), s.name);
  assert.equal(expandRounds(D).length, 8);
  const f = expandRounds(F);
  assert.equal(f.length, 10);
  assert.ok(f.every(r => r.movements.map(m => m.movement).join() === 'Kettlebell swing,Push-up'));
  assert.deepEqual(f[0].movements.map(m => m.intervalSlot), ['A', 'B'], 'intervalSlot carries onto the movement');
  assert.deepEqual(roundsOf(D), [{ movements: [{ movement: 'Barbell thruster', kind: 'weight_reps', reps: 5, load: 65 }] }]);
  assert.equal(roundSummary(f[3]), 'Kettlebell swing 53 × 12 · Push-up 10');
  // The header reads as it did before derivation.
  assert.equal(describeFormat(D).eyebrow, 'CONDITIONING · TABATA · 8 ROUNDS');
  assert.equal(describeFormat(D).line, '20s work / 10s rest × 8');
});

test('derivation copies the first set, lets set.kind override, keeps exercise id', () => {
  const sec = {
    format: { type: 'emom', rounds: 3, intervalSec: 60 },
    exercises: [{
      id: 'sw', movement: 'Kettlebell swing', kind: 'reps', cue: 'hips', partition: 'unbroken',
      sets: [{ kind: 'weight_reps', reps: 15, load: 53, loadBwMult: 0.5 }, { reps: 99 }]
    }]
  };
  const [m] = roundsOf(sec)[0].movements;
  assert.deepEqual(m, { movement: 'Kettlebell swing', kind: 'weight_reps', id: 'sw', reps: 15, load: 53, loadBwMult: 0.5, cue: 'hips', partition: 'unbroken' });
  assert.equal(expandRounds(sec)[2].movements[0].id, 'sw');
});

test('chippers, intervals, AMRAPs and tabata without format.rounds are not derived', () => {
  for (const l of ['B', 'K']) assert.ok(!isDerivedRounds(byLetter(l)) && !isRoundsSection(byLetter(l)), l);
  assert.ok(!isDerivedRounds({ format: { type: 'intervals', rounds: 4 }, exercises: [mv] }));
  assert.ok(!isDerivedRounds({ format: { type: 'amrap', rounds: 4 }, exercises: [mv] }));
  assert.ok(!isDerivedRounds({ format: { type: 'tabata', workSec: 20 }, exercises: [mv] }));
  assert.deepEqual(roundsOf({ format: { type: 'tabata', workSec: 20 }, exercises: [mv] }), []);
  // Written rounds[] always win over derivation.
  const own = { format: { type: 'emom', rounds: 2 }, exercises: [mv], rounds: [{ movements: [{ movement: 'Air squat', kind: 'reps', reps: 5 }] }] };
  assert.ok(!isDerivedRounds(own));
  assert.equal(expandRounds(own)[1].movements[0].movement, 'Air squat');
});

test('the round check rule holds on derived rounds', () => {
  const F = byLetter('D');
  let st = seedSectionState(F);
  assert.equal(st.rounds.length, 10);
  st = checkMovement(st, 0, 0, true);
  assert.equal(st.rounds[0].done, false);
  st = checkMovement(st, 0, 1, true);
  assert.equal(st.rounds[0].done, true);
  st = checkRound(st, 1, true);
  assert.ok(st.rounds[1].movements.every(m => m.done));
  st = checkMovement(st, 1, 0, false);
  assert.equal(st.rounds[1].done, false);
});

test('derived section result: rounds with done flags, block footer, nothing required', () => {
  const D = byLetter('C');
  let st = seedSectionState(D);
  st = checkRound(st, 0, true);
  st = checkRound(st, 1, true);
  const res = buildSectionResult(D, st);
  assert.equal(res.rounds.length, 8);
  assert.deepEqual(res.rounds.map(r => r.done), [true, true, false, false, false, false, false, false]);
  assert.deepEqual(res.rounds[0].movements[0], { movement: 'Barbell thruster', done: true, load: 65, reps: 5 });
  assert.ok(!('score' in res), 'score none is never scored');
  assert.ok(hasBlockFooter(D) && usesFormatFeatures(D));
  // Untouched rounds are fine: round checkboxes are optional for the athlete.
  assert.ok(buildSectionResult(D, seedSectionState(D)).rounds.every(r => r.done === false));
  // Derived sections log no "exId.setId" entries — main.js skips them because
  // isDerivedRounds is true; the rounds above are the record.
  assert.equal(isDerivedRounds(D), true);
});

test('derived digest lines are written per round', () => {
  const C = byLetter('C');
  const st = checkRound(seedSectionState(C), 0, true);
  const lines = digestSectionLines(C, st, { rpe: 7 });
  assert.equal(lines.length, 9);
  assert.equal(lines[0], '  Round 1  ✓ Barbell thruster 65×5');
  assert.equal(lines[1], '  Round 2  ○ Barbell thruster 65×5');
  assert.equal(lines[8], '  RPE  7');
});

test('derivation warnings: multi-set exercises, no format.rounds', () => {
  const w = sec => validateFormat(sec).warnings.join('\n');
  const multi = { format: { type: 'tabata', rounds: 8, workSec: 20 }, exercises: [{ ...mv, sets: [{ reps: 5 }, { reps: 5 }] }] };
  assert.match(w(multi), /only the first set is used for rounds/);
  assert.match(w({ format: { type: 'emom', intervalSec: 60 }, exercises: [mv] }), /emom without rounds — no rounds are drawn/);
  assert.doesNotMatch(w({ format: { type: 'intervals' }, exercises: [mv] }), /without rounds/);
  assert.doesNotMatch(w(byLetter('D')), /first set|without rounds/);
});

/* ── R3: keypad time entry ───────────────────────────────────── */

test('fmtTimeDigits', () => {
  const cases = [
    ['', ''], ['5', '5'], ['05', '05'], ['158', '1:58'], ['841', '8:41'], ['0841', '8:41'],
    ['1254', '12:54'], ['12542', '1:25:42'], ['125412', '12:54:12'], ['1254123', '12:54:12'],
    ['8:41', '8:41'], ['1:25:42', '1:25:42'], ['0:00', '0:00'], ['000841', '8:41'],
    ['012542', '1:25:42'], ['ab12c', '12'], [null, ''], [841, '8:41']
  ];
  for (const [raw, want] of cases) assert.equal(fmtTimeDigits(raw), want, JSON.stringify(raw));
});

test('fmtPaceDigits', () => {
  const cases = [
    ['', ''], ['1', '1'], ['158', '1:58'], ['1:58', '1:58'], ['0158', '1:58'],
    ['1058', '10:58'], ['12542', '12:54'], ['0:00', '0:00']
  ];
  for (const [raw, want] of cases) assert.equal(fmtPaceDigits(raw), want, JSON.stringify(raw));
});

test('score time typed without colons uses the same formatter', () => {
  const G = byLetter('E');
  assert.deepEqual(buildScore(G, { time: '12542' }), { time: '1:25:42', timeSec: 5142 });
  assert.deepEqual(buildScore(G, { time: '0841' }), { time: '8:41', timeSec: 521 });
  assert.deepEqual(buildScore(G, { time: '8:41' }), { time: '8:41', timeSec: 521 });
});

test('auto-format fields: duration, pace and the score time — not the session duration', () => {
  assert.deepEqual(AUTO_FORMAT_FIELDS, ['duration', 'pace', 'score-time']);
  assert.ok(isAutoFormatField('duration') && isAutoFormatField('pace') && isAutoFormatField('score-time'));
  assert.ok(!isAutoFormatField('f-duration') && !isAutoFormatField('reps'));
  assert.equal(timeFormatterFor('pace'), fmtPaceDigits);
  assert.equal(timeFormatterFor('score-time'), fmtTimeDigits);
  assert.equal(timeFormatterFor('load'), null);
});

/* ── R4: RPE policy ──────────────────────────────────────────── */

test('rpe policy table', () => {
  const ask = { mode: 'ask' }, hide = { mode: 'hide' }, eleven = { mode: 'assume', value: 11 };
  assert.deepEqual(sectionRpePolicy({}), ask, 'legacy: ask');
  assert.deepEqual(sectionRpePolicy({ benchmark: 'girl' }), eleven);
  assert.deepEqual(sectionRpePolicy({ benchmark: 'hero' }), eleven);
  assert.deepEqual(sectionRpePolicy({ rpe: 'hide' }), hide);
  assert.deepEqual(sectionRpePolicy({ rpe: 8 }), { mode: 'assume', value: 8 });
  assert.deepEqual(sectionRpePolicy({ rpe: 'ask', benchmark: 'girl' }), ask, 'explicit ask overrides benchmark');
  assert.deepEqual(sectionRpePolicy({ rpe: 'hide', benchmark: 'hero' }), hide);
  assert.deepEqual(sectionRpePolicy({ rpe: 12 }), ask, 'invalid falls back to asking');
  assert.equal(rpePolicy(undefined), null);

  assert.deepEqual(sessionRpePolicy({ sections: [{}, {}] }), ask);
  assert.deepEqual(sessionRpePolicy({ sections: [{ benchmark: 'girl' }, { benchmark: 'hero' }] }), eleven, 'all benchmarks');
  assert.deepEqual(sessionRpePolicy({ sections: [{ benchmark: 'girl' }, {}] }), ask, 'mixed day asks');
  assert.deepEqual(sessionRpePolicy({ sections: [] }), ask);
  assert.deepEqual(sessionRpePolicy({ rpe: 'ask', sections: [{ benchmark: 'girl' }] }), ask);
  assert.deepEqual(sessionRpePolicy({ rpe: 'hide', sections: [{}] }), hide);
  assert.deepEqual(sessionRpePolicy({ rpe: 9, sections: [{}] }), { mode: 'assume', value: 9 });
  assert.deepEqual(sessionRpePolicy(fixture), ask, 'the fixture mixes benchmarks with plain blocks');

  assert.ok(showSectionRpe(byLetter('L')) && !showSectionRpe(byLetter('E')) && !showSectionRpe({ rpe: 'hide' }));
  assert.ok(showExerciseRpe({}) && showExerciseRpe({ rpe: 'ask' }));
  assert.ok(!showExerciseRpe({ benchmark: 'girl' }) && !showExerciseRpe({ rpe: 'hide' }) && !showExerciseRpe({ rpe: 7 }));
  assert.ok(showSessionRpe(fixture) && !showSessionRpe({ sections: [{ benchmark: 'hero' }] }));
});

test('session rpe result: assumed carries rpeAssumed, answered never does', () => {
  const allBench = { sections: [{ benchmark: 'girl' }] };
  assert.deepEqual(sessionRpeResult(allBench, '7'), { rpe: 11, rpeAssumed: true });
  assert.deepEqual(sessionRpeResult(fixture, '7'), { rpe: 7 });
  assert.deepEqual(sessionRpeResult(fixture, ''), { rpe: null });
  assert.deepEqual(sessionRpeResult({ rpe: 'hide', sections: [{}] }, '7'), { rpe: null });
  assert.equal(sessionRpeText(allBench, ''), 'RPE 11 (assumed)');
  assert.equal(sessionRpeText(fixture, '8'), 'RPE 8');
  assert.equal(sessionRpeText(fixture, ''), null);
});

test('section-assumed rpe lands in sections[id], not exerciseRpe, and is never mirrored', () => {
  const G = { ...byLetter('E'), id: 'diane' };
  const wod = { sections: [{ ...byLetter('A'), id: 'sec1' }, G] };
  const res = withSections({ rpe: 7, log: {} }, wod, {});
  assert.equal(res.sections.diane.rpe, 11);
  assert.equal(res.sections.diane.rpeAssumed, true);
  assert.equal(res.rpe, 7, 'top-level rpe stays the session answer');
  assert.ok(!('rpeAssumed' in res), 'the mirror does not copy rpe / rpeAssumed');
  assert.ok('score' in res, 'the mirror still copies score');
  assert.deepEqual(sectionNotesAndRpe(wod, {}, { diane: 9 }).exerciseRpe, {});

  // An unscored, round-less section with an assumed RPE still gets an entry.
  const plain = { id: 'x', rpe: 6, exercises: [mv] };
  assert.ok(usesFormatFeatures(plain));
  assert.deepEqual(buildSectionResult(plain, null), { rpe: 6, rpeAssumed: true });
  // "hide" records nothing.
  assert.equal(buildSectionResult({ rpe: 'hide', exercises: [mv] }, null), null);
  // L is untagged: no rpe in its entry.
  assert.ok(!('rpe' in buildSectionResult(byLetter('L'), null)));
});

test('rpe / benchmark validation', () => {
  const p = sec => validateFormat(sec).problems.join('\n');
  const w = sec => validateFormat(sec).warnings.join('\n');
  const scored = { format: { type: 'for_time', score: 'time' }, exercises: [mv] };
  assert.match(p({ ...scored, rpe: 'sometimes' }), /rpe: "sometimes" is not/);
  assert.match(p({ ...scored, rpe: 12 }), /rpe: 12 is not/);
  assert.match(p({ ...scored, rpe: 0 }), /rpe: 0 is not/);
  assert.match(p({ ...scored, benchmark: 'legend' }), /benchmark: "legend"/);
  for (const rpe of ['ask', 'hide', 1, 7.5, 11]) assert.equal(p({ ...scored, rpe }), '', String(rpe));
  assert.equal(p({ ...scored, benchmark: 'hero' }) + w({ ...scored, benchmark: 'hero' }), '');
  assert.match(w({ exercises: [mv], benchmark: 'girl' }), /not a scored or rounds block/);
  assert.match(w({ exercises: [mv], rpe: 'hide' }), /not a scored or rounds block/);
  assert.match(w({ format: { type: 'circuit', rounds: 3 }, rounds: [{ movements: [mv] }], benchmark: 'girl' }), /without format.score/);
  assert.deepEqual(validatePlanRpe({ rpe: 'ask' }).problems, []);
  assert.deepEqual(validatePlanRpe({}).problems, []);
  assert.match(validatePlanRpe({ rpe: 'often' }).problems[0], /^rpe: "often"/);
});

/* ── fixture + legacy ────────────────────────────────────────── */

test('fixture benchmarks are tagged as specified', () => {
  const tags = Object.fromEntries(fixture.sections.map(s => [s.name[0], s.benchmark || null]));
  assert.deepEqual(tags, {
    A: null, B: null, C: null, D: null, E: 'girl', F: 'girl', G: 'girl',
    H: 'girl', I: 'girl', J: 'girl', K: 'hero', L: null
  });
});

test('wodin validate: every example passes with no warnings', () => {
  const dir = fileURLToPath(new URL('examples/', root));
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => dir + f);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('cli/wodin.mjs', root)), 'validate', ...files], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr.trim(), '', 'no warnings');
});

test('legacy examples behave exactly as before', () => {
  for (const f of ['athlete-1.json', 'athlete-a.json', 'minimal.json', 'routine-2-back-biceps.json']) {
    const wod = JSON.parse(readFileSync(new URL('examples/' + f, root), 'utf8'));
    assert.deepEqual(sessionRpePolicy(wod), { mode: 'ask' }, f);
    for (const sec of wod.sections) {
      assert.ok(!isDerivedRounds(sec) && !isRoundsSection(sec), `${f}: ${sec.name}`);
      assert.deepEqual(sectionRpePolicy(sec), { mode: 'ask' });
      assert.equal(usesFormatFeatures(sec), false);
    }
    const base = { rpe: 6, log: {} };
    assert.equal(withSections(base, wod, {}), base, `${f}: result shape unchanged`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  expandRounds, roundScheme, describeFormat, formatBwMult, describePartition,
  seedRoundState, setRoundDone, setMovementDone, roundDone, firstOpenRound,
  seedSectionState, togglePill, buildScore, buildSectionResult, withSections,
  sectionNotesAndRpe, roundSummary, digestSectionLines, validateFormat,
  hasBlockFooter, usesFormatFeatures
} from '../src/format.js';

const fixture = JSON.parse(readFileSync(new URL('../examples/format-test.json', import.meta.url), 'utf8'));
const byLetter = l => fixture.sections.find(s => s.name.startsWith(l + ' '));

test('Diane: per-round reps override rep-based movements and give a scheme', () => {
  const sec = byLetter('G');
  const r = expandRounds(sec);
  assert.equal(r.length, 3);
  assert.deepEqual(r.map(x => x.movements.map(m => m.reps)), [[21, 21], [15, 15], [9, 9]]);
  assert.equal(r[1].movements[0].load, 225, 'load carries into copied rounds');
  assert.equal(roundScheme(sec), '21-15-9');
  assert.equal(describeFormat({ ...sec, type: 'conditioning' }).eyebrow, 'CONDITIONING · FOR TIME · 21-15-9');
});

test('Helen: bare repeat adds n copies, cardio untouched, cap in the line', () => {
  const sec = byLetter('H');
  const r = expandRounds(sec);
  assert.equal(r.length, 3);
  assert.equal(r[2].movements[0].distance, 400);
  const d = describeFormat(sec);
  assert.equal(d.eyebrow, 'CONDITIONING · FOR TIME · 3 ROUNDS');
  assert.equal(d.line, 'Cap 15:00');
  assert.equal(roundSummary(r[0]), 'Run 400 m · Kettlebell swing 53 × 21 · Pull-up 12');
});

test('a round with reps and repeat is that round plus n copies', () => {
  const sec = { rounds: [{ reps: 5, repeat: 2, movements: [{ movement: 'Bodyweight push-up', kind: 'reps', reps: 99 }] }] };
  assert.deepEqual(expandRounds(sec).map(r => r.movements[0].reps), [5, 5, 5]);
});

test('Barbara pads to format.rounds; header shows rest', () => {
  const sec = byLetter('K');
  assert.equal(expandRounds(sec).length, 5);
  assert.equal(describeFormat(sec).line, 'Rest 3:00 between rounds');
});

test('AMRAP is never padded or split into per-round state', () => {
  const sec = { ...byLetter('I'), format: { ...byLetter('I').format, rounds: 5 } };
  assert.equal(expandRounds(sec).length, 1);
  assert.deepEqual(seedRoundState(sec), []);
  assert.equal(describeFormat(byLetter('I')).eyebrow, 'CONDITIONING · AMRAP');
});

test('Linda: scheme over ten rounds and BW multiples', () => {
  const sec = byLetter('M');
  assert.equal(roundScheme(sec), '10-9-8-7-6-5-4-3-2-1');
  assert.equal(formatBwMult(1.5), '1.5× BW');
  assert.equal(formatBwMult(1.0), '1× BW');
  assert.equal(roundSummary(expandRounds(sec)[9]).split(' · ')[0], 'Barbell deadlift 1.5× BW × 1');
  // The ratio is the prescription; the athlete's actual load starts blank.
  assert.equal(seedRoundState(sec)[0].movements[0].load, '');
});

test('format lines for tabata and emom pairs', () => {
  assert.equal(describeFormat(byLetter('D')).line, '20s work / 10s rest × 8');
  const f = describeFormat(byLetter('F'));
  assert.deepEqual(f.parts, ['Every 1:00 for 10 min', 'Alternating A / B each interval']);
  assert.equal(describeFormat(byLetter('A')), null);
});

test('partition hints', () => {
  assert.equal(describePartition('free'), 'Partition as needed');
  assert.equal(describePartition('unbroken'), 'Unbroken');
  assert.equal(describePartition({ max: 10 }), 'Max 10 per set');
  assert.equal(describePartition(undefined), null);
});

test('round check rule holds both ways', () => {
  const [r] = seedRoundState(byLetter('H'));
  assert.equal(roundDone(r), false);
  const all = setRoundDone(r, true);
  assert.ok(all.done && all.movements.every(m => m.done));
  const one = setMovementDone(all, 1, false);
  assert.equal(one.done, false);
  assert.equal(roundDone(one), false);
  let step = r;
  for (let j = 0; j < r.movements.length; j++) step = setMovementDone(step, j, true);
  assert.equal(step.done, true);
  assert.equal(r.done, false, 'helpers do not mutate');
  assert.equal(firstOpenRound([all, one]), 1);
});

test('saved round state survives only where it still lines up', () => {
  const sec = byLetter('G');
  const saved = seedRoundState(sec).map(r => setRoundDone(r, true));
  saved[1].movements.pop();
  const merged = seedRoundState(sec, saved);
  assert.deepEqual(merged.map(r => r.done), [true, false, true]);
});

test('scores: blank is null, keypad digits become a clock', () => {
  const G = byLetter('G'), I = byLetter('I'), N = byLetter('N');
  assert.equal(buildScore(G, { time: '' }), null);
  assert.deepEqual(buildScore(G, { time: '841' }), { time: '8:41', timeSec: 521 });
  assert.deepEqual(buildScore(I, { rounds: '18', reps: '7' }), { rounds: 18, reps: 7 });
  assert.deepEqual(buildScore(I, { rounds: '5', reps: '' }), { rounds: 5, reps: 0 });
  assert.deepEqual(buildScore(N, { totalReps: '74' }), { totalReps: 74 });
  assert.equal(buildScore(byLetter('D'), { time: '1:00' }), null, 'score none is never scored');
});

test('section result: optional on-only, modifiers all, rounds with movements', () => {
  const G = byLetter('G');
  let st = seedSectionState(G);
  st = togglePill(st, 'optional', 'pike');
  st.rounds = st.rounds.map(r => setRoundDone(r, true));
  st.score.time = '8:41';
  const res = buildSectionResult(G, st);
  assert.deepEqual(res.optional, { pike: true });
  assert.deepEqual(res.score, { time: '8:41', timeSec: 521 });
  assert.equal(res.rounds.length, 3);
  assert.deepEqual(res.rounds[2].movements[0], { movement: 'Barbell deadlift', done: true, load: 225, reps: 9 });

  const O = byLetter('O');
  assert.deepEqual(buildSectionResult(O, seedSectionState(O)).modifiers, { vest: false });
  assert.equal(buildSectionResult(byLetter('A'), null), null);
  assert.equal(buildSectionResult(byLetter('I'), seedSectionState(byLetter('I'))).rounds, undefined);
});

test('withSections mirrors only when exactly one section has an entry', () => {
  const G = { ...byLetter('G'), id: 'sec7' };
  const one = withSections({ log: {} }, { sections: [{ ...byLetter('A'), id: 'sec1' }, G] }, {});
  assert.deepEqual(Object.keys(one.sections), ['sec7']);
  assert.equal(one.score, null);
  assert.deepEqual(one.optional, {});
  assert.equal(one.rounds.length, 3);

  const two = withSections({ log: {} }, { sections: [G, { ...byLetter('H'), id: 'sec8' }] }, {});
  assert.equal(Object.keys(two.sections).length, 2);
  assert.ok(!('score' in two) && !('rounds' in two));

  const none = { log: {} };
  assert.equal(withSections(none, { sections: [byLetter('A')] }, {}), none);
});

test('block notes and RPE key by section id, only for footer sections', () => {
  const wod = { sections: [{ ...byLetter('A'), id: 'sec1' }, { ...byLetter('G'), id: 'sec7' }] };
  const out = sectionNotesAndRpe(wod, { sec1: 'x', sec7: ' grip went ' }, { sec1: 9, sec7: '8' });
  assert.deepEqual(out, { notes: { sec7: 'grip went' }, exerciseRpe: { sec7: 8 } });
  assert.ok(hasBlockFooter(byLetter('J')) && !hasBlockFooter(byLetter('F')));
  assert.ok(usesFormatFeatures(byLetter('O')) && !usesFormatFeatures(byLetter('D')));
});

test('digest lines', () => {
  const G = byLetter('G');
  let st = togglePill(seedSectionState(G), 'optional', 'pike');
  st.rounds[0] = setRoundDone(st.rounds[0], true);
  st.rounds[1] = setMovementDone(st.rounds[1], 0, true);
  st.score.time = '8:41';
  const lines = digestSectionLines(G, st, { rpe: 9, note: 'ok' });
  assert.deepEqual(lines, [
    '  Scaled  Pike push-ups',
    '  Round 1  ✓ Barbell deadlift 225×21 · Handstand push-up 21',
    '  Round 2  ✓ Barbell deadlift 225×15 · ○ Handstand push-up 15',
    '  Round 3  ○ Barbell deadlift 225×9 · Handstand push-up 9',
    '  Score  8:41',
    '  RPE  9',
    '  ↳ ok'
  ]);
});

test('the fixture validates with no problems', () => {
  fixture.sections.forEach((sec, i) => {
    assert.deepEqual(validateFormat(sec, `sections[${i}]`).problems, [], sec.name);
  });
});

test('validator problems and warnings', () => {
  const p = sec => validateFormat(sec).problems;
  const w = sec => validateFormat(sec).warnings;
  const mv = { movement: 'Bodyweight push-up', kind: 'reps', reps: 5 };

  assert.match(p({ name: 'x' })[0], /needs exercises or rounds/);
  assert.match(p({ name: 'x', exercises: [], rounds: undefined }).join(), /needs exercises or rounds/);
  assert.match(p({ format: { type: 'wod' }, rounds: [{ movements: [mv] }] }).join(), /type "wod"/);
  assert.match(p({ format: { type: 'amrap', score: 'best' }, rounds: [{ movements: [mv] }] }).join(), /score "best"/);
  assert.match(p({ format: { type: 'emom', intervalSec: 0 }, rounds: [{ movements: [mv] }] }).join(), /intervalSec/);
  assert.match(p({ rounds: [] }).join(), /non-empty/);
  assert.match(p({ rounds: [{ reps: 3 }] }).join(), /first round needs movements/);
  assert.match(p({ rounds: [{ movements: [{ movement: 'Row' }] }] }).join(), /missing kind/);
  assert.match(p({ rounds: [{ movements: [{ ...mv, kind: 'lift' }] }] }).join(), /kind "lift"/);
  assert.match(p({ rounds: [{ movements: [{ ...mv, kind: 'weight_reps', load: 0 }] }] }).join(), /load 0/);
  assert.match(p({ rounds: [{ movements: [{ ...mv, loadBwMult: 0 }] }] }).join(), /loadBwMult/);
  assert.match(p({ rounds: [{ movements: [mv] }], optional: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }).join(), /duplicate id/);
  assert.match(p({ rounds: [{ movements: [mv] }], modifiers: [{ label: 'Vest' }] }).join(), /missing id/);
  assert.match(p({ exercises: [{ ...mv, intervalSlot: 'C', sets: [{}] }] }).join(), /intervalSlot/);
  assert.match(p({ exercises: [{ ...mv, partition: { max: 0 }, sets: [{}] }] }).join(), /partition/);
  assert.match(p({ exercises: [{ ...mv, sets: [{ loadBwMult: -1 }] }] }).join(), /loadBwMult/);

  assert.match(w({ format: { type: 'for_time', rounds: 2 }, rounds: [{ movements: [mv] }, { repeat: 2 }] }).join(), /expands to 3/);
  assert.ok(!w(byLetter('K')).some(x => /expands to/.test(x)), 'padding up to format.rounds is intended, not a warning');
  assert.match(w({ format: { type: 'emom' }, exercises: [{ ...mv, sets: [{}] }] }).join(), /emom without intervalSec/);
  assert.match(w({ format: { type: 'tabata' }, exercises: [{ ...mv, sets: [{}] }] }).join(), /tabata without workSec/);
  assert.match(w({ format: { type: 'for_time' }, exercises: [{ ...mv, intervalSlot: 'A', sets: [{}] }] }).join(), /only means something in an emom/);
  assert.match(w({ format: { type: 'for_time', score: 'total_reps' }, exercises: [{ ...mv, sets: [{}] }] }).join(), /did you mean amrap/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  seedSectionState, checkRound, checkMovement, setMovementValue, setScoreValue,
  roundIsOpen, splitRef, repeatCaption, rxText, roundDone, buildSectionResult
} from '../src/format.js';

const fixture = JSON.parse(readFileSync(new URL('../examples/format-test.json', import.meta.url), 'utf8'));
const byLetter = l => fixture.sections.find(s => s.name.startsWith(l + ' '));

test('checkMovement: last tick closes the round, un-ticking one reopens it', () => {
  const sec = byLetter('H');
  let st = seedSectionState(sec);
  st = checkMovement(st, 0, 0, true);
  st = checkMovement(st, 0, 1, true);
  assert.equal(roundDone(st.rounds[0]), false);
  st = checkMovement(st, 0, 2, true);
  assert.equal(st.rounds[0].done, true);
  st = checkMovement(st, 0, 1, false);
  assert.equal(st.rounds[0].done, false);
  assert.equal(roundDone(st.rounds[0]), false);
});

test('checkRound sets every movement, both directions, without touching other rounds', () => {
  const sec = byLetter('G');
  const before = seedSectionState(sec);
  const on = checkRound(before, 1, true);
  assert.ok(on.rounds[1].movements.every(m => m.done));
  assert.equal(on.rounds[0].done, false);
  assert.equal(before.rounds[1].done, false, 'input state is not mutated');
  const off = checkRound(on, 1, false);
  assert.ok(off.rounds[1].movements.every(m => !m.done));
});

test('check helpers ignore out-of-range indices', () => {
  const st = seedSectionState(byLetter('G'));
  assert.equal(checkRound(st, 9, true), st);
  assert.equal(checkMovement(st, 0, 9, true), st);
  assert.equal(setMovementValue(st, 9, 0, 'reps', '5'), st);
});

test('setMovementValue and setScoreValue land in the result', () => {
  const sec = byLetter('G');
  let st = seedSectionState(sec);
  st = setMovementValue(st, 0, 0, 'load', '185');
  st = setScoreValue(st, 'time', '8:41');
  const r = buildSectionResult(sec, st);
  assert.equal(r.rounds[0].movements[0].load, 185);
  assert.equal(r.rounds[1].movements[0].load, 225, 'other rounds keep the prescription');
  assert.deepEqual(r.score, { time: '8:41', timeSec: 521 });
});

test('roundIsOpen: first not-done round by default, an explicit tap wins', () => {
  let st = seedSectionState(byLetter('K')).rounds;
  assert.equal(roundIsOpen(st, 0), true);
  assert.equal(roundIsOpen(st, 1), false);
  assert.equal(roundIsOpen(st, 1, true), true);
  assert.equal(roundIsOpen(st, 0, false), false);
  const sec = seedSectionState(byLetter('K'));
  st = checkRound(sec, 0, true).rounds;
  assert.equal(roundIsOpen(st, 0), false);
  assert.equal(roundIsOpen(st, 1), true);
});

test('splitRef takes indices from the end so ids may contain colons', () => {
  assert.deepEqual(splitRef('sec7:2:1', 2), ['sec7', 2, 1]);
  assert.deepEqual(splitRef('a:b:3', 1), ['a:b', 3]);
  assert.equal(splitRef('sec7:x', 1), null);
  assert.equal(splitRef(':3', 1), null);
  assert.equal(splitRef('sec7', 1), null);
  assert.equal(splitRef(undefined, 1), null);
});

test('repeatCaption and rxText for the AMRAP template', () => {
  assert.equal(repeatCaption(byLetter('I')), 'Repeat for 20 min');
  assert.equal(repeatCaption({ format: { type: 'amrap', capSec: 450 } }), 'Repeat for 7:30');
  assert.equal(repeatCaption({ format: { type: 'amrap' } }), null);
  const [run, pull] = byLetter('N').rounds[0].movements;
  assert.equal(rxText(run), '400 m');
  assert.equal(rxText(pull), 'max reps');
  assert.equal(rxText({ kind: 'reps', reps: 5 }), '5 reps');
  assert.equal(rxText({ kind: 'weight_reps', reps: 21, load: 53 }), '53 × 21');
});

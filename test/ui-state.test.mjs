import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  seedSectionState, checkRound, checkMovement, setMovementValue, setScoreValue,
  roundIsOpen, splitRef, repeatCaption, rxText, roundDone, buildSectionResult,
  isDerivedRounds, expandRounds, isAutoFormatField, timeFormatterFor, fmtClock, parseClock
} from '../src/format.js';

const fixture = JSON.parse(readFileSync(new URL('../examples/format-test.json', import.meta.url), 'utf8'));
const byLetter = l => fixture.sections.find(s => s.name.startsWith(l + ' '));

test('checkMovement: last tick closes the round, un-ticking one reopens it', () => {
  const sec = byLetter('F');
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
  const sec = byLetter('E');
  const before = seedSectionState(sec);
  const on = checkRound(before, 1, true);
  assert.ok(on.rounds[1].movements.every(m => m.done));
  assert.equal(on.rounds[0].done, false);
  assert.equal(before.rounds[1].done, false, 'input state is not mutated');
  const off = checkRound(on, 1, false);
  assert.ok(off.rounds[1].movements.every(m => !m.done));
});

test('check helpers ignore out-of-range indices', () => {
  const st = seedSectionState(byLetter('E'));
  assert.equal(checkRound(st, 9, true), st);
  assert.equal(checkMovement(st, 0, 9, true), st);
  assert.equal(setMovementValue(st, 9, 0, 'reps', '5'), st);
});

test('setMovementValue and setScoreValue land in the result', () => {
  const sec = byLetter('E');
  let st = seedSectionState(sec);
  st = setMovementValue(st, 0, 0, 'load', '185');
  st = setScoreValue(st, 'time', '8:41');
  const r = buildSectionResult(sec, st);
  assert.equal(r.rounds[0].movements[0].load, 185);
  assert.equal(r.rounds[1].movements[0].load, 225, 'other rounds keep the prescription');
  assert.deepEqual(r.score, { time: '8:41', timeSec: 521 });
});

test('roundIsOpen: first not-done round by default, an explicit tap wins', () => {
  let st = seedSectionState(byLetter('G')).rounds;
  assert.equal(roundIsOpen(st, 0), true);
  assert.equal(roundIsOpen(st, 1), false);
  assert.equal(roundIsOpen(st, 1, true), true);
  assert.equal(roundIsOpen(st, 0, false), false);
  const sec = seedSectionState(byLetter('G'));
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
  assert.equal(repeatCaption(byLetter('H')), 'Repeat for 20 min');
  assert.equal(repeatCaption({ format: { type: 'amrap', capSec: 450 } }), 'Repeat for 7:30');
  assert.equal(repeatCaption({ format: { type: 'amrap' } }), null);
  const [run, pull] = byLetter('I').rounds[0].movements;
  assert.equal(rxText(run), '400 m');
  assert.equal(rxText(pull), 'max reps');
  assert.equal(rxText({ kind: 'reps', reps: 5 }), '5 reps');
  assert.equal(rxText({ kind: 'weight_reps', reps: 21, load: 53 }), '53 × 21');
});

test('derived emom rounds carry the A / B slot the page draws as a chip', () => {
  const F = byLetter('D');
  assert.ok(isDerivedRounds(F));
  const rounds = expandRounds(F);
  assert.equal(rounds.length, 10);
  assert.deepEqual(rounds[0].movements.map(m => m.intervalSlot), ['A', 'B']);
  assert.ok(!isDerivedRounds(byLetter('B')) && !isDerivedRounds(byLetter('K')), 'chippers and intervals keep set rows');
});

test('inputmode: numeric exactly for the fields that write their own colons', () => {
  for (const p of ['duration', 'pace', 'score-time']) assert.ok(isAutoFormatField(p), p);
  for (const p of ['f-duration', 'load', 'reps', 'distance', 'score-rounds', 'score-totalReps']) {
    assert.ok(!isAutoFormatField(p), p);
  }
  assert.equal(timeFormatterFor('duration')('841'), '8:41');
  assert.equal(timeFormatterFor('score-time')('12542'), '1:25:42');
  assert.equal(timeFormatterFor('pace')('158'), '1:58');
});

/* Session duration (f-duration): same digit pad and auto colons as the score time */

const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('session duration: numeric keypad, formatted as typed, not hard-coded to text', () => {
  const fld = mainSrc.match(/field\(\{\s*id: 'f-duration'[\s\S]*?\}\)/)[0];
  assert.match(fld, /mode: timeMode\('duration'\)/);
  assert.doesNotMatch(fld, /mode: 'text'/);
  // The mode comes from the shared list, so it resolves to numeric.
  assert.ok(isAutoFormatField('duration'));
  assert.match(mainSrc, /const timeMode = \(prop, otherwise\) => isAutoFormatField\(prop\) \? 'numeric' : otherwise;/);
  // Input handler formats through the shared keypadTime, and stores the formatted string.
  assert.match(mainSrc, /id === 'f-duration'\) \{ S\.duration = keypadTime\(el, 'duration'\); return save\(\); \}/);
  const f = timeFormatterFor('duration');
  for (const [typed, want] of [['8', '8'], ['84', '84'], ['841', '8:41'], ['8410', '84:10'],
                               ['12542', '1:25:42'], ['125412', '12:54:12'], ['1254123', '12:54:12']]) {
    assert.equal(f(typed), want, typed);
  }
});

test('session duration: listeners stay bound once, outside render()', () => {
  assert.equal((mainSrc.match(/id === 'f-duration'/g) || []).length >= 1, true);
  const render = mainSrc.slice(mainSrc.indexOf('function renderWorkout'), mainSrc.indexOf('function bind()'));
  assert.doesNotMatch(render, /addEventListener/);
  assert.equal((mainSrc.match(/addEventListener\('input'/g) || []).length, 1);
});

/* An unreadable #w= / #wj= / #id= hash stays on the library, not only in a toast. */

test('unreadable hash: sticky library banner, dismiss clears the hash, a workout clears it', () => {
  assert.match(mainSrc, /let libraryHashError = null/);
  assert.match(mainSrc, /The link in the address bar could not be read — it was likely cut short or corrupted\. Paste a fresh Copy Link below, or dismiss\./);

  const resolve = mainSrc.slice(
    mainSrc.indexOf('async function resolveWod'),
    mainSrc.indexOf('async function route')
  );
  assert.match(resolve, /\/\^#\(w\|wj\|id\)=\//);
  assert.match(resolve, /libraryHashError = LIBRARY_HASH_ERROR/);
  assert.match(resolve, /toast\("That link's workout could not be read"\)/);

  const renderLib = mainSrc.slice(
    mainSrc.indexOf('function renderLibrary'),
    mainSrc.indexOf('function pasteProblem')
  );
  const view = renderLib.slice(renderLib.indexOf("$('app').innerHTML"));
  const headerAt = view.indexOf('<header>');
  const bannerAt = view.indexOf('library-error');
  const listAt = view.indexOf('class="lib"');
  assert.ok(headerAt >= 0 && bannerAt > headerAt && listAt > bannerAt, 'banner sits after the header and before the list');
  assert.match(view, /libraryHashError/);
  assert.match(view, /data-dismiss-hash-error/);

  const bind = mainSrc.slice(mainSrc.indexOf('function bind()'), mainSrc.indexOf("app.addEventListener('change'"));
  const dismiss = bind.match(/if \(e\.target\.closest\('\[data-dismiss-hash-error\]'\)\) \{[\s\S]*?\n    \}/);
  assert.ok(dismiss, 'dismiss handler is in the click delegate');
  assert.match(dismiss[0], /libraryHashError = null/);
  assert.match(dismiss[0], /location\.hash = ''/);
  assert.match(dismiss[0], /return route\(\)/);

  const route = mainSrc.slice(mainSrc.indexOf('async function route()'), mainSrc.indexOf('async function shareWod'));
  const opened = route.slice(route.indexOf('if (!wod)'));
  assert.ok(opened.indexOf('renderLibrary()') < opened.indexOf('libraryHashError = null'));

  const paste = mainSrc.slice(mainSrc.indexOf('async function openPastedLink'), mainSrc.indexOf('function pasteLink'));
  const openedPaste = paste.slice(paste.indexOf("pasteProblem('')"));
  assert.match(openedPaste, /libraryHashError = null/);
});

test('session duration: values already stored or filled by the timer load and save unchanged', () => {
  // The page timer fills the box with fmtClock output; the formatter must leave that alone,
  // so re-saving an untouched value (or editing next to it) never rewrites it.
  for (const sec of [0, 5, 59, 60, 61, 599, 702, 3599, 3600, 3725, 5142, 43200, 359999]) {
    const shown = fmtClock(sec);
    assert.equal(timeFormatterFor('duration')(shown), shown, shown);
    assert.equal(parseClock(shown), sec, shown);
  }
  // Values the examples and older logs hold are hh:mm:ss / mm:ss and survive too.
  for (const v of ['45:00', '1:00', '5:00', '1:05:00', '0:45', '12:30:15']) {
    assert.equal(timeFormatterFor('duration')(v), v, v);
  }
  // And the typed form lands on the same string a stored value would have, same seconds.
  assert.equal(timeFormatterFor('duration')('12542'), fmtClock(5142));
  assert.equal(parseClock(timeFormatterFor('duration')('841')), 521);
});

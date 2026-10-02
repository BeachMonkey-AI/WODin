import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  timerState, normaliseTimer, timerElapsedMs, timerStart, timerPause, timerReset, timerSetMs,
  seedSectionState, buildSectionResult, fmtClock, parseClock
} from '../src/format.js';

const fixture = JSON.parse(readFileSync(new URL('../examples/format-test.json', import.meta.url), 'utf8'));
const byLetter = l => fixture.sections.find(s => s.name.startsWith(l + ' '));

const T0 = 1_700_000_000_000;

test('timerState is stopped at zero', () => {
  assert.deepEqual(timerState(), { running: false, startedAt: null, accMs: 0 });
  assert.equal(timerElapsedMs(timerState(), T0), 0);
  assert.deepEqual(timerReset(), timerState());
});

test('start / pause / resume is computed from timestamps', () => {
  let t = timerStart(timerState(), T0);
  assert.deepEqual(t, { running: true, startedAt: T0, accMs: 0 });
  assert.equal(timerElapsedMs(t, T0 + 65_400), 65_400);

  t = timerPause(t, T0 + 65_400);
  assert.deepEqual(t, { running: false, startedAt: null, accMs: 65_400 });
  assert.equal(timerElapsedMs(t, T0 + 999_999), 65_400, 'paused time does not move');

  t = timerStart(t, T0 + 100_000);
  assert.equal(timerElapsedMs(t, T0 + 110_000), 75_400, 'resume continues from accMs');
  assert.equal(fmtClock(timerElapsedMs(t, T0 + 110_000) / 1000), '1:15', 'seconds floor');
});

test('start from a given time, and a second start without one is a no-op', () => {
  const t = timerStart(timerState(), T0, 521_000);
  assert.equal(timerElapsedMs(t, T0 + 2_000), 523_000);
  assert.deepEqual(timerStart(t, T0 + 5_000), t);
});

test('elapsed never goes negative, even with the clock wound back', () => {
  const t = timerStart(timerState(), T0);
  assert.equal(timerElapsedMs(t, T0 - 60_000), 0);
  assert.equal(timerElapsedMs({ running: false, startedAt: null, accMs: -5 }, T0), 0);
});

test('a typed time overwrites a running timer and stops it', () => {
  const running = timerStart(timerState(), T0);
  const typed = timerSetMs(running, parseClock('8:41') * 1000);
  assert.deepEqual(typed, { running: false, startedAt: null, accMs: 521_000 });
  assert.equal(timerElapsedMs(typed, T0 + 60_000), 521_000);
  // Then Start carries on from the typed value.
  assert.equal(timerElapsedMs(timerStart(typed, T0 + 60_000), T0 + 70_000), 531_000);
  // Blank / unparseable typed time → 0.
  assert.equal(timerSetMs(running, (parseClock('') ?? 0) * 1000).accMs, 0);
  assert.equal(timerSetMs(running, NaN).accMs, 0);
});

test('reset zeroes a running timer', () => {
  const t = timerReset(timerStart(timerState(), T0, 5_000));
  assert.equal(timerElapsedMs(t, T0 + 10_000), 0);
  assert.equal(t.running, false);
});

test('a running timer survives a JSON roundtrip (reload)', () => {
  const sec = byLetter('G');
  const st = { ...seedSectionState(sec), timer: timerStart(timerState(), T0, 30_000) };
  const reloaded = seedSectionState(sec, JSON.parse(JSON.stringify(st)));
  assert.deepEqual(reloaded.timer, st.timer);
  assert.equal(timerElapsedMs(reloaded.timer, T0 + 600_000), 630_000, 'time passed while closed counts');
});

test('seed is tolerant of saved states without a timer, or with a broken one', () => {
  const sec = byLetter('G');
  assert.deepEqual(seedSectionState(sec).timer, timerState());
  assert.deepEqual(seedSectionState(sec, { score: { time: '8:41' } }).timer, timerState());
  assert.equal(seedSectionState(sec, { score: { time: '8:41' } }).score.time, '8:41');
  assert.deepEqual(normaliseTimer({ running: true, startedAt: 'x', accMs: 4_000 }),
    { running: false, startedAt: null, accMs: 4_000 }, 'running without startedAt comes back paused');
  assert.deepEqual(normaliseTimer({ running: 'yes', accMs: 'lots' }), timerState());
  assert.deepEqual(normaliseTimer(null), timerState());
});

test('the timer is UI state only: the result carries score.time, not the timer', () => {
  const sec = byLetter('G');
  const st = { ...seedSectionState(sec), timer: timerPause(timerStart(timerState(), T0), T0 + 521_900) };
  st.score = { ...st.score, time: fmtClock(st.timer.accMs / 1000) };
  const r = buildSectionResult(sec, st);
  assert.deepEqual(r.score, { time: '8:41', timeSec: 521 });
  assert.ok(!('timer' in r));
});

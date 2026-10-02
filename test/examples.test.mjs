// The shipped examples are the schema's teaching material (AGENT.md quotes
// them), so two things must stay true: every schema addition is shown by at
// least one of them, and none of them breaks the naming rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  isDerivedRounds, expandRounds, roundsOf, seedSectionState, buildSectionResult,
  setRoundDone, togglePill, setScoreValue, sectionRpePolicy, hasBlockFooter,
  movementNameWarning, validateFormat
} from '../src/format.js';

const root = new URL('../', import.meta.url);
const dir = fileURLToPath(new URL('examples/', root));
const load = f => JSON.parse(readFileSync(dir + f, 'utf8'));
const fixture = load('format-test.json');
const S = fixture.sections;

const movementsOf = sec => [
  ...(sec.exercises || []),
  ...(sec.rounds || []).flatMap(r => r.movements || [])
];
const some = pred => S.some(pred);

/* One predicate per schema addition. Each must hold for at least one section. */
const COVERAGE = {
  'format block': s => !!s.format,
  'rounds[] hierarchy': s => Array.isArray(s.rounds) && s.rounds.length > 0,
  'per-round reps entry': s => (s.rounds || []).some((r, i) => i > 0 && r.reps && !r.movements),
  'repeat entry': s => (s.rounds || []).some(r => r.repeat),
  'format.rounds padding a short rounds[]': s => s.format?.rounds > 1 && s.rounds?.length === 1 && s.format.type !== 'amrap',
  'restSec between rounds (for_time)': s => s.format?.type === 'for_time' && s.format.restSec > 0,
  'restSec after each interval (tabata)': s => s.format?.type === 'tabata' && s.format.restSec > 0,
  'intervalSlot A/B': s => (s.exercises || []).some(e => e.intervalSlot === 'A') && (s.exercises || []).some(e => e.intervalSlot === 'B'),
  'mixed kinds in a round': s => (s.rounds || []).some(r => new Set((r.movements || []).map(m => m.kind)).size > 1),
  'optional[] scaling pills': s => (s.optional || []).length > 0,
  'modifiers[] add-on pills': s => (s.modifiers || []).length > 0,
  'loadBwMult': s => movementsOf(s).some(m => m.loadBwMult),
  'partition': s => movementsOf(s).some(m => m.partition),
  'capSec': s => s.format?.capSec > 0,
  'score: time (stopwatch)': s => s.format?.score === 'time',
  'score: rounds_reps': s => s.format?.score === 'rounds_reps',
  'score: total_reps': s => s.format?.score === 'total_reps',
  'format: tabata': s => s.format?.type === 'tabata',
  'format: emom': s => s.format?.type === 'emom',
  'format: for_time': s => s.format?.type === 'for_time',
  'format: amrap': s => s.format?.type === 'amrap',
  'format: circuit': s => s.format?.type === 'circuit',
  'derived rounds (tabata)': s => isDerivedRounds(s) && s.format.type === 'tabata',
  'derived rounds (emom)': s => isDerivedRounds(s) && s.format.type === 'emom',
  'benchmark: girl': s => s.benchmark === 'girl',
  'benchmark: hero': s => s.benchmark === 'hero',
  'RPE asked on a rounds block (untagged)': s => hasBlockFooter(s) && sectionRpePolicy(s).mode === 'ask',
  'athlete-filled duration + pace (time fields)': s => (s.exercises || []).some(e => (e.sets || []).some(x => x.athleteFills === 'duration' && x.pace)),
  'athlete-filled reps': s => movementsOf(s).some(m => m.athleteFills === 'reps'),
  'cue carrying a modifier': s => movementsOf(s).some(m => /^(outdoors|bodyweight)/i.test(m.cue || '')),
  'plain strength with tag and cue': s => !s.format && (s.exercises || []).some(e => e.tag && e.cue && e.sets?.length > 1)
};

test('every schema addition is demonstrated by at least one example section', () => {
  for (const [feature, pred] of Object.entries(COVERAGE)) {
    assert.ok(some(pred), `no example section demonstrates: ${feature}`);
  }
});

test('the demonstrations work end to end: round rule, result score/optional/modifiers', () => {
  const diane = S.find(s => /Diane/.test(s.name));
  let st = seedSectionState(diane);
  st = togglePill(st, 'optional', 'pike');
  st = setScoreValue(st, 'time', '8:41');
  st.rounds = st.rounds.map(r => setRoundDone(r, true));
  const res = buildSectionResult(diane, st);
  assert.deepEqual(res.score, { time: '8:41', timeSec: 521 });
  assert.deepEqual(res.optional, { pike: true });
  assert.ok(res.rounds.every(r => r.done && r.movements.every(m => m.done)), 'round rule: round done == all movements done');

  const murph = S.find(s => /Murph/.test(s.name));
  assert.deepEqual(buildSectionResult(murph, seedSectionState(murph)).modifiers, { vest: false });

  const cindy = S.find(s => /Cindy/.test(s.name));
  assert.equal(expandRounds(cindy).length, 1, 'AMRAP is a single template round');
  assert.equal(buildSectionResult(cindy, seedSectionState(cindy)).rounds, undefined);
});

test('example sections stay distinct: no two share a format, scheme and block shape', () => {
  const shape = s => JSON.stringify([
    s.format?.type, s.format?.score, !!s.format?.restSec, !!s.format?.capSec, !!s.format?.rounds,
    !!s.rounds, !!s.exercises, isDerivedRounds(s), !!s.optional, !!s.modifiers, s.benchmark || null,
    roundsOf(s).length > 1, movementsOf(s).some(m => m.loadBwMult), movementsOf(s).some(m => m.partition),
    (s.exercises || []).some(e => e.intervalSlot), movementsOf(s).some(m => m.athleteFills),
    (s.exercises || []).some(e => (e.sets || []).some(x => x.athleteFills || x.rest))
  ]);
  const seen = new Map();
  for (const s of S) {
    const k = shape(s);
    assert.ok(!seen.has(k), `"${s.name}" duplicates the shape of "${seen.get(k)}" — cut one`);
    seen.set(k, s.name);
  }
});

test('the example set is small: every section is a lesson', () => {
  assert.ok(S.length >= 9 && S.length <= 12, `${S.length} sections`);
});

const agentMd = readFileSync(new URL('AGENT.md', root), 'utf8');

test('AGENT.md references only examples that exist, and none that were dropped', () => {
  const named = [...agentMd.matchAll(/\b(Diane|Helen|Cindy|Nicole|Linda|Barbara|Murph|Angie)\b/g)].map(m => m[1]);
  for (const n of new Set(named)) assert.ok(S.some(s => s.name.includes(n)), `AGENT.md mentions ${n}, which is not in the examples`);
  assert.doesNotMatch(agentMd, /fifteen|\bA to O\b|\bA–O\b/i, 'stale count of examples');
});

test('the annotated examples in AGENT.md are the tested example sections, verbatim', () => {
  const strip = obj => { const { name, ...rest } = obj; return rest; };
  const blocks = [...agentMd.matchAll(/```jsonc\n([\s\S]*?)```/g)].map(m => m[1])
    .filter(b => /^\{\n  "name":/.test(b));
  assert.ok(blocks.length >= 8, `${blocks.length} annotated section examples`);
  const matched = new Set();
  for (const b of blocks) {
    const json = b.split('\n').map(l => l.replace(/\s+\/\/.*$/, '')).join('\n');
    const doc = JSON.parse(json);
    const i = S.findIndex(s => isDeepStrictEqual(strip(s), strip(doc)));
    assert.ok(i >= 0, `AGENT.md example "${doc.name}" differs from every section in format-test.json`);
    matched.add(i);
    assert.deepEqual(validateFormat(doc).warnings, [], doc.name);
  }
  assert.equal(matched.size, blocks.length, 'each example shown once');
});

/* ── naming rule ─────────────────────────────────────────────── */

test('movement names carry no modifiers; real equipment stays', () => {
  const bad = ['Outdoor run', 'Bodyweight pull-up', 'Run (outdoors)', 'Indoor row', 'Body-weight squat', 'Pull-up Bodyweight', 'Row 500m'];
  for (const n of bad) assert.ok(movementNameWarning(n), n);
  const good = ['Run', 'Pull-up', 'Push-up', 'Air squat', 'Sit-up', 'Handstand push-up', 'Barbell deadlift',
    'Kettlebell swing', 'Dumbbell row', 'Rowing machine row', 'Weighted pull-up', 'Box jump'];
  for (const n of good) assert.equal(movementNameWarning(n), null, n);
  assert.match(movementNameWarning('Outdoor run'), /into cue/);
});

test('every movement in every example has a plain name', () => {
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    for (const sec of load(f).sections) {
      for (const m of movementsOf(sec)) assert.equal(movementNameWarning(m.movement), null, `${f}: ${m.movement}`);
    }
  }
});

test('modifier cues survive derivation into round movements', () => {
  const emom = S.find(s => s.format?.type === 'emom');
  const withCue = roundsOf(emom)[0].movements.find(m => m.cue);
  assert.match(withCue.cue, /Bodyweight/);
  assert.equal(validateFormat(emom).warnings.length, 0);
});

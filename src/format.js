/* WODin — section formats and rounds. Pure logic, no DOM.
 *
 * Kept apart from main.js so node's test runner and the CLI validator can
 * import exactly what the page runs — one definition of "what does round 3 of
 * this plan contain" rather than three that drift. `wodin render` inlines this
 * file into the standalone HTML, so it must stay dependency-free and must not
 * import anything itself.
 *
 * Vocabulary, matching the plan schema:
 *   format    — how a section is run and scored: tabata, emom, for_time, …
 *   rounds[]  — the plan's compact round list ({ reps }, { repeat } shorthands)
 *   expanded  — that list unrolled into one concrete round per round performed
 *   movement  — one line inside a round; flat, no sets[]
 */

export const FORMAT_TYPES = ['tabata', 'emom', 'intervals', 'for_time', 'amrap', 'circuit'];
export const SCORE_TYPES = ['time', 'rounds_reps', 'total_reps', 'none'];
export const KINDS = ['weight_reps', 'reps', 'time', 'cardio', 'carry'];

// A round's `reps` rewrites these and leaves the rest alone: "21-15-9" means
// 21 deadlifts, not a 21-metre run.
export const REP_KINDS = ['reps', 'weight_reps', 'carry'];

const FORMAT_LABEL = {
  tabata: 'Tabata', emom: 'EMOM', intervals: 'Intervals',
  for_time: 'For time', amrap: 'AMRAP', circuit: 'Circuit'
};

const SCORE_LABEL = { time: 'Finish time', rounds_reps: 'Rounds + reps', total_reps: 'Total reps' };

const DEFAULT_UNITS = { load: 'lb', distance: 'm' };
const unitsOf = units => ({ ...DEFAULT_UNITS, ...(units || {}) });

/* ── small value helpers ─────────────────────────────────────── */

const blank = v => v === '' || v === null || v === undefined;
const isPosNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isPosInt = v => Number.isInteger(v) && v > 0;

// Same coercion the existing log uses: a number when it reads as one, the raw
// string when the athlete typed something else, null when left blank.
export const num = v => blank(v) ? null : (isNaN(Number(v)) ? v : Number(v));

/** 702 → "11:42", 3725 → "1:02:05". */
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** "11:42" → 702. Null for blank or unparseable, never NaN. */
export function parseClock(str) {
  if (blank(str)) return null;
  const p = String(str).trim().split(':').map(Number);
  if (p.some(n => isNaN(n))) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2]
       : p.length === 2 ? p[0] * 60 + p[1]
       : p[0];
}

/* ── keypad time entry ───────────────────────────────────────── */

// Leading zeros only pad the leading group: "0841" is 8:41, but a bare "05"
// is still being typed and stays put. Never below `min` digits, so "000"
// is "0:00", not ":00".
const trimZeros = (d, min) => d.replace(new RegExp(`^0+(?=\\d{${min}})`), '');

/**
 * Digits as typed on a numeric keypad → a clock, while they are typed:
 * "841" → "8:41", "1254" → "12:54", "12542" → "1:25:42". Non-digits are
 * dropped first, so a colon typed on a keyboard that has one is harmless.
 * Capped at six digits (h:mm:ss, hours up to 99). Pure; main.js applies it on
 * input and buildScore applies it to a score typed without colons.
 */
export function fmtTimeDigits(raw) {
  let d = String(raw ?? '').replace(/\D/g, '').slice(0, 6);
  if (d.length <= 2) return d;
  d = trimZeros(d, 3);
  if (d.length <= 4) return d.slice(0, -2) + ':' + d.slice(-2);
  return d.slice(0, -4) + ':' + d.slice(-4, -2) + ':' + d.slice(-2);
}

/** Same for a pace — m:ss only, four digits at most, since a pace has no hours. */
export function fmtPaceDigits(raw) {
  let d = String(raw ?? '').replace(/\D/g, '').slice(0, 4);
  if (d.length <= 2) return d;
  d = trimZeros(d, 3);
  return d.slice(0, -2) + ':' + d.slice(-2);
}

/* Which fields insert their own colons, keyed by the field's data-prop
 * ("score-time" is the score box's time). These take inputmode="numeric":
 * commit 60483d8 moved time fields to inputmode="text" because Android's
 * numeric keypad has no colon key, but a field that writes its own colons
 * never needs one, and the digit pad is the faster keyboard at the rack.
 * The session duration (f-duration) is one of them, under the key 'duration':
 * the page timer still fills it with a plain clock string, which the formatter
 * leaves as it is, and typing in it gets the same digit pad and auto colons. */
export const AUTO_FORMAT_FIELDS = ['duration', 'pace', 'score-time'];
export const isAutoFormatField = prop => AUTO_FORMAT_FIELDS.includes(prop);

/** The formatter for an auto-format field, or null when the field has none. */
export const timeFormatterFor = prop =>
  prop === 'pace' ? fmtPaceDigits : isAutoFormatField(prop) ? fmtTimeDigits : null;

/** A rest or work span as people say it: 20 → "20s", 180 → "3:00". */
export function fmtSpan(sec) {
  return sec < 60 ? `${sec}s` : fmtClock(sec);
}

/** 1.5 → "1.5× BW". The multiplier is the prescription; the load field
 *  stays free for the absolute number the athlete actually lifted. */
export function formatBwMult(mult) {
  return `${Number(mult)}× BW`;
}

/** The hint drawn under a movement name, or null when there is none. */
export function describePartition(p) {
  if (p === 'free') return 'Partition as needed';
  if (p === 'unbroken') return 'Unbroken';
  if (p && typeof p === 'object' && isPosInt(p.max)) return `Max ${p.max} per set`;
  return null;
}

export const formatLabel = type => FORMAT_LABEL[type] || type;
export const scoreLabel = score => SCORE_LABEL[score] || null;

/* ── what kind of section is this? ───────────────────────────── */

export const isAmrap = sec => sec?.format?.type === 'amrap';

// Formats whose exercises become rounds when format.rounds says how many. A
// tabata or EMOM is the same short list done N times, so writing N rounds by
// hand would be pure repetition. Chippers (for_time + exercises, e.g. Murph)
// and intervals stay exercise-based: their sets are the record.
const DERIVED_FORMATS = ['tabata', 'emom'];

// Round-movement fields copied from an exercise's first set.
const SET_FIELDS = ['reps', 'load', 'loadType', 'loadBwMult', 'distance', 'distanceUnit', 'duration', 'pace', 'athleteFills'];
const EXERCISE_FIELDS = ['tag', 'cue', 'link', 'partition', 'intervalSlot'];

/** True when the section's rounds are synthesized from its exercises: an emom
 *  or tabata with a positive format.rounds, exercises, and no rounds[] of its own. */
export function isDerivedRounds(sec) {
  return !!sec && !(Array.isArray(sec.rounds) && sec.rounds.length) &&
    DERIVED_FORMATS.includes(sec.format?.type) && isPosInt(sec.format?.rounds) &&
    Array.isArray(sec.exercises) && sec.exercises.length > 0;
}

/**
 * The section's effective rounds[]: its own when written, otherwise — for a
 * derived emom / tabata — ONE template round with a movement per exercise,
 * taken from that exercise's first set. expandRounds' format.rounds padding
 * then makes it N rounds, so "8 rounds of thrusters" is one exercise, not
 * eight round entries. Empty for everything else.
 */
export function roundsOf(sec) {
  if (Array.isArray(sec?.rounds) && sec.rounds.length) return sec.rounds;
  if (!isDerivedRounds(sec)) return [];
  const movements = sec.exercises.filter(ex => ex && typeof ex === 'object').map(ex => {
    const set = (Array.isArray(ex.sets) && ex.sets[0]) || {};
    const m = { movement: ex.movement, kind: set.kind || ex.kind };
    if (ex.id) m.id = ex.id;
    for (const k of SET_FIELDS) if (set[k] !== undefined) m[k] = set[k];
    for (const k of EXERCISE_FIELDS) if (ex[k] !== undefined) m[k] = ex[k];
    return m;
  });
  return movements.length ? [{ movements }] : [];
}

export const isRoundsSection = sec => roundsOf(sec).length > 0;

/** The section's score type, or null when nothing is scored. */
export function scoreOf(sec) {
  const s = sec?.format?.score;
  return s && s !== 'none' ? s : null;
}

/** Rounds-based or scored sections get one footer for the whole block — score
 *  box, then RPE / note keyed by the SECTION id — instead of per-exercise pills.
 *  A for-time chipper is one effort; rating each movement of it is noise.
 *  Derived emom / tabata rounds count: they are rounds sections. */
export const hasBlockFooter = sec => isRoundsSection(sec) || !!scoreOf(sec);

/** Whether the result needs a `sections[id]` entry for this section. An
 *  assumed RPE needs one too — that entry is where it is recorded. */
export const usesFormatFeatures = sec =>
  isRoundsSection(sec) || !!scoreOf(sec) ||
  !!(sec?.optional && sec.optional.length) || !!(sec?.modifiers && sec.modifiers.length) ||
  sectionRpePolicy(sec).mode === 'assume';

/* ── RPE policy ──────────────────────────────────────────────── */

/* Whether to ask the athlete for an RPE, and what to record when not asking.
 *   ask              draw the pill; record only what is tapped (today's behaviour)
 *   hide             no pill, nothing recorded
 *   assume <value>   no pill; record <value> with rpeAssumed: true
 * Girls and heroes are max effort by definition, so asking is noise: a
 * benchmark section assumes 11. 11 sits beyond the 1–10 scale on purpose — it
 * can never be mistaken for a tapped value — and rpeAssumed marks it besides.
 * An assumed value is never prefilled into a control (the prefill rule): the
 * pill is simply not drawn. Legacy plans set none of this and ask everywhere. */

export const BENCHMARKS = ['girl', 'hero'];
export const ASSUMED_BENCHMARK_RPE = 11;

const ASK = Object.freeze({ mode: 'ask' });

/** One `rpe` setting → a policy, or null when unset or not a valid setting
 *  (the validator reports invalid ones; the page falls back to asking). */
export function rpePolicy(setting) {
  if (setting === 'ask') return ASK;
  if (setting === 'hide') return { mode: 'hide' };
  if (typeof setting === 'number' && Number.isFinite(setting) && setting >= 1 && setting <= 11) {
    return { mode: 'assume', value: setting };
  }
  return null;
}

/** section.rpe wins; else a girl / hero benchmark assumes 11; else ask. */
export function sectionRpePolicy(sec) {
  return rpePolicy(sec?.rpe)
    || (BENCHMARKS.includes(sec?.benchmark) ? { mode: 'assume', value: ASSUMED_BENCHMARK_RPE } : ASK);
}

/** wod.rpe wins; else a day made only of benchmarks assumes 11 — there is
 *  nothing left for the athlete to rate; else ask. */
export function sessionRpePolicy(wod) {
  const own = rpePolicy(wod?.rpe);
  if (own) return own;
  const secs = wod?.sections;
  if (Array.isArray(secs) && secs.length && secs.every(s => BENCHMARKS.includes(s?.benchmark))) {
    return { mode: 'assume', value: ASSUMED_BENCHMARK_RPE };
  }
  return ASK;
}

/** Whether the section's block RPE pill is drawn: only when asking. */
export const showSectionRpe = sec => sectionRpePolicy(sec).mode === 'ask';

/** Whether per-exercise RPE pills are drawn in a section WITHOUT a block
 *  footer: only when the section asks. An assumed section has already said
 *  how hard it was, so a per-exercise pill would invite a contradiction. */
export const showExerciseRpe = sec => sectionRpePolicy(sec).mode === 'ask';

/** Whether the session RPE control is drawn. */
export const showSessionRpe = wod => sessionRpePolicy(wod).mode === 'ask';

/** The result's session `rpe` (+ `rpeAssumed`). `answered` is the control's
 *  raw value; an athlete-answered RPE never carries rpeAssumed. */
export function sessionRpeResult(wod, answered) {
  const p = sessionRpePolicy(wod);
  if (p.mode === 'assume') return { rpe: p.value, rpeAssumed: true };
  if (p.mode === 'hide' || blank(answered)) return { rpe: null };
  return { rpe: Number(answered) };
}

/** The digest's session RPE fragment: "RPE 8", "RPE 11 (assumed)", or null. */
export function sessionRpeText(wod, answered) {
  const r = sessionRpeResult(wod, answered);
  if (r.rpe === null) return null;
  return `RPE ${r.rpe}${r.rpeAssumed ? ' (assumed)' : ''}`;
}

/** True when an EMOM pairs A and B movements, so the header can say so. */
export function hasAlternatingSlots(sec) {
  const slots = new Set((sec?.exercises || []).map(ex => ex.intervalSlot).filter(Boolean));
  return slots.has('A') && slots.has('B');
}

/* ── rounds expansion ────────────────────────────────────────── */

// Copies a template's movements into a concrete round, applying the round's
// reps to rep-based movements only. Ids are positional when the plan has none,
// so result rows line up with the plan even when the agent wrote no ids.
function concreteRound(movements, reps) {
  return {
    reps: blank(reps) ? null : reps,
    movements: movements.map((m, j) => {
      const out = { ...m, id: m.id || 'm' + (j + 1) };
      if (!blank(reps) && REP_KINDS.includes(m.kind)) out.reps = reps;
      return out;
    })
  };
}

/**
 * Unrolls `section.rounds` into one entry per round performed.
 *
 *   { movements, reps? }          a new round
 *   { reps }                      the previous round's movements at these reps
 *   { repeat: n }                 n more copies of the previous round
 *   { reps | movements, repeat }  that round, then n more copies of it
 *
 * A round's reps always override rep-based movement reps — that is what makes
 * 21-15-9 three entries rather than three full movement lists. When
 * format.rounds asks for more rounds than were written (Barbara: one round, 5
 * rounds), the last one is copied up to the count. AMRAP is never padded: its
 * rounds are open-ended, so what comes back is the "each round" template.
 *
 * An opening entry with no movements has nothing to copy and is dropped here;
 * validateFormat reports it. A derived emom / tabata (see roundsOf) arrives
 * here as one template round and is padded like Barbara.
 */
export function expandRounds(section) {
  const rounds = roundsOf(section);
  if (!rounds.length) return [];
  const out = [];
  let prev = null;

  for (const entry of rounds) {
    if (!entry || typeof entry !== 'object') continue;
    const hasMoves = Array.isArray(entry.movements) && entry.movements.length > 0;
    const hasReps = !blank(entry.reps);
    let round;

    if (hasMoves) round = concreteRound(entry.movements, entry.reps);
    else if (!prev) continue;
    else if (hasReps) round = concreteRound(prev.movements, entry.reps);
    else if (isPosInt(entry.repeat)) {
      // Bare { repeat: n } is n copies, not n + 1 — "repeat twice more".
      for (let i = 0; i < entry.repeat; i++) out.push(concreteRound(prev.movements, prev.reps));
      continue;
    } else round = concreteRound(prev.movements, prev.reps);

    out.push(round);
    prev = round;
    if (isPosInt(entry.repeat)) {
      for (let i = 0; i < entry.repeat; i++) out.push(concreteRound(round.movements, round.reps));
    }
  }

  const want = section.format?.rounds;
  if (!isAmrap(section) && isPosInt(want) && out.length && out.length < want) {
    const last = out[out.length - 1];
    while (out.length < want) out.push(concreteRound(last.movements, last.reps));
  }

  return out.map((r, i) => ({ ...r, id: 'r' + (i + 1), n: i + 1 }));
}

/** "21-15-9" when every round carries reps and they differ; otherwise null,
 *  and the header shows a plain round count instead. */
export function roundScheme(section) {
  if (isAmrap(section)) return null;
  const reps = expandRounds(section).map(r => r.reps);
  if (reps.length < 2 || reps.some(blank)) return null;
  return new Set(reps).size > 1 ? reps.join('-') : null;
}

/* ── format header ───────────────────────────────────────────── */

/**
 * The header drawn above a formatted block:
 *   eyebrow  "CONDITIONING · FOR TIME · 3 ROUNDS"  (or "· 21-15-9")
 *   parts    ["Cap 15:00"], ["20s work / 10s rest × 8"], …
 *   line     parts joined with " · ", or "" when there is nothing to say
 * Null when the section has no format.
 */
export function describeFormat(section) {
  const f = section?.format;
  if (!f || typeof f !== 'object') return null;

  const rounds = isRoundsSection(section) && !isAmrap(section)
    ? expandRounds(section).length
    : (isPosInt(f.rounds) ? f.rounds : 0);
  const scheme = roundScheme(section);

  const eyebrow = [
    section.type && section.type !== 'other' ? section.type : null,
    formatLabel(f.type),
    scheme || (rounds && f.type !== 'amrap' ? `${rounds} round${rounds === 1 ? '' : 's'}` : null)
  ].filter(Boolean).join(' · ').toUpperCase();

  const parts = [];
  const times = isPosInt(f.rounds) ? ` × ${f.rounds}` : '';
  if (f.type === 'tabata' || f.type === 'intervals') {
    if (isPosNum(f.workSec) && isPosNum(f.restSec)) parts.push(`${fmtSpan(f.workSec)} work / ${fmtSpan(f.restSec)} rest${times}`);
    else if (isPosNum(f.workSec)) parts.push(`${fmtSpan(f.workSec)} work${times}`);
    else if (isPosNum(f.restSec)) parts.push(`${fmtSpan(f.restSec)} rest between efforts`);
  }
  if (f.type === 'emom' && isPosNum(f.intervalSec)) {
    const total = isPosInt(f.rounds) ? f.intervalSec * f.rounds : 0;
    const span = !total ? '' : total % 60 === 0 ? ` for ${total / 60} min` : ` for ${fmtClock(total)}`;
    parts.push(`Every ${fmtClock(f.intervalSec)}${span}`);
    if (hasAlternatingSlots(section)) parts.push('Alternating A / B each interval');
  }
  if ((f.type === 'for_time' || f.type === 'circuit') && isPosNum(f.restSec)) {
    parts.push(`Rest ${fmtSpan(f.restSec)} between rounds`);
  }
  if (isPosNum(f.capSec)) parts.push(`Cap ${fmtClock(f.capSec)}`);

  return { eyebrow, parts, line: parts.join(' · ') };
}

/* ── movement text ───────────────────────────────────────────── */

// Drops a trailing parenthetical such as "(alt. legs)" — validate warns about
// those, but a one-line round summary has no room for one that slips through.
const shortName = name => String(name || '').replace(/\s*\([^)]*\)\s*$/, '');

/** The prescription for one round movement, as the collapsed-round summary shows
 *  it: "53 × 21", "1.5× BW × 10", "400 m", "max reps". */
export function prescriptionText(m, units) {
  const u = unitsOf(units);
  const dUnit = m.distanceUnit || u.distance;
  const reps = blank(m.reps) ? (m.athleteFills === 'reps' ? 'max reps' : '') : String(m.reps);
  const load = m.loadType === 'bodyweight' ? 'BW'
    : !blank(m.load) ? String(m.load)
    : !blank(m.loadBwMult) ? formatBwMult(m.loadBwMult)
    : '';
  const dist = blank(m.distance) ? '' : `${m.distance} ${dUnit}`;

  switch (m.kind) {
    case 'weight_reps': return [load, reps].filter(Boolean).join(' × ');
    case 'carry':       return [[load, reps].filter(Boolean).join(' × '), dist].filter(Boolean).join(' ');
    case 'reps':        return reps;
    case 'time':        return m.duration || '';
    case 'cardio':      return dist || m.duration || (m.pace ? String(m.pace) : '');
    default:            return '';
  }
}

/** "Run 400 m · Kettlebell swing 53 × 21 · Pull-up 12" — the one line a
 *  collapsed round shows in place of its movements. */
export function roundSummary(round, units) {
  return (round?.movements || [])
    .map(m => [shortName(m.movement), prescriptionText(m, units)].filter(Boolean).join(' '))
    .join(' · ');
}

/* ── round state + the round check rule ──────────────────────── */

/* Round state is { done, movements: [{ done, load, reps, distance, duration,
 * pace }] }, index-aligned with expandRounds(). The check rule is one fact
 * stored two ways: a round is done exactly when all its movements are. Every
 * helper below returns a new round with both sides already agreeing, so no
 * caller can leave them out of step. */

// Prescribed values prefill, as for sets. A bodyweight-multiple load does not:
// the plan gives a ratio, and only the athlete knows what that came to.
function seedMovement(m) {
  return {
    done: false,
    load: m.loadType === 'bodyweight' ? 'BW' : (blank(m.load) ? '' : String(m.load)),
    reps: blank(m.reps) ? '' : String(m.reps),
    distance: blank(m.distance) ? '' : String(m.distance),
    duration: m.duration ?? '',
    pace: m.pace ? String(m.pace).split('/')[0] : ''
  };
}

/**
 * Fresh state for every concrete round, merged with `saved` where it still
 * lines up. A round from an older copy of the plan is kept only while its
 * movement count matches, so an edited plan cannot misfile old ticks.
 * AMRAP has no per-round state — its rounds are unbounded and the score box
 * carries the count — so it seeds [].
 */
export function seedRoundState(section, saved) {
  if (isAmrap(section)) return [];
  return expandRounds(section).map((r, i) => {
    const fresh = { done: false, movements: r.movements.map(seedMovement) };
    const old = Array.isArray(saved) ? saved[i] : null;
    if (!old || !Array.isArray(old.movements) || old.movements.length !== fresh.movements.length) return fresh;
    const movements = fresh.movements.map((m, j) => ({ ...m, ...old.movements[j] }));
    return { done: movements.every(m => m.done), movements };
  });
}

/** Round done == all movements done. A movement-less round falls back to its flag. */
export function roundDone(round) {
  const ms = round?.movements || [];
  return ms.length ? ms.every(m => !!m.done) : !!round?.done;
}

/** Ticking a round ticks every movement in it; unticking clears them all. */
export function setRoundDone(round, done) {
  return {
    ...round,
    done: !!done,
    movements: (round.movements || []).map(m => ({ ...m, done: !!done }))
  };
}

/** Ticking a movement recomputes its round, so the last tick closes the round
 *  and un-ticking any one reopens it. */
export function setMovementDone(round, index, done) {
  const movements = (round.movements || []).map((m, j) => j === index ? { ...m, done: !!done } : m);
  return { ...round, movements, done: movements.length > 0 && movements.every(m => m.done) };
}

/** Index of the round to show expanded by default: the first not done, or -1. */
export const firstOpenRound = roundStates => (roundStates || []).findIndex(r => !roundDone(r));

/* ── section stopwatch ───────────────────────────────────────── */

/* The stopwatch beside a "time" score box. It is computed from timestamps,
 * never from counted ticks: { running, startedAt (epoch ms), accMs } lives in
 * the persisted section state and elapsed is worked out from `now` whenever it
 * is needed. A reload, a backgrounded tab or a phone that slept through the
 * metcon loses nothing, and a throttled setInterval cannot drift it. Every
 * helper takes `now` so tests can inject it, and returns a new state.
 * UI state only: the result carries score.time / timeSec, never the timer. */

const msOk = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export const timerState = () => ({ running: false, startedAt: null, accMs: 0 });

/** A saved timer, or a fresh one when it is missing or malformed. A "running"
 *  timer with no usable startedAt cannot be resumed, so it comes back paused. */
export function normaliseTimer(saved) {
  if (!saved || typeof saved !== 'object') return timerState();
  const accMs = msOk(saved.accMs) ? saved.accMs : 0;
  const running = saved.running === true && msOk(saved.startedAt);
  return { running, startedAt: running ? saved.startedAt : null, accMs };
}

/** accMs plus the live stretch since startedAt. Never negative, even if the
 *  device clock was wound back while it ran. */
export function timerElapsedMs(t, now) {
  const s = normaliseTimer(t);
  return s.accMs + (s.running ? Math.max(0, now - s.startedAt) : 0);
}

/** Runs from `fromMs` when given (the time in the field), else from accMs.
 *  Starting a running timer without fromMs changes nothing. */
export function timerStart(t, now, fromMs) {
  const s = normaliseTimer(t);
  if (s.running && !msOk(fromMs)) return s;
  return { running: true, startedAt: now, accMs: msOk(fromMs) ? fromMs : s.accMs };
}

/** Folds the live stretch into accMs and stops. */
export function timerPause(t, now) {
  return { running: false, startedAt: null, accMs: timerElapsedMs(t, now) };
}

export const timerReset = () => timerState();

/** A typed time wins over the stopwatch: stopped, and holding exactly that. */
export function timerSetMs(t, ms) {
  return { running: false, startedAt: null, accMs: msOk(ms) ? ms : 0 };
}

/* ── whole-section state ─────────────────────────────────────── */

/** Blank score, every pill off, fresh rounds, a stopped stopwatch. Score
 *  starts empty — it is a measurement, and a defaulted score would be
 *  indistinguishable from one typed. */
export function seedSectionState(section, saved) {
  return {
    score: { time: '', rounds: '', reps: '', totalReps: '', ...(saved?.score || {}) },
    optional: { ...(saved?.optional || {}) },
    modifiers: { ...(saved?.modifiers || {}) },
    rounds: seedRoundState(section, saved?.rounds),
    timer: normaliseTimer(saved?.timer)
  };
}

/** Flips one scaling or modifier pill. `group` is "optional" or "modifiers". */
export function togglePill(secState, group, id) {
  const next = { ...(secState[group] || {}) };
  next[id] = !next[id];
  return { ...secState, [group]: next };
}

/* ── page state helpers ──────────────────────────────────────── */

/* Small, immutable edits main.js makes from its event handlers. They live here
 * so the round check rule is applied in exactly one place and can be tested
 * without a DOM; main.js only decides when to call them and when to re-render. */

/** Ticks or unticks a whole round of a section's state. Out-of-range is a no-op. */
export function checkRound(secState, i, done) {
  if (!secState?.rounds?.[i]) return secState;
  const rounds = secState.rounds.slice();
  rounds[i] = setRoundDone(rounds[i], done);
  return { ...secState, rounds };
}

/** Ticks or unticks one movement; the round follows via setMovementDone. */
export function checkMovement(secState, i, j, done) {
  if (!secState?.rounds?.[i]?.movements?.[j]) return secState;
  const rounds = secState.rounds.slice();
  rounds[i] = setMovementDone(rounds[i], j, done);
  return { ...secState, rounds };
}

/** Records a typed value for one round movement (load, reps, distance, …). */
export function setMovementValue(secState, i, j, prop, value) {
  const m = secState?.rounds?.[i]?.movements?.[j];
  if (!m) return secState;
  const rounds = secState.rounds.slice();
  const movements = rounds[i].movements.slice();
  movements[j] = { ...m, [prop]: value };
  rounds[i] = { ...rounds[i], movements };
  return { ...secState, rounds };
}

/** Records one part of the score (time, rounds, reps, totalReps). */
export function setScoreValue(secState, prop, value) {
  return { ...secState, score: { ...(secState?.score || {}), [prop]: value } };
}

/**
 * Whether round i is drawn expanded. An explicit tap (override true/false)
 * wins; otherwise only the first round not yet done is open, so the page
 * always lands on the round the athlete is about to do.
 */
export function roundIsOpen(roundStates, i, override) {
  return typeof override === 'boolean' ? override : i === firstOpenRound(roundStates);
}

/**
 * Splits "secId:2:1" into ["secId", 2, 1]. Indices are taken from the END,
 * because a section id comes from the plan and may itself contain a colon.
 * `count` is how many trailing integers to expect. Null when malformed.
 */
export function splitRef(ref, count) {
  const parts = String(ref ?? '').split(':');
  if (parts.length < count + 1) return null;
  const nums = parts.splice(parts.length - count).map(Number);
  if (nums.some(n => !Number.isInteger(n) || n < 0)) return null;
  const id = parts.join(':');
  return id ? [id, ...nums] : null;
}

/** "Repeat for 20 min" under an AMRAP's template round, or null with no cap. */
export function repeatCaption(section) {
  const cap = section?.format?.capSec;
  if (!isPosNum(cap)) return null;
  return `Repeat for ${cap % 60 === 0 ? `${cap / 60} min` : fmtClock(cap)}`;
}

/** A read-only prescription for the AMRAP template: prescriptionText, with
 *  "reps" spelled out where a bare number would be ambiguous. */
export function rxText(m, units) {
  const t = prescriptionText(m, units);
  return m.kind === 'reps' && /^\d+$/.test(t) ? `${t} reps` : t;
}

/* ── result ──────────────────────────────────────────────────── */

/** "8:41" or "841" (a numeric keypad has no colon) → "8:41". */
function normaliseClock(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.includes(':')) return s;
  return fmtTimeDigits(s);
}

/**
 * The score for one section, or null when it was left blank. Null rather than
 * an absent key so "scored but not entered" stays distinct from "not scored".
 */
export function buildScore(section, score) {
  const type = scoreOf(section);
  if (!type || !score) return null;

  if (type === 'time') {
    const time = normaliseClock(score.time);
    const timeSec = parseClock(time);
    return time && timeSec !== null ? { time, timeSec } : null;
  }
  if (type === 'rounds_reps') {
    if (blank(score.rounds) && blank(score.reps)) return null;
    // A finished round with no partial is "5 + 0", not "5 + unknown".
    return { rounds: num(score.rounds) ?? 0, reps: num(score.reps) ?? 0 };
  }
  if (type === 'total_reps') {
    return blank(score.totalReps) ? null : { totalReps: num(score.totalReps) };
  }
  return null;
}

// Mirrors the log entry shape for the movement's kind, so an agent reading a
// round movement reads it exactly as it would a set.
function movementResult(m, v) {
  const out = { movement: m.movement, done: !!v.done };
  const kind = m.kind;
  if (kind === 'weight_reps' || kind === 'carry') {
    if (v.load === 'BW') out.loadType = 'bodyweight';
    else out.load = num(v.load);
    if (!blank(m.loadBwMult)) out.loadBwMult = m.loadBwMult;
  }
  if (REP_KINDS.includes(kind)) out.reps = num(v.reps);
  if (kind === 'carry' || kind === 'cardio') out.distance = num(v.distance);
  if (kind === 'cardio') out.pace = v.pace || null;
  if (kind === 'time' || kind === 'cardio') {
    out.duration = v.duration || null;
    out.durationSec = parseClock(v.duration);
  }
  return out;
}

/**
 * The `sections[id]` entry for one section, or null for a section that uses
 * none of the format features (it is fully described by `log`).
 *
 * `optional` lists only the pills switched on; `modifiers` lists every modifier
 * as a boolean, because "ran Murph without the vest" is itself the answer.
 * Round movements live here and never in `log`, which stays sets-only.
 *
 * Derived emom / tabata sections (isDerivedRounds) emit NO "exId.setId" log
 * entries: the rounds replace the set rows on the page, so the rounds here are
 * the record. main.js skips their exercises when building `log`.
 *
 * An assumed section RPE is recorded here as rpe + rpeAssumed: true, never in
 * `exerciseRpe`, which stays "what the athlete rated".
 */
export function buildSectionResult(section, secState) {
  if (!usesFormatFeatures(section)) return null;
  const st = secState || seedSectionState(section);
  const out = {};

  if (scoreOf(section)) out.score = buildScore(section, st.score);

  const rpe = sectionRpePolicy(section);
  if (rpe.mode === 'assume') { out.rpe = rpe.value; out.rpeAssumed = true; }

  if (section.optional && section.optional.length) {
    out.optional = {};
    section.optional.forEach(o => { if (st.optional?.[o.id]) out.optional[o.id] = true; });
  }
  if (section.modifiers && section.modifiers.length) {
    out.modifiers = {};
    section.modifiers.forEach(o => { out.modifiers[o.id] = !!st.modifiers?.[o.id]; });
  }

  if (isRoundsSection(section) && !isAmrap(section)) {
    const states = st.rounds && st.rounds.length ? st.rounds : seedRoundState(section);
    out.rounds = expandRounds(section).map((r, i) => {
      const rs = states[i] || { movements: [] };
      const movements = r.movements.map((m, j) => movementResult(m, rs.movements?.[j] || {}));
      return { done: movements.length ? movements.every(m => m.done) : !!rs.done, movements };
    });
  }
  return out;
}

/**
 * Adds `sections` to a result built by main.js, plus the convenience mirror:
 * when exactly one section has an entry, its score / optional / modifiers /
 * rounds are also copied to the top level. That is the shape most single-WOD
 * consumers expect; `sections` stays the canonical, unambiguous form. A
 * section's rpe / rpeAssumed are never mirrored: top-level `rpe` is the session's.
 * `states` is keyed by section id. Returns a new result; the input is untouched.
 */
export function withSections(result, wod, states) {
  const sections = {};
  (wod?.sections || []).forEach(sec => {
    const entry = buildSectionResult(sec, states?.[sec.id]);
    if (entry) sections[sec.id] = entry;
  });

  const ids = Object.keys(sections);
  if (!ids.length) return result;

  const out = { ...result, sections };
  if (ids.length === 1) {
    const only = sections[ids[0]];
    for (const key of ['score', 'optional', 'modifiers', 'rounds']) {
      if (key in only) out[key] = only[key];
    }
  }
  return out;
}

/** Block notes and RPE: footer sections key them by section id in the same
 *  `notes` / `exerciseRpe` maps exercises use. Only non-empty values appear,
 *  and an RPE only where the section asks for one — an assumed value goes to
 *  sections[id], a hidden one nowhere. */
export function sectionNotesAndRpe(wod, notes, rpes) {
  const outNotes = {}, outRpe = {};
  (wod?.sections || []).filter(hasBlockFooter).forEach(sec => {
    const note = String(notes?.[sec.id] || '').trim();
    if (note) outNotes[sec.id] = note;
    if (rpes?.[sec.id] && showSectionRpe(sec)) outRpe[sec.id] = Number(rpes[sec.id]);
  });
  return { notes: outNotes, exerciseRpe: outRpe };
}

/* ── digest ──────────────────────────────────────────────────── */

/** What was done for one movement, as the digest writes it: "225×21", "21", "400m 1:32". */
function movementDigest(m, v, units) {
  const dUnit = m.distanceUnit || unitsOf(units).distance;
  const load = !blank(v.load) ? v.load : !blank(m.loadBwMult) ? `(${formatBwMult(m.loadBwMult)})` : '—';
  const reps = blank(v.reps) ? '—' : v.reps;
  switch (m.kind) {
    case 'weight_reps': return `${load}×${reps}`;
    case 'carry':       return `${load}×${reps} ${blank(v.distance) ? '—' : v.distance}${dUnit}`;
    case 'reps':        return String(reps);
    case 'time':        return v.duration || '—';
    case 'cardio':      return [blank(v.distance) ? null : v.distance + dUnit, v.duration || null].filter(Boolean).join(' ') || '—';
    default:            return '';
  }
}

/** "8:41", "18 rounds + 7 reps", "74 reps"; null when blank. */
export function scoreText(section, score) {
  const s = buildScore(section, score);
  if (!s) return null;
  if ('time' in s) return s.time;
  if ('totalReps' in s) return `${s.totalReps} reps`;
  return `${s.rounds} round${s.rounds === 1 ? '' : 's'} + ${s.reps} rep${s.reps === 1 ? '' : 's'}`;
}

/**
 * The digest lines a format section adds under its heading, indented like
 * exercise rows:
 *   "  Scaled  Pike push-ups"
 *   "  With  20 lb vest"
 *   "  Round 1  ✓ Barbell deadlift 225×21 · Bodyweight handstand push-up 21"
 *   "  Score  8:41"
 *   "  RPE  8"   "  RPE  11 (assumed)"   "  ↳ note"
 * A partly done round marks each movement, so the gap is visible in a chat.
 */
export function digestSectionLines(section, secState, { units, rpe, note } = {}) {
  const st = secState || seedSectionState(section);
  const lines = [];

  const on = (section.optional || []).filter(o => st.optional?.[o.id]).map(o => o.label);
  if (on.length) lines.push('  Scaled  ' + on.join(', '));
  const mods = (section.modifiers || []).filter(o => st.modifiers?.[o.id]).map(o => o.label);
  if (mods.length) lines.push('  With  ' + mods.join(', '));

  if (isRoundsSection(section) && !isAmrap(section)) {
    expandRounds(section).forEach((r, i) => {
      const rs = st.rounds?.[i] || { movements: [] };
      const vals = r.movements.map((m, j) => ({ m, v: rs.movements?.[j] || {} }));
      const done = vals.every(x => x.v.done);
      const partial = !done && vals.some(x => x.v.done);
      const body = vals.map(({ m, v }) =>
        (partial ? (v.done ? '✓ ' : '○ ') : '') + `${m.movement} ${movementDigest(m, v, units)}`
      ).join(' · ');
      lines.push(`  Round ${r.n}  ${partial ? '' : done ? '✓ ' : '○ '}${body}`);
    });
  }

  if (scoreOf(section)) lines.push('  Score  ' + (scoreText(section, st.score) || '—'));
  // The section's policy decides, not the caller: an assumed value is written
  // as such, and a hidden or assumed section ignores any stray tapped value.
  const policy = sectionRpePolicy(section);
  if (policy.mode === 'assume') lines.push(`  RPE  ${policy.value} (assumed)`);
  else if (policy.mode === 'ask' && rpe) lines.push('  RPE  ' + rpe);
  const n = String(note || '').trim();
  if (n) lines.push('  ↳ ' + n);
  return lines;
}

/* ── validation ──────────────────────────────────────────────── */

// Modifier words that describe HOW or WHERE a movement is done, not WHICH
// movement it is. They belong in cue (or tag): "Run" + cue "Outdoors". Real
// equipment that changes the lift (Barbell, Kettlebell, Dumbbell, Rowing
// machine) is part of the name and is deliberately not listed.
const NAME_MODIFIER = /\b(body-?weight|outdoors?|indoors?)\b/i;

/** The movement-name check, shared so round movements get the same advice as
 *  exercises. `movement` is searched verbatim for the form-check link and is
 *  what cross-session tracking keys on, so it must be the name alone: no
 *  trailing parenthetical, no measurement, no "Outdoor" / "Bodyweight"
 *  modifier — the modifier goes in `cue`. */
export function movementNameWarning(name) {
  if (!name) return null;
  const paren = name.match(/\s*\(([^)]*)\)\s*$/);
  const measure = name.match(/\s+\d+\s*(m|km|mi|ft|s|sec|min|reps?)$/i);
  const modifier = name.match(NAME_MODIFIER);
  if (paren) return `${name}: move "(${paren[1]})" into cue or tag — the name is searched verbatim and is not the place for it`;
  if (measure) return `${name}: the prescription belongs in sets, not the name — search and progress tracking both key on this`;
  if (modifier) return `${name}: move "${modifier[0]}" into cue — a modifier is not part of the movement's name (write "Run" with cue "Outdoors", "Pull-up" with cue "Bodyweight")`;
  return null;
}

const partitionOk = p => p === 'free' || p === 'unbroken' ||
  (p && typeof p === 'object' && !Array.isArray(p) && isPosInt(p.max) && Object.keys(p).length === 1);

function checkPills(list, key, where, problems) {
  if (list === undefined) return;
  if (!Array.isArray(list)) { problems.push(`${where}.${key}: must be an array`); return; }
  const seen = new Set();
  list.forEach((o, i) => {
    const at = `${where}.${key}[${i}]`;
    if (!o || typeof o !== 'object') { problems.push(`${at}: must be an object`); return; }
    if (!o.id) problems.push(`${at}: missing id`);
    else if (seen.has(o.id)) problems.push(`${at}: duplicate id "${o.id}"`);
    else seen.add(o.id);
    if (!o.label) problems.push(`${at}: missing label`);
    if (o.load !== undefined && !(typeof o.load === 'number' && o.load >= 0)) problems.push(`${at}: load must be a non-negative number`);
  });
}

// A problem string for a bad plan- or section-level `rpe`, or null.
function checkRpeSetting(v, at) {
  if (v === undefined || rpePolicy(v)) return null;
  return `${at}: ${JSON.stringify(v)} is not "ask", "hide" or a number from 1 to 11`;
}

/** The plan-level RPE check, for the CLI: only `wod.rpe` itself. */
export function validatePlanRpe(wod) {
  const p = checkRpeSetting(wod?.rpe, 'rpe');
  return { problems: p ? [p] : [], warnings: [] };
}

/** Submit-sheet copy. A trimmed plan `coach` renames the button and the title
 *  ("Fuse" → "Send to Fuse"). Missing, non-string, or whitespace-only keeps
 *  the two defaults — the button and the title are not the same string. */
export function sendLabels(coach) {
  const name = typeof coach === 'string' ? coach.trim() : '';
  if (!name) return { button: 'Send to coach', title: 'Send to your coach' };
  const label = `Send to ${name}`;
  return { button: label, title: label };
}

function checkLoad(obj, at, problems) {
  if (obj.load === 0) problems.push(`${at}: load 0 — use "loadType": "bodyweight"`);
  if (obj.loadBwMult !== undefined && obj.loadBwMult !== null && !isPosNum(obj.loadBwMult)) {
    problems.push(`${at}: loadBwMult must be a positive number (1.5 = 1.5× bodyweight)`);
  }
}

/**
 * Checks everything a section gained with formats: format, rounds, optional,
 * modifiers, and the exercise-level partition / intervalSlot / loadBwMult.
 * Problems fail validation; warnings flag something probably unintended.
 * Exercise basics (kind, sets, names) stay in the CLI's existing checks.
 */
export function validateFormat(section, where = 'section') {
  const problems = [], warnings = [];
  if (!section || typeof section !== 'object') return { problems: [`${where}: must be an object`], warnings };

  const f = section.format;
  const hasExercises = Array.isArray(section.exercises) && section.exercises.length > 0;
  const hasRoundsKey = section.rounds !== undefined;

  if (!hasExercises && !hasRoundsKey) problems.push(`${where}: needs exercises or rounds`);

  if (f !== undefined) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) problems.push(`${where}.format: must be an object`);
    else {
      if (!FORMAT_TYPES.includes(f.type)) problems.push(`${where}.format: type "${f.type}" is not one of ${FORMAT_TYPES.join(', ')}`);
      if (f.score !== undefined && !SCORE_TYPES.includes(f.score)) problems.push(`${where}.format: score "${f.score}" is not one of ${SCORE_TYPES.join(', ')}`);
      if (f.rounds !== undefined && !isPosInt(f.rounds)) problems.push(`${where}.format: rounds must be a positive integer`);
      for (const k of ['workSec', 'restSec', 'intervalSec', 'capSec']) {
        if (f[k] !== undefined && !isPosNum(f[k])) problems.push(`${where}.format: ${k} must be a positive number of seconds`);
      }
      if (f.type === 'emom' && f.intervalSec === undefined) warnings.push(`${where}.format: emom without intervalSec — the header cannot say how often`);
      if (f.type === 'tabata' && f.workSec === undefined) warnings.push(`${where}.format: tabata without workSec — the header cannot say how long each effort is`);
      if (f.type === 'for_time' && (f.score === 'rounds_reps' || f.score === 'total_reps')) {
        warnings.push(`${where}.format: for_time scored as ${f.score} — did you mean amrap?`);
      }
      if (f.type === 'amrap' && f.score === 'time') warnings.push(`${where}.format: amrap scored as time — an AMRAP runs to the cap, so time is fixed`);
    }
  }

  if (hasRoundsKey) {
    const R = section.rounds;
    if (!Array.isArray(R) || !R.length) problems.push(`${where}.rounds: must be a non-empty array`);
    else {
      const first = R[0];
      if (!first || !Array.isArray(first.movements) || !first.movements.length) {
        problems.push(`${where}.rounds[0]: the first round needs movements — later rounds copy from it`);
      }
      R.forEach((entry, i) => {
        const at = `${where}.rounds[${i}]`;
        if (!entry || typeof entry !== 'object') { problems.push(`${at}: must be an object`); return; }
        if (entry.reps !== undefined && entry.reps !== null && !isPosInt(entry.reps)) problems.push(`${at}: reps must be a positive integer`);
        if (entry.repeat !== undefined && !isPosInt(entry.repeat)) problems.push(`${at}: repeat must be a positive integer`);
        if (entry.movements !== undefined && !Array.isArray(entry.movements)) { problems.push(`${at}: movements must be an array`); return; }
        (entry.movements || []).forEach((m, j) => {
          const mAt = `${at}.movements[${j}]`;
          if (!m || typeof m !== 'object') { problems.push(`${mAt}: must be an object`); return; }
          if (!m.movement) problems.push(`${mAt}: missing movement`);
          else { const w = movementNameWarning(m.movement); if (w) warnings.push(w); }
          if (!m.kind) problems.push(`${mAt} (${m.movement}): missing kind — the renderer cannot infer it`);
          else if (!KINDS.includes(m.kind)) problems.push(`${mAt} (${m.movement}): kind "${m.kind}" is not one of ${KINDS.join(', ')}`);
          checkLoad(m, mAt, problems);
          if (m.partition !== undefined && !partitionOk(m.partition)) problems.push(`${mAt}: partition must be "free", "unbroken" or { "max": n }`);
        });
      });

      const want = f && isPosInt(f.rounds) ? f.rounds : null;
      if (want && f.type !== 'amrap') {
        // Count what was written, before padding — padding is what fills a
        // short list up to format.rounds, so it would always agree.
        const written = expandRounds({ rounds: R }).length;
        if (written > want) warnings.push(`${where}: rounds[] expands to ${written} rounds but format.rounds is ${want}`);
      }
    }
  }

  checkPills(section.optional, 'optional', where, problems);
  checkPills(section.modifiers, 'modifiers', where, problems);

  if (DERIVED_FORMATS.includes(f?.type) && hasExercises && !hasRoundsKey) {
    if (!isPosInt(f.rounds)) {
      warnings.push(`${where}.format: ${f.type} without rounds — no rounds are drawn, the exercises show as ordinary set rows`);
    } else {
      section.exercises.forEach((ex, j) => {
        if (ex && Array.isArray(ex.sets) && ex.sets.length > 1) {
          warnings.push(`${where}.exercises[${j}] (${ex.movement}): ${ex.sets.length} sets in a ${f.type} — only the first set is used for rounds`);
        }
      });
    }
  }

  const rpeProblem = checkRpeSetting(section.rpe, `${where}.rpe`);
  if (rpeProblem) problems.push(rpeProblem);
  if (section.benchmark !== undefined && !BENCHMARKS.includes(section.benchmark)) {
    problems.push(`${where}.benchmark: "${section.benchmark}" is not one of ${BENCHMARKS.join(', ')}`);
  }
  if ((section.rpe !== undefined || section.benchmark !== undefined) && !hasBlockFooter(section)) {
    warnings.push(`${where}: rpe / benchmark on a section that is not a scored or rounds block — an assumed value is still recorded under sections, and per-exercise RPE pills are hidden`);
  }
  if (section.benchmark !== undefined && !scoreOf(section)) {
    warnings.push(`${where}: benchmark "${section.benchmark}" without format.score — a benchmark is normally scored`);
  }

  (section.exercises || []).forEach((ex, j) => {
    if (!ex || typeof ex !== 'object') return;
    const at = `${where}.exercises[${j}]`;
    if (ex.partition !== undefined && !partitionOk(ex.partition)) problems.push(`${at}: partition must be "free", "unbroken" or { "max": n }`);
    if (ex.intervalSlot !== undefined) {
      if (ex.intervalSlot !== 'A' && ex.intervalSlot !== 'B') problems.push(`${at}: intervalSlot must be "A" or "B"`);
      else if (f?.type !== 'emom') warnings.push(`${at} (${ex.movement}): intervalSlot only means something in an emom`);
    }
    (ex.sets || []).forEach((set, k) => {
      // load 0 is already reported by the CLI's set loop; only the new field here.
      if (set && set.loadBwMult !== undefined && set.loadBwMult !== null && !isPosNum(set.loadBwMult)) {
        problems.push(`${at}.sets[${k}]: loadBwMult must be a positive number (1.5 = 1.5× bodyweight)`);
      }
    });
  });

  return { problems, warnings };
}

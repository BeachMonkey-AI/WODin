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

export const isRoundsSection = sec => Array.isArray(sec?.rounds) && sec.rounds.length > 0;
export const isAmrap = sec => sec?.format?.type === 'amrap';

/** The section's score type, or null when nothing is scored. */
export function scoreOf(sec) {
  const s = sec?.format?.score;
  return s && s !== 'none' ? s : null;
}

/** Rounds-based or scored sections get one footer for the whole block — score
 *  box, then RPE / note keyed by the SECTION id — instead of per-exercise pills.
 *  A for-time chipper is one effort; rating each movement of it is noise. */
export const hasBlockFooter = sec => isRoundsSection(sec) || !!scoreOf(sec);

/** Whether the result needs a `sections[id]` entry for this section. */
export const usesFormatFeatures = sec =>
  isRoundsSection(sec) || !!scoreOf(sec) ||
  !!(sec?.optional && sec.optional.length) || !!(sec?.modifiers && sec.modifiers.length);

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
 * validateFormat reports it.
 */
export function expandRounds(section) {
  if (!isRoundsSection(section)) return [];
  const out = [];
  let prev = null;

  for (const entry of section.rounds) {
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

// Drops a trailing "(outdoors)" / "(bodyweight)" — the name keeps it for search,
// but a one-line round summary has no room for it.
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

/* ── whole-section state ─────────────────────────────────────── */

/** Blank score, every pill off, fresh rounds. Score starts empty — it is a
 *  measurement, and a defaulted score would be indistinguishable from one typed. */
export function seedSectionState(section, saved) {
  return {
    score: { time: '', rounds: '', reps: '', totalReps: '', ...(saved?.score || {}) },
    optional: { ...(saved?.optional || {}) },
    modifiers: { ...(saved?.modifiers || {}) },
    rounds: seedRoundState(section, saved?.rounds)
  };
}

/** Flips one scaling or modifier pill. `group` is "optional" or "modifiers". */
export function togglePill(secState, group, id) {
  const next = { ...(secState[group] || {}) };
  next[id] = !next[id];
  return { ...secState, [group]: next };
}

/* ── result ──────────────────────────────────────────────────── */

/** "8:41" or "841" (a numeric keypad has no colon) → "8:41". */
function normaliseClock(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.includes(':')) return s;
  const d = s.replace(/\D/g, '');
  return d.length <= 2 ? d : d.slice(0, -2).replace(/^0+(?=\d)/, '') + ':' + d.slice(-2);
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
 */
export function buildSectionResult(section, secState) {
  if (!usesFormatFeatures(section)) return null;
  const st = secState || seedSectionState(section);
  const out = {};

  if (scoreOf(section)) out.score = buildScore(section, st.score);

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
 * consumers expect; `sections` stays the canonical, unambiguous form.
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
 *  `notes` / `exerciseRpe` maps exercises use. Only non-empty values appear. */
export function sectionNotesAndRpe(wod, notes, rpes) {
  const outNotes = {}, outRpe = {};
  (wod?.sections || []).filter(hasBlockFooter).forEach(sec => {
    const note = String(notes?.[sec.id] || '').trim();
    if (note) outNotes[sec.id] = note;
    if (rpes?.[sec.id]) outRpe[sec.id] = Number(rpes[sec.id]);
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
 *   "  Round 1  ✓ Barbell deadlift 225×21 · Handstand push-up 21"
 *   "  Score  8:41"
 *   "  RPE  8"   "  ↳ note"
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
  if (rpe) lines.push('  RPE  ' + rpe);
  const n = String(note || '').trim();
  if (n) lines.push('  ↳ ' + n);
  return lines;
}

/* ── validation ──────────────────────────────────────────────── */

/** The existing movement-name check, shared so round movements get the same
 *  advice as exercises. `movement` is searched verbatim for the form-check link
 *  and is what cross-session tracking keys on, so it must be the name alone. */
export function movementNameWarning(name) {
  if (!name) return null;
  const paren = name.match(/\s*\(([^)]*)\)\s*$/);
  const measure = name.match(/\s+\d+\s*(m|km|mi|ft|s|sec|min|reps?)$/i);
  if (paren) return `${name}: move "(${paren[1]})" into cue or tag — the name is searched verbatim and is not the place for it`;
  if (measure) return `${name}: the prescription belongs in sets, not the name — search and progress tracking both key on this`;
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

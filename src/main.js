/* WODin — renders a plan (wod.schema.json) as a loggable page and emits a
 * result (result.schema.json).
 *
 * Resolution order for "which workout am I showing?":
 *   1. #w=<deflate-raw + base64url>  or  #wj=<base64url JSON>   — the link carries it
 *   2. #id=<workoutId>                                          — from this device's library
 *   3. ?d=<date>  → fetch wods/<date>.json                      — from the deploy
 *   4. nothing                                                  — the library home screen
 */

import { ICON } from './icons.js';
// Every rule about formats and rounds lives in format.js, shared with the CLI
// and the tests; this file only draws it and routes events into it.
import {
  describeFormat, expandRounds, isRoundsSection, isAmrap, scoreOf, scoreLabel,
  hasBlockFooter, usesFormatFeatures, formatBwMult, describePartition, roundSummary,
  fmtSpan, roundDone, seedSectionState, togglePill, checkRound, checkMovement,
  setMovementValue, setScoreValue, roundIsOpen, splitRef, repeatCaption, rxText,
  withSections, sectionNotesAndRpe, digestSectionLines, isDerivedRounds,
  fmtClock, parseClock, isAutoFormatField, timeFormatterFor,
  showSectionRpe, showExerciseRpe, showSessionRpe, sessionRpeResult, sessionRpeText,
  timerElapsedMs, timerStart, timerPause, timerReset, timerSetMs
} from './format.js';

// Replaced by scripts/build.mjs with the same content hash the service worker
// caches under. Shown in the library so "is this thing even updated?" is a
// question you can answer by looking, rather than by guessing.
const BUILD = '390271a9';
const REPO = 'https://github.com/BeachMonkey-AI/WODin';

// Index 0 = RPE 1. Both RPE dropdowns list 10 down to 1 — the top of the
// effort scale is the one an athlete reaches for after a hard set, so it
// shouldn't cost a scroll — and each option carries this anchor so "7"
// means the same thing to everyone tapping it, not just whoever wrote the plan.
const RPE_DESC = ['Minimal effort', 'Very light', 'Light', 'Fairly light', 'Moderate',
  'Somewhat hard', 'Hard', 'Very hard', 'Near max', 'Max effort'];
const rpeOptions = (label, current) => [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(n =>
  `<option value="${n}" ${String(current) === String(n) ? 'selected' : ''}>${label} ${n} — ${RPE_DESC[n - 1]}</option>`
).join('');

// Shown on every view. The repo link is the answer to "what is this thing and can
// I run my own?", which a workout arriving by link from a stranger's agent ought
// to be able to answer for itself.
const footer = () => {
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return `<p class="foot">
    <a href="${REPO}" target="_blank" rel="noopener">github.com/BeachMonkey-AI/WODin</a>
    <span>build ${esc(BUILD)}${installed ? ' · installed' : ''}</span>
  </p>`;
};

const LIB_KEY = 'wodin:index';
const wodKey = id => 'wodin:wod:' + id;
const logKey = id => 'wodin:log:' + id;

const $ = id => document.getElementById(id);

/* ── storage ─────────────────────────────────────────────────── */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

const library = () => readJSON(LIB_KEY, []);

function remember(wod) {
  const entry = {
    workoutId: wod.workoutId,
    title: wod.title || wod.athleteTitle || wod.workoutId,
    date: wod.date || wod.workoutId,
    seenAt: new Date().toISOString()
  };
  const list = library().filter(x => x.workoutId !== wod.workoutId);
  list.unshift(entry);
  writeJSON(LIB_KEY, list.slice(0, 50));
  writeJSON(wodKey(wod.workoutId), wod);
}

/* ── fragment codecs ─────────────────────────────────────────── */

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Mirrors decodeFragment. Falls back to the uncompressed #wj= form where
// CompressionStream is missing — a longer link beats no link.
async function encodeFragment(wod) {
  const text = JSON.stringify(wod);
  if (typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([text]).stream()
        .pipeThrough(new CompressionStream('deflate-raw'));
      const buf = await new Response(stream).arrayBuffer();
      return 'w=' + bytesToB64url(new Uint8Array(buf));
    } catch { /* fall through */ }
  }
  return 'wj=' + bytesToB64url(new TextEncoder().encode(text));
}

async function decodeFragment(hash) {
  const m = hash.match(/^#(w|wj|id)=([\s\S]+)$/);
  if (!m) return null;
  const [, kind, payload] = m;

  if (kind === 'id') {
    return readJSON(wodKey(decodeURIComponent(payload)), null);
  }
  const bytes = b64urlToBytes(payload);
  const text = kind === 'w'
    ? await inflateRaw(bytes)
    : new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

/* ── plan normalisation ──────────────────────────────────────── */

// Ids are optional on input; assign them positionally so the result can key by
// "<exerciseId>.<setId>" regardless of what the agent bothered to write.
function normalise(wod) {
  let exN = 0;
  (wod.sections || []).forEach((sec, si) => {
    sec.id = sec.id || 'sec' + (si + 1);
    (sec.exercises || []).forEach(ex => {
      ex.id = ex.id || 'ex' + (++exN);
      if (!ex.id.startsWith('ex')) exN++;
      (ex.sets || []).forEach((set, sj) => { set.id = set.id || 's' + (sj + 1); });
    });
  });
  return wod;
}

/* ── helpers ─────────────────────────────────────────────────── */

const numStr = v => (v === null || v === undefined) ? '' : String(v);
const stripPace = p => p ? String(p).split('/')[0] : '';
const paceUnit = p => {
  const m = p && String(p).match(/\/(.+)$/);
  return m ? '/' + m[1] : '/500m';
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Every movement links out to a form check unless the plan overrides it. `movement`
// is searched verbatim, which is why it has to be the exercise's canonical name —
// "Row form" finds rowing technique, "Easy row 500m form" finds nothing useful.
const formLink = ex => ex.link ||
  'https://www.youtube.com/results?search_query=' + encodeURIComponent(ex.movement + ' form');

// Clock text ↔ seconds, shared with the result builder in format.js.
const clock = fmtClock;
const toSec = parseClock;

// A field that writes its own colons wants the digit pad; see AUTO_FORMAT_FIELDS.
const timeMode = (prop, otherwise) => isAutoFormatField(prop) ? 'numeric' : otherwise;

/* ── app ─────────────────────────────────────────────────────── */

let WOD = null;
let S = null;
const openNotes = new Set();
// "<secId>:<n>" → expanded or not, for rounds the athlete has tapped open or
// shut. Session-only on purpose: a reload should land on the round to do next.
const openRounds = new Map();
let tick = null;
let pendingRemove = null;   // library entry awaiting its inline confirm

function forget(workoutId) {
  writeJSON(LIB_KEY, library().filter(x => x.workoutId !== workoutId));
  try {
    localStorage.removeItem(wodKey(workoutId));
    localStorage.removeItem(logKey(workoutId));
  } catch { /* storage unavailable — the index entry is already gone */ }
}

const unitOf = k => (WOD.units && WOD.units[k]) || (k === 'load' ? 'lb' : 'm');
const isSkipped = id => S.skipped.includes(id);
const eachExercise = () => (WOD.sections || []).flatMap(s => s.exercises || []);
// Exercises drawn as set rows — everything but a derived emom / tabata, whose
// exercises are drawn as rounds and write no log, skipped or digest rows.
const setExercises = () => (WOD.sections || []).filter(s => !isDerivedRounds(s)).flatMap(s => s.exercises || []);
const roundExerciseIds = () => new Set((WOD.sections || []).filter(isDerivedRounds).flatMap(s => s.exercises.map(ex => ex.id)));
const loggedExercises = sec => isDerivedRounds(sec) ? [] : (sec.exercises || []).filter(ex => !isSkipped(ex.id));

function seedState() {
  const sets = {};
  eachExercise().forEach(ex => ex.sets.forEach(set => {
    sets[ex.id + '.' + set.id] = {
      load:     set.loadType === 'bodyweight' ? 'BW' : numStr(set.load),
      reps:     numStr(set.reps),
      distance: numStr(set.distance),
      duration: set.duration ?? '',
      pace:     stripPace(set.pace)
    };
  }));
  return {
    elapsed: 0, running: false, startedAt: null,
    rpe: '', summary: '', duration: '',
    skipped: [], sets, notes: {}, rpes: {}, added: {},
    sections: seedSections(null)
  };
}

// Score, scaling pills and round ticks for every section that has any of them,
// keyed by section id. A log saved before formats existed has no `sections`
// and simply gets fresh ones.
function seedSections(saved) {
  const out = {};
  (WOD.sections || []).filter(usesFormatFeatures).forEach(sec => {
    out[sec.id] = seedSectionState(sec, saved && saved[sec.id]);
  });
  return out;
}

function loadState() {
  const fresh = seedState();
  const saved = readJSON(logKey(WOD.workoutId), null);
  if (!saved) return fresh;
  const merged = {
    ...fresh, ...saved,
    sets: { ...fresh.sets, ...(saved.sets || {}) },
    sections: seedSections(saved.sections)
  };
  // An older build stored added sets as a count; carry those over as ids.
  Object.keys(merged.added).forEach(ex => {
    if (typeof merged.added[ex] === 'number') {
      merged.added[ex] = Array.from({ length: merged.added[ex] }, (_, i) => 'a' + (i + 1));
    }
  });
  return merged;
}

const save = () => writeJSON(logKey(WOD.workoutId), S);

function allSets(ex) {
  const template = ex.sets[ex.sets.length - 1];
  return ex.sets.concat(
    (S.added[ex.id] || []).map(id => ({ ...template, id, _added: true }))
  );
}

function seedAdded() {
  eachExercise().forEach(ex => allSets(ex).forEach(set => {
    const k = ex.id + '.' + set.id;
    if (S.sets[k]) return;
    S.sets[k] = { ...(S.sets[ex.id + '.' + ex.sets[ex.sets.length - 1].id] || {}) };
  }));
}

// `attrs` is pre-escaped markup for data-* hooks; `label` overrides the
// id-derived aria-label where the id is machine-shaped (round movements, score).
function field({ id, val, unit, ph, mode, cls, attrs, label }) {
  const uw = Math.max(2, String(unit || '').length) + 'ch';
  return `<label class="field ${cls || ''}" style="--uw:${uw}">
    <input id="${esc(id)}" value="${esc(val ?? '')}" placeholder="${esc(ph ?? '')}"
           inputmode="${mode || 'decimal'}" autocomplete="off" ${attrs || ''}
           aria-label="${esc(label || id.replace(/[.\-]/g, ' '))}">
    <span class="unit">${esc(unit || '')}</span>
  </label>`;
}

/* The inputs for one kind of entry, shared by set rows and round movements so
 * a round's kettlebell swing looks and types exactly like a set of them.
 * `fid(prop)` names each input; `extra(prop)` adds its data-* hooks. */
function kindFields(kind, v, { fid, extra = () => '', label = () => '', dUnit, pace, ph = {} }) {
  const f = (prop, o) => field({ id: fid(prop), val: v[prop], attrs: extra(prop), label: label(prop),
    ...o, mode: timeMode(prop, o.mode) });
  if (kind === 'weight_reps') {
    const bw = v.load === 'BW';
    return f('load', { unit: bw ? '' : unitOf('load'), ph: unitOf('load'), cls: bw ? 'bw' : '' })
      + `<span class="times">×</span>`
      + f('reps', { unit: 'reps', mode: 'numeric', ph: ph.reps });
  }
  if (kind === 'reps') return f('reps', { unit: 'reps', mode: 'numeric', ph: ph.reps });
  if (kind === 'time') return f('duration', { unit: 'mm:ss', ph: '0:00' });
  if (kind === 'carry') {
    return f('load', { unit: unitOf('load') })
      + `<span class="times">×</span>`
      + f('reps', { unit: 'reps', mode: 'numeric', ph: ph.reps })
      + f('distance', { unit: dUnit });
  }
  if (kind === 'cardio') {
    return f('pace', { unit: paceUnit(pace), ph: '0:00' })
      + f('distance', { unit: dUnit })
      + f('duration', { unit: 'mm:ss', ph: '0:00' });
  }
  return '';
}

// "Partition as needed" and friends, under a movement name. Empty when unset.
const partitionHint = p => {
  const t = describePartition(p);
  return t ? `<p class="part">${esc(t)}</p>` : '';
};
const bwChip = mult => mult == null ? '' : `<span class="bwx">${esc(formatBwMult(mult))}</span>`;
// The A / B chip before a movement in an emom; empty everywhere else.
const slotChip = (sec, x) => sec?.format?.type === 'emom' && x.intervalSlot
  ? `<span class="slot" aria-label="Interval ${esc(x.intervalSlot)}">${esc(x.intervalSlot)}</span>` : '';

/* ── render: workout ─────────────────────────────────────────── */

function renderWorkout() {
  const d = new Date((WOD.date || WOD.workoutId) + 'T12:00:00');
  const nice = isNaN(d) ? (WOD.date || '')
    : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

  const head = `
    <header>
      <div class="eyebrow">
        <a href="#" id="home">← WODin</a>
        <span class="eb-right">
          <span>${esc(nice)}</span>
          <button class="btn-share" id="shareWod" type="button"
                  aria-label="Share this workout without your submit link">${ICON.share}<span>Share</span></button>
        </span>
      </div>
      <h1>${esc(WOD.athleteTitle || WOD.title || 'Workout')}</h1>
      ${WOD.athleteTitle && WOD.title ? `<h2>${esc(WOD.title)}</h2>` : ''}
      <div class="meta">
        ${WOD.program ? `<span class="prog">${esc(WOD.program)}</span>` : ''}
        ${WOD.estDuration ? `<span>${esc(WOD.estDuration)}</span>` : ''}
        ${WOD.targetRpe ? `<span>target RPE ${WOD.targetRpe}</span>` : ''}
      </div>
      ${WOD.coachNote ? `<p class="coach">${esc(WOD.coachNote)}</p>` : ''}
      ${WOD.coach ? `<p class="coach-by">— ${esc(WOD.coach)}</p>` : ''}
    </header>

    <div class="timer">
      <span class="clock ${S.elapsed || S.running ? '' : 'idle'}" id="clock">${clock(S.elapsed)}</span>
      <button class="btn-reset" id="reset" type="button" aria-label="Reset timer"
              ${S.elapsed || S.running ? '' : 'hidden'}>${ICON.reset}</button>
      <button class="btn-timer ${S.running ? 'running' : ''}" id="toggle" type="button">
        ${S.running ? 'Pause' : (S.elapsed ? 'Resume' : 'Start')}
      </button>
    </div>`;

  const body = (WOD.sections || []).map(renderSection).join('');

  // Both closing controls carry their own label — the placeholder on one, the
  // empty option on the other — so neither needs a caption above it.
  const sessionRpe = S.rpe ?? '';
  const rpeGhost = WOD.targetRpe ? ` · Rx ${WOD.targetRpe}` : '';
  // A hidden or assumed session RPE draws no control at all — nothing to
  // prefill, nothing to answer — and the duration takes the whole row.
  const askRpe = showSessionRpe(WOD);
  const close = `
    <section class="close">
      <div class="close-grid${askRpe ? '' : ' one'}">
        ${field({ id: 'f-duration', val: S.duration || (S.elapsed ? clock(S.elapsed) : ''),
                  unit: 'hh:mm:ss', ph: 'Duration', mode: timeMode('duration'), cls: 'pill-field' })}
        ${askRpe ? `<select class="pill-rpe ${sessionRpe === '' ? '' : 'set'}" id="f-rpe"
                aria-label="Session RPE, 1 to 10">
          <option value="">Session RPE${rpeGhost}</option>
          ${rpeOptions('Session RPE', sessionRpe)}
        </select>` : ''}
      </div>
      <div class="block">
        <span class="fl">How it went</span>
        <textarea id="f-summary" placeholder="How it felt, what to remember">${esc(S.summary)}</textarea>
      </div>
      <button class="btn-log" id="log" type="button">Log workout</button>
    </section>
    ${footer()}`;

  $('app').innerHTML = head + body + close;
}

/* A section is: its rule, then (only when it has them) the format header and
 * the scaling pills, then the body — rounds and/or exercises — then (only for
 * scored or rounds-based blocks) one footer for the whole block. A plain
 * section draws exactly what it always did. */
function renderSection(sec) {
  // A derived emom / tabata draws its exercises as rounds, so the set rows
  // would only repeat them; its rounds are the record (see buildResult).
  const exercises = isDerivedRounds(sec) ? [] : (sec.exercises || []);
  return `
    <div class="sec-head">${esc(sec.name)}</div>
    ${renderFormatHead(sec)}
    ${renderScalePills(sec)}
    ${isRoundsSection(sec) ? renderRounds(sec) : ''}
    ${exercises.map(ex => renderEx(ex, sec)).join('')}
    ${hasBlockFooter(sec) ? renderBlockFooter(sec) : ''}
  `;
}

function renderFormatHead(sec) {
  const d = describeFormat(sec);
  if (!d) return '';
  return `<div class="fmt">
    <div class="fmt-eyebrow">${esc(d.eyebrow)}</div>
    ${d.line ? `<p class="fmt-line">${esc(d.line)}</p>` : ''}
  </div>`;
}

// optional[] is scaling down, modifiers[] is loading up; they look identical
// because to the athlete both are "tick what you actually did".
function renderScalePills(sec) {
  const st = S.sections[sec.id];
  const group = (key, caption) => {
    const list = sec[key] || [];
    if (!list.length || !st) return '';
    return `<div class="scale">
      <span class="scale-cap">${caption}</span>
      <div class="scale-row">
        ${list.map(o => {
          const on = !!st[key][o.id];
          return `<button class="spill ${on ? 'on' : ''}" type="button" aria-pressed="${on}"
                          data-pill="${esc(key)}:${esc(o.id)}" data-sec="${esc(sec.id)}">${esc(o.label)}</button>`;
        }).join('')}
      </div>
    </div>`;
  };
  return group('optional', 'Scaling') + group('modifiers', 'Modifiers');
}

// A tag · cue line, plus the bodyweight-multiple chip, shared by exercises
// and round movements.
function cueLine(x, chip = '') {
  if (!x.tag && !x.cue && !chip) return '';
  const text = (x.tag ? `<span class="tag">${esc(x.tag)}</span>${x.cue ? ' · ' : ''}` : '') + esc(x.cue || '');
  return `<p class="cue">${chip}${chip && text ? ' ' : ''}${text}</p>`;
}

/* ── rounds ── */

function renderRounds(sec) {
  if (isAmrap(sec)) return renderAmrap(sec);

  const st = S.sections[sec.id];
  const rounds = expandRounds(sec);
  const states = st.rounds;
  const f = sec.format || {};
  const rest = (f.type === 'for_time' || f.type === 'circuit') && f.restSec > 0
    ? `<div class="round-rest"><span>Rest ${esc(fmtSpan(f.restSec))}</span></div>` : '';

  const blocks = rounds.map((r, i) => {
    const rs = states[i] || { movements: [] };
    const done = roundDone(rs);
    const open = roundIsOpen(states, i, openRounds.get(sec.id + ':' + r.n));
    const ref = esc(sec.id) + ':' + i;
    return `<div class="round ${open ? 'open' : ''} ${done ? 'done' : ''}">
      <div class="round-head">
        <button class="round-toggle" type="button" data-round-toggle="${esc(sec.id)}:${r.n}"
                aria-expanded="${open}">
          <span class="dot"></span>
          <span class="round-n">Round ${r.n}</span>
          <span class="round-of">${r.n} of ${rounds.length}</span>
        </button>
        <label class="check">
          <input type="checkbox" data-round-check="${ref}" ${done ? 'checked' : ''}
                 aria-label="Round ${r.n} done">
        </label>
      </div>
      ${open
        ? `<div class="round-body">${r.movements.map((m, j) => renderMovement(sec, i, j, m, rs.movements[j] || {})).join('')}</div>`
        : `<p class="round-sum">${esc(roundSummary(r, WOD.units))}</p>`}
    </div>`;
  });

  return `<div class="rounds">
    <div class="rounds-cap">Rounds</div>
    ${blocks.join(rest)}
  </div>`;
}

function renderMovement(sec, i, j, m, v) {
  const ref = `${esc(sec.id)}:${i}:${j}`;
  const fields = kindFields(m.kind, v, {
    fid: prop => `rm-${sec.id}-${i}-${j}-${prop}`,
    extra: prop => `data-rm="${ref}" data-prop="${prop}"`,
    label: prop => `${m.movement}, round ${i + 1}, ${prop}`,
    dUnit: m.distanceUnit || unitOf('distance'),
    pace: m.pace,
    ph: { reps: m.athleteFills === 'reps' && (m.reps == null || m.reps === '') ? 'max' : '' }
  });
  return `<div class="mv ${v.done ? 'done' : ''}">
    <div class="mv-top">
      ${slotChip(sec, m)}<a class="mv-name" href="${esc(formLink(m))}" target="_blank" rel="noopener">${esc(m.movement)}${ICON.ext}</a>
      <label class="check sm">
        <input type="checkbox" data-mv-check="${ref}" ${v.done ? 'checked' : ''}
               aria-label="${esc(m.movement)}, round ${i + 1}, done">
      </label>
    </div>
    ${cueLine(m, bwChip(m.loadBwMult))}
    ${partitionHint(m.partition)}
    <div class="mv-fields k-${esc(m.kind)}">${fields}</div>
  </div>`;
}

// AMRAP rounds are open-ended, so there is nothing to tick per round: the plan
// is shown once as a read-only template and the score box takes the count.
function renderAmrap(sec) {
  const cap = repeatCaption(sec);
  const rows = expandRounds(sec).flatMap(r => r.movements).map(m => `
    <div class="mv rx">
      <div class="mv-top">
        <a class="mv-name" href="${esc(formLink(m))}" target="_blank" rel="noopener">${esc(m.movement)}${ICON.ext}</a>
        <span class="mv-rx">${esc(rxText(m, WOD.units))}</span>
      </div>
      ${cueLine(m, bwChip(m.loadBwMult))}
      ${partitionHint(m.partition)}
    </div>`).join('');
  return `<div class="rounds">
    <div class="rounds-cap">Each round</div>
    <div class="round open template"><div class="round-body">${rows}</div></div>
    ${cap ? `<p class="round-cap">${esc(cap)}</p>` : ''}
  </div>`;
}

/* ── section stopwatch, beside a "time" score box ── */

// What the stopwatch buttons say for a timer state. Shared by the render and
// by the in-place update after typing, which must not re-render (focus, caret).
function swView(sec, timer) {
  const t = timer || {};
  const elapsed = timerElapsedMs(t, Date.now());
  const label = t.running ? 'Pause' : elapsed > 0 ? 'Resume' : 'Start';
  return {
    label, running: !!t.running, showReset: !!t.running || elapsed > 0,
    aria: `${label} stopwatch for ${sec.name || 'this block'}`
  };
}

function stopwatch(sec) {
  const st = S.sections[sec.id];
  if (!st) return '';
  const v = swView(sec, st.timer);
  const id = esc(sec.id);
  return `<div class="sw">
    <button class="sw-go ${v.running ? 'running' : ''}" id="sw-go-${id}" type="button"
            data-sw="go" data-sec="${id}" aria-label="${esc(v.aria)}">${v.label}</button>
    <button class="sw-reset" id="sw-reset-${id}" type="button" data-sw="reset" data-sec="${id}"
            aria-label="Reset stopwatch for ${esc(sec.name || 'this block')}" ${v.showReset ? '' : 'hidden'}>${ICON.reset}</button>
  </div>`;
}

// Brings one section's stopwatch buttons in line with its state without a render.
function syncStopwatch(sid) {
  const sec = (WOD.sections || []).find(s => s.id === sid);
  const go = $('sw-go-' + sid), reset = $('sw-reset-' + sid);
  if (!sec || !go || !S.sections[sid]) return;
  const v = swView(sec, S.sections[sid].timer);
  go.textContent = v.label;
  go.classList.toggle('running', v.running);
  go.setAttribute('aria-label', v.aria);
  if (reset) reset.hidden = !v.showReset;
}

// Stops one section's stopwatch and writes what it read into the score.
// Seconds are floored: 8:41.9 is 8:41, the way any stopwatch displays it.
function pauseSectionTimer(sid, now) {
  const st = S.sections[sid];
  if (!st || !st.timer || !st.timer.running) return false;
  const timer = timerPause(st.timer, now);
  S.sections[sid] = { ...setScoreValue(st, 'time', clock(timer.accMs / 1000)), timer };
  return true;
}

/* ── block footer: score box, then RPE / note / + set for the whole block ── */

function renderBlockFooter(sec) {
  const st = S.sections[sec.id];
  const type = scoreOf(sec);
  const sc = st ? st.score : {};
  const scoreField = (prop, unit, mode, ph, val = sc[prop]) => field({
    id: `score-${sec.id}-${prop}`, val, unit, ph, mode: timeMode('score-' + prop, mode), cls: 'score-field',
    attrs: `data-score="${esc(sec.id)}" data-prop="${prop}"`,
    label: `${sec.name} result, ${unit}`
  });

  // A running stopwatch shows its live time; otherwise the field holds what
  // was typed or what the last pause wrote.
  const timer = st && st.timer;
  const liveTime = timer && timer.running ? clock(timerElapsedMs(timer, Date.now()) / 1000) : sc.time;
  const inputs = type === 'time' ? scoreField('time', 'mm:ss', 'text', '0:00', liveTime) + stopwatch(sec)
    : type === 'rounds_reps' ? scoreField('rounds', 'rounds', 'numeric', '0') + scoreField('reps', 'reps', 'numeric', '0')
    : type === 'total_reps' ? scoreField('totalReps', 'reps', 'numeric', '0')
    : '';
  const rowCls = type === 'rounds_reps' ? 'two' : type === 'time' && st ? 'timed' : '';
  const box = !type ? '' : `<div class="score">
    <div class="score-cap">Result · ${esc(scoreLabel(type))}</div>
    <div class="score-row ${rowCls}">${inputs}</div>
  </div>`;

  // "+ set" only makes sense when there is exactly one thing to add a set to.
  const exs = sec.exercises || [];
  const oneEx = !isRoundsSection(sec) && exs.length === 1 ? exs[0] : null;
  const note = S.notes[sec.id] || '';
  const noteOpen = !!note || openNotes.has(sec.id);
  const rpe = S.rpes[sec.id] ?? '';

  return `${box}
    <div class="block-foot">
      <div class="pills">
        ${showSectionRpe(sec) ? `<select class="pill-rpe ${rpe === '' ? '' : 'set'}" data-rpe="${esc(sec.id)}"
                aria-label="How hard ${esc(String(sec.name || 'this block').toLowerCase())} felt, 1 to 10">
          <option value="">RPE</option>
          ${rpeOptions('RPE', rpe)}
        </select>` : ''}
        <button class="pill" type="button" data-opennote="${esc(sec.id)}" ${noteOpen ? 'hidden' : ''}>+ note</button>
        ${oneEx ? `<button class="pill" type="button" data-add="${esc(oneEx.id)}">+ set</button>` : ''}
      </div>
      <div class="ex-note" data-noterow="${esc(sec.id)}" ${noteOpen ? '' : 'hidden'}>
        <textarea id="note-${esc(sec.id)}" data-note="${esc(sec.id)}"
                  placeholder="How this block went">${esc(note)}</textarea>
      </div>
    </div>`;
}

/* ── exercises ── */

function renderEx(ex, sec) {
  const skipped = isSkipped(ex.id);
  const added = S.added[ex.id] || [];
  const rows = allSets(ex).map((set, i) => renderSet(ex, set, i + 1, added.length > 0));
  const note = S.notes[ex.id] || '';
  const noteOpen = !!note || openNotes.has(ex.id);
  const rpe = S.rpes[ex.id] ?? '';
  // In a scored or rounds block, RPE and note belong to the block (see
  // renderBlockFooter); rating each movement of one effort is noise.
  const ownPills = !(sec && hasBlockFooter(sec));
  const slot = slotChip(sec, ex);

  return `<div class="ex ${skipped ? 'skipped' : ''}" data-ex="${ex.id}">
    <div class="ex-top">
      ${slot}<a class="ex-name" href="${esc(formLink(ex))}" target="_blank" rel="noopener">${esc(ex.movement)}${ICON.ext}</a>
      <label class="skip"><input type="checkbox" data-skip="${ex.id}" ${skipped ? 'checked' : ''}>Skip</label>
    </div>
    ${(ex.tag || ex.cue) ? `<p class="cue">${ex.tag ? `<span class="tag">${esc(ex.tag)}</span> · ` : ''}${esc(ex.cue || '')}</p>` : ''}
    ${partitionHint(ex.partition)}
    <div class="sets ${added.length ? 'has-added' : ''}">
      ${rows.join('')}
      ${ownPills ? `<div class="pills">
        ${showExerciseRpe(sec) ? `<select class="pill-rpe ${rpe === '' ? '' : 'set'}" data-rpe="${ex.id}"
                aria-label="How hard ${esc(ex.movement.toLowerCase())} felt, 1 to 10">
          <option value="">RPE</option>
          ${rpeOptions('RPE', rpe)}
        </select>` : ''}
        <button class="pill" type="button" data-opennote="${ex.id}" ${noteOpen ? 'hidden' : ''}>+ note</button>
        <button class="pill" type="button" data-add="${ex.id}">+ set</button>
      </div>
      <div class="ex-note" data-noterow="${ex.id}" ${noteOpen ? '' : 'hidden'}>
        <textarea id="note-${ex.id}" data-note="${ex.id}"
                  placeholder="How ${esc(ex.movement.toLowerCase())} went">${esc(note)}</textarea>
      </div>` : ''}
    </div>
  </div>`;
}

function renderSet(ex, set, n, reserveDelCol) {
  const k = ex.id + '.' + set.id;
  const v = S.sets[k] || {};
  const kind = set.kind || ex.kind || 'weight_reps';
  const dUnit = set.distanceUnit || unitOf('distance');

  const mid = kindFields(kind, v, { fid: prop => k + '-' + prop, dUnit, pace: set.pace });

  // Only added sets can be removed — a prescribed set is part of the plan and stays
  // on the page; Skip is what records that it wasn't done.
  const del = !reserveDelCol ? ''
    : set._added
      ? `<button class="btn-del" type="button" data-del="${k}" aria-label="Remove added set ${n}">×</button>`
      : '<span></span>';

  return `<div class="set k-${kind}" data-set="${k}">
    <span class="set-n ${set._added ? 'added' : ''}">Set ${n}${set.loadBwMult != null ? bwChip(set.loadBwMult) : ''}</span>
    ${mid}
    ${del}
  </div>`;
}

/* ── render: library ─────────────────────────────────────────── */

function renderLibrary() {
  const list = library();
  const items = list.map(x => {
    const log = readJSON(logKey(x.workoutId), null);
    // Three states, because "touched" and "finished" are different facts and the
    // athlete needs to know which sessions they still owe their coach.
    const sent = log && log.submittedAt;
    const started = log && (log.elapsed || Object.keys(log.notes || {}).length || log.summary);
    const badge = sent ? { text: 'Logged', cls: 'done' }
                : started ? { text: 'In progress', cls: '' }
                : { text: 'New', cls: 'dim' };

    // Removing is confirmed inline rather than with a dialog, because a mis-tap
    // here would throw away a logged session with nothing else holding a copy.
    if (pendingRemove === x.workoutId) {
      return `<div class="lib-item confirming">
        <span class="col">
          <span class="t">Remove this?</span>
          <span class="d">${started || sent ? 'It has entries you logged — they go too' : 'Nothing logged yet'}</span>
        </span>
        <button class="lib-btn danger" type="button" data-remove="${esc(x.workoutId)}">Remove</button>
        <button class="lib-btn" type="button" data-cancel-remove="1">Keep</button>
      </div>`;
    }

    return `<div class="lib-item">
      <a class="col" href="#id=${encodeURIComponent(x.workoutId)}">
        <span class="t">${esc(x.title)}</span>
        <span class="d">${esc(x.date)}</span>
      </a>
      <span class="badge ${badge.cls}">${badge.text}</span>
      <button class="lib-x" type="button" data-ask-remove="${esc(x.workoutId)}"
              aria-label="Remove ${esc(x.title)}">×</button>
    </div>`;
  }).join('');

  // An installed iOS web app gets its own storage, separate from the browser's,
  // and iOS never opens an in-scope link in it. So the library it sees can only
  // ever be filled by pasting — saying "your link opens straight into this app"
  // would be a plain lie here.
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  const empty = installed
    ? `<div class="lib-empty">
         <p><b>Nothing here yet.</b> Workout links open in your browser, not in this
         installed app — and the two keep separate storage, so what you opened there
         doesn't show up here.</p>
         <p style="margin-bottom:0">Copy the link your coach sent and paste it below.
         After that the workout lives here, and works with no signal.</p>
       </div>`
    : `<div class="lib-empty">
         <p><b>Nothing here yet.</b> Your coach or agent sends you a link and the
         workout opens straight into this app — after that it stays on this device,
         listed here, and works with no signal.</p>
         <p style="margin-bottom:0">A link looks like <code>…/WODin/#w=…</code></p>
       </div>`;

  $('app').innerHTML = `
    <header>
      <div class="eyebrow"><b>WODin</b></div>
      <h1>Your workouts</h1>
    </header>
    ${list.length ? `<div class="lib">${items}</div>` : empty}
    <div class="paste">
      <button class="pill" type="button" id="paste">Paste a workout link</button>
      <div class="paste-manual" id="pasteManual" hidden>
        <input id="pasteInput" type="url" inputmode="url" autocomplete="off"
               placeholder="Paste the link here" aria-label="Workout link">
        <button class="lib-btn danger" type="button" id="pasteGo">Open</button>
      </div>
      <p class="paste-error" id="pasteError" hidden></p>
    </div>
    ${footer()}`;
}

function pasteProblem(msg) {
  const box = $('pasteError');
  if (!box) return;
  box.textContent = msg;
  box.hidden = !msg;
}

// Accepts a full link or a bare fragment, so it works whether the athlete copied
// the whole URL or the tail of one. `quiet` suppresses complaints, for the
// speculative clipboard read where the athlete never claimed to have copied a link.
//
// The workout is decoded here rather than after navigating, so a bad link can say
// what is wrong with it. Silently landing back on an unchanged library was the
// worst version of this: indistinguishable from the button not working.
async function openPastedLink(text, quiet) {
  const raw = String(text).trim();
  const m = raw.match(/#?((?:w|wj|id)=[^\s&#]+)/);

  // An elided link — "…/WODin/#w=…" — is the displayed text of a link rather than
  // the link itself, and it is what you get by selecting a link instead of copying
  // it. It partly matches the pattern, so check before trying to decode.
  if (raw.includes('…') || raw.includes('...')) {
    if (!quiet) {
      pasteProblem('That is the shortened text shown for a link, not the link itself. Long-press it and choose Copy Link, or use Share from the app it arrived in.');
    }
    return false;
  }

  if (!m) {
    if (!quiet) {
      pasteProblem('That is not a workout link — a real one contains #w= followed by a long code.');
    }
    return false;
  }

  const hash = '#' + m[1];
  try {
    const wod = await decodeFragment(hash);
    if (!wod || !wod.sections) throw new Error('no workout');
  } catch {
    if (!quiet) {
      pasteProblem('That link is damaged, most likely cut short when it was copied — they run to about 1,600 characters. Copy it again with Copy Link, or use Share from the app it arrived in.');
    }
    return false;
  }

  pasteProblem('');
  if (location.hash === hash) { route(); return true; }
  location.hash = hash;
  return true;
}

function pasteLink() {
  // The field opens first and the clipboard is only a shortcut. Reading the
  // clipboard can sit behind a permission prompt that never resolves, and a
  // button that appears to do nothing is worse than one extra paste.
  const manual = $('pasteManual');
  if (manual) {
    manual.hidden = false;
    $('pasteInput').focus();
  }

  navigator.clipboard?.readText?.()
    .then(text => { if (text) openPastedLink(text, true); })
    .catch(() => { /* denied, unsupported, or still prompting — the field is there */ });
}

/* ── events ──────────────────────────────────────────────────── */

// Rewrites an auto-format field while it is typed ("841" → "8:41", pace
// "158" → "1:58") using format.js's formatter for `prop`, and returns the value
// to store. A reformat moves the caret to the end: keypad entry only ever
// appends, and a computed mid-string position can land on the wrong side of a
// colon the formatter just inserted. Fields with no formatter pass through.
function keypadTime(el, prop) {
  const fmt = timeFormatterFor(prop);
  if (!fmt) return el.value;
  const val = fmt(el.value);
  if (val !== el.value) {
    el.value = val;
    try { el.setSelectionRange(val.length, val.length); } catch { /* not focusable */ }
  }
  return val;
}

// Bound exactly once. #app survives every render — only its innerHTML is replaced —
// so binding inside render() would stack a listener per render, and one click would
// then fire every one of them.
function bind() {
  const app = $('app');

  app.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'pasteInput') {
      e.preventDefault();
      openPastedLink(e.target.value);
    }
  });

  app.addEventListener('input', e => {
    const el = e.target;
    const id = el.id || '';
    if (id === 'pasteInput') return;

    if (id === 'f-summary')  { S.summary = el.value; return save(); }
    // Duration has to live in state, not just the DOM: any re-render rebuilds
    // this field, and a typed value that only existed in the input was lost the
    // moment the athlete tapped a pill. Typed like every other time box: digits
    // only, colons inserted as it goes ("841" -> "8:41"); the stored string is
    // the same h:mm:ss / m:ss text as ever.
    if (id === 'f-duration') { S.duration = keypadTime(el, 'duration'); return save(); }

    if (el.dataset && el.dataset.note) { S.notes[el.dataset.note] = el.value; return save(); }

    // Round movements and score boxes write into S.sections and never
    // re-render, so the field being typed in keeps its focus and caret.
    if (el.dataset && el.dataset.rm) {
      const ref = splitRef(el.dataset.rm, 2);
      if (!ref || !S.sections[ref[0]]) return;
      const prop = el.dataset.prop;
      const val = keypadTime(el, prop);
      S.sections[ref[0]] = setMovementValue(S.sections[ref[0]], ref[1], ref[2], prop, val);
      return save();
    }
    if (el.dataset && el.dataset.score) {
      const sid = el.dataset.score;
      if (!S.sections[sid]) return;
      const prop = el.dataset.prop;
      const val = keypadTime(el, 'score-' + prop);
      S.sections[sid] = setScoreValue(S.sections[sid], prop, val);
      // A typed time beats the stopwatch: it stops (if running) and holds the
      // typed value, so Start carries on from it. Buttons update in place.
      if (prop === 'time' && S.sections[sid].timer) {
        S.sections[sid].timer = timerSetMs(S.sections[sid].timer, (toSec(val) ?? 0) * 1000);
        syncStopwatch(sid);
      }
      return save();
    }

    const m = id.match(/^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)-(load|reps|distance|duration|pace)$/);
    if (!m) return;
    const [, key, prop] = m;
    const val = keypadTime(el, prop);

    S.sets[key] = S.sets[key] || {};
    S.sets[key][prop] = val;
    save();
  });

  app.addEventListener('click', e => {
    const openNote = e.target.closest('[data-opennote]');
    if (openNote) {
      openNotes.add(openNote.dataset.opennote);
      renderWorkout();
      const ta = $('note-' + openNote.dataset.opennote);
      if (ta) ta.focus();
      return;
    }

    // The header row expands or collapses; the round's checkbox sits outside
    // this button, so ticking a round never also toggles it.
    const rt = e.target.closest('[data-round-toggle]');
    if (rt) {
      const ref = splitRef(rt.dataset.roundToggle, 1);
      const st = ref && S.sections[ref[0]];
      if (!st) return;
      const key = ref[0] + ':' + ref[1];
      openRounds.set(key, !roundIsOpen(st.rounds, ref[1] - 1, openRounds.get(key)));
      renderWorkout();
      return;
    }

    const sw = e.target.closest('[data-sw]');
    if (sw) return onStopwatch(sw.dataset.sec, sw.dataset.sw);

    const pill = e.target.closest('[data-pill]');
    if (pill) {
      const sid = pill.dataset.sec;
      const cut = pill.dataset.pill.indexOf(':');
      const group = pill.dataset.pill.slice(0, cut), id = pill.dataset.pill.slice(cut + 1);
      if (!S.sections[sid] || (group !== 'optional' && group !== 'modifiers')) return;
      S.sections[sid] = togglePill(S.sections[sid], group, id);
      save(); renderWorkout();
      return;
    }

    const add = e.target.closest('[data-add]');
    if (add) {
      const list = S.added[add.dataset.add] = S.added[add.dataset.add] || [];
      let n = 1;
      while (list.includes('a' + n)) n++;
      list.push('a' + n);
      seedAdded(); save(); renderWorkout();
      return;
    }

    const del = e.target.closest('[data-del]');
    if (del) {
      const [exId, setId] = del.dataset.del.split('.');
      S.added[exId] = (S.added[exId] || []).filter(x => x !== setId);
      delete S.sets[del.dataset.del];
      save(); renderWorkout();
      return;
    }

    if (e.target.id === 'paste') return pasteLink();
    if (e.target.id === 'pasteGo') return void openPastedLink($('pasteInput').value);

    const ask = e.target.closest('[data-ask-remove]');
    if (ask) { pendingRemove = ask.dataset.askRemove; return renderLibrary(); }

    if (e.target.closest('[data-cancel-remove]')) { pendingRemove = null; return renderLibrary(); }

    const remove = e.target.closest('[data-remove]');
    if (remove) {
      forget(remove.dataset.remove);
      pendingRemove = null;
      toast('Removed');
      return renderLibrary();
    }

    if (e.target.id === 'toggle') return toggleTimer();
    if (e.target.closest('#reset')) {
      S.running = false; S.elapsed = 0; S.startedAt = null;
      save(); renderWorkout(); runTick(); return;
    }
    if (e.target.closest('#shareWod')) return void shareWod();
    if (e.target.id === 'log') return openSheet();
    if (e.target.closest('#home')) {
      e.preventDefault();
      location.hash = '';
      route();
    }
  });

  app.addEventListener('change', e => {
    if (e.target.id === 'f-rpe') {
      S.rpe = e.target.value;
      // Deliberately no re-render: the select shows its own choice, and
      // rebuilding the section here would fight whatever is being typed below.
      e.target.classList.toggle('set', e.target.value !== '');
      return save();
    }

    const rated = e.target.dataset && e.target.dataset.rpe;
    if (rated) {
      // Clearing it removes the key entirely: unrated and "felt easy" are
      // different answers, and the result must not conflate them.
      if (e.target.value) S.rpes[rated] = Number(e.target.value);
      else delete S.rpes[rated];
      save(); renderWorkout();
      return;
    }

    const ds = e.target.dataset || {};
    if (ds.roundCheck || ds.mvCheck) return onRoundTick(ds.roundCheck, ds.mvCheck, e.target.checked);

    const sk = ds.skip;
    if (!sk) return;
    S.skipped = e.target.checked
      ? [...new Set([...S.skipped, sk])]
      : S.skipped.filter(x => x !== sk);
    save(); renderWorkout();
  });

  // Timers are worked out from timestamps, so a tab coming back from the
  // background (or a phone waking) only needs a repaint, not a catch-up.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && WOD && S) runTick();
  });
}

// Start / Pause / Resume and Reset on a section stopwatch. Start runs from
// whatever the field shows, so a typed 8:41 then Start carries on from 8:41.
function onStopwatch(sid, act) {
  const st = sid && S && S.sections[sid];
  if (!st) return;
  const now = Date.now();
  if (act === 'reset') {
    S.sections[sid] = { ...setScoreValue(st, 'time', ''), timer: timerReset() };
  } else if (st.timer && st.timer.running) {
    pauseSectionTimer(sid, now);
  } else {
    const input = $('score-' + sid + '-time');
    const shown = toSec(input ? input.value : st.score.time) ?? 0;
    // Resuming a paused stopwatch keeps its sub-second remainder, unless the
    // field now says something else — then the field wins.
    const acc = timerElapsedMs(st.timer, now);
    const fromMs = Math.floor(acc / 1000) === shown ? acc : shown * 1000;
    S.sections[sid] = { ...st, timer: timerStart(st.timer, now, fromMs) };
  }
  save(); renderWorkout(); runTick();
}

// A tick on a round or one of its movements. The round check rule itself is in
// format.js; what happens here is the view. When a tick finishes a round, any
// open/shut taps in that block are forgotten so the page moves on to the next
// round by itself — the athlete's hands are on a bar, not on the screen.
function onRoundTick(roundRef, mvRef, checked) {
  const ref = roundRef ? splitRef(roundRef, 1) : splitRef(mvRef, 2);
  const st = ref && S.sections[ref[0]];
  if (!st) return;
  const [sid, i, j] = ref;
  const wasDone = roundDone(st.rounds[i] || {});
  S.sections[sid] = roundRef ? checkRound(st, i, checked) : checkMovement(st, i, j, checked);
  if (!wasDone && roundDone(S.sections[sid].rounds[i] || {})) {
    for (const k of [...openRounds.keys()]) if (splitRef(k, 1)?.[0] === sid) openRounds.delete(k);
  }
  save(); renderWorkout();
}

/* ── timer ───────────────────────────────────────────────────── */

const elapsedNow = () =>
  S.running && S.startedAt ? (Date.now() - S.startedAt) / 1000 : S.elapsed;

function toggleTimer() {
  if (S.running) {
    S.elapsed = elapsedNow();
    S.running = false; S.startedAt = null;
  } else {
    S.running = true;
    S.startedAt = Date.now() - S.elapsed * 1000;
  }
  save(); renderWorkout(); runTick();
}

const runningSections = () =>
  Object.keys((S && S.sections) || {}).filter(sid => S.sections[sid].timer?.running);

// Repaints every running clock from timestamps — nothing here counts ticks,
// so a late or skipped interval costs nothing. A field the athlete is in is
// left alone. Returns whether anything is still running.
function paintClocks() {
  if (!S || !WOD) return false;
  const now = Date.now();
  if (S.running) {
    const el = $('clock');
    if (el) el.textContent = clock(elapsedNow());
    const dur = $('f-duration');
    if (dur && document.activeElement !== dur) dur.value = clock(elapsedNow());
  }
  const live = runningSections();
  live.forEach(sid => {
    const el = $('score-' + sid + '-time');
    if (el && document.activeElement !== el) el.value = clock(timerElapsedMs(S.sections[sid].timer, now) / 1000);
  });
  return S.running || live.length > 0;
}

// One interval drives the session clock and every running section stopwatch.
// Safe to call any time: it restarts cleanly, and stops itself once nothing runs.
function runTick() {
  clearInterval(tick);
  tick = null;
  if (!paintClocks()) return;
  // 4 Hz, not 1: every value is recomputed from Date.now(), so the rate only
  // decides how soon a new second shows (a 1 s tick lags the real second by up to 1 s).
  tick = setInterval(() => {
    if (!paintClocks()) { clearInterval(tick); tick = null; }
  }, 250);
}

/* ── digest + result ─────────────────────────────────────────── */

function setValues(ex, set) {
  const v = S.sets[ex.id + '.' + set.id] || {};
  const kind = set.kind || ex.kind || 'weight_reps';
  const dUnit = set.distanceUnit || unitOf('distance');

  if (kind === 'weight_reps') return `${v.load || '—'}×${v.reps || '—'}`;
  if (kind === 'reps')        return `${v.reps || '—'}`;
  if (kind === 'time')        return `${v.duration || '—'}`;
  if (kind === 'carry')       return `${v.load || '—'}×${v.reps || '—'} ${v.distance || '—'}${dUnit}`;
  if (kind === 'cardio')      return `${v.pace || '—'} pace / ${v.distance || '—'}${dUnit} / ${v.duration || '—'}`;
  return '';
}

function buildDigest() {
  const lines = [];
  const dur = ($('f-duration') || {}).value || (S.elapsed ? clock(S.elapsed) : '—');

  lines.push(`WODin ${WOD.workoutId} · ${WOD.title || WOD.athleteTitle || ''}`.trim());
  lines.push([dur, sessionRpeText(WOD, S.rpe)].filter(Boolean).join(' · '));

  const width = 18;
  (WOD.sections || []).forEach(sec => {
    const rows = [];
    // A footer block rates and annotates the block, not its movements, so its
    // exercise rows carry no RPE or note of their own.
    const footer = hasBlockFooter(sec);
    loggedExercises(sec).forEach(ex => {
      const exRpe = !footer && showExerciseRpe(sec) && S.rpes[ex.id];
      rows.push('  ' + ex.movement.padEnd(width) + ' ' + allSets(ex).map(s => setValues(ex, s)).join(', ')
        + (exRpe ? '  · RPE ' + exRpe : ''));
      const note = footer ? '' : (S.notes[ex.id] || '').trim();
      if (note) rows.push('  ' + ' '.repeat(width) + ' ↳ ' + note);
    });
    if (usesFormatFeatures(sec)) {
      rows.push(...digestSectionLines(sec, S.sections[sec.id], {
        units: WOD.units,
        rpe: footer ? S.rpes[sec.id] : null,
        note: footer ? S.notes[sec.id] : null
      }));
    }
    if (!rows.length) return;
    lines.push('', sec.name.toUpperCase(), ...rows);
  });

  const skipped = setExercises().filter(ex => isSkipped(ex.id));
  if (skipped.length) lines.push('', 'SKIPPED  ' + skipped.map(e => e.movement).join(', '));
  if (S.summary.trim()) lines.push('', 'Summary: ' + S.summary.trim());

  return lines.join('\n');
}

const num = v => (v === '' || v == null) ? null : (isNaN(Number(v)) ? v : Number(v));

function isAsPlanned(set, v, kind) {
  if (set._added) return false;
  const same = (a, b) => String(a ?? '') === String(b ?? '');
  const loadOk = set.loadType === 'bodyweight' ? v.load === 'BW' : same(v.load, set.load);
  if (kind === 'weight_reps') return loadOk && same(v.reps, set.reps);
  if (kind === 'reps')        return same(v.reps, set.reps);
  if (kind === 'time')        return same(v.duration, set.duration);
  if (kind === 'carry')       return loadOk && same(v.reps, set.reps) && same(v.distance, set.distance);
  if (kind === 'cardio')      return same(v.distance, set.distance) && same(v.duration, set.duration);
  return true;
}

function buildResult() {
  const log = {}, notes = {}, exerciseRpe = {};

  (WOD.sections || []).forEach(sec => loggedExercises(sec).forEach(ex => {
    const note = (S.notes[ex.id] || '').trim();
    if (note) notes[ex.id] = note;
    if (S.rpes[ex.id] && showExerciseRpe(sec)) exerciseRpe[ex.id] = S.rpes[ex.id];

    allSets(ex).forEach(set => {
      const k = ex.id + '.' + set.id;
      const v = S.sets[k] || {};
      const kind = set.kind || ex.kind || 'weight_reps';
      const entry = {};

      if (kind === 'weight_reps' || kind === 'carry') {
        if (v.load === 'BW') entry.loadType = 'bodyweight';
        else entry.load = num(v.load);
      }
      if (kind === 'weight_reps' || kind === 'reps' || kind === 'carry') entry.reps = num(v.reps);
      if (kind === 'carry')  entry.distance = num(v.distance);
      if (kind === 'cardio') { entry.distance = num(v.distance); entry.pace = v.pace || null; }
      if (kind === 'time' || kind === 'cardio') {
        entry.duration = v.duration || null;
        entry.durationSec = toSec(v.duration);
      }
      if (set._added) entry.added = true;
      entry.asPlanned = isAsPlanned(set, v, kind);
      log[k] = entry;
    });
  }));

  // Footer blocks key their RPE and note by section id in the same two maps.
  const block = sectionNotesAndRpe(WOD, S.notes, S.rpes);
  Object.assign(notes, block.notes);
  Object.assign(exerciseRpe, block.exerciseRpe);

  const durStr = ($('f-duration') || {}).value || (S.elapsed ? clock(S.elapsed) : null);
  const roundIds = roundExerciseIds();
  // `log` stays sets-only; scores, pills and round ticks go under `sections`.
  return withSections({
    schema: 'wodin/result@1',
    workoutId: WOD.workoutId,
    startedAt: S.startedAt ? new Date(S.startedAt).toISOString() : null,
    submittedAt: new Date().toISOString(),
    duration: durStr || null,
    durationSec: toSec(durStr),
    // Asked: the answer or null, as always. Assumed: the policy's value with
    // rpeAssumed: true, whatever an old saved log holds. Hidden: null.
    ...sessionRpeResult(WOD, S.rpe),
    athleteSummary: S.summary.trim() || null,
    log,
    notes,
    exerciseRpe,
    skipped: S.skipped.filter(id => !roundIds.has(id))
  }, WOD, S.sections);
}

/* ── submit sheet ────────────────────────────────────────────── */

/* Two delivery modes, because endpoints differ in what they can be made to do.
 *
 *   default — JSON + any sink.headers. Cross-origin, so the browser preflights:
 *             the endpoint must answer OPTIONS and allow the headers used.
 *             We can read the response, so delivery is confirmed.
 *
 *   "blind" — no-cors. Content type drops to text/plain so it qualifies as a
 *             simple request and no preflight happens, which means it reaches an
 *             endpoint that knows nothing about CORS with zero server changes.
 *             The response is opaque, so we cannot tell success from failure and
 *             must not claim otherwise. sink.headers are dropped — no-cors
 *             forbids custom headers.
 */
async function postResult() {
  const { url, headers = {}, mode } = WOD.sink;
  const body = JSON.stringify(buildResult());

  if (mode === 'blind') {
    try {
      await fetch(url, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body
      });
      toast('Sent — delivery not confirmed');
      $('scrim').hidden = true;
      return true;
    } catch {
      toast('No signal — nothing sent');
      return false;
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body
    });
    // A readable response is the only case we can speak about with certainty.
    if (res.ok) {
      toast('Sent');
      $('scrim').hidden = true;
      return true;
    }
    // Definitely not accepted — leave the sheet open so Share and Copy are one tap away.
    toast(`Rejected by the server (${res.status})`);
    return false;
  } catch {
    // A cors-mode fetch rejects identically whether the request never left or it
    // was delivered and the response merely omitted Access-Control-Allow-Origin.
    // Those are indistinguishable from here, and the second is common enough that
    // reporting failure is usually the wrong call — the payload already landed.
    // Only an offline device lets us say "nothing sent" honestly.
    if (navigator.onLine) {
      toast('Sent — delivery not confirmed');
      $('scrim').hidden = true;
      return true;
    }
    toast('No signal — nothing sent');
    return false;
  }
}

function sink(act, icon, title, desc, primary) {
  return `<button class="sink ${primary ? 'primary' : ''}" type="button" data-sink="${act}">
    ${icon}<span class="col"><span class="t">${title}</span><span class="d">${desc}</span></span>
  </button>`;
}

function openSheet() {
  // Reaching for Submit ends the session, so stop the clock before reading it.
  // Pause rather than reset: nothing is destroyed, and Resume is there if the
  // sheet was opened early. It also keeps the duration honest — a clock still
  // running behind the sheet would show one number in the preview and send
  // another by the time anything was tapped.
  // Section stopwatches stop the same way, writing their time into the score.
  let stopped = false;
  if (S.running) {
    S.elapsed = elapsedNow();
    S.running = false;
    S.startedAt = null;
    stopped = true;
  }
  const now = Date.now();
  runningSections().forEach(sid => { if (pauseSectionTimer(sid, now)) stopped = true; });
  if (stopped) {
    save();
    renderWorkout();
    runTick();
  }

  $('digest').textContent = buildDigest();

  const canShare = typeof navigator.share === 'function';
  const posting = WOD.sink && WOD.sink.type === 'post' && WOD.sink.url;

  $('sinks').innerHTML = [
    posting ? sink('post', ICON.send, 'Send to coach',
      WOD.sink.mode === 'blind' ? 'Posts to your agent — no delivery receipt' : 'Posts straight to your agent',
      true) : '',
    canShare ? sink('share', ICON.share, 'Share', 'Hand it to any app', !posting) : '',
    sink('copy', ICON.copy, 'Copy summary', 'Paste into any chat', !posting && !canShare),
    sink('download', ICON.json, 'Download JSON', 'The structured result payload', false)
  ].join('');

  $('scrim').hidden = false;
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

$('scrim').addEventListener('click', async e => {
  if (e.target.id === 'scrim' || e.target.id === 'sheetClose') { $('scrim').hidden = true; return; }
  const btn = e.target.closest('[data-sink]');
  if (!btn) return;

  const digest = buildDigest();

  // Handing the result off in any form is the athlete finishing with this
  // session — that is what the library's "Logged" badge reports. A copy is not
  // proof it was pasted, but it is the last thing we can observe, and leaving a
  // finished workout labelled "In progress" forever is the worse error.
  const markSent = () => { S.submittedAt = new Date().toISOString(); save(); };

  switch (btn.dataset.sink) {
    case 'post':
      if (await postResult()) markSent();
      break;

    case 'share':
      try {
        await navigator.share({ title: 'WODin ' + WOD.workoutId, text: digest });
        markSent();
        $('scrim').hidden = true;
      } catch { /* dismissed */ }
      break;

    case 'copy':
      try {
        await navigator.clipboard.writeText(digest);
        markSent();
        toast('Summary copied'); $('scrim').hidden = true;
      } catch { toast("Couldn't copy — select the text above"); }
      break;

    default: {
      const blob = new Blob([JSON.stringify(buildResult(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `wodin-${WOD.workoutId}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      markSent();
      toast('Downloaded');
      $('scrim').hidden = true;
    }
  }
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') $('scrim').hidden = true; });

/* ── routing ─────────────────────────────────────────────────── */

async function resolveWod() {
  if (location.hash) {
    try {
      const wod = await decodeFragment(location.hash);
      if (wod) return wod;
    } catch (err) {
      console.warn('Could not read the workout from this link:', err);
      toast("That link's workout could not be read");
    }
  }

  const d = new URLSearchParams(location.search).get('d');
  if (d) {
    try {
      const res = await fetch(`wods/${encodeURIComponent(d)}.json`);
      if (res.ok) return await res.json();
    } catch { /* offline or absent — fall through to the library */ }
  }
  return null;
}

async function route() {
  clearInterval(tick);
  pendingRemove = null;
  openRounds.clear();
  const wod = await resolveWod();

  if (!wod) { WOD = null; S = null; renderLibrary(); return; }

  WOD = normalise(wod);
  remember(WOD);
  S = loadState();
  seedAdded();
  renderWorkout();
  runTick();
}

/* ── sharing the workout onward ──────────────────────────────
 *
 * The link you were sent carries `sink` — the address, and possibly the token,
 * that submits a result to your agent. Passing that link to a training partner
 * would hand them the ability to post workouts as you.
 *
 * So sharing re-encodes the plan with `sink` removed. They get the workout and
 * can log it for themselves; their Submit offers Share and Copy, and has
 * nowhere to post. Nothing else is stripped — the coach note travels with it,
 * which is worth knowing if yours carries anything personal.
 */
async function shareWod() {
  if (!WOD) return;

  const plan = JSON.parse(JSON.stringify(WOD));
  delete plan.sink;

  const url = location.origin + location.pathname + '#' + await encodeFragment(plan);
  const title = [WOD.title, WOD.athleteTitle].filter(Boolean)[0] || 'Workout';

  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch { /* dismissed, or unavailable — fall through to the clipboard */ }
  }

  try {
    await navigator.clipboard.writeText(url);
    toast('Workout link copied — without your submit link');
  } catch {
    toast("Couldn't copy the link");
  }
}

/* ── "open it in the app" ────────────────────────────────────
 *
 * Only offered when all three are true: this is a browser tab rather than the
 * installed app, we are on Android, and the app really is installed. Anything
 * less and it is a nag for something the reader cannot act on.
 *
 * It offers copy-and-paste rather than a launch because an Android intent:// URI
 * cannot carry a fragment — the intent syntax claims "#" for itself — and the
 * whole workout lives in ours. An intent launch would open the app at its base
 * URL with an empty library, which is worse than not offering. Chrome's own
 * ⋮ → Open in <app> does preserve the fragment, so the hint points there too.
 */
const DISMISS_KEY = 'wodin:openapp-dismissed';

async function maybeOfferApp() {
  const installedHere = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (installedHere) return;
  if (!/android/i.test(navigator.userAgent)) return;
  if (readJSON(DISMISS_KEY, false)) return;
  if (!navigator.getInstalledRelatedApps) return;

  let apps = [];
  try { apps = await navigator.getInstalledRelatedApps(); } catch { return; }
  if (!apps.length) return;

  $('openApp').hidden = false;
}

document.getElementById('openApp').addEventListener('click', async e => {
  if (e.target.id === 'openAppDismiss') {
    writeJSON(DISMISS_KEY, true);
    $('openApp').hidden = true;
    return;
  }
  if (e.target.id !== 'openAppCopy') return;
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied — open WODin and tap Paste');
  } catch {
    toast("Couldn't copy — use Chrome's ⋮ menu instead");
  }
});

window.addEventListener('hashchange', route);

bind();
route();
maybeOfferApp();

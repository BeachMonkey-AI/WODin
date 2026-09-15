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

// Replaced by scripts/build.mjs with the same content hash the service worker
// caches under. Shown in the library so "is this thing even updated?" is a
// question you can answer by looking, rather than by guessing.
const BUILD = '5cf9a4cc';

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

// Every movement links out to a form check unless the plan overrides it.
const formLink = ex => ex.link ||
  'https://www.youtube.com/results?search_query=' + encodeURIComponent(ex.movement + ' form');

function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function toSec(str) {
  if (!str) return null;
  const p = String(str).split(':').map(Number);
  if (p.some(isNaN)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2]
       : p.length === 2 ? p[0] * 60 + p[1]
       : p[0];
}

// "158" → "1:58". Lets a numeric keypad produce mm:ss with no colon key.
function fmtTime(raw) {
  const d = String(raw).replace(/\D/g, '').slice(0, 6);
  if (d.length <= 2) return d;
  return d.slice(0, -2).replace(/^0+(?=\d)/, '') + ':' + d.slice(-2);
}

/* ── app ─────────────────────────────────────────────────────── */

let WOD = null;
let S = null;
const openNotes = new Set();
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
    rpe: '', summary: '',
    skipped: [], sets, notes: {}, added: {}
  };
}

function loadState() {
  const fresh = seedState();
  const saved = readJSON(logKey(WOD.workoutId), null);
  if (!saved) return fresh;
  const merged = { ...fresh, ...saved, sets: { ...fresh.sets, ...(saved.sets || {}) } };
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

function field({ id, val, unit, ph, mode, cls }) {
  const uw = Math.max(2, String(unit || '').length) + 'ch';
  return `<label class="field ${cls || ''}" style="--uw:${uw}">
    <input id="${id}" value="${esc(val ?? '')}" placeholder="${esc(ph ?? '')}"
           inputmode="${mode || 'decimal'}" autocomplete="off"
           aria-label="${esc(id.replace(/[.\-]/g, ' '))}">
    <span class="unit">${esc(unit || '')}</span>
  </label>`;
}

/* ── render: workout ─────────────────────────────────────────── */

function renderWorkout() {
  const d = new Date((WOD.date || WOD.workoutId) + 'T12:00:00');
  const nice = isNaN(d) ? (WOD.date || '')
    : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

  const head = `
    <header>
      <div class="eyebrow"><a href="#" id="home">← WODin</a><span>${esc(nice)}</span></div>
      <h1>${esc(WOD.athleteTitle || WOD.title || 'Workout')}</h1>
      ${WOD.athleteTitle && WOD.title ? `<h2>${esc(WOD.title)}</h2>` : ''}
      <div class="meta">
        ${WOD.program ? `<span class="prog">${esc(WOD.program)}</span>` : ''}
        ${WOD.estDuration ? `<span>${esc(WOD.estDuration)}</span>` : ''}
        ${WOD.targetRpe ? `<span>target RPE ${WOD.targetRpe}</span>` : ''}
      </div>
      ${WOD.coachNote ? `<p class="coach">${esc(WOD.coachNote)}</p>` : ''}
    </header>

    <div class="timer">
      <span class="clock ${S.elapsed || S.running ? '' : 'idle'}" id="clock">${clock(S.elapsed)}</span>
      <button class="btn-reset" id="reset" type="button" aria-label="Reset timer"
              ${S.elapsed || S.running ? '' : 'hidden'}>${ICON.reset}</button>
      <button class="btn-timer ${S.running ? 'running' : ''}" id="toggle" type="button">
        ${S.running ? 'Pause' : (S.elapsed ? 'Resume' : 'Start')}
      </button>
    </div>`;

  const body = (WOD.sections || []).map(sec => `
    <div class="sec-head">${esc(sec.name)}</div>
    ${(sec.exercises || []).map(renderEx).join('')}
  `).join('');

  const rpeGhost = WOD.targetRpe ? `Rx ${WOD.targetRpe}` : '—';
  const close = `
    <section class="close">
      <div class="close-grid">
        <div>
          <span class="fl">Duration <b>from timer</b></span>
          ${field({ id: 'f-duration', val: S.elapsed ? clock(S.elapsed) : '', unit: '', ph: '—', mode: 'numeric' })}
        </div>
        <div>
          <span class="fl">Session RPE <b>optional</b></span>
          ${field({ id: 'f-rpe', val: S.rpe, unit: '/10', ph: rpeGhost, mode: 'numeric' })}
        </div>
      </div>
      <div class="block">
        <span class="fl">How it went</span>
        <textarea id="f-summary" placeholder="How it felt, what to remember">${esc(S.summary)}</textarea>
      </div>
      <button class="btn-log" id="log" type="button">Log workout</button>
    </section>`;

  $('app').innerHTML = head + body + close;
}

function renderEx(ex) {
  const skipped = isSkipped(ex.id);
  const added = S.added[ex.id] || [];
  const rows = allSets(ex).map((set, i) => renderSet(ex, set, i + 1, added.length > 0));
  const note = S.notes[ex.id] || '';
  const noteOpen = !!note || openNotes.has(ex.id);

  return `<div class="ex ${skipped ? 'skipped' : ''}" data-ex="${ex.id}">
    <div class="ex-top">
      <a class="ex-name" href="${esc(formLink(ex))}" target="_blank" rel="noopener">${esc(ex.movement)}${ICON.ext}</a>
      <label class="skip"><input type="checkbox" data-skip="${ex.id}" ${skipped ? 'checked' : ''}>Skip</label>
    </div>
    ${(ex.tag || ex.cue) ? `<p class="cue">${ex.tag ? `<span class="tag">${esc(ex.tag)}</span> · ` : ''}${esc(ex.cue || '')}</p>` : ''}
    <div class="sets ${added.length ? 'has-added' : ''}">
      ${rows.join('')}
      <div class="pills">
        <button class="pill" type="button" data-add="${ex.id}">+ set</button>
        <button class="pill" type="button" data-opennote="${ex.id}" ${noteOpen ? 'hidden' : ''}>+ note</button>
      </div>
      <div class="ex-note" data-noterow="${ex.id}" ${noteOpen ? '' : 'hidden'}>
        <textarea id="note-${ex.id}" data-note="${ex.id}"
                  placeholder="How ${esc(ex.movement.toLowerCase())} went">${esc(note)}</textarea>
      </div>
    </div>
  </div>`;
}

function renderSet(ex, set, n, reserveDelCol) {
  const k = ex.id + '.' + set.id;
  const v = S.sets[k] || {};
  const kind = set.kind || ex.kind || 'weight_reps';
  const dUnit = set.distanceUnit || unitOf('distance');

  let mid = '';
  if (kind === 'weight_reps') {
    const bw = v.load === 'BW';
    mid = field({ id: k + '-load', val: v.load, unit: bw ? '' : unitOf('load'), ph: unitOf('load'), cls: bw ? 'bw' : '' })
        + `<span class="times">×</span>`
        + field({ id: k + '-reps', val: v.reps, unit: 'reps', mode: 'numeric' });
  } else if (kind === 'reps') {
    mid = field({ id: k + '-reps', val: v.reps, unit: 'reps', mode: 'numeric' });
  } else if (kind === 'time') {
    mid = field({ id: k + '-duration', val: v.duration, unit: 'mm:ss', ph: '0:00', mode: 'numeric' });
  } else if (kind === 'carry') {
    mid = field({ id: k + '-load', val: v.load, unit: unitOf('load') })
        + `<span class="times">×</span>`
        + field({ id: k + '-reps', val: v.reps, unit: 'reps', mode: 'numeric' })
        + field({ id: k + '-distance', val: v.distance, unit: dUnit });
  } else if (kind === 'cardio') {
    mid = field({ id: k + '-pace', val: v.pace, unit: paceUnit(set.pace), ph: '0:00', mode: 'numeric' })
        + field({ id: k + '-distance', val: v.distance, unit: dUnit })
        + field({ id: k + '-duration', val: v.duration, unit: 'mm:ss', ph: '0:00', mode: 'numeric' });
  }

  // Only added sets can be removed — a prescribed set is part of the plan and stays
  // on the page; Skip is what records that it wasn't done.
  const del = !reserveDelCol ? ''
    : set._added
      ? `<button class="btn-del" type="button" data-del="${k}" aria-label="Remove added set ${n}">×</button>`
      : '<span></span>';

  return `<div class="set k-${kind}" data-set="${k}">
    <span class="set-n ${set._added ? 'added' : ''}">Set ${n}</span>
    ${mid}
    ${del}
  </div>`;
}

/* ── render: library ─────────────────────────────────────────── */

function renderLibrary() {
  const list = library();
  const items = list.map(x => {
    const log = readJSON(logKey(x.workoutId), null);
    const started = log && (log.elapsed || Object.keys(log.notes || {}).length || log.summary);

    // Removing is confirmed inline rather than with a dialog, because a mis-tap
    // here would throw away a logged session with nothing else holding a copy.
    if (pendingRemove === x.workoutId) {
      return `<div class="lib-item confirming">
        <span class="col">
          <span class="t">Remove this?</span>
          <span class="d">${started ? 'It has entries you logged — they go too' : 'Nothing logged yet'}</span>
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
      <span class="badge ${started ? '' : 'dim'}">${started ? 'In progress' : 'New'}</span>
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
    <p class="build">build ${esc(BUILD)}${installed ? ' · installed' : ''}</p>`;
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

    if (id === 'f-rpe')      { S.rpe = el.value; return save(); }
    if (id === 'f-summary')  { S.summary = el.value; return save(); }
    if (id === 'f-duration') return save();

    if (el.dataset && el.dataset.note) { S.notes[el.dataset.note] = el.value; return save(); }

    const m = id.match(/^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)-(load|reps|distance|duration|pace)$/);
    if (!m) return;
    const [, key, prop] = m;
    let val = el.value;

    if (prop === 'duration' || prop === 'pace') {
      const before = val, pos = el.selectionStart;
      val = fmtTime(val);
      if (val !== before) {
        el.value = val;
        const shift = val.length - before.length;
        el.setSelectionRange(pos + shift, pos + shift);
      }
    }

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
      save(); renderWorkout(); return;
    }
    if (e.target.id === 'log') return openSheet();
    if (e.target.closest('#home')) {
      e.preventDefault();
      location.hash = '';
      route();
    }
  });

  app.addEventListener('change', e => {
    const sk = e.target.dataset && e.target.dataset.skip;
    if (!sk) return;
    S.skipped = e.target.checked
      ? [...new Set([...S.skipped, sk])]
      : S.skipped.filter(x => x !== sk);
    save(); renderWorkout();
  });
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

function runTick() {
  clearInterval(tick);
  if (!S || !S.running) return;
  tick = setInterval(() => {
    const el = $('clock');
    if (el) el.textContent = clock(elapsedNow());
    const dur = $('f-duration');
    if (dur && document.activeElement !== dur) dur.value = clock(elapsedNow());
  }, 1000);
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
  lines.push([dur, S.rpe ? `RPE ${S.rpe}` : null].filter(Boolean).join(' · '));

  const width = 18;
  (WOD.sections || []).forEach(sec => {
    const rows = [];
    (sec.exercises || []).filter(ex => !isSkipped(ex.id)).forEach(ex => {
      rows.push('  ' + ex.movement.padEnd(width) + ' ' + allSets(ex).map(s => setValues(ex, s)).join(', '));
      const note = (S.notes[ex.id] || '').trim();
      if (note) rows.push('  ' + ' '.repeat(width) + ' ↳ ' + note);
    });
    if (!rows.length) return;
    lines.push('', sec.name.toUpperCase(), ...rows);
  });

  const skipped = eachExercise().filter(ex => isSkipped(ex.id));
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
  const log = {}, notes = {};

  eachExercise().forEach(ex => {
    if (isSkipped(ex.id)) return;
    const note = (S.notes[ex.id] || '').trim();
    if (note) notes[ex.id] = note;

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
  });

  const durStr = ($('f-duration') || {}).value || (S.elapsed ? clock(S.elapsed) : null);
  return {
    schema: 'wodin/result@1',
    workoutId: WOD.workoutId,
    startedAt: S.startedAt ? new Date(S.startedAt).toISOString() : null,
    submittedAt: new Date().toISOString(),
    duration: durStr || null,
    durationSec: toSec(durStr),
    rpe: S.rpe === '' ? null : Number(S.rpe),
    athleteSummary: S.summary.trim() || null,
    log,
    notes,
    skipped: S.skipped.slice()
  };
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
    } catch {
      toast('No signal — nothing sent');
    }
    return;
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
    } else {
      // Definitely not accepted — leave the sheet open so Share and Copy are one tap away.
      toast(`Rejected by the server (${res.status})`);
    }
  } catch {
    // A cors-mode fetch rejects identically whether the request never left or it
    // was delivered and the response merely omitted Access-Control-Allow-Origin.
    // Those are indistinguishable from here, and the second is common enough that
    // reporting failure is usually the wrong call — the payload already landed.
    // Only an offline device lets us say "nothing sent" honestly.
    if (navigator.onLine) {
      toast('Sent — delivery not confirmed');
      $('scrim').hidden = true;
    } else {
      toast('No signal — nothing sent');
    }
  }
}

function sink(act, icon, title, desc, primary) {
  return `<button class="sink ${primary ? 'primary' : ''}" type="button" data-sink="${act}">
    ${icon}<span class="col"><span class="t">${title}</span><span class="d">${desc}</span></span>
  </button>`;
}

function openSheet() {
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

  switch (btn.dataset.sink) {
    case 'post':
      await postResult();
      break;

    case 'share':
      try {
        await navigator.share({ title: 'WODin ' + WOD.workoutId, text: digest });
        $('scrim').hidden = true;
      } catch { /* dismissed */ }
      break;

    case 'copy':
      try {
        await navigator.clipboard.writeText(digest);
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
  const wod = await resolveWod();

  if (!wod) { WOD = null; S = null; renderLibrary(); return; }

  WOD = normalise(wod);
  remember(WOD);
  S = loadState();
  seedAdded();
  renderWorkout();
  runTick();
}

window.addEventListener('hashchange', route);

bind();
route();

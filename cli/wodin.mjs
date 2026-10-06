#!/usr/bin/env node
/* wodin — turn a plan into something an athlete can open, and a logged session
 * back into structured JSON. Zero dependencies: node's own zlib and http.
 *
 *   wodin link   wod.json [--base URL]   → shareable #w= URL
 *   wodin render wod.json [-o out.html]  → self-contained single file
 *   wodin serve  [wod.json] [--port N]   → localhost + LAN, POST /submit → logs/
 *   wodin parse  <file|->                → digest or JSON → canonical result JSON
 *   wodin validate wod.json ...          → structural check against the schema
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFormat, validatePlanRpe, movementNameWarning } from '../src/format.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_BASE = 'https://beachmonkey-ai.github.io/WODin/';

const args = process.argv.slice(2);
const cmd = args.shift();

function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
}
const positional = () => args.find(a => !a.startsWith('-') && args[args.indexOf(a) - 1]?.startsWith('-') !== true);

const readWod = file => JSON.parse(readFileSync(file, 'utf8'));
const die = msg => { console.error(msg); process.exit(1); };

/* ── link ────────────────────────────────────────────────────── */

function encodeWod(wod) {
  return deflateRawSync(Buffer.from(JSON.stringify(wod), 'utf8')).toString('base64url');
}

function cmdLink(file) {
  const wod = readWod(file);
  const base = flag('--base', DEFAULT_BASE).replace(/#.*$/, '');
  const url = `${base}${base.endsWith('/') ? '' : '/'}#w=${encodeWod(wod)}`;
  console.log(url);
  if (url.length > 8000) {
    console.error(`\n⚠  ${url.length} characters — some clients truncate beyond ~8000.`);
    console.error('   Consider committing the workout and linking ?d=<date> instead.');
  }
}

/* ── render ──────────────────────────────────────────────────── */

// A standalone file has no siblings to import from, so every `import { … } from
// './x.js'` in main.js is replaced by that module's source. Each module runs in
// its own function scope and hands back its exports: format.js and main.js both
// define helpers such as `num`, and two top-level declarations of one name in a
// module script are a SyntaxError — the whole page would load blank.
function inlineModules(mainSrc) {
  const loaded = new Set();
  const js = mainSrc.replace(
    /^import\s*\{([^}]*)\}\s*from\s*'\.\/([\w-]+\.js)';?[ \t]*\r?$/gm,
    (_, names, mod) => {
      const ns = '__mod_' + mod.replace(/\W/g, '_');
      const bindings = `const {${names.replace(/\s+as\s+/g, ': ')}} = ${ns};`;
      if (loaded.has(ns)) return bindings;
      loaded.add(ns);

      const src = readFileSync(path.join(ROOT, 'src', mod), 'utf8');
      if (/^\s*import[\s{]/m.test(src)) die(`render: src/${mod} has imports of its own — keep inlined modules dependency-free`);
      const exported = [...src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)]
        .map(m => m[1]);
      const body = src.replace(/^export\s+/gm, '');
      return `const ${ns} = (() => {\n${body}\nreturn { ${exported.join(', ')} };\n})();\n${bindings}`;
    });

  // Anything left is an import this function could not rewrite, and the inline
  // script has nothing to resolve it against. Fail here, not on the athlete's phone.
  const stray = js.match(/^\s*(import|export)\b.*$/m);
  if (stray) die(`render: could not inline "${stray[0].trim()}"`);
  return js;
}

function cmdRender(file) {
  const wod = readWod(file);
  const out = flag('-o', `wodin-${wod.workoutId || 'workout'}.html`);

  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tokens = readFileSync(path.join(ROOT, 'styles', 'tokens.css'), 'utf8');
  const css = readFileSync(path.join(ROOT, 'src', 'app.css'), 'utf8');
  const js = inlineModules(readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8'));

  // A standalone file has no directory to resolve ../fonts/ against, so the faces
  // are embedded. It roughly quadruples the file, which is the price of a single
  // document that renders identically with no network and no sibling files.
  const fontCss = readFileSync(path.join(ROOT, 'styles', 'fonts.css'), 'utf8')
    .replace(/url\('\.\.\/fonts\/([^']+)'\)/g, (_, file) => {
      const b64 = readFileSync(path.join(ROOT, 'public', 'fonts', file)).toString('base64');
      return `url('data:font/woff2;base64,${b64}')`;
    });

  const inlined = html
    .replace(/<link rel="manifest"[^>]*>\s*/g, '')
    .replace(/<link rel="(icon|apple-touch-icon)"[^>]*>\s*/g, '')
    .replace(/<link rel="stylesheet" href="styles\/fonts\.css"[^>]*>/, `<style>\n${fontCss}\n</style>`)
    .replace(/<link rel="stylesheet" href="styles\/tokens\.css"[^>]*>/, `<style>\n${tokens}\n</style>`)
    .replace(/<link rel="stylesheet" href="src\/app\.css"[^>]*>/, `<style>\n${css}\n</style>`)
    // A function, not a string: a replacement string would expand any `$&` or
    // `$'` that happens to appear in the inlined source.
    .replace(/<script type="module" src="src\/main\.js"><\/script>/,
      () => `<script type="module">\n${js}\n</script>`)
    // A file:// page has no service worker and no wods/ to fetch; the workout is baked in.
    .replace(/<script>\s*\/\/ Relative path[\s\S]*?<\/script>/, '')
    .replace('</body>', `  <script>location.hash = 'w=${encodeWod(wod)}';</script>\n</body>`);

  writeFileSync(out, inlined);
  console.log(`Wrote ${out} (${(inlined.length / 1024).toFixed(0)} KB) — open it in any browser.`);
}

/* ── serve ───────────────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png'
};

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) return nic.address;
    }
  }
  return null;
}

function cmdServe(file) {
  const port = Number(flag('--port', 5173));
  const logDir = path.resolve(flag('--out', 'logs'));
  const wod = file ? readWod(file) : null;

  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const result = JSON.parse(body);
        mkdirSync(logDir, { recursive: true });
        const dest = path.join(logDir, `${result.workoutId || Date.now()}.json`);
        writeFileSync(dest, JSON.stringify(result, null, 2));
        console.log(`✓ logged → ${path.relative(process.cwd(), dest)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      } catch (err) {
        res.writeHead(400).end(String(err));
      }
      return;
    }

    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';

    let found = null;
    for (const base of [ROOT, path.join(ROOT, 'public'), path.join(ROOT, 'src')]) {
      const p = path.resolve(base, rel);
      // Contain traversal: the resolved path must stay inside the repo.
      if (!p.startsWith(ROOT + path.sep)) continue;
      try { if (statSync(p).isFile()) { found = p; break; } } catch { /* next base */ }
    }

    if (!found) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(found)] || 'application/octet-stream' });
    res.end(readFileSync(found));
  });

  server.listen(port, () => {
    const frag = wod ? '#w=' + encodeWod(wod) : '';
    const lan = lanAddress();
    console.log(`\nWODin serving on:`);
    console.log(`  http://localhost:${port}/${frag}`);
    if (lan) console.log(`  http://${lan}:${port}/${frag}   ← this one works from your phone on the same wifi`);
    console.log(`\nSubmissions land in ${path.relative(process.cwd(), logDir) || 'logs'}/  ·  Ctrl-C to stop\n`);
  });
}

/* ── parse ───────────────────────────────────────────────────── */

const toSec = str => {
  if (!str) return null;
  const p = String(str).split(':').map(Number);
  if (p.some(isNaN)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
};

// Accepts either canonical JSON (passed through) or the text digest the page
// puts on the clipboard, so an agent never has to care which one it was handed.
function parseDigest(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);

  const lines = trimmed.split(/\r?\n/);
  const head = lines[0].match(/^WODin\s+(\S+)(?:\s+·\s+(.*))?$/);
  if (!head) die('Not a WODin digest — expected a first line like "WODin 2026-09-13 · Title".');

  const result = {
    schema: 'wodin/result@1',
    workoutId: head[1],
    submittedAt: new Date().toISOString(),
    duration: null, durationSec: null, rpe: null, athleteSummary: null,
    log: {}, notes: {}, skipped: []
  };

  const meta = (lines[1] || '').split('·').map(s => s.trim());
  for (const bit of meta) {
    if (/^\d+:\d\d(:\d\d)?$/.test(bit)) { result.duration = bit; result.durationSec = toSec(bit); }
    // "RPE 11 (assumed)": the plan's policy, not an answer — see rpeAssumed.
    const rpe = bit.match(/^RPE\s+([\d.]+)(\s+\(assumed\))?$/i);
    if (rpe) {
      result.rpe = Number(rpe[1]);
      if (rpe[2]) result.rpeAssumed = true;
    }
  }

  let section = null, lastMovement = null;
  for (const raw of lines.slice(2)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    const summary = line.match(/^Summary:\s*(.*)$/);
    if (summary) { result.athleteSummary = summary[1]; continue; }

    const skipped = line.match(/^SKIPPED\s+(.*)$/);
    if (skipped) { result.skipped = skipped[1].split(',').map(s => s.trim()); continue; }

    if (/^[A-Z][A-Z\s/&-]+$/.test(line.trim()) && !line.startsWith('  ')) { section = line.trim(); continue; }

    const note = line.match(/^\s+↳\s*(.*)$/);
    if (note && lastMovement) { result.notes[lastMovement] = note[1]; continue; }

    const row = line.match(/^\s{2}(\S.*?)\s{2,}(.+)$/);
    if (row) {
      lastMovement = row[1].trim();
      result.log[lastMovement] = { section, raw: row[2].trim() };
    }
  }

  console.error('Note: a digest identifies exercises by name, not id — `log` keys are movement');
  console.error('names and values are the raw entry text. Use the JSON payload for exact ids.');
  return result;
}

function cmdParse(file) {
  const text = (!file || file === '-')
    ? readFileSync(0, 'utf8')
    : readFileSync(file, 'utf8');
  console.log(JSON.stringify(parseDigest(text), null, 2));
}

/* ── validate ────────────────────────────────────────────────── */

const KINDS = ['weight_reps', 'reps', 'time', 'cardio', 'carry'];
// A plan travels inside a shareable URL and is stored on the athlete's device.
// Anything shaped like a credential in sink.headers is published, not protected.
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization'];

function cmdValidate(files) {
  let bad = 0;
  for (const file of files) {
    const problems = [], warnings = [];
    let wod;
    try { wod = readWod(file); } catch (err) { console.error(`✗ ${file}: ${err.message}`); bad++; continue; }

    if (!wod.workoutId) problems.push('missing workoutId');
    if (!Array.isArray(wod.sections) || !wod.sections.length) problems.push('missing sections');
    problems.push(...validatePlanRpe(wod).problems);

    if (wod.sink) {
      if (wod.sink.type === 'post' && !wod.sink.url) problems.push('sink: type "post" needs a url');
      if (wod.sink.mode && !['cors', 'blind'].includes(wod.sink.mode)) {
        problems.push(`sink: mode "${wod.sink.mode}" is not one of cors, blind`);
      }
      if (wod.sink.mode === 'blind' && wod.sink.headers) {
        warnings.push('sink: headers are dropped in blind mode — no-cors forbids custom headers');
      }
      for (const name of Object.keys(wod.sink.headers || {})) {
        if (CREDENTIAL_HEADERS.includes(name.toLowerCase())) {
          warnings.push(`sink.headers.${name} rides inside the link and is stored on the athlete's device`);
          warnings.push('  fine if it is a per-workout token: bound to this workoutId, ~72h, single use');
          warnings.push('  not fine if it is a standing credential — rotating one means reissuing every link');
        }
      }
    }

    (wod.sections || []).forEach((sec, i) => {
      const where = `sections[${i}]`;
      if (!sec.name) problems.push(`${where}: missing name`);
      (sec.exercises || []).forEach((ex, j) => {
        const exWhere = `${where}.exercises[${j}]`;
        if (!ex.movement) problems.push(`${exWhere}: missing movement`);
        else {
          // `movement` is searched verbatim for the form-check link and is what any
          // cross-session progress tracking matches on, so it has to be the exercise's
          // name and nothing else. Shared with round movements via src/format.js.
          const named = movementNameWarning(ex.movement);
          if (named) warnings.push(named);
        }
        if (!ex.kind) problems.push(`${exWhere} (${ex.movement}): missing kind — the renderer cannot infer it`);
        else if (!KINDS.includes(ex.kind)) problems.push(`${exWhere} (${ex.movement}): kind "${ex.kind}" is not one of ${KINDS.join(', ')}`);
        if (!Array.isArray(ex.sets) || !ex.sets.length) problems.push(`${exWhere} (${ex.movement}): no sets`);
      });
      // format, rounds[], scaling pills and the newer exercise fields. Same
      // function the page's tests exercise, so the CLI cannot drift from it.
      const fmt = validateFormat(sec, where);
      problems.push(...fmt.problems);
      warnings.push(...fmt.warnings);
    });

    if (problems.length) { bad++; console.error(`✗ ${file}`); problems.forEach(p => console.error(`    ${p}`)); }
    else console.log(`✓ ${file}`);
    // Warnings never fail the run — they flag a real risk without blocking anyone.
    // De-duplicated: a movement repeated across rounds and blocks earns its
    // advice once, not once per appearance.
    [...new Set(warnings)].forEach(w => console.error(`  ⚠ ${w}`));
  }
  process.exit(bad ? 1 : 0);
}

/* ── dispatch ────────────────────────────────────────────────── */

const file = args.find(a => !a.startsWith('-'));

switch (cmd) {
  case 'link':     file ? cmdLink(file) : die('usage: wodin link <wod.json> [--base URL]'); break;
  case 'render':   file ? cmdRender(file) : die('usage: wodin render <wod.json> [-o out.html]'); break;
  case 'serve':    cmdServe(file); break;
  case 'parse':    cmdParse(file); break;
  case 'validate': args.filter(a => !a.startsWith('-')).length ? cmdValidate(args.filter(a => !a.startsWith('-'))) : die('usage: wodin validate <wod.json> ...'); break;
  default:
    console.log(`wodin — hand a workout to a human, get back what they did

  wodin link     <wod.json> [--base URL]    shareable #w= URL  (the phone path)
  wodin render   <wod.json> [-o out.html]   self-contained single file
  wodin serve    [wod.json] [--port 5173]   localhost + LAN; POST /submit → logs/
  wodin parse    <file|->                   digest or JSON → canonical result JSON
  wodin validate <wod.json> ...             structural check

Schemas: schema/wod.schema.json, schema/result.schema.json
Protocol: AGENT.md`);
    process.exit(cmd ? 1 : 0);
}

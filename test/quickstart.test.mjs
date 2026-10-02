// The no-clone quick start in README.md and AGENT.md is the first thing an agent does,
// so what it shows has to work: the minimal plan validates, the example URL decodes to
// that plan, and the Node and Python encoders produce links that decode back to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');
const DOCS = { 'README.md': read('README.md'), 'AGENT.md': read('AGENT.md') };
const ENDPOINT = 'https://beachmonkey-ai.github.io/WODin/';
const cli = fileURLToPath(new URL('cli/wodin.mjs', root));

const fences = (md, lang) => [...md.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map(m => m[1]);
const quickStart = md => {
  const i = md.indexOf('## Quick start: no clone, no install');
  assert.ok(i >= 0, 'has a Quick start section');
  const j = md.indexOf('\n## ', i + 1);
  return md.slice(i, j < 0 ? undefined : j);
};
const decode = frag => JSON.parse(inflateRawSync(Buffer.from(frag, 'base64url')).toString('utf8'));
const planOf = md => JSON.parse(fences(quickStart(md), 'json')[0]);
const urlOf = md => fences(quickStart(md), 'text').map(s => s.trim()).find(s => s.startsWith(ENDPOINT + '#w='));
const tmp = () => mkdtempSync(join(tmpdir(), 'wodin-qs-'));

for (const [name, md] of Object.entries(DOCS)) {
  test(`${name}: opens with the no-clone flow and names the endpoint and fragment`, () => {
    const qs = quickStart(md);
    assert.ok(qs.includes(ENDPOINT), 'endpoint named');
    assert.ok(qs.includes('#w=') && qs.includes('#wj='), 'both fragment forms named');
    const first = md.indexOf('git clone');
    assert.ok(first < 0 || first > md.indexOf(qs), 'clone appears only after the quick start');
    assert.ok(md.indexOf(qs) < 1800, 'quick start is near the top');
  });

  test(`${name}: the minimal plan validates with the repo CLI`, () => {
    const dir = tmp();
    writeFileSync(join(dir, 'wod.json'), JSON.stringify(planOf(md)));
    const r = spawnSync(process.execPath, [cli, 'validate', join(dir, 'wod.json')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /⚠/, 'no warnings');
  });

  test(`${name}: the example URL decodes to the minimal plan`, () => {
    const url = urlOf(md);
    assert.ok(url, 'example URL present');
    assert.deepEqual(decode(url.slice((ENDPOINT + '#w=').length)), planOf(md));
    assert.ok(md.includes(`${url.length} characters`), 'the stated URL length is the real one');
  });

  test(`${name}: the Node snippet round-trips`, () => {
    const code = fences(quickStart(md), 'js')[0];
    assert.match(code, /deflateRawSync/);
    const dir = tmp();
    writeFileSync(join(dir, 'wod.json'), JSON.stringify(planOf(md), null, 2));
    writeFileSync(join(dir, 'enc.mjs'), code);
    const r = spawnSync(process.execPath, ['enc.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    assert.ok(out.startsWith(ENDPOINT + '#w='));
    assert.deepEqual(decode(out.slice((ENDPOINT + '#w=').length)), planOf(md));
  });

  test(`${name}: the Python snippet uses raw deflate and round-trips (skipped without python)`, t => {
    const code = fences(quickStart(md), 'python')[0];
    assert.match(code, /compressobj\(9, zlib\.DEFLATED, -15\)/);
    const py = ['python3', 'python'].find(p => spawnSync(p, ['--version']).status === 0);
    if (!py) return t.skip('no python on this machine');
    const dir = tmp();
    writeFileSync(join(dir, 'wod.json'), JSON.stringify(planOf(md), null, 2));
    writeFileSync(join(dir, 'enc.py'), code);
    const r = spawnSync(py, ['enc.py'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    assert.ok(out.startsWith(ENDPOINT + '#w='));
    assert.deepEqual(decode(out.slice((ENDPOINT + '#w=').length)), planOf(md));
  });
}

test('README.md and AGENT.md show the same minimal plan and example URL', () => {
  assert.deepEqual(planOf(DOCS['README.md']), planOf(DOCS['AGENT.md']));
  assert.equal(urlOf(DOCS['README.md']), urlOf(DOCS['AGENT.md']));
});

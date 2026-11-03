import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The top timer bar must stay pinned on iPhone Safari (see the .timer comment
// in src/app.css). These guard the pieces of that fix that are easy to lose.
const root = new URL('../', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8').replace(/\r\n/g, '\n');
const css = read('src/app.css');
const rule = sel => {
  const m = css.match(new RegExp('\\n' + sel.replace(/[.:]/g, '\\$&') + ' \\{([^}]*)\\}'));
  assert.ok(m, `no ${sel} rule in app.css`);
  return m[1];
};

test('timer bar: sticky, own compositing layer, pinned below the safe area', () => {
  const t = rule('.timer');
  assert.match(t, /position:\s*sticky/);
  assert.match(t, /top:\s*calc\(env\(safe-area-inset-top[^;]*\/\s*var\(--ui-scale/);
  assert.match(t, /transform:\s*translateZ\(0\)/);
  assert.match(t, /backface-visibility:\s*hidden/);
  assert.match(t, /background:\s*var\(--ground\)/);
});

test('timer bar stacks above content but under the status strip, sheet and toast', () => {
  const z = sel => Number(rule(sel).match(/z-index:\s*(\d+)/)[1]);
  assert.ok(z('.timer') < z('body::before'));
  assert.ok(z('body::before') < z('.scrim'));
  assert.ok(z('.scrim') < z('.toast'));
});

test('viewport-fit=cover is in index.html, which wodin render inlines', () => {
  assert.match(read('index.html'), /name="viewport"[^>]*viewport-fit=cover/);
  assert.match(rule('body'), /padding-top:\s*env\(safe-area-inset-top/);
});

test('renderWorkout keeps the timer node across renders', () => {
  const js = read('src/main.js');
  assert.match(js, /querySelector\(':scope > \.timer'\)/);
});

#!/usr/bin/env node
// Copies the app into dist/ and bumps the service worker's cache name from a
// content hash. No base-path parameter — index.html, the manifest, and sw.js
// all use paths relative to their own location, so root (/) and PR preview
// (/preview/pr-<N>/) deploys both work unmodified. See README.md.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');

function collectFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(e => e.isFile())
    .map(e => path.join(e.parentPath ?? e.path, e.name));
}

function build() {
  mkdirSync(DIST, { recursive: true });

  cpSync(path.join(ROOT, 'index.html'), path.join(DIST, 'index.html'));
  cpSync(path.join(ROOT, 'styles'), path.join(DIST, 'styles'), { recursive: true });
  cpSync(path.join(ROOT, 'src'), path.join(DIST, 'src'), { recursive: true });
  cpSync(path.join(ROOT, 'public', 'manifest.webmanifest'), path.join(DIST, 'manifest.webmanifest'));
  cpSync(path.join(ROOT, 'public', 'fonts'), path.join(DIST, 'fonts'), { recursive: true });

  // The schemas are part of the deliverable, not just repo furniture — their $id
  // values point at the deployed copies, so an agent can fetch them by URL.
  cpSync(path.join(ROOT, 'schema'), path.join(DIST, 'schema'), { recursive: true });
  cpSync(path.join(ROOT, 'examples'), path.join(DIST, 'examples'), { recursive: true });
  // Optional: committed workouts served to the ?d=<date> path.
  if (existsSync(path.join(ROOT, 'wods'))) {
    cpSync(path.join(ROOT, 'wods'), path.join(DIST, 'wods'), { recursive: true });
  }

  if (existsSync(path.join(ROOT, 'public', 'icons'))) {
    cpSync(path.join(ROOT, 'public', 'icons'), path.join(DIST, 'icons'), { recursive: true });
  } else {
    console.warn('public/icons/ not found — run "npm run gen-icons" first.');
  }

  // Hash everything that affects what's served, so any real change bumps the cache.
  const hashInputs = [
    ...collectFiles(path.join(ROOT, 'src')),
    ...collectFiles(path.join(ROOT, 'styles')),
    path.join(ROOT, 'index.html'),
    path.join(ROOT, 'public', 'manifest.webmanifest'),
    // The worker's own source too — changing which files it precaches changes what
    // is served, so it should invalidate the cache like any other content change.
    path.join(ROOT, 'public', 'sw.js'),
  ];
  const hash = createHash('sha256');
  for (const f of hashInputs.sort()) hash.update(readFileSync(f));
  const shortHash = hash.digest('hex').slice(0, 8);

  let sw = readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const cacheLine = /const CACHE\s*=\s*'[^']*';/;
  if (!cacheLine.test(sw)) throw new Error("sw.js is missing the expected \"const CACHE = '...'\" line");
  sw = sw.replace(cacheLine, `const CACHE = 'app-${shortHash}';`);
  writeFileSync(path.join(DIST, 'sw.js'), sw);

  console.log(`Built dist/ — cache app-${shortHash}`);
}

build();

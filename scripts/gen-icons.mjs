#!/usr/bin/env node
// One SVG (public/icon.svg) -> 192/512/maskable/apple-touch PNGs in public/icons/.
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'public', 'icon.svg');
const OUT = path.join(ROOT, 'public', 'icons');

// Background color behind the maskable safe-zone — should match manifest.webmanifest's
// background_color / theme_color for a seamless mask on Android's adaptive-icon shapes.
const BG = { r: 0x0d, g: 0x10, b: 0x11, alpha: 1 };

async function main() {
  mkdirSync(OUT, { recursive: true });
  const svg = readFileSync(SRC);

  await sharp(svg).resize(192, 192).png().toFile(path.join(OUT, 'icon-192.png'));
  await sharp(svg).resize(512, 512).png().toFile(path.join(OUT, 'icon-512.png'));

  // Maskable: content must sit inside the ~40%-radius safe zone, so shrink to ~60% and
  // pad with the background color — Android clips the rest to its own shape.
  const maskableContent = await sharp(svg).resize(308, 308).png().toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 4, background: BG } })
    .composite([{ input: maskableContent, gravity: 'center' }])
    .png()
    .toFile(path.join(OUT, 'icon-maskable.png'));

  // Apple touch icon: no transparency (iOS ignores alpha and shows it as black).
  await sharp(svg).resize(180, 180).flatten({ background: BG }).png()
    .toFile(path.join(OUT, 'apple-touch-icon.png'));

  console.log('Generated public/icons/: icon-192.png, icon-512.png, icon-maskable.png, apple-touch-icon.png');
}

main();

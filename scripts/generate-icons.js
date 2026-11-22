#!/usr/bin/env node
'use strict';
/**
 * Generates the extension's placeholder icons (16/48/128 px PNG) with zero dependencies.
 * Design: rounded square with a coral→orange gradient, a white play triangle, and a small
 * "second viewer" dot to suggest watching together.
 *   node scripts/generate-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'extension', 'icons');
const SS = 4; // supersampling factor for anti-aliasing

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const C1 = [229, 72, 77];
const C2 = [255, 138, 91];

function inRoundedRect(x, y, r) {
  // unit square [0,1], corner radius r
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s = (p1x, p1y, p2x, p2y, p3x, p3y) => (p1x - p3x) * (p2y - p3y) - (p2x - p3x) * (p1y - p3y);
  const d1 = s(px, py, ax, ay, bx, by);
  const d2 = s(px, py, bx, by, cx, cy);
  const d3 = s(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function sample(x, y, size) {
  // returns [r,g,b,a] in 0..255 for unit coords
  const radius = size <= 16 ? 0.2 : 0.24;
  if (!inRoundedRect(x, y, radius)) return [0, 0, 0, 0];
  const t = (x + y) / 2;
  let col = [lerp(C1[0], C2[0], t), lerp(C1[1], C2[1], t), lerp(C1[2], C2[2], t), 255];
  // Play triangle (slightly left of centre so it looks optically centred)
  if (inTriangle(x, y, [0.36, 0.27], [0.36, 0.73], [0.74, 0.5])) col = [255, 255, 255, 255];
  // "Together" dot, bottom-right (skip at 16px where it would be mush)
  if (size > 16) {
    const d = Math.hypot(x - 0.79, y - 0.79);
    if (d <= 0.11) col = [255, 255, 255, 255];
    else if (d <= 0.15) col = [lerp(C1[0], C2[0], 0.9), lerp(C1[1], C2[1], 0.9), lerp(C1[2], C2[2], 0.9), 255];
  }
  return col;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, size);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const i = (py * size + px) * 4;
      const n = SS * SS;
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log('wrote', path.relative(process.cwd(), file));
}

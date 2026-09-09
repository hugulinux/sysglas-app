// make-icon.js — generates a 32×32 RGBA PNG tray icon for SYSGLAS.
// Pure Node, no external deps. Uses built-in zlib for IDAT compression.
//
//   node make-icon.js
//
// Produces ./assets/tray-icon.png and ./assets/tray-icon@2x.png (64×64).
'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── CRC32 (PNG spec) ────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── PNG chunk ───────────────────────────────────────────────────────────
function chunk(type, data) {
  const len  = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// ── Pixel generator: cyan glass-glow orb ─────────────────────────────────
function makePixels(size) {
  // RGBA
  const px = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size * 0.48;
  const rCore  = size * 0.30;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d  = Math.sqrt(dx * dx + dy * dy);
      const i  = (y * size + x) * 4;

      if (d < rCore) {
        // Bright core
        const t = d / rCore;
        px[i]     = 180 + Math.round(75 * (1 - t));   // R
        px[i + 1] = 235 + Math.round(20 * (1 - t));     // G
        px[i + 2] = 255;                              // B
        px[i + 3] = 255;                              // A
      } else if (d < rOuter) {
        // Glow falloff
        const t = (d - rCore) / (rOuter - rCore);
        const a = Math.round(255 * Math.pow(1 - t, 2.4));
        px[i]     = 0;
        px[i + 1] = 180 + Math.round(60 * (1 - t));
        px[i + 2] = 230 + Math.round(25 * (1 - t));
        px[i + 3] = a;
      } else {
        // Transparent
        px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0;
      }
    }
  }
  return px;
}

// ── Encode RGBA pixels as PNG ────────────────────────────────────────────
function encodePNG(width, height, rgba) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 6;   // color type RGBA
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  // IDAT — prepend filter byte (0 = None) to each scanline, then deflate
  const scanlineLen = width * 4;
  const raw = Buffer.alloc(height * (scanlineLen + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (scanlineLen + 1)] = 0;
    rgba.copy(raw, y * (scanlineLen + 1) + 1, y * scanlineLen, (y + 1) * scanlineLen);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Generate ─────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, 'assets');
fs.mkdirSync(outDir, { recursive: true });

const sizes = [
  { name: 'tray-icon.png',    size: 32 },
  { name: 'tray-icon@2x.png', size: 64 },
  { name: 'icon.png',         size: 256 },
];

for (const { name, size } of sizes) {
  const png = encodePNG(size, size, makePixels(size));
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`✓ wrote assets/${name} (${size}×${size}, ${png.length} bytes)`);
}

console.log('\nSYSGLAS tray icon ready.\n');
#!/usr/bin/env node
/**
 * generate-pixel-art.js
 *
 * Generates a 16x16 pixel art BMP image of a little robot character.
 * Uses only Node.js built-ins — no external dependencies.
 *
 * Usage: node tools/generate-pixel-art.js [output-path]
 * Default output: tools/pixel-robot.bmp
 */

const fs = require('fs');
const path = require('path');

// --- Color palette (R, G, B) ---
const COLORS = {
  _: [0, 0, 0, 0],       // transparent (white background)
  B: [30, 30, 30],        // black (outline)
  G: [80, 80, 80],        // dark gray (body shadow)
  S: [160, 160, 160],     // silver (body)
  W: [220, 220, 220],     // white (highlight)
  R: [220, 50, 50],       // red (antenna light / accent)
  C: [60, 180, 220],      // cyan (eyes)
  Y: [240, 200, 60],      // yellow (chest light)
  D: [100, 100, 100],     // mid gray (limbs)
};

// 16x16 pixel grid — a cute robot sprite
// Each character maps to COLORS above
// Row 0 = top of image
const SPRITE = [
  '______RR________',  // row 0:  antenna light
  '______BB________',  // row 1:  antenna stem
  '____BBBBBB______',  // row 2:  head top
  '___BWSSSSSWB____',  // row 3:  head
  '___BCCSSWCCB____',  // row 4:  eyes (cyan pupils)
  '___BCCSSWCCB____',  // row 5:  eyes
  '___BSSGGSSSB____',  // row 6:  mouth
  '____BBBBBB______',  // row 7:  head bottom
  '___BSSYYSSB_____',  // row 8:  chest top + yellow light
  '___DBSSSSSBD____',  // row 9:  chest + arms
  '___DBSSSSSBD____',  // row 10: chest + arms
  '___DBSSSSSBD____',  // row 11: chest + arms
  '____BBBBBB______',  // row 12: waist
  '____BD__DB______',  // row 13: legs
  '____BD__DB______',  // row 14: legs
  '___BBDD_DDBB____',  // row 15: feet
];

const WIDTH = 16;
const HEIGHT = 16;

function createBMP(pixelGrid, width, height) {
  // BMP with 24-bit color (no alpha)
  const rowSize = Math.ceil((width * 3) / 4) * 4; // rows padded to 4-byte boundary
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize; // 14 (file header) + 40 (DIB header) + pixels

  const buf = Buffer.alloc(fileSize);

  // --- BMP File Header (14 bytes) ---
  buf.write('BM', 0);                    // signature
  buf.writeUInt32LE(fileSize, 2);         // file size
  buf.writeUInt16LE(0, 6);               // reserved1
  buf.writeUInt16LE(0, 8);               // reserved2
  buf.writeUInt32LE(54, 10);             // pixel data offset

  // --- DIB Header (BITMAPINFOHEADER, 40 bytes) ---
  buf.writeUInt32LE(40, 14);             // DIB header size
  buf.writeInt32LE(width, 18);           // width
  buf.writeInt32LE(height, 22);          // height (positive = bottom-up)
  buf.writeUInt16LE(1, 26);             // color planes
  buf.writeUInt16LE(24, 28);            // bits per pixel
  buf.writeUInt32LE(0, 30);             // compression (none)
  buf.writeUInt32LE(pixelDataSize, 34);  // image size
  buf.writeInt32LE(2835, 38);           // horizontal resolution (72 DPI)
  buf.writeInt32LE(2835, 42);           // vertical resolution (72 DPI)
  buf.writeUInt32LE(0, 46);             // colors in palette
  buf.writeUInt32LE(0, 50);             // important colors

  // --- Pixel Data (bottom-up, BGR order) ---
  for (let y = 0; y < height; y++) {
    // BMP stores rows bottom-to-top
    const srcRow = pixelGrid[height - 1 - y];
    const rowOffset = 54 + y * rowSize;

    for (let x = 0; x < width; x++) {
      const char = srcRow[x] || '_';
      const color = COLORS[char] || COLORS['_'];
      const r = color[0], g = color[1], b = color[2];

      // BMP uses BGR byte order
      const pixelOffset = rowOffset + x * 3;
      buf[pixelOffset] = b;
      buf[pixelOffset + 1] = g;
      buf[pixelOffset + 2] = r;
    }
    // Padding bytes are already 0 from Buffer.alloc
  }

  return buf;
}

// Parse sprite into proper grid
function parseSpriteGrid(spriteLines, width) {
  return spriteLines.map(line => {
    const chars = [];
    for (let i = 0; i < width; i++) {
      chars.push(line[i] || '_');
    }
    return chars;
  });
}

// Fill background with white for "transparent" pixels
function fillBackground(grid) {
  return grid.map(row =>
    row.map(c => {
      if (c === '_') return '_';
      return c;
    })
  );
}

// Generate
const grid = parseSpriteGrid(SPRITE, WIDTH);
const bmpBuffer = createBMP(grid, WIDTH, HEIGHT);

const outputPath = process.argv[2] || path.join(__dirname, 'pixel-robot.bmp');
fs.writeFileSync(outputPath, bmpBuffer);

console.log(`✓ Pixel art robot generated: ${outputPath}`);
console.log(`  Size: ${WIDTH}x${HEIGHT} pixels, ${bmpBuffer.length} bytes`);
console.log(`  Format: 24-bit BMP (uncompressed)`);

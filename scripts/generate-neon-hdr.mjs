// Regenerate the semantic Rec.2100 PQ swatches: node scripts/generate-neon-hdr.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

// ST 2084 encodes absolute nits, with 10,000 nits at code value 1.
function pq(nits) {
  const p = (nits / 10000) ** (2610 / 16384);
  return ((3424 / 4096 + (2413 / 128) * p) / (1 + (2392 / 128) * p)) ** (2523 / 32);
}

const width = 256;
// Linear BT.2020 channel intensities in cd/m². Pastels suit dark text in
// light mode; saturated inks suit small glyphs against dark code backgrounds.
const swatches = {
  "fill-green": [185, 310, 225],
  "fill-blue": [200, 265, 420],
  "fill-red": [420, 205, 240],
  "ink-green": [35, 365, 180],
  "ink-blue": [65, 300, 650],
  "ink-violet": [580, 120, 650],
  "ink-amber": [490, 265, 35],
  "ink-red": [650, 110, 215],
};
const header = Buffer.alloc(13);
header.writeUInt32BE(1);
header.writeUInt32BE(1, 4);
header[8] = 16;
header[9] = 2; // RGB, no alpha, no SDR ICC profile.
mkdirSync(new URL("../src/client/assets/", import.meta.url), { recursive: true });
for (const [name, channels] of Object.entries(swatches)) {
  const row = Buffer.alloc(7);
  const luminance = channels.reduce(
    (sum, nits, channel) => sum + nits * [0.2627, 0.678, 0.0593][channel],
    0,
  );
  // Barely above 203-nit reference white on broad fills; modest small-glyph EDR.
  const target = name.startsWith("fill-") ? 215 : 235;
  channels.forEach((nits, channel) =>
    row.writeUInt16BE(Math.round(pq((nits * target) / luminance) * 65535), 1 + channel * 2),
  );
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    // BT.2020 primaries, ST 2084 transfer, RGB matrix, full range.
    chunk("cICP", Buffer.from([9, 16, 0, 1])),
    chunk("IDAT", deflateSync(row)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(new URL(`../src/client/assets/neon-${name}.png`, import.meta.url), png);
}

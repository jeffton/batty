// Regenerate the lossless Rec.2100 PQ chrome seam: node scripts/generate-neon-hdr.mjs
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
const stops = [
  [30, 580, 650],
  [300, 90, 650],
  [650, 40, 340],
];
const row = Buffer.alloc(1 + width * 6);
for (let x = 0; x < width; x++) {
  const position = (x / (width - 1)) * 2;
  const index = Math.min(1, Math.floor(position));
  const mix = position - index;
  for (let channel = 0; channel < 3; channel++) {
    const nits = stops[index][channel] * (1 - mix) + stops[index + 1][channel] * mix;
    row.writeUInt16BE(Math.round(pq(nits) * 65535), 1 + x * 6 + channel * 2);
  }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(width);
header.writeUInt32BE(1, 4);
header[8] = 16;
header[9] = 2; // RGB, no alpha, no SDR ICC profile.
// cICP: BT.2020 primaries, ST 2084 transfer, RGB matrix, full range.
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("cICP", Buffer.from([9, 16, 0, 1])),
  chunk("IDAT", deflateSync(row)),
  chunk("IEND", Buffer.alloc(0)),
]);
const destination = new URL("../src/client/assets/neon-pq.png", import.meta.url);
mkdirSync(new URL("../src/client/assets/", import.meta.url), { recursive: true });
writeFileSync(destination, png);

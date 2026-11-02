// Regenerate with: node scripts/generate-logo-hdr.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import sharp from "sharp";

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

function linear(value) {
  const encoded = value / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

// ST 2084, absolute cd/m². SDR reference white is 203 nits; the logo's
// brightest white reaches only 235 nits (1.16×). No hue or saturation boost.
function pq(value) {
  const p = ((value * 235) / 10000) ** (2610 / 16384);
  return ((3424 / 4096 + (2413 / 128) * p) / (1 + (2392 / 128) * p)) ** (2523 / 32);
}

const { data, info } = await sharp(new URL("../public/favicon.png", import.meta.url).pathname)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const rows = Buffer.alloc(info.height * (1 + info.width * 8));
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const source = (y * info.width + x) * 4;
    const target = y * (1 + info.width * 8) + 1 + x * 8;
    const [r, g, b] = [0, 1, 2].map((channel) => linear(data[source + channel]));
    // Linear sRGB to linear BT.2020, D65 white point unchanged.
    const rgb = [
      0.627404 * r + 0.329283 * g + 0.043313 * b,
      0.069097 * r + 0.91954 * g + 0.011362 * b,
      0.016391 * r + 0.088013 * g + 0.895595 * b,
    ];
    rgb.forEach((value, channel) =>
      rows.writeUInt16BE(Math.round(pq(value) * 65535), target + channel * 2),
    );
    // PNG stores straight alpha: preserve coverage, never apply PQ to alpha.
    rows.writeUInt16BE(data[source + 3] * 257, target + 6);
  }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(info.width);
header.writeUInt32BE(info.height, 4);
header[8] = 16;
header[9] = 6; // RGBA
writeFileSync(
  new URL("../src/client/assets/logo-hdr.png", import.meta.url),
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("cICP", Buffer.from([9, 16, 0, 1])), // BT.2020 / PQ / RGB / full range
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);

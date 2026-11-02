import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { expect, test } from "vite-plus/test";

function nits(encoded: number): number {
  const p = (encoded / 65535) ** (32 / 2523);
  return 10000 * (Math.max(p - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * p)) ** (16384 / 2610);
}

function srgb(value: number): number {
  return 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
}

test("HDR logo preserves original coverage and colors with bounded genuine PQ headroom", async () => {
  const png = readFileSync("src/client/assets/logo-hdr.png");
  const chunks = new Map<string, Buffer[]>();
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    chunks.set(type, [...(chunks.get(type) ?? []), png.subarray(offset + 8, offset + 8 + size)]);
    offset += size + 12;
  }
  expect([...chunks.get("cICP")![0]!]).toEqual([9, 16, 0, 1]);
  const header = chunks.get("IHDR")![0]!;
  expect([header[8], header[9]]).toEqual([16, 6]);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const original = await sharp("public/favicon.png")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect([width, height]).toEqual([original.info.width, original.info.height]);
  const pixels = inflateSync(Buffer.concat(chunks.get("IDAT")!));
  let peak = 0;
  for (let y = 0; y < height; y++) {
    expect(pixels[y * (1 + width * 8)]).toBe(0);
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 8) + 1 + x * 8;
      const source = (y * width + x) * 4;
      expect(pixels.readUInt16BE(offset + 6)).toBe(original.data[source + 3]! * 257);
      const rgb = [0, 1, 2].map((channel) => nits(pixels.readUInt16BE(offset + channel * 2)));
      peak = Math.max(peak, ...rgb);
      // Convert decoded BT.2020 back to sRGB and compare with the source pixels.
      const [r, g, b] = rgb.map((value) => value / 380) as [number, number, number];
      const decoded = [
        1.660491 * r - 0.587641 * g - 0.07285 * b,
        -0.12455 * r + 1.1329 * g - 0.008349 * b,
        -0.018151 * r - 0.100579 * g + 1.11873 * b,
      ].map(srgb);
      for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(decoded[channel]! - original.data[source + channel]!)).toBeLessThan(0.2);
      }
    }
  }
  expect(peak).toBeGreaterThan(350);
  expect(peak).toBeLessThan(380.1);
});

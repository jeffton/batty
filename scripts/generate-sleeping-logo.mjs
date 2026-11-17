import fs from "node:fs/promises";
import sharp from "sharp";

// Keep the actual logo's silhouette, materials and face. Only close its eyes.
const source = new URL("../public/pwa-512.png", import.meta.url);
const { data, info } = await sharp(await fs.readFile(source))
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const original = Buffer.from(data);
for (const [left, right] of [
  [124, 214],
  [298, 388],
]) {
  const top = 190;
  const bottom = 288;
  const radius = 32;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      // Rounded eye sockets, with a soft edge into the original ivory face.
      const dx = Math.max(left + radius - x, 0, x - (right - radius));
      const dy = Math.max(top + radius - y, 0, y - (bottom - radius));
      const blend = Math.min(1, Math.max(0, (radius - Math.hypot(dx, dy)) / 3));
      const t = (x - left) / (right - left);
      for (let channel = 0; channel < 3; channel++) {
        const a = original[(y * info.width + left - 4) * 4 + channel];
        const b = original[(y * info.width + right + 4) * 4 + channel];
        const index = (y * info.width + x) * 4 + channel;
        data[index] = Math.round(data[index] * (1 - blend) + (a * (1 - t) + b * t) * blend);
      }
    }
  }
}
const lids =
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <g fill="none" stroke="#397f83" stroke-width="9" stroke-linecap="round">
    <path d="M145 237 Q169 257 193 237" />
    <path d="M319 237 Q343 257 367 237" />
  </g>
</svg>`);
await fs.writeFile(
  new URL("../src/client/assets/logo-sleeping.png", import.meta.url),
  await sharp(data, { raw: info })
    .composite([{ input: lids }])
    .png()
    .toBuffer(),
);

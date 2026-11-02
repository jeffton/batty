// @vitest-environment node
import path from "node:path";
import fs from "node:fs/promises";
import { inflateSync } from "node:zlib";
import vue from "@vitejs/plugin-vue";
import { chromium } from "patchright";
import { expect, test } from "vite-plus/test";
import { closeBrowserFixtureServer, createBrowserFixtureServer } from "../test/browser-fixture";

test("semantic PQ swatches have modest measured EDR rather than maximum highlights", async () => {
  for (const name of [
    "fill-green",
    "fill-blue",
    "fill-red",
    "ink-green",
    "ink-blue",
    "ink-violet",
    "ink-amber",
    "ink-red",
  ]) {
    const png = await fs.readFile(`src/client/assets/neon-${name}.png`);
    const chunks = new Map<string, Buffer>();
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      chunks.set(
        png.toString("ascii", offset + 4, offset + 8),
        png.subarray(offset + 8, offset + 8 + length),
      );
      offset += length + 12;
    }
    expect([...chunks.get("cICP")!]).toEqual([9, 16, 0, 1]);
    expect(chunks.get("IHDR")![8]).toBe(16);
    const pixels = inflateSync(chunks.get("IDAT")!);
    const decodePq = (value: number) => {
      const p = (value / 65535) ** (32 / 2523);
      return (
        10000 * (Math.max(p - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * p)) ** (16384 / 2610)
      );
    };
    const luminance = [0.2627, 0.678, 0.0593].reduce(
      (sum, weight, channel) => sum + weight * decodePq(pixels.readUInt16BE(1 + channel * 2)),
      0,
    );
    expect(luminance).toBeCloseTo(name.startsWith("fill-") ? 215 : 235, 0);
  }
});

test("Neon recolors real messages, hover, syntax and semantic diffs in both system variants", async () => {
  const server = await createBrowserFixtureServer("src/client/components/Neon.fixture.html", {
    plugins: [vue()],
    define: { __BATTY_BUILD_ID__: JSON.stringify("dev") },
    resolve: { alias: { "@": path.resolve("src") } },
    server: { host: "127.0.0.1", port: 0 },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await server.listen();
    const page = await browser.newPage({
      viewport: { width: 390, height: 900 },
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    page.on("pageerror", (error) => console.error(error.message));
    await page.goto(`${server.resolvedUrls!.local[0]}src/client/components/Neon.fixture.html`);
    await page.locator(".diff-block__line--add").waitFor({ timeout: 10000 });
    for (const colorScheme of ["light", "dark", "light"] as const) {
      await page.emulateMedia({ colorScheme });
      const styles = await page.evaluate(() => {
        const rgb = (color: string) => {
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const sample = (selector: string, pseudo?: string) => {
          const computed = getComputedStyle(document.querySelector(selector)!, pseudo);
          return {
            color: rgb(computed.color),
            background: rgb(computed.backgroundColor),
            image: computed.backgroundImage,
          };
        };
        return {
          user: sample(".message--user"),
          userFill: sample(".message--user", "::before"),
          system: sample(".message__system-bubble"),
          keyword: sample(".hljs-keyword"),
          add: sample(".diff-block__line--add"),
          remove: sample(".diff-block__line--remove"),
          plain: sample("p"),
        };
      });
      const luminance = (rgb: number[]) =>
        rgb.reduce((sum, n, i) => {
          const c = n / 255;
          return (
            sum +
            [0.2126, 0.7152, 0.0722][i]! * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
          );
        }, 0);
      const contrast = (a: number[], b: number[]) => {
        const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (values[0]! + 0.05) / (values[1]! + 0.05);
      };
      expect(contrast(styles.user.color, styles.userFill.background)).toBeGreaterThan(7);
      expect(contrast(styles.system.color, styles.system.background)).toBeGreaterThan(4.5);
      expect(styles.add.background[1]).toBeGreaterThan(styles.add.background[0]!);
      expect(styles.remove.background[0]).toBeGreaterThan(styles.remove.background[1]!);
      expect(styles.keyword.color).not.toEqual(styles.plain.color);
      await page.getByRole("button", { name: "Hover", exact: true }).hover();
      const hover = await page
        .getByRole("button", { name: "Hover", exact: true })
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(hover).toBe(colorScheme === "light" ? "rgb(194, 247, 231)" : "rgb(8, 75, 64)");
      if (process.env.BATTY_UI_SCREENSHOTS === "1") {
        await fs.mkdir(".tmp/neon-semantic", { recursive: true });
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await page.screenshot({ path: `.tmp/neon-semantic/${colorScheme}-${width}.png` });
        }
      }
    }
    // This SDR host cannot emulate HDR through CDP. Activate only the HDR media
    // condition in the delivered stylesheet to test its real selectors/compositing.
    await page.evaluate(() => {
      for (const style of document.querySelectorAll("style")) {
        if (style.textContent?.includes("(dynamic-range: high)")) {
          style.textContent = style.textContent.replaceAll(
            "(dynamic-range: high)",
            "(min-width: 0px)",
          );
        }
      }
    });
    await page.emulateMedia({ colorScheme: "dark" });
    const selected = await page
      .locator(".hljs-keyword")
      .first()
      .evaluate((el) => ({
        hdr: matchMedia("(dynamic-range: high)").matches,
        image: getComputedStyle(el).backgroundImage,
        clip: getComputedStyle(el).backgroundClip,
        fill: getComputedStyle(el).webkitTextFillColor,
      }));
    expect(selected.hdr).toBe(false);
    expect(selected.image).toContain("neon-ink-violet.png");
    expect(selected.clip).toBe("text");
    expect(selected.fill).toBe("rgba(0, 0, 0, 0)");
    await page.emulateMedia({ colorScheme: "light" });
    const fill = await page
      .locator(".message--user")
      .evaluate((el) => getComputedStyle(el, "::before").backgroundImage);
    expect(fill).toContain("neon-fill-green.png");
    const images = await page.evaluate(async () => {
      const files = [
        "fill-green",
        "fill-blue",
        "fill-red",
        "ink-green",
        "ink-blue",
        "ink-violet",
        "ink-amber",
        "ink-red",
      ];
      return Promise.all(
        files.map(async (name) => {
          const img = new Image();
          img.src = `/src/client/assets/neon-${name}.png`;
          await img.decode();
          return img.naturalWidth;
        }),
      );
    });
    expect(images).toEqual(Array(8).fill(1));
    await page.evaluate(`(async()=>{
      const {applyAppAppearance}=await import("/src/client/lib/appearance.ts");
      applyAppAppearance({title:"Batty",color:"neutral"});
    })()`);
    expect(
      await page
        .locator(".hljs-keyword")
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundImage),
    ).toBe("none");
  } finally {
    await browser.close();
    await closeBrowserFixtureServer(server);
  }
});

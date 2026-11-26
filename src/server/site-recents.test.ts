// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { SiteRecents } from "./site-recents";
import { createSite, setSitePublic } from "./sites";

test("only ready local sites can become recent, and visits remain ordered across overlapping opens and restart", async () => {
  const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-site-recents-"));
  const sitesDir = path.join(battyDir, "sites");
  const baseUrl = "/batty";
  const config = { battyDir, sitesDir, baseUrl } as const;
  const recent = new SiteRecents(config);
  const makeSite = async (ready: boolean) => {
    const site = await createSite(sitesDir, baseUrl, "Same name");
    if (ready) await fs.writeFile(path.join(site.directory, "index.html"), "<h1>Site</h1>");
    return site;
  };
  try {
    const a = await makeSite(true);
    const b = await makeSite(true);
    const empty = await makeSite(false);
    const unsafe = await makeSite(false);
    await fs.writeFile(path.join(battyDir, "elsewhere.html"), "<h1>Not site content</h1>");
    await fs.symlink(
      path.join(battyDir, "elsewhere.html"),
      path.join(unsafe.directory, "index.html"),
    );
    const initial = await recent.catalog();
    expect(initial.recentSiteIds).toEqual([]);
    expect(initial.sites).toHaveLength(2);
    expect(initial.sites).toEqual(expect.arrayContaining([a.descriptor, b.descriptor]));
    const openedEmpty = await recent.open(empty.descriptor.id);
    expect(openedEmpty).toEqual({ ...initial, site: empty.descriptor });
    await setSitePublic(sitesDir, baseUrl, b.descriptor.id, true);
    const outcomes = await Promise.allSettled([
      recent.open(a.descriptor.id),
      recent.open("missing"),
      recent.open(b.descriptor.id),
      recent.catalog(),
    ]);
    expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { statusCode: 404 } });
    expect(outcomes[2]).toMatchObject({ status: "fulfilled", value: { site: { public: true } } });
    const order = [b.descriptor.id, a.descriptor.id];
    expect(outcomes[3]).toMatchObject({ status: "fulfilled", value: { recentSiteIds: order } });
    expect((await new SiteRecents(config).catalog()).recentSiteIds).toEqual(order);
    await fs.unlink(path.join(b.directory, "index.html"));
    expect(await recent.catalog()).toEqual({
      sites: [a.descriptor],
      recentSiteIds: [a.descriptor.id],
    });
  } finally {
    await fs.rm(battyDir, { recursive: true, force: true });
  }
});

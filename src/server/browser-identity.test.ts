// @vitest-environment node
import { expect, test } from "vite-plus/test";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { BrowserService } from "./browser-service";
import { removeTestBrowserRoot } from "./test-browser-cleanup";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-identity-"));
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><meta name="viewport" content="width=device-width">
      <title>Identity</title><body><a href="/next">Next</a>
      <script>window.received=${JSON.stringify({
        ua: request.headers["user-agent"],
        mobile: request.headers["sec-ch-ua-mobile"],
        platform: request.headers["sec-ch-ua-platform"],
      })}</script></body>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const service = new BrowserService(undefined, 4, root);
  return {
    root,
    url,
    service,
    async close(current = service) {
      await current.closeSession("identity");
      await current.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeTestBrowserRoot(root);
    },
  };
}

const inspect = `({received:window.received,ua:navigator.userAgent,
  mobile:navigator.userAgentData.mobile,touch:navigator.maxTouchPoints,width:innerWidth,
  timeOrigin:performance.timeOrigin,cookie:document.cookie,login:localStorage.getItem('login')})`;

async function state(service: BrowserService, pageId?: string) {
  const result = await service.execute("identity", {
    action: "evaluate",
    pageId,
    script: `JSON.stringify(${inspect})`,
  });
  return JSON.parse(result.text.slice(result.text.indexOf("Evaluation result:\n") + 19));
}

test("explicit mobile identity selects server HTML on the first request without changing layout or other tabs", async () => {
  const f = await fixture();
  try {
    const opened = await f.service.execute("identity", {
      action: "open",
      url: f.url,
      identity: "mobile",
      viewport: { width: 900, height: 700 },
    });
    const pageId = opened.details.pageId!;
    expect(await state(f.service, pageId)).toMatchObject({
      received: { ua: expect.stringContaining("Mobile"), mobile: "?1", platform: '"Android"' },
      mobile: true,
      touch: 0,
      width: 900,
    });
    await f.service.execute("identity", { action: "click", pageId, selector: "text=Next" });
    expect((await state(f.service, pageId)).received.mobile).toBe("?1");
    const ordinary = await f.service.execute("identity", {
      action: "open",
      url: f.url,
      newPage: true,
    });
    expect((await state(f.service, ordinary.details.pageId)).received.mobile).toBe("?0");
    expect((await state(f.service, pageId)).mobile).toBe(true);
    await f.service.execute("identity", { action: "reload", pageId, identity: "auto" });
    expect((await state(f.service, pageId)).received.mobile).toBe("?0");
    await expect(
      f.service.execute("identity", { action: "snapshot", pageId, identity: "mobile" }),
    ).rejects.toThrow("only be set on open or reload");
  } finally {
    await f.close();
  }
}, 30_000);

test("desktop and phone viewers resize a pinned identity without replacing the website document", async () => {
  const f = await fixture();
  try {
    const opened = await f.service.execute("identity", {
      action: "open",
      url: f.url,
      cloud: true,
      identity: "mobile",
    });
    const id = opened.details.sites![0]!.browserId!;
    for (const mobile of [true, false]) {
      const before = await state(f.service);
      await f.service.cloudControl(id, {
        action: "viewport",
        width: mobile ? 390 : 1100,
        height: 700,
        mobile,
      });
      expect(await state(f.service)).toMatchObject({
        mobile: true,
        touch: mobile ? 1 : 0,
        width: mobile ? 390 : 1100,
        timeOrigin: before.timeOrigin,
      });
      await f.service.cloudControl(id, { action: "reload" });
      expect((await state(f.service)).received.mobile).toBe("?1");
    }
    await f.service.execute("identity", { action: "reload", identity: "desktop" });
    await f.service.cloudControl(id, { action: "viewport", width: 390, height: 700, mobile: true });
    await f.service.cloudControl(id, { action: "reload" });
    expect((await state(f.service)).received.mobile).toBe("?0");
    await f.service.execute("identity", { action: "reload", identity: "auto" });
    expect((await state(f.service)).received.mobile).toBe("?1");
  } finally {
    await f.close();
  }
}, 30_000);

test("pinned tab identity and login survive service reconnect independently of viewer mode", async () => {
  const f = await fixture();
  let service = f.service;
  try {
    const opened = await service.execute("identity", {
      action: "open",
      url: f.url,
      cloud: true,
      identity: "mobile",
    });
    const id = opened.details.sites![0]!.browserId!;
    await service.cloudControl(id, { action: "viewport", width: 1100, height: 700, mobile: false });
    await service.execute("identity", {
      action: "evaluate",
      script: "document.cookie='login=retained';localStorage.setItem('login','retained')",
    });
    const before = await state(service);
    await service.dispose();
    service = new BrowserService(undefined, 4, f.root);
    const target = await service.cloudTarget(id);
    expect(target.state.pageId).toBe(opened.details.pageId);
    expect(target.state.mobile).toBe(false);
    expect(await state(service, opened.details.pageId)).toMatchObject({
      mobile: true,
      touch: 0,
      width: 1100,
      timeOrigin: before.timeOrigin,
      cookie: "login=retained",
      login: "retained",
    });
    await service.cloudControl(id, { action: "navigate", url: f.url + "next" });
    expect((await state(service, opened.details.pageId)).received.mobile).toBe("?1");
    const pages = await service.execute("identity", { action: "pages" });
    expect(pages.details.pages?.find((page) => page.id === opened.details.pageId)?.identity).toBe(
      "mobile",
    );
  } finally {
    await f.close(service);
  }
}, 30_000);

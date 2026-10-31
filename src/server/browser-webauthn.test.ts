// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import { chromium } from "patchright";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import { removeTestBrowserRoot } from "./test-browser-cleanup";
import os from "node:os";
import path from "node:path";
import { BrowserService } from "./browser-service";
import { installWebAuthnPolicy } from "./browser-webauthn";

// Executed by the website, not Patchright's default isolated evaluation world.
const probe = `
window.probe = (async () => {
  const result = { available: 'PublicKeyCredential' in window, get: '', create: '', conditional: '' };
  const publicKey = { challenge: new Uint8Array([1]), rp: { name: 'Test' },
    user: { id: new Uint8Array([1]), name: 'test', displayName: 'Test' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }] };
  for (const [name, method, options] of [
    ['get', 'get', { publicKey }],
    ['create', 'create', { publicKey }],
    ['conditional', 'get', { publicKey, mediation: 'conditional' }],
  ]) {
    try { await navigator.credentials[method](options); result[name] = 'resolved'; }
    catch (error) { result[name] = error.name; }
  }
  return result;
})();`;
const blocked = {
  available: false,
  get: "NotAllowedError",
  create: "NotAllowedError",
  conditional: "NotAllowedError",
};

async function website() {
  const frameServer = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      `<!doctype html><html><head><script>${probe}</script></head><body>Frame</body></html>`,
    );
  });
  frameServer.listen(0, "127.0.0.1");
  await once(frameServer, "listening");
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      `<!doctype html><html><head><script>${request.url === "/existing" ? "" : probe}</script></head><body>Login
      <input name="username"><input name="password" type="password">
      ${request.url === "/" ? '<iframe src="/frame"></iframe><iframe src="http://127.0.0.1:PORT/frame"></iframe>' : ""}
      </body></html>`.replace("PORT", String((frameServer.address() as { port: number }).port)),
    );
  });
  server.listen(0);
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    close: async () => {
      for (const listener of [server, frameServer]) {
        listener.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  };
}

test("tool browsers reject WebAuthn before website scripts, in frames and after navigation/reconnect", async () => {
  const site = await website();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-webauthn-"));
  let service = new BrowserService(undefined, 4, root);
  try {
    await service.execute("policy", { action: "open", url: `${site.url}next` });
    // Attaching cloud later keeps the same policy and page.
    const attachment = await service.execute("policy", { action: "attach", cloud: true });
    const page = (await service.cloudTarget(attachment.details.sites![0]!.browserId)).page;
    expect(await page.evaluate("window.probe", undefined, undefined, false)).toEqual(blocked);
    // Chromium's loopback-network permission is needed for cross-origin fixtures.
    await page.context().grantPermissions(["local-network-access"]);
    await page.goto(site.url);
    expect(page.frames()).toHaveLength(3);
    for (const frame of page.frames()) {
      await expect
        .poll(() => frame.evaluate("window.probe", undefined, undefined, false), { timeout: 5000 })
        .toEqual(blocked);
    }
    await page.locator('[name="username"]').fill("example");
    await page.locator('[name="password"]').fill("test-password");
    expect(await page.locator('[name="username"]').inputValue()).toBe("example");
    expect(await page.locator('[name="password"]').inputValue()).toBe("test-password");
    await page.goto(`${site.url}next`);
    expect(await page.evaluate("window.probe", undefined, undefined, false)).toEqual(blocked);
    await page.evaluate("window.retainedState = 42", undefined, undefined, false);
    await service.dispose();
    service = new BrowserService(undefined, 4, root);
    await service.execute("policy", { action: "pages" });
    const restored = (await service.cloudTarget(attachment.details.sites![0]!.browserId)).page;
    expect(await restored.evaluate("window.retainedState", undefined, undefined, false)).toBe(42);
    // Test calls made after reconnect, not just the previous script's result.
    await restored.addScriptTag({ content: probe });
    expect(await restored.evaluate("window.probe", undefined, undefined, false)).toEqual(blocked);
  } finally {
    await service.closeSession("policy");
    await service.dispose();
    await site.close();
    await removeTestBrowserRoot(root);
  }
}, 30_000);

test("existing Patchright documents receive the policy without reload; other credentials delegate unchanged", async () => {
  const site = await website();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await context.grantPermissions(["local-network-access"]);
    // Do not run the WebAuthn probe until the policy is installed.
    await page.goto(`${site.url}existing`);
    await page.evaluate(
      () => {
        (window as any).retainedState = 42;
        (window as any).credentialCalls = [];
        for (const method of ["get", "create"] as const) {
          CredentialsContainer.prototype[method] = function (...args: any[]) {
            (window as any).credentialCalls.push({
              method,
              receiver: this === navigator.credentials,
              args,
            });
            return Promise.resolve(null);
          };
        }
      },
      undefined,
      undefined,
      false,
    );
    await installWebAuthnPolicy(context);
    await installWebAuthnPolicy(context); // Idempotent across reconnects.
    await page.addScriptTag({ content: probe });
    expect(await page.evaluate("window.probe", undefined, undefined, false)).toEqual(blocked);
    const result = await page.evaluate(
      async () => {
        const get = await navigator.credentials.get({ mediation: "silent" });
        const create = await navigator.credentials.create({});
        return {
          get,
          create,
          calls: (window as any).credentialCalls,
          state: (window as any).retainedState,
        };
      },
      undefined,
      undefined,
      false,
    );
    await page.goto(site.url, { waitUntil: "domcontentloaded" });
    for (const frame of page.frames()) {
      await expect
        .poll(() => frame.evaluate("window.probe", undefined, undefined, false), { timeout: 3000 })
        .toEqual(blocked);
    }
    // Race installation against a real frame detach. The main page survives;
    // navigation remains covered by the context script.
    const child = page.frames()[1]!;
    const evaluate = child.evaluate.bind(child);
    vi.spyOn(child, "evaluate").mockImplementationOnce(async (...args) => {
      await page
        .locator("iframe")
        .first()
        .evaluate((element) => element.remove());
      return evaluate(...args);
    });
    await installWebAuthnPolicy(context);
    expect(child.isDetached()).toBe(true);
    expect(page.isClosed()).toBe(false);
    await page.goto(`${site.url}next`);
    expect(await page.evaluate("window.probe", undefined, undefined, false)).toEqual(blocked);
    expect(result).toEqual({
      get: null,
      create: null,
      state: 42,
      calls: [
        { method: "get", receiver: true, args: [{ mediation: "silent" }] },
        { method: "create", receiver: true, args: [{}] },
      ],
    });
  } finally {
    await browser.close();
    await site.close();
  }
}, 30_000);

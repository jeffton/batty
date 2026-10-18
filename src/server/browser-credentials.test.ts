// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import fastify from "fastify";
import { BrowserService } from "./browser-service";
import { registerCloudBrowserRoutes } from "./routes/cloud-browser";

vi.mock("./cloud-browser-stream", () => ({
  CloudBrowserStreams: class {
    async close() {}
  },
}));
const html = `<!doctype html><form onsubmit="event.preventDefault();window.submitted=true">
<input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password">
<button>Sign in</button></form>`;

test("local credential handoff is explicit, document-bound, one-shot and authenticated without logging secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-credentials-"));
  const website = http.createServer((_request, reply) => reply.end(html));
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
  const service = new BrowserService(undefined, 4, root);
  const logs: string[] = [];
  const app = fastify({ logger: { stream: { write: (line: string) => logs.push(line) } } });
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.cookie !== "test-auth=yes")
      return reply.code(401).send({ error: "Authentication required" });
  });
  const close = await registerCloudBrowserRoutes(app, service, "https://batty.example");
  const headers = { cookie: "test-auth=yes", origin: "https://batty.example" };
  try {
    const result = await service.execute("credentials-test", { action: "open", url, cloud: true });
    const id = result.details.sites![0]!.browserId;
    const endpoint = `/api/cloud-browser/${id}/credentials`;
    const page = (await service.cloudTarget(id)).page;
    const username = "test-only-user";
    const password = "test-only-password-sensitive-marker";
    const prepare = async () => {
      const response = await app.inject({ method: "POST", url: `${endpoint}/prepare`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      return response.json();
    };
    const fill = (target: unknown, overrides = headers) =>
      app.inject({
        method: "POST",
        url: `${endpoint}/fill`,
        headers: overrides,
        payload: { target, username, password },
      });
    let target = await prepare();
    expect(target.origin).toBe(new URL(url).origin);
    expect(await page.locator('[name="password"]').inputValue()).toBe("");
    expect((await fill(target, { ...headers, cookie: "" })).statusCode).toBe(401);
    expect((await fill(target, { ...headers, origin: "https://other.example" })).statusCode).toBe(
      403,
    );
    const response = await fill(target);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(await page.locator('[name="username"]').inputValue()).toBe(username);
    expect(await page.locator('[name="password"]').inputValue()).toBe(password);
    expect(
      await page.evaluate(() => (window as unknown as { submitted?: boolean }).submitted),
    ).toBeUndefined();
    expect((await fill(target)).statusCode).toBe(409);

    target = await prepare();
    await page.reload(); // Same URL and origin, different document.
    expect((await fill(target)).statusCode).toBe(409);
    expect(await page.locator('[name="password"]').inputValue()).toBe("");
    target = await prepare();
    await page.goto(`${url}different`);
    expect((await fill(target)).statusCode).toBe(409);
    target = await prepare();
    await page.locator('[name="password"]').evaluate((input) => input.remove());
    expect((await fill(target)).statusCode).toBe(409);
    await page.goto(url);
    target = await prepare();
    expect((await fill({ ...target, revision: "stale" })).statusCode).toBe(409);
    expect((await fill({ ...target, token: "another-session-token" })).statusCode).toBe(409);
    await page.goto(url);
    await page.evaluate(() => {
      const username = document.querySelector<HTMLInputElement>('[name="username"]')!;
      const password = document.querySelector<HTMLInputElement>('[name="password"]')!;
      // A controlled form rerenders with its previous password state on username input.
      username.addEventListener("input", () => {
        password.value = "";
      });
    });
    target = await prepare();
    expect((await fill(target)).statusCode).toBe(204);
    expect(await page.locator('[name="password"]').inputValue()).toBe(password);
    await page.goto(url);
    await page.evaluate(() => {
      document.querySelector('[name="username"]')!.addEventListener("input", () => {
        document.querySelector('[name="password"]')!.outerHTML =
          '<input name="password" type="password">';
      });
    });
    target = await prepare();
    expect((await fill(target)).statusCode).toBe(409);
    expect(await page.locator('[name="password"]').inputValue()).toBe("");
    await page.goto(url);
    await page.evaluate(() => {
      document.querySelector('[name="username"]')!.addEventListener("input", () => {
        history.pushState({}, "", "/username-handler-navigation");
      });
    });
    target = await prepare();
    expect((await fill(target)).statusCode).toBe(409);
    expect(await page.locator('[name="password"]').inputValue()).toBe("");
    await page.setContent(
      '<input autocomplete="username"><input type="password"><input type="password">',
    );
    expect(
      (await app.inject({ method: "POST", url: `${endpoint}/prepare`, headers })).statusCode,
    ).toBe(409);
    const malformed = await app.inject({
      method: "POST",
      url: `${endpoint}/fill`,
      headers: { ...headers, "content-type": "application/json" },
      payload: `{"password":"${password}", broken}`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain(password);
    const invalid = await app.inject({
      method: "POST",
      url: `${endpoint}/fill`,
      headers,
      payload: { password },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain(password);
    await service.closeSession("credentials-test");
    expect((await fill(target)).statusCode).toBe(410);
    expect(logs.join("\n")).not.toContain(password);
    expect(logs.join("\n")).not.toContain(username);
  } finally {
    await close();
    await app.close();
    await service.closeSession("credentials-test");
    await service.dispose();
    website.closeAllConnections();
    await new Promise<void>((resolve) => website.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);

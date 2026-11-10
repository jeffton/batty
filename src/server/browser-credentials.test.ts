// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import { removeTestBrowserRoot } from "./test-browser-cleanup";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { BrowserService } from "./browser-service";

vi.mock("./cloud-browser-stream", () => ({
  CloudBrowserStreams: class {
    async close() {}
  },
}));

const html = `<!doctype html><form onsubmit="event.preventDefault();window.submitted=true">
<input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password">
<button>Sign in</button></form>`;

test("credential handoff is explicit, document-bound, one-shot and never submits the form", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-credentials-"));
  const website = http.createServer((_request, reply) => reply.end(html));
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
  const service = new BrowserService(undefined, 4, root);
  try {
    const opened = await service.execute("credentials-test", { action: "open", url, cloud: true });
    const id = opened.details.sites![0]!.browserId!;
    const page = (await service.cloudTarget(id)).page;
    const username = "test-only-user";
    const password = "test-only-password-sensitive-marker";
    const prepare = () => service.prepareCloudCredentials(id);
    const fill = (target: Awaited<ReturnType<typeof prepare>>, user = username, pass = password) =>
      service.fillCloudCredentials(id, { target, username: user, password: pass });

    let target = await prepare();
    expect(target.origin).toBe(new URL(url).origin);
    expect(await page.locator('[name="password"]').inputValue()).toBe("");
    await fill(target);
    expect(await page.locator('[name="username"]').inputValue()).toBe(username);
    expect(await page.locator('[name="password"]').inputValue()).toBe(password);
    expect(
      await page.evaluate(() => (window as unknown as { submitted?: boolean }).submitted),
    ).toBeUndefined();
    await expect(fill(target)).rejects.toMatchObject({ statusCode: 409 });

    target = await prepare();
    await page.reload();
    await expect(fill(target)).rejects.toMatchObject({ statusCode: 409 });
    expect(await page.locator('[name="password"]').inputValue()).toBe("");
    target = await prepare();
    await page.goto(`${url}different`);
    await expect(fill(target)).rejects.toMatchObject({ statusCode: 409 });

    await page.goto(url);
    await page.evaluate(() => {
      const username = document.querySelector<HTMLInputElement>('[name="username"]')!;
      const password = document.querySelector<HTMLInputElement>('[name="password"]')!;
      username.addEventListener("input", () => {
        password.value = "";
      });
    });
    target = await prepare();
    await fill(target);
    expect(await page.locator('[name="password"]').inputValue()).toBe(password);

    await page.goto(url);
    await page.evaluate(() => {
      document.querySelector('[name="username"]')!.addEventListener("input", () => {
        document.querySelector('[name="password"]')!.outerHTML =
          '<input name="password" type="password">';
      });
    });
    target = await prepare();
    await expect(fill(target)).rejects.toMatchObject({ statusCode: 409 });
    expect(await page.locator('[name="password"]').inputValue()).toBe("");

    await page.goto(url);
    await page.evaluate(() => {
      document.querySelector('[name="username"]')!.addEventListener("input", () => {
        history.pushState({}, "", "/username-handler-navigation");
      });
    });
    target = await prepare();
    await expect(fill(target)).rejects.toMatchObject({ statusCode: 409 });
    expect(await page.locator('[name="password"]').inputValue()).toBe("");

    await page.goto(url);
    target = await prepare();
    await page.locator('[name="password"]').evaluate((input) => input.remove());
    await expect(fill(target)).rejects.toMatchObject({ statusCode: 409 });
    expect(await page.locator('[name="password"]').count()).toBe(0);

    await page.goto(url);
    target = await prepare();
    await expect(fill({ ...target, revision: "stale" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(fill({ ...target, token: "another-session-token" })).rejects.toMatchObject({
      statusCode: 409,
    });

    for (const content of [
      '<form><input type="search"><button>Search</button></form>',
      '<form action="/login"><input type="tel" autocomplete="one-time-code"><button>Continue</button></form>',
      '<form action="/login"><input name="otp"><button>Continue</button></form>',
      '<form><input type="email"><button>Subscribe</button></form>',
      '<form action="/signup"><input autocomplete="username"><button>Continue</button></form>',
      '<form action="/signup"><input type="email"><input type="password"><button>Create account</button></form>',
      '<form><input autocomplete="username"><input type="password" autocomplete="new-password"></form>',
      '<form><input type="email"><input type="password"><button>Create account</button></form>',
      '<iframe srcdoc="<input autocomplete=username><input type=password autocomplete=current-password>"></iframe>',
    ]) {
      await page.setContent(content);
      expect((await service.cloudState(id)).login).toBeUndefined();
      await expect(prepare()).rejects.toMatchObject({ statusCode: 409 });
    }

    await page.setContent(
      '<form><input autocomplete="username"><input type="password" autocomplete="current-password"><input autocomplete="one-time-code" id="code"></form>',
    );
    expect((await service.cloudState(id)).login).toBeDefined();
    await page.locator("#code").focus();
    expect((await service.cloudState(id)).login).toBeUndefined();
    expect((await service.cloudState(id)).focused!.type).toBe("text");

    await page.setContent(
      '<form><input autocomplete="username"><input type="password" autocomplete="current-password"></form>',
    );
    expect((await service.cloudState(id)).login).toBeDefined();
    target = await prepare();
    await fill(target);
    expect(await page.locator('input[type="password"]').inputValue()).toBe(password);

    await page.setContent(
      '<form action="/ax/claim"><input type="email" name="email"><button>Continue</button></form>',
    );
    expect((await service.cloudState(id)).login).toMatchObject({ username: true, password: false });
    target = await prepare();
    await fill(target, username, "");
    expect(await page.locator('[name="email"]').inputValue()).toBe(username);

    await page.setContent(
      '<form><input type="password" autocomplete="current-password"><button>Sign in</button></form>',
    );
    expect((await service.cloudState(id)).login).toMatchObject({ username: false, password: true });
    target = await prepare();
    await fill(target, "", password);
    expect(await page.locator("input").inputValue()).toBe(password);

    target = await prepare();
    await page.locator("input").evaluate((input) => {
      input.outerHTML = '<input type="password" autocomplete="current-password">';
    });
    await expect(fill(target)).rejects.toMatchObject({ statusCode: 409 });

    target = await prepare();
    await page
      .locator("input")
      .evaluate((input) => input.setAttribute("autocomplete", "new-password"));
    await expect(fill(target)).rejects.toMatchObject({ statusCode: 409 });

    await page.route("http://insecure-login.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: html }),
    );
    await page.goto("http://insecure-login.test/");
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    expect((await service.cloudState(id)).login).toMatchObject({ username: true, password: true });
    target = await prepare();
    await fill(target);

    await page.goto(url);
    await service.closeSession("credentials-test");
    await expect(prepare()).rejects.toMatchObject({ statusCode: 410 });
  } finally {
    await service.closeSession("credentials-test");
    await service.dispose();
    website.closeAllConnections();
    await new Promise<void>((resolve) => website.close(() => resolve()));
    await removeTestBrowserRoot(root);
  }
}, 60_000);

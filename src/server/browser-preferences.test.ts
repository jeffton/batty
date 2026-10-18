// @vitest-environment node
import { expect, test, vi } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser } from "patchright";
import {
  closePersistentBrowser,
  connectPersistentBrowser,
  writeBrowserJson,
} from "./browser-persistence";

test("Chromium reads native-prompt preferences before launch without disabling webpage password fields", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-browser-prefs-"));
  let browser: Browser | undefined;
  try {
    await writeBrowserJson(path.join(directory, "profile", "Default", "Preferences"), {
      credentials_enable_service: true,
      translate: { enabled: true, unused_fixture_key: "preserved" },
      intl: { accept_languages: "en-US,en" },
    });
    ({ browser } = await connectPersistentBrowser(directory, { useTailscale: false }));
    const context = browser.contexts()[0]!;
    const page = context.pages()[0]!;
    await page.goto("chrome://settings/languages");
    const getPreference = (name: string) =>
      page.evaluate(
        (name) =>
          new Promise<{ value: unknown }>((resolve) => {
            (globalThis as any).chrome.settingsPrivate.getPref(name, resolve);
          }),
        name,
        undefined,
        false,
      );
    // Read Chrome's effective in-memory preferences through its own WebUI API,
    // not merely the JSON file written before launch.
    expect((await getPreference("translate.enabled")).value).toBe(false);
    expect((await getPreference("credentials_enable_service")).value).toBe(false);
    expect((await getPreference("intl.accept_languages")).value).toBe("en-US,en");
    const preferences = JSON.parse(
      await fs.readFile(path.join(directory, "profile", "Default", "Preferences"), "utf8"),
    );
    expect(preferences.translate.unused_fixture_key).toBe("preserved");
    await page.goto(
      "data:text/html,<form><input autocomplete='username'><input type='password' autocomplete='current-password'></form><button onclick=\"document.documentElement.lang='sv'\">Website language</button>",
    );
    await page.locator("input[type=password]").fill("synthetic-fixture");
    expect(await page.locator("input[type=password]").inputValue()).toBe("synthetic-fixture");
    await page.getByRole("button", { name: "Website language" }).click();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("sv");
    // Reattaching must not recreate or rewrite a running profile's preferences.
    await page.evaluate(() => {
      (globalThis as any).sessionMarker = 42;
    });
    await browser.close();
    const writes = vi.spyOn(fs, "writeFile");
    const reconnect = await connectPersistentBrowser(directory);
    expect(
      writes.mock.calls.some(([file]) =>
        String(file).startsWith(path.join(directory, "profile", "Default", "Preferences")),
      ),
    ).toBe(false);
    writes.mockRestore();
    browser = reconnect.browser;
    expect(reconnect.created).toBe(false);
    expect(
      await browser
        .contexts()[0]!
        .pages()[0]!
        .evaluate(() => (globalThis as any).sessionMarker),
    ).toBe(42);
  } finally {
    vi.restoreAllMocks();
    await closePersistentBrowser(directory, browser);
  }
}, 20_000);

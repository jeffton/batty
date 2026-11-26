// Run after pnpm build. No production paths, credentials, model calls or database.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { tsImport } from "tsx/esm/api";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

const { createMaintenanceApp } = await tsImport(
  "../src/server/maintenance-app.ts",
  import.meta.url,
);
const { createMaintenanceChat } = await tsImport(
  "../src/server/maintenance-chat.ts",
  import.meta.url,
);
const { PasskeyAuthService } = await tsImport("../src/server/passkeys.ts", import.meta.url);
const { maintenanceDir, maintenanceFile, writeMaintenance } = await tsImport(
  "../src/server/maintenance-state.ts",
  import.meta.url,
);
const { createAuthToken } = await tsImport("../src/server/auth.ts", import.meta.url);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-maintenance-fixture-"));
const secret = "fixture auth secret";
const state = {
  id: "fixture",
  phase: "offline",
  message: "Copying the test database",
  progress: 37,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  model: { provider: "faux", modelId: "main-fixture", thinkingLevel: "high" },
};
let toolRead;
let app;
let browser;
try {
  const faux = fauxProvider({ models: [{ id: "main-fixture" }], tokensPerSecond: 10000 });
  // The real pi agent makes two calls; fixture provider sees the genuine diagnostic result.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("maintenance_status", {})], { stopReason: "toolUse" }),
    ({ messages }) => {
      const result = messages.findLast((message) => message.role === "toolResult");
      toolRead = JSON.parse(result.content[0].text);
      return fauxAssistantMessage([fauxText(`The copy is ${toolRead.progress}% complete.`)]);
    },
  ]);
  const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  models.registerNativeProvider(faux.provider);
  await fs.mkdir(path.join(root, ".batty"));
  await fs.writeFile(
    path.join(root, ".batty/options.json"),
    JSON.stringify({
      authSecret: secret,
      workspacesRoots: [root],
      webPushSubject: "mailto:fixture@example.invalid",
    }),
  );
  await fs.mkdir(maintenanceDir(root));
  await writeMaintenance(root, state);
  const guarded = await promisify(execFile)(process.execPath, ["dist/server/main.mjs", root], {
    timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: root, BATTY_SELF_PATH: process.cwd() },
  });
  assert.match(guarded.stdout, /Run batty2 maintenance allow-start/);

  // No main process or runtime database exists. This app loads the production browser bundle.
  const mainUrl = "http://127.0.0.1:1";
  app = await createMaintenanceApp(
    root,
    path.resolve("dist/client"),
    mainUrl,
    createMaintenanceChat(root, mainUrl, models),
  );
  const listener = await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = listener.replace("127.0.0.1", "localhost");
  const currentCookie = `batty2-auth=${createAuthToken(secret)}`;
  const csrf = await fetch(origin + "/api/maintenance/chat", {
    method: "POST",
    headers: { origin: "https://another.test", cookie: currentCookie },
  });
  assert.equal(csrf.status, 403);
  const guest = await fetch(origin + "/api/maintenance/status");
  assert.deepEqual(await guest.json(), { active: true, authenticated: false });
  const blocked = await fetch(origin + "/api/bootstrap");
  assert.equal(blocked.status, 503);
  assert.equal(blocked.headers.get("x-batty-maintenance"), "1");

  browser = await chromium.launch({ headless: true });
  const desktop = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  await desktop.addCookies([
    { name: "batty2-auth", value: currentCookie.split("=")[1], url: origin },
  ]);
  const page = await desktop.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  assert.equal((await page.goto(origin)).status(), 503);
  await page.getByText(state.message).waitFor();
  assert.equal(await page.getByRole("progressbar").getAttribute("value"), "37");
  await page.getByRole("textbox", { name: "Question" }).fill("How is the copy going?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByText("The copy is 37% complete.").waitFor();
  assert.equal(toolRead.progress, 37);
  assert.deepEqual(failures, []);

  // A fresh mobile tab cannot see private status until a real WebAuthn sign-in.
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 700 },
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
  });
  const phone = await mobile.newPage();
  await phone.goto(origin + "/maintenance/");
  await phone.getByRole("button", { name: "Sign in with a passkey" }).waitFor();
  assert.equal(await phone.getByText(state.message).count(), 0);
  const cdp = await mobile.newCDPSession(phone);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const passkeys = new PasskeyAuthService(root, secret);
  const setup = await passkeys.initialize();
  const enrollment = await passkeys.beginRegistration(setup.code, origin, "localhost");
  const credential = await phone.evaluate(async (options) => {
    const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options);
    return (await navigator.credentials.create({ publicKey })).toJSON();
  }, enrollment.optionsJSON);
  await passkeys.finishRegistration(enrollment.requestId, credential, origin, "localhost");
  await phone.getByRole("button", { name: "Sign in with a passkey" }).click();
  await phone.getByText(state.message).waitFor();
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 390);
  await phone.locator(".illustration").evaluate((image) => image.decode());
  assert.equal(
    await phone.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)),
    0,
  );

  await writeMaintenance(root, { ...state, message: "Verifying fixture", progress: null });
  await phone.getByText("Verifying fixture").waitFor();
  assert.equal(await phone.getByRole("progressbar").getAttribute("value"), null);
  await page.reload();
  await page.getByText("Verifying fixture").waitFor();
  assert.equal(await page.getByText("The copy is 37% complete.").count(), 0);

  await phone.route(origin + "/", (route) => route.fulfill({ body: "Normal Batty" }));
  await fs.unlink(maintenanceFile(root));
  await phone.getByText("Normal Batty").waitFor();
  await fs.access(path.join(root, ".batty/runtime.sqlite")).then(
    () => {
      throw new Error("Maintenance created the main database");
    },
    (error) => assert.equal(error.code, "ENOENT"),
  );
  console.log(
    "Maintenance status, model diagnostics, fresh passkey, mobile and return to Batty verified",
  );
} finally {
  await browser?.close();
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}

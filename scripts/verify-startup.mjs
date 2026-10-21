// Run after pnpm build. Start the actual packaged server with isolated runtime data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const repo = process.cwd();
const artifact = path.join(repo, "dist/server/main.mjs");
await fs.access(artifact);

for (const baseUrl of ["/", "/batty"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-startup-"));
  let child;
  let exited;
  let logs = "";
  try {
    const workspaceRoot = path.join(root, "workspaces");
    await fs.mkdir(path.join(workspaceRoot, "assistant"), { recursive: true });
    await fs.mkdir(path.join(root, ".batty"));
    const secret = crypto.randomBytes(32).toString("base64url");
    await fs.writeFile(
      path.join(root, ".batty/options.json"),
      JSON.stringify({
        baseUrl,
        authSecret: secret,
        workspacesRoots: [workspaceRoot],
        assistantWorkspaceId: "assistant",
        webPushSubject: "mailto:smoke@example.invalid",
      }),
    );
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    child = spawn(process.execPath, [artifact, root], {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        BATTY_SELF_PATH: repo,
        BATTY_HOST: "127.0.0.1",
        BATTY_PORT: String(port),
        BATTY_BUILD_ID: "startup-smoke",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = once(child, "exit");
    child.stdout.on("data", (chunk) => {
      logs = (logs + chunk).slice(-16_384);
    });
    child.stderr.on("data", (chunk) => {
      logs = (logs + chunk).slice(-16_384);
    });
    const origin = `http://127.0.0.1:${port}`;
    const get = (route, init) =>
      fetch(`${origin}${route}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(2000) });
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Packaged server exited during startup (baseUrl=${baseUrl}).\n${logs}`);
      try {
        const response = await get("/healthz");
        const health = await response.json();
        if (response.ok && health.ok && health.buildId === "startup-smoke") {
          healthy = true;
          break;
        }
      } catch (error) {
        if (error.cause?.code !== "ECONNREFUSED") throw error;
      }
      await delay(100);
    }
    assert(healthy, `Packaged server failed to become healthy (baseUrl=${baseUrl}).\n${logs}`);
    const html = await (await get("/")).text();
    assert(html.includes(`<base href="${baseUrl === "/" ? "/" : `${baseUrl}/`}">`));
    const version = await (await get("/api/version")).json();
    assert.equal(version.buildId, "startup-smoke");
    const id = "00000000-0000-0000-0000-000000000000";
    const route = `/api/cloud-browser/${id}/state`;
    assert.equal((await get(route)).status, 401);
    assert.equal((await get("/api/cron/running")).status, 401);
    const foregroundAck = (headers = {}) =>
      get("/api/push/foreground/ack", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ clientId: id, challengeId: id }),
      });
    assert.equal((await foregroundAck()).status, 401);
    const payload = Buffer.from(
      JSON.stringify({ issuedAt: Date.now(), expiresAt: Date.now() + 60_000 }),
    ).toString("base64url");
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    const cookie = `batty2-auth=${payload}.${signature}`;
    assert.equal((await get(route, { headers: { cookie } })).status, 410);
    const runningCron = await get("/api/cron/running", { headers: { cookie } });
    assert.equal(runningCron.status, 200);
    assert.deepEqual(await runningCron.json(), []);
    const ack = await foregroundAck({ cookie });
    assert.equal(ack.status, 200);
    assert.deepEqual(await ack.json(), { ok: false });
    const streamAbort = new AbortController();
    try {
      const response = await get("/api/main/events", {
        headers: { cookie },
        signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(5000)]),
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      let packet = "";
      while (!packet.includes("\n\n")) {
        const { value, done } = await reader.read();
        assert(!done, "Session SSE ended before push stream identity");
        packet += new TextDecoder().decode(value);
      }
      assert(packet.startsWith("event: push-client\ndata: "));
      const identity = JSON.parse(packet.split("\n")[1].slice(6));
      assert.match(identity.clientId, /^[a-f0-9-]{36}$/);
      await reader.cancel();
    } finally {
      streamAbort.abort();
    }
    const control = (requestOrigin) =>
      get(`/api/cloud-browser/${id}/control`, {
        method: "POST",
        headers: {
          cookie,
          "x-forwarded-host": "smoke.example",
          "x-forwarded-proto": "https",
          origin: requestOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "reload" }),
      });
    assert.equal((await control("https://attacker.example")).status, 403);
    assert.equal((await control("https://smoke.example")).status, 410);
    const upgrade = (headers = {}) =>
      new Promise((resolve, reject) => {
        const request = http.get(`${origin}/api/cloud-browser/${id}/socket`, {
          agent: false,
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
            ...headers,
          },
          timeout: 2000,
        });
        request.on("response", (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        request.on("upgrade", (response, socket) => {
          socket.destroy();
          resolve(response.statusCode);
        });
        request.on("error", reject);
        request.on("timeout", () => request.destroy(new Error("WebSocket upgrade timed out")));
      });
    assert.equal(await upgrade({ origin }), 401);
    assert.equal(await upgrade({ cookie, origin: "https://attacker.example" }), 403);
    assert.equal(await upgrade({ cookie, origin }), 410);
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(200);
      assert.equal(child.exitCode, null);
      assert.equal((await get("/healthz")).status, 200);
    }
    console.log(
      `Packaged server startup passed: baseUrl=${baseUrl}, authenticated cloud routes, HTTPS origin, stable health`,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (exited) {
      const terminated = await Promise.race([
        exited.then(() => true),
        delay(10_000, false, { ref: false }),
      ]);
      if (!terminated) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

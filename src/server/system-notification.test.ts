import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { expect, test, vi } from "vite-plus/test";
import { createAuthToken } from "./auth";
import { fixture } from "./orchestration-test-fixture";
import { registerPushCompletions } from "./push-completions";
import { registerApiAuth } from "./routes/api-auth";
import { registerCronRoutes } from "./routes/cron";
import { context, entryMessages, type Runtime } from "./runtime";
import { publishSystemNotification } from "./system-notification";
import type { WebPushService } from "./web-push";

test("owner's local notification commits a visible reply and push exactly once without a model", async () => {
  const { orchestration, open } = await fixture();
  const { harness, main } = await open();
  const app = Fastify({ trustProxy: ["127.0.0.1"] });
  const secret = "isolated-test-key";
  await app.register(cookie);
  registerApiAuth(app, { authSecret: secret, cookieName: "test" }, () => undefined);
  registerCronRoutes(app, orchestration, (id, text) => publishSystemNotification(main, id, text));
  const notify = vi.fn<WebPushService["notifyAgentCompleted"]>();
  const stop = registerPushCompletions(
    { harness, main, state: async () => ({ sessionId: String(main.id) }) } as unknown as Runtime,
    { notifyAgentCompleted: notify } as unknown as WebPushService,
    (error) => {
      throw error;
    },
  );
  const credentials = { cookie: `test=${createAuthToken(secret, 60_000)}` };
  const text = "Test-only backup failure";
  const payload = { action: "notify", eventId: "backup-test", text };
  const send = (headers: Record<string, string> = credentials, body = payload) =>
    app.inject({ method: "POST", url: "/api/cron", payload: body, headers });
  try {
    expect((await send({ cookie: "" })).statusCode).toBe(401);
    expect((await send({ ...credentials, "x-forwarded-for": "198.51.100.3" })).statusCode).toBe(
      403,
    );
    expect((await send(credentials, { ...payload, text: " " })).statusCode).toBe(400);
    const results = await Promise.all([send(), send()]);
    expect(results.map((result) => result.json().published).sort()).toEqual([false, true]);
    expect(entryMessages((await main.context(context)).entries)).toMatchObject([
      { role: "assistant", blocks: [{ type: "text", text }] },
    ]);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0]![0].messages).toMatchObject([
      { role: "assistant", blocks: [{ type: "text", text }] },
    ]);
  } finally {
    stop();
    await app.close();
  }
});

import { Type } from "typebox";
import { Check } from "typebox/value";
import type { FastifyInstance } from "fastify";
import { CLOUD_BROWSER_KEYS, type CloudBrowserControl } from "@/shared/cloud-browser";
import type { BrowserService } from "../browser-service";
import { CloudBrowserStreams } from "../cloud-browser-stream";
import { createCloudBrowserEventWriter } from "../cloud-browser-events";

const target = {
  pageId: Type.String({ minLength: 1, maxLength: 100 }),
  revision: Type.String({ minLength: 1, maxLength: 100 }),
};
const point = {
  x: Type.Number({ minimum: 0, maximum: 10_000 }),
  y: Type.Number({ minimum: 0, maximum: 10_000 }),
};
const command = (action: string, fields = {}) =>
  Type.Object({ action: Type.Literal(action), ...fields }, { additionalProperties: false });
const controlSchema = Type.Union([
  command("click", { ...target, ...point }),
  command("scroll", {
    ...target,
    ...point,
    deltaX: Type.Number({ minimum: -10_000, maximum: 10_000 }),
    deltaY: Type.Number({ minimum: -10_000, maximum: 10_000 }),
  }),
  command("drag", {
    ...target,
    ...point,
    endX: Type.Number({ minimum: 0, maximum: 10_000 }),
    endY: Type.Number({ minimum: 0, maximum: 10_000 }),
  }),
  command("fill-focused", {
    ...target,
    focusId: Type.String({ minLength: 1, maxLength: 100 }),
    value: Type.String({ maxLength: 10_000 }),
  }),
  command("text", { ...target, text: Type.String({ minLength: 1, maxLength: 10_000 }) }),
  command("key", {
    ...target,
    key: Type.String({ enum: [...CLOUD_BROWSER_KEYS] }),
    focusId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  }),
  command("navigate", {
    url: Type.String({ minLength: 1, maxLength: 8192, pattern: "^https?://" }),
  }),
  command("back"),
  command("reload"),
  command("switch", { pageId: target.pageId }),
  command("close-page", { pageId: target.pageId }),
  command("viewport", {
    width: Type.Integer({ minimum: 1, maximum: 10000 }),
    height: Type.Integer({ minimum: 1, maximum: 10000 }),
    mobile: Type.Boolean(),
  }),
]);

export function registerCloudBrowserRoutes(
  app: FastifyInstance,
  browser: BrowserService,
  baseUrl: string,
): () => Promise<void> {
  const streams = new CloudBrowserStreams(browser);
  const prefix = "/api/cloud-browser/:browserId";
  app.get<{ Params: { browserId: string } }>(`${prefix}/state`, async (request) =>
    browser.cloudState(request.params.browserId),
  );
  app.post<{ Params: { browserId: string }; Body: CloudBrowserControl }>(
    `${prefix}/control`,
    {
      schema: { body: controlSchema },
      bodyLimit: 64 * 1024,
      // AJV's removeAdditional mutates union branches before discriminating actions.
      validatorCompiler: () => (data) =>
        Check(controlSchema, data)
          ? { value: data }
          : { error: new Error("Invalid browser control command.") },
    },
    async (request, reply) => {
      // Credentials alone must not let another site drive a logged-in browser.
      const origin = new URL(baseUrl, `${request.protocol}://${request.host}`).origin;
      if (request.headers.origin !== origin)
        return reply.code(403).send({ error: "Same-origin browser control required." });
      return browser.cloudControl(request.params.browserId, request.body);
    },
  );
  app.get<{ Params: { browserId: string } }>(`${prefix}/events`, async (request, reply) => {
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const writer = createCloudBrowserEventWriter(reply.raw);
    const onClose = () => {
      closed = true;
      writer.close();
      unsubscribe?.();
    };
    reply.raw.on("close", onClose);
    try {
      unsubscribe = await streams.subscribe(request.params.browserId, writer.send);
    } catch (error) {
      reply.raw.removeListener("close", onClose);
      writer.close();
      throw error;
    }
    if (closed) {
      unsubscribe();
      return reply;
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    reply.raw.flushHeaders();
    writer.start();
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableNeedDrain) reply.raw.write(": keepalive\n\n");
    }, 15_000);
    // Reauthenticate long-lived views periodically, including after logout.
    const reconnect = setTimeout(() => reply.raw.end(), 10 * 60_000);
    heartbeat.unref();
    reconnect.unref();
    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      clearTimeout(reconnect);
    });
    return reply;
  });
  return () => streams.close();
}

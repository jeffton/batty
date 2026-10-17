import { Type } from "typebox";
import { Check } from "typebox/value";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { CLOUD_BROWSER_KEYS, type CloudBrowserControl } from "@/shared/cloud-browser";
import type { BrowserService } from "../browser-service";
import { CloudBrowserStreams } from "../cloud-browser-stream";
import { createCloudBrowserSocketWriter } from "../cloud-browser-events";

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
    deviceScaleFactor: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })),
  }),
]);

const socketCommandSchema = Type.Union([
  command("ack", { frameId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }),
  command("flush", { requestId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }),
  command("scroll", {
    ...target,
    ...point,
    deltaX: Type.Number({ minimum: -10_000, maximum: 10_000 }),
    deltaY: Type.Number({ minimum: -10_000, maximum: 10_000 }),
  }),
]);
type ScrollCommand = Extract<CloudBrowserControl, { action: "scroll" }>;

export async function registerCloudBrowserRoutes(
  app: FastifyInstance,
  browser: BrowserService,
  baseUrl: string,
): Promise<() => Promise<void>> {
  await app.register(websocket, { options: { maxPayload: 2048, perMessageDeflate: false } });
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
  app.get<{ Params: { browserId: string } }>(
    `${prefix}/socket`,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const origin = new URL(baseUrl, `${request.protocol}://${request.host}`).origin;
        if (request.headers.origin !== origin)
          return reply.code(403).send({ error: "Same-origin browser control required." });
        // Ordinary onRequest auth runs before upgrade; expiry must also reject before upgrade.
        await browser.cloudTarget(request.params.browserId);
      },
    },
    (socket, request) => {
      const writer = createCloudBrowserSocketWriter(socket);
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      let scrolling = false;
      const pendingScroll: ScrollCommand[] = [];
      let fenceRequestId: number | undefined;
      let fenceQueued = false;
      let lastFenceRequestId = 0;
      const drain = () => {
        if (
          closed ||
          scrolling ||
          pendingScroll.length ||
          fenceQueued ||
          fenceRequestId === undefined
        )
          return;
        const requestId = fenceRequestId;
        fenceQueued = true;
        writer.send("scroll-drained", { requestId }, () => {
          fenceRequestId = undefined;
          fenceQueued = false;
        });
      };
      const fail = (error: unknown) => {
        const { message, statusCode } = error as Error & { statusCode?: number };
        writer.send("browser-error", {
          error: message,
          statusCode,
          retryable: statusCode !== 410 && statusCode !== 400 && statusCode !== 403,
        });
      };
      const scroll = async () => {
        if (scrolling) return;
        scrolling = true;
        try {
          while (!closed && pendingScroll.length) {
            const command = pendingScroll.shift()!;
            try {
              await browser.cloudScroll(request.params.browserId, command);
              streams.scrolling(request.params.browserId);
            } catch (error) {
              const { message, statusCode } = error as Error & { statusCode?: number };
              writer.send("scroll-error", { error: message, statusCode });
            }
          }
        } finally {
          scrolling = false;
          drain();
        }
      };
      socket.on("message", (data, isBinary) => {
        try {
          if (isBinary) throw new Error("Browser commands must be JSON text.");
          const parsed: unknown = JSON.parse(data.toString());
          if (!Check(socketCommandSchema, parsed))
            throw new Error("Invalid browser socket command.");
          const command = parsed as
            | ScrollCommand
            | { action: "ack"; frameId: number }
            | { action: "flush"; requestId: number };
          if (command.action === "ack") writer.acknowledge(command.frameId);
          else if (command.action === "flush") {
            if (fenceRequestId !== undefined || command.requestId <= lastFenceRequestId)
              throw new Error(
                "Browser scroll fences require one outstanding request and increasing request IDs.",
              );
            fenceRequestId = command.requestId;
            lastFenceRequestId = command.requestId;
            drain();
          } else {
            const next = command as ScrollCommand;
            const last = pendingScroll.at(-1);
            // Only coalesce the same exact anchor; nested and outer scroll targets stay FIFO.
            if (
              last &&
              last.pageId === next.pageId &&
              last.revision === next.revision &&
              last.x === next.x &&
              last.y === next.y
            ) {
              last.deltaX += next.deltaX;
              last.deltaY += next.deltaY;
            } else if (pendingScroll.length < 2) pendingScroll.push({ ...next });
            else {
              writer.send("scroll-error", {
                error: "Browser scroll input queue is full. Wait for pending input to finish.",
                statusCode: 409,
              });
              return;
            }
            void scroll();
          }
        } catch (error) {
          fail(Object.assign(error as Error, { statusCode: 400 }));
        }
      });
      let alive = true;
      socket.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, 15_000);
      // A fresh upgrade rechecks the ordinary Batty authentication cookie after logout/expiry.
      const reauthenticate = setTimeout(
        () => socket.close(1001, "Authentication revalidation"),
        10 * 60_000,
      );
      heartbeat.unref();
      reauthenticate.unref();
      socket.on("close", () => {
        closed = true;
        pendingScroll.length = 0;
        fenceRequestId = undefined;
        writer.close();
        unsubscribe?.();
        clearInterval(heartbeat);
        clearTimeout(reauthenticate);
      });
      socket.on("error", (error) => {
        request.log.warn({ err: error }, "Cloud browser socket failed");
        socket.terminate();
      });
      void streams
        .subscribe(request.params.browserId, writer.send)
        .then((stop) => {
          if (closed) stop();
          else unsubscribe = stop;
        })
        .catch(fail);
    },
  );
  return () => streams.close();
}

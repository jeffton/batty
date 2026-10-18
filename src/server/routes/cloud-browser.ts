import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { Type } from "typebox";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type {
  CloudBrowserControl,
  CloudBrowserTouch,
  CloudBrowserCredentials,
} from "@/shared/cloud-browser";
import type { BrowserService } from "../browser-service";
import { CloudBrowserControlSchema, CloudBrowserSocketCommandSchema } from "../browser-schemas";
import { CloudBrowserStreams } from "../cloud-browser-stream";
import { createCloudBrowserSocketWriter } from "../cloud-browser-events";

type ScrollCommand = Extract<CloudBrowserControl, { action: "scroll" }>;

export async function registerCloudBrowserRoutes(
  app: FastifyInstance,
  browser: BrowserService,
  baseUrl: string,
): Promise<() => Promise<void>> {
  await app.register(websocket, { options: { maxPayload: 2048, perMessageDeflate: false } });
  const streams = new CloudBrowserStreams(browser);
  const prefix = "/api/cloud-browser/:browserId";
  const credentialSchema = Type.Object(
    {
      target: Type.Object(
        {
          loginId: Type.String({ maxLength: 100 }),
          pageId: Type.String({ maxLength: 200 }),
          revision: Type.String({ maxLength: 100 }),
          url: Type.String({ maxLength: 16384 }),
          origin: Type.String({ maxLength: 2048 }),
          token: Type.String({ maxLength: 100 }),
        },
        { additionalProperties: false },
      ),
      username: Type.String({ maxLength: 4096 }),
      password: Type.String({ maxLength: 16384 }),
    },
    { additionalProperties: false },
  );
  const sameOrigin = (request: { protocol: string; host: string; headers: { origin?: string } }) =>
    request.headers.origin === new URL(baseUrl, `${request.protocol}://${request.host}`).origin;
  app.post<{ Params: { browserId: string } }>(
    `${prefix}/credentials/prepare`,
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!sameOrigin(request))
        return reply.code(403).send({ error: "Same-origin browser control required." });
      return browser.prepareCloudCredentials(request.params.browserId);
    },
  );
  app.post<{ Params: { browserId: string }; Body: CloudBrowserCredentials }>(
    `${prefix}/credentials/fill`,
    {
      bodyLimit: 64 * 1024,
      // Parser/validation errors may contain submitted JSON. Do not pass them to
      // the global error logger or echo their messages back to the client.
      errorHandler: (_error, _request, reply) => {
        const status = (_error as { statusCode?: number }).statusCode ?? 500;
        return reply
          .code(status)
          .header("Cache-Control", "no-store")
          .send({ error: "Credential fill failed. Reopen the login panel and try again." });
      },
      schema: { body: credentialSchema },
      validatorCompiler: () => (data) =>
        Check(credentialSchema, data)
          ? { value: data }
          : { error: new Error("Invalid credential request.") },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!sameOrigin(request))
        return reply.code(403).send({ error: "Same-origin browser control required." });
      await browser.fillCloudCredentials(request.params.browserId, request.body);
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { browserId: string } }>(`${prefix}/state`, async (request) =>
    browser.cloudState(request.params.browserId),
  );
  app.post<{ Params: { browserId: string }; Body: CloudBrowserControl }>(
    `${prefix}/control`,
    {
      schema: { body: CloudBrowserControlSchema },
      bodyLimit: 64 * 1024,
      // AJV's removeAdditional mutates union branches before discriminating actions.
      validatorCompiler: () => (data) =>
        Check(CloudBrowserControlSchema, data)
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
      const touchOwner = randomUUID();
      let touchHeld = false;
      const releaseTouch = async () => {
        if (!touchHeld) return;
        streams.scrolling(request.params.browserId, false);
        touchHeld = false;
        try {
          await browser.cloudReleaseTouch(request.params.browserId, touchOwner);
        } catch (error) {
          request.log.warn({ err: error }, "Cloud browser touch cancellation failed");
        }
      };
      const pendingScroll: Array<ScrollCommand | CloudBrowserTouch> = [];
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
          retryable:
            statusCode !== 410 && statusCode !== 400 && statusCode !== 403 && statusCode !== 504,
        });
      };
      const scroll = async () => {
        if (scrolling) return;
        scrolling = true;
        try {
          while (!closed && pendingScroll.length) {
            const command = pendingScroll.shift()!;
            try {
              if (command.action === "touch") {
                await browser.cloudTouch(request.params.browserId, command, touchOwner);
                // Hold the motion quality across touch pauses and the release fling.
                touchHeld = command.phase === "start" || command.phase === "move";
                streams.scrolling(request.params.browserId, touchHeld);
              } else {
                await browser.cloudScroll(request.params.browserId, command);
                streams.scrolling(request.params.browserId);
              }
            } catch (error) {
              const { message, statusCode } = error as Error & { statusCode?: number };
              if (command.action === "touch") await releaseTouch();
              writer.send("scroll-error", { error: message, statusCode });
            }
          }
        } finally {
          scrolling = false;
          if (closed) await releaseTouch();
          drain();
        }
      };
      socket.on("message", (data, isBinary) => {
        try {
          if (isBinary) throw new Error("Browser commands must be JSON text.");
          const parsed: unknown = JSON.parse(data.toString());
          if (!Check(CloudBrowserSocketCommandSchema, parsed))
            throw new Error("Invalid browser socket command.");
          const command = parsed as
            | ScrollCommand
            | CloudBrowserTouch
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
            const next = command;
            const last = pendingScroll.at(-1);
            // Only coalesce the same exact anchor; nested and outer scroll targets stay FIFO.
            if (
              last?.action === "scroll" &&
              next.action === "scroll" &&
              last.pageId === next.pageId &&
              last.revision === next.revision &&
              last.x === next.x &&
              last.y === next.y
            ) {
              last.deltaX += next.deltaX;
              last.deltaY += next.deltaY;
            } else if (
              last?.action === "touch" &&
              next.action === "touch" &&
              last.phase === "move" &&
              next.phase === "move" &&
              last.pageId === next.pageId &&
              last.revision === next.revision
            ) {
              pendingScroll[pendingScroll.length - 1] = next;
            } else if (pendingScroll.length < (next.action === "touch" ? 64 : 2))
              pendingScroll.push({ ...next });
            else {
              writer.send("scroll-error", {
                error: "Browser scroll input queue is full. Wait for pending input to finish.",
                statusCode: 409,
              });
              if (next.action === "touch") socket.close(1013, "Browser input queue is full");
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
        // The input loop repeats this after any in-flight start has completed.
        void releaseTouch();
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

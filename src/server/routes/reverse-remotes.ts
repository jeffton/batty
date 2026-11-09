import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Runtime } from "../runtime";
import { writeStreamEvent } from "../session-sse";
import { parseResponseMetadata } from "../reverse-transport";

/** Bearer auth runs in the existing /api/node boundary, independently on every body channel. */
export function registerReverseRemoteRoutes(app: FastifyInstance, runtime: Runtime) {
  const reverse = runtime.remotes.reverse;
  const peer = (request: FastifyRequest) => {
    const instance = request.headers["x-batty-instance-id"];
    if (typeof instance !== "string" || !request.nodeGrant)
      throw Object.assign(new Error("Reverse peer identity required"), { statusCode: 403 });
    return reverse.connectionFor(request.nodeGrant.id, instance);
  };
  app.addContentTypeParser("application/x-batty-reverse", (_request, payload, done) =>
    done(null, payload),
  );
  app.get("/api/node/reverse/control", async (request, reply) => {
    const connection = peer(request);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Batty-Instance-Id": runtime.remotes.access.identity().instanceId,
    });
    reply.raw.flushHeaders();
    let writes = Promise.resolve();
    const close = reverse.accept(
      connection,
      (event) => {
        writes = writes.then(() =>
          writeStreamEvent(reply.raw, `data: ${JSON.stringify(event)}\n\n`),
        );
        return writes;
      },
      () => reply.raw.end(),
    );
    const heartbeat = setInterval(() => {
      if (!reverse.isAlive(connection)) {
        close();
        return;
      }
      if (!reply.raw.writableNeedDrain) {
        writes = writes.then(() => writeStreamEvent(reply.raw, 'data: {"type":"ping"}\n\n'));
        void writes.catch(close);
      }
    }, 15_000);
    reply.raw.once("close", () => {
      clearInterval(heartbeat);
      close();
    });
  });
  app.post("/api/node/reverse/alive", async (request) => {
    reverse.acknowledge(peer(request));
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>("/api/node/reverse/transfers/:id", async (request, reply) => {
    const transfer = reverse.transfer(peer(request), request.params.id);
    if (transfer.bodyClaimed || !transfer.request.body)
      return reply.code(409).send({ error: "Reverse request body already consumed or absent" });
    transfer.bodyClaimed = true;
    reply.type("application/octet-stream");
    return reply.send(Readable.fromWeb(transfer.request.body));
  });
  app.post<{ Params: { id: string }; Body: Readable }>(
    "/api/node/reverse/transfers/:id",
    async (request, reply) => {
      const transfer = reverse.transfer(peer(request), request.params.id);
      if (transfer.responseClaimed)
        return reply.code(409).send({ error: "Reverse response already supplied" });
      const metadata = request.headers["x-batty-response"];
      if (typeof metadata !== "string" || !(request.body instanceof Readable))
        return reply.code(400).send({ error: "Reverse response stream and metadata required" });
      const { status, headers } = parseResponseMetadata(metadata);
      transfer.responseClaimed = true;
      const body = Readable.toWeb(request.body) as ReadableStream<Uint8Array>;
      transfer.abortResponse = (error) => request.body.destroy(error);
      try {
        transfer.resolve(
          new Response([204, 205, 304].includes(status) ? null : body, { status, headers }),
        );
        if ([204, 205, 304].includes(status)) request.body.resume();
        await finished(request.body);
        transfer.finish();
        return { ok: true };
      } catch (error) {
        transfer.finish(new Error("Reverse response interrupted"));
        throw error;
      }
    },
  );
  app.addHook("onListen", async () => {
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Reverse bridge requires a TCP listener");
    reverse.start(`http://127.0.0.1:${address.port}/`);
  });
}

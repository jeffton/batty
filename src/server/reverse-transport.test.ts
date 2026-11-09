import { expect, test } from "vite-plus/test";
import {
  isNodeRoute,
  ReverseChannel,
  responseMetadata,
  parseResponseMetadata,
  type ReverseEvent,
} from "./reverse-transport";

test("reverse routing only bridges the existing agent API", () => {
  for (const route of [
    "identity",
    "workspaces",
    "catalog/events",
    "assignments/123",
    "sessions/42/events?after=8",
    "files/work/12/tool/file",
  ])
    expect(isNodeRoute(route, "GET"), route).toBe(true);
  expect(isNodeRoute("commands", "POST")).toBe(true);
  for (const route of [
    "https://other.test/api/node/identity",
    "/api/main",
    "../main",
    "reverse/control",
    "workspaces?url=http://elsewhere",
    "sessions/42/events?after=0&url=x",
    "files/work/12/tool/..",
    "files/work/12/tool/%2fsecret",
    "files/work/12/tool/%5csecret",
    "files/work/12/tool/%00",
    "files/work/12/tool/%",
  ])
    expect(isNodeRoute(route, "GET"), route).toBe(false);
  expect(isNodeRoute("identity", "POST")).toBe(false);
  expect(isNodeRoute("commands", "DELETE")).toBe(false);
});

test("transport disconnect rejects admitted requests and never replays them", async () => {
  const events: ReverseEvent[] = [];
  const channel = new ReverseChannel(async (event) => {
    events.push(event);
  });
  const response = channel.request(
    "commands",
    new Request("https://peer.test/api/node/commands", { method: "POST", body: "one command" }),
  );
  const rejected = expect(response).rejects.toThrow("disconnected");
  expect(events).toMatchObject([{ type: "request", route: "commands", body: true }]);
  channel.close();
  await rejected;
  expect(channel.transfers.size).toBe(0);
  expect(events.filter((event) => event.type === "request")).toHaveLength(1);
  await expect(
    channel.request("identity", new Request("https://peer.test/api/node/identity")),
  ).rejects.toThrow("offline");
});

test("request abort cancels a response after headers without stopping other streams", async () => {
  const events: ReverseEvent[] = [];
  const channel = new ReverseChannel(async (event) => {
    events.push(event);
  });
  const controller = new AbortController();
  const first = channel.request(
    "catalog/events",
    new Request("https://peer.test/api/node/catalog/events", { signal: controller.signal }),
  );
  const second = channel.request("identity", new Request("https://peer.test/api/node/identity"));
  const [id, otherId] = [...channel.transfers.keys()];
  const transfer = channel.transfers.get(id!)!;
  let aborted = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      transfer.abortResponse = (error) => {
        aborted = true;
        stream.error(error);
      };
    },
  });
  transfer.resolve(new Response(body));
  const response = await first;
  const read = response.body!.getReader().read();
  const rejected = expect(read).rejects.toThrow("aborted");
  controller.abort();
  await rejected;
  expect(aborted).toBe(true);
  expect(channel.transfers.has(otherId!)).toBe(true);
  expect(events).toContainEqual({ type: "cancel", id });
  channel.transfers.get(otherId!)!.resolve(Response.json({ instanceId: "other" }));
  channel.transfers.get(otherId!)!.finish();
  expect(await (await second).json()).toEqual({ instanceId: "other" });
  channel.close();
});

test("body is not consumed or copied before its native HTTP receiver pulls", async () => {
  let pulled = 0;
  const controller = new AbortController();
  const channel = new ReverseChannel(async () => {});
  const body = new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        pulled++;
        stream.enqueue(new Uint8Array(65536));
      },
    },
    { highWaterMark: 0 },
  );
  const init = { method: "POST", body, duplex: "half", signal: controller.signal };
  const request = new Request("https://peer.test/api/node/commands", init);
  const response = channel.request("commands", request);
  const rejected = expect(response).rejects.toThrow("aborted");
  await Promise.resolve();
  expect(pulled).toBe(0);
  const reader = channel.transfers.values().next().value!.request.body!.getReader();
  await reader.read();
  expect(pulled).toBe(1);
  await reader.cancel();
  controller.abort();
  await rejected;
  channel.close();
});

test("response metadata retains application headers but drops decoded wire framing", () => {
  const response = new Response("decoded", {
    headers: {
      "content-encoding": "gzip",
      "content-length": "123",
      "content-type": "text/event-stream",
      "x-application": "preserved",
    },
  });
  const metadata = parseResponseMetadata(responseMetadata(response));
  const headers = new Headers(metadata.headers);
  expect(headers.get("content-type")).toBe("text/event-stream");
  expect(headers.get("x-application")).toBe("preserved");
  expect(headers.has("content-encoding")).toBe(false);
  expect(headers.has("content-length")).toBe(false);
  expect(() =>
    parseResponseMetadata(
      Buffer.from(JSON.stringify({ status: 101, headers: [] })).toString("base64url"),
    ),
  ).toThrow("metadata");
});

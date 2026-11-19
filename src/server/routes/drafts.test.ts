import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastify from "fastify";
import { afterEach, expect, it } from "vite-plus/test";
import { createAuthToken, verifyAuthToken } from "../auth";
import { registerDraftRoutes } from "./drafts";

const secret = "draft-test-secret";
const cookieName = "batty";
const authorized = { cookie: `${cookieName}=${createAuthToken(secret)}` };
const resources: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});

async function createRoot() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-drafts-test-"));
  resources.push(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

async function fixture(root: string, fileSize = 32, scope?: string) {
  const app = fastify();
  resources.push(() => app.close());
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize } });
  // Mirror the installation's shared /api hook, using the real cookie verifier.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!verifyAuthToken(secret, request.cookies[cookieName])) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });
  await registerDraftRoutes(app, root, scope);
  return app;
}

it("isolates saved text and files when the installation owner scope changes", async () => {
  const root = await createRoot();
  const previous = await fixture(root, 32, "previous-owner");
  const currentHeaders = { ...authorized, "x-batty-draft-scope": "current-owner" };
  const previousHeaders = { ...authorized, "x-batty-draft-scope": "previous-owner" };
  const id = randomUUID();
  const body = draftForm("Private text", [0]);
  body.append("file", new Blob(["Private file"]), "private.txt");
  const { payload, headers } = await formPayload(body);
  expect(
    (
      await previous.inject({
        method: "PUT",
        url: route(id),
        payload,
        headers: { ...headers, ...previousHeaders },
      })
    ).statusCode,
  ).toBe(204);
  await previous.close();
  const current = await fixture(root, 32, "current-owner");
  expect((await current.inject({ url: "/api/drafts", headers: previousHeaders })).statusCode).toBe(
    403,
  );
  expect((await current.inject({ url: "/api/drafts", headers: currentHeaders })).json()).toEqual({
    drafts: [],
  });
  expect(
    (await current.inject({ url: `${route(id)}/files/0`, headers: currentHeaders })).statusCode,
  ).toBe(404);
});

function draftForm(text: string, timestamps: number[], retryId?: string) {
  const form = new FormData();
  form.set("text", text);
  form.set("createdAt", "1700000000000");
  form.set("lastModified", JSON.stringify(timestamps));
  if (retryId !== undefined) form.set("retryId", retryId);
  return form;
}

async function formPayload(form: FormData) {
  const body = new Response(form);
  return {
    headers: { ...authorized, "content-type": body.headers.get("content-type")! },
    payload: Buffer.from(await body.arrayBuffer()),
  };
}

const route = (id: string) => `/api/drafts/${id}`;

it("round-trips metadata and ordered files across runtime restart, without overwriting a replay", async () => {
  const root = await createRoot();
  const app = await fixture(root, 300 * 1024);
  const id = randomUUID();
  const retryId = randomUUID();
  const form = draftForm("draft 🌴\nnext line", [1, 2], retryId);
  const attachment = new Uint8Array(270_001);
  for (let i = 0; i < attachment.length; i++) attachment[i] = i % 251;
  form.append("file", new Blob([attachment], { type: "image/png" }), "../hej åäö.png");
  form.append("file", new Blob(["notes"], { type: "text/html;charset=utf-8" }), '"notes".html');
  form.set(
    "fileMetadata",
    JSON.stringify([
      { name: "../hej åäö.png", type: "image/png" },
      { name: '"notes".html', type: "text/html;charset=utf-8" },
    ]),
  );
  const put = { method: "PUT" as const, url: route(id), ...(await formPayload(form)) };
  expect((await app.inject(put)).statusCode).toBe(204);
  expect((await app.inject(put)).statusCode).toBe(204);
  expect(
    (await app.inject({ ...put, ...(await formPayload(draftForm("modified", []))) })).statusCode,
  ).toBe(204);
  await app.close();

  const restarted = await fixture(root);
  const list = await restarted.inject({ url: "/api/drafts", headers: authorized });
  expect(list.headers["cache-control"]).toBe("no-store");
  expect(list.json()).toEqual({
    drafts: [
      {
        id,
        text: "draft 🌴\nnext line",
        createdAt: 1700000000000,
        retryId,
        files: [
          { name: "../hej åäö.png", type: "image/png", lastModified: 1 },
          { name: '"notes".html', type: "text/html;charset=utf-8", lastModified: 2 },
        ],
      },
    ],
  });
  const first = await restarted.inject({ url: `${route(id)}/files/0`, headers: authorized });
  expect(first.statusCode).toBe(200);
  expect(first.rawPayload).toEqual(Buffer.from(attachment));
  expect(first.headers["cache-control"]).toBe("no-store");
  const second = await restarted.inject({ url: `${route(id)}/files/1`, headers: authorized });
  expect(second.payload).toBe("notes");
  expect(second.headers["content-type"]).toBe("application/octet-stream");
  expect(second.headers["content-disposition"]).toBe("attachment");
  expect(
    (await restarted.inject({ url: `${route(id)}/files/2`, headers: authorized })).statusCode,
  ).toBe(404);
});

it("makes deletion durable and remove-wins before creation, after creation, and during concurrent requests", async () => {
  const root = await createRoot();
  const app = await fixture(root);
  const form = draftForm("draft", [0]);
  form.append("file", new Blob(["deleted bytes"]), "draft.txt");
  const payload = await formPayload(form);
  const put = (id: string) => ({ method: "PUT" as const, url: route(id), ...payload });
  const del = (id: string) => ({ method: "DELETE" as const, url: route(id), headers: authorized });
  const [before, after, concurrent] = [randomUUID(), randomUUID(), randomUUID()] as const;
  expect((await app.inject(del(before))).statusCode).toBe(204);
  expect((await app.inject(put(before))).statusCode).toBe(204);
  expect((await app.inject(put(after))).statusCode).toBe(204);
  expect((await app.inject(del(after))).statusCode).toBe(204);
  expect((await app.inject(del(after))).statusCode).toBe(204);
  expect(
    (await Promise.all([app.inject(put(concurrent)), app.inject(del(concurrent))])).map(
      (r) => r.statusCode,
    ),
  ).toEqual([204, 204]);
  await app.close();

  // Simulate a crash during staging, before publishing the upload.
  await fs.mkdir(path.join(root, ".draft-put-crashed"));
  const restarted = await fixture(root);
  expect((await restarted.inject(put(before))).statusCode).toBe(204);
  expect((await restarted.inject(put(after))).statusCode).toBe(204);
  expect((await restarted.inject({ url: "/api/drafts", headers: authorized })).json()).toEqual({
    drafts: [],
  });
  expect(
    (await restarted.inject({ url: `${route(after)}/files/0`, headers: authorized })).statusCode,
  ).toBe(404);
  expect((await fs.readdir(root)).filter((name) => name.startsWith(".draft-put-"))).toEqual([]);
  using db = new DatabaseSync(path.join(root, "drafts.sqlite"), { readOnly: true });
  expect(db.prepare("SELECT id, metadata FROM drafts ORDER BY id").all()).toEqual(
    [before, after, concurrent].sort().map((id) => ({ id, metadata: null })),
  );
  expect(db.prepare("SELECT id FROM draft_chunks").all()).toEqual([]);
});

it("rejects unauthenticated requests, malformed or oversized uploads, and injected paths without writing draft state", async () => {
  const root = await createRoot();
  const app = await fixture(root);
  const id = randomUUID();
  const upload = await formPayload(draftForm("draft", []));
  for (const request of [
    { url: "/api/drafts" },
    {
      method: "PUT" as const,
      url: route(id),
      headers: { ...upload.headers, cookie: "batty=invalid" },
      payload: upload.payload,
    },
    { method: "DELETE" as const, url: route(id) },
    { url: `${route(id)}/files/0` },
  ]) {
    expect((await app.inject(request)).statusCode).toBe(401);
  }
  expect(
    (await app.inject({ method: "DELETE", url: route("%2E%2E%2Foutside"), headers: authorized }))
      .statusCode,
  ).toBe(400);
  expect(
    (await app.inject({ url: `${route(id)}/files/%2E%2E%2Foutside`, headers: authorized }))
      .statusCode,
  ).toBe(400);
  const badTimestamp = draftForm("draft", [42]);
  const badReceipt = draftForm("draft", [], "invalid");
  const oversized = draftForm("draft", [1]);
  oversized.append("file", new Blob([new Uint8Array(33)]), "oversized.bin");
  for (const [form, status] of [
    [badTimestamp, 400],
    [badReceipt, 400],
    [oversized, 413],
  ] as const) {
    expect(
      (await app.inject({ method: "PUT", url: route(id), ...(await formPayload(form)) }))
        .statusCode,
    ).toBe(status);
  }
  const formWithFile = draftForm("draft", [1]);
  formWithFile.append("file", new Blob(["hi"]), "partial.bin");
  for (const input of [upload, await formPayload(formWithFile)]) {
    const malformed = { ...input, payload: input.payload.subarray(0, input.payload.length - 12) };
    expect((await app.inject({ method: "PUT", url: route(id), ...malformed })).statusCode).toBe(
      400,
    );
  }
  expect((await fs.readdir(root)).filter((name) => name.startsWith(".draft-put-"))).toEqual([]);
  using db = new DatabaseSync(path.join(root, "drafts.sqlite"), { readOnly: true });
  expect(db.prepare("SELECT id FROM drafts").all()).toEqual([]);
});

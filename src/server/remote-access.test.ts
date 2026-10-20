import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { stateDirPath } from "./options";
import { RemoteAccess } from "./remote-access";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "batty-remote-access-"));
  directories.push(directory);
  return {
    directory,
    file: path.join(stateDirPath(directory), "remote-access.json"),
    access: await RemoteAccess.open(directory),
  };
}

it("persists installation identity and hashed incoming grants, and revokes them across restarts", async () => {
  const { directory, access, file } = await fixture();
  expect(access.identity().instanceId).toMatch(/^[a-f0-9-]{36}$/);
  const issued = await access.issue("Home Batty");
  expect(Buffer.from(issued.token, "base64url")).toHaveLength(32);
  expect(access.authenticate(issued.token)).toEqual({ id: issued.id, label: "Home Batty" });
  expect(access.authenticate("wrong")).toBeUndefined();
  expect(access.listGrants()).toEqual([{ id: issued.id, label: "Home Batty" }]);
  const persisted = await fs.readFile(file, "utf8");
  expect(persisted).not.toContain(issued.token);
  expect(JSON.parse(persisted).grants[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
  const reopened = await RemoteAccess.open(directory);
  expect(reopened.identity()).toEqual(access.identity());
  expect(reopened.authenticate(issued.token)).toEqual({ id: issued.id, label: "Home Batty" });
  await reopened.revoke(issued.id);
  expect((await RemoteAccess.open(directory)).authenticate(issued.token)).toBeUndefined();
});

it("stores outgoing tokens privately while public listings and returned objects expose no mutable state", async () => {
  const { directory, access, file } = await fixture();
  await access.addConnection({
    id: "work-pc",
    label: "Work",
    url: "https://example.com/nested/batty///",
    token: "remote-token",
    instanceId: "remote-instance",
  });
  const expected = {
    id: "work-pc",
    label: "Work",
    url: "https://example.com/nested/batty/",
    instanceId: "remote-instance",
  };
  expect(access.listConnections()).toEqual([expected]);
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  const reopened = await RemoteAccess.open(directory);
  expect(reopened.getConnection("work-pc")).toEqual({ ...expected, token: "remote-token" });
  reopened.listConnections()[0]!.label = "Changed";
  reopened.getConnection("work-pc")!.token = "Changed";
  expect(reopened.getConnection("work-pc")).toEqual({ ...expected, token: "remote-token" });
  await expect(reopened.addConnection({ ...expected, token: "other" })).rejects.toThrow(
    "already exists",
  );
  await reopened.removeConnection("work-pc");
  expect((await RemoteAccess.open(directory)).listConnections()).toEqual([]);
});

it.each([
  "http://example.com/",
  "ftp://localhost/",
  "https://user:password@example.com/",
  "https://example.com/?secret=1",
  "https://example.com/#fragment",
  "https://example.com/?",
  "https://example.com/#",
])("rejects unsafe remote URL %s", async (url) => {
  const { access } = await fixture();
  await expect(
    access.addConnection({ id: "test", label: "Test", url, token: "token" }),
  ).rejects.toThrow();
  expect(access.listConnections()).toEqual([]);
});

it.each(["http://localhost:3000/", "http://127.0.0.1:3000/", "http://[::1]:3000/"])(
  "permits loopback HTTP for development: %s",
  async (url) => {
    const { access } = await fixture();
    await access.addConnection({ id: "dev", label: "Dev", url, token: "token" });
    expect(access.listConnections()[0]!.url).toBe(url);
  },
);

it.each(["", "../remote", "two words", "a/b", ".", "-start"])(
  "rejects unsafe connection ID %j",
  async (id) => {
    const { access } = await fixture();
    await expect(
      access.addConnection({ id, label: "Test", url: "https://example.com", token: "token" }),
    ).rejects.toThrow("ID");
  },
);

it("serializes concurrent mutations without losing grants or connections", async () => {
  const { access, directory } = await fixture();
  const issued = await Promise.all(
    Array.from({ length: 15 }, (_, i) => access.issue(`Grant ${i}`)),
  );
  await Promise.all([
    ...issued.slice(0, 5).map(({ id }) => access.revoke(id)),
    ...Array.from({ length: 5 }, (_, i) =>
      access.addConnection({
        id: `node-${i}`,
        label: `Node ${i}`,
        url: "https://example.com",
        token: `token-${i}`,
      }),
    ),
  ]);
  const reopened = await RemoteAccess.open(directory);
  expect(reopened.listGrants()).toHaveLength(10);
  expect(reopened.listConnections()).toHaveLength(5);
  expect(issued.slice(5).every(({ token }) => reopened.authenticate(token))).toBe(true);
});

it("surfaces malformed state and persistence errors without publishing an unpersisted mutation", async () => {
  const { access, directory, file } = await fixture();
  await fs.rename(stateDirPath(directory), `${stateDirPath(directory)}-saved`);
  await expect(access.issue("Unpersisted")).rejects.toThrow();
  expect(access.listGrants()).toEqual([]);
  await fs.rename(`${stateDirPath(directory)}-saved`, stateDirPath(directory));
  await access.issue("Persisted");
  expect(access.listGrants()).toHaveLength(1);
  expect(await fs.readdir(stateDirPath(directory))).toEqual(["remote-access.json"]);
  await fs.writeFile(file, "{ broken");
  await expect(RemoteAccess.open(directory)).rejects.toThrow();
});

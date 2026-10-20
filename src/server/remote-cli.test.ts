import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { isRemoteCommand, parseRemoteArgs } from "./remote-cli";
import { runCronCli } from "./cron-cli";
import { verifyAuthToken } from "./auth";
import { loadConfig } from "./config";

test("parses grant provisioning and public listing commands", async () => {
  expect((await parseRemoteArgs(["remote", "grant", "add", "--label", "Home"])).body).toEqual({
    action: "grant-add",
    label: "Home",
  });
  expect((await parseRemoteArgs(["remote", "grant", "list"])).body).toEqual({
    action: "grant-list",
  });
  expect((await parseRemoteArgs(["remote", "grant", "revoke", "--id", "grant-id"])).body).toEqual({
    action: "grant-revoke",
    id: "grant-id",
  });
  expect((await parseRemoteArgs(["remote", "connection", "list"])).body).toEqual({
    action: "connection-list",
  });
  expect((await parseRemoteArgs(["remote", "connection", "remove", "--id", "work"])).body).toEqual({
    action: "connection-remove",
    id: "work",
  });
});

test("reads a connection token from stdin without requiring a secret in argv", async () => {
  const readToken = vi.fn().mockResolvedValue(" private-token\n");
  const input = await parseRemoteArgs(
    [
      "--root",
      "/tmp/test",
      "remote",
      "connection",
      "add",
      "--id",
      "work",
      "--label",
      "Work",
      "--url",
      "https://example.com/batty/",
      "--token-stdin",
    ],
    readToken,
  );
  expect(readToken).toHaveBeenCalledOnce();
  expect(input).toEqual({
    root: "/tmp/test",
    help: false,
    body: {
      action: "connection-add",
      id: "work",
      label: "Work",
      url: "https://example.com/batty/",
      token: "private-token",
    },
  });
});

test.each([
  ["remote", "grant", "add"],
  ["remote", "grant", "list", "--token", "private-token"],
  ["remote", "grant", "revoke"],
  ["remote", "connection", "remove"],
  [
    "remote",
    "connection",
    "add",
    "--id",
    "work",
    "--label",
    "Work",
    "--url",
    "https://example.com",
  ],
  [
    "remote",
    "connection",
    "add",
    "--id",
    "work",
    "--label",
    "Work",
    "--url",
    "https://example.com",
    "--token",
    "t",
    "--token-stdin",
  ],
  ["remote", "unknown", "list"],
])("rejects invalid provisioning command %j", async (...args) => {
  await expect(parseRemoteArgs(args)).rejects.toThrow();
});

test("dispatch distinguishes the command from a cron prompt containing remote", () => {
  expect(isRemoteCommand(["--root", "/tmp/test", "remote", "grant", "list"])).toBe(true);
  expect(isRemoteCommand(["--root=/tmp/test", "remote", "--help"])).toBe(true);
  expect(isRemoteCommand(["cron", "add", "--prompt", "remote"])).toBe(false);
});

test("existing batty2 entrypoint provisions through the live authenticated local API", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-remote-cli-"));
  const originalHost = process.env.BATTY_HOST;
  const originalPort = process.env.BATTY_PORT;
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ id: "grant-id", token: "one-time-token" })));
  vi.stubGlobal("fetch", fetchMock);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await fs.mkdir(path.join(root, ".batty"));
    await fs.writeFile(
      path.join(root, ".batty", "options.json"),
      JSON.stringify({ workspacesRoots: [root], webPushSubject: "mailto:test@example.com" }),
    );
    await fs.writeFile(
      path.join(root, ".batty", "environment.json"),
      JSON.stringify({ BATTY_HOST: "::", BATTY_PORT: "4555" }),
    );
    await runCronCli(["--root", root, "remote", "grant", "add", "--label", "Home"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://[::1]:4555/api/remotes");
    expect(request.body).toBe('{"action":"grant-add","label":"Home"}');
    const config = await loadConfig(root);
    expect(
      verifyAuthToken(
        config.authSecret,
        request.headers.cookie.slice(config.cookieName.length + 1),
      ),
    ).toBe(true);
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual({
      id: "grant-id",
      token: "one-time-token",
    });
    expect(await fs.readdir(path.join(root, ".batty"))).not.toContain("remote-access.json");
    fetchMock.mockResolvedValue(new Response("No such grant", { status: 404 }));
    await expect(
      runCronCli(["--root", root, "remote", "grant", "revoke", "--id", "missing"]),
    ).rejects.toThrow("Batty2 404: No such grant");
  } finally {
    output.mockRestore();
    vi.unstubAllGlobals();
    if (originalHost === undefined) delete process.env.BATTY_HOST;
    else process.env.BATTY_HOST = originalHost;
    if (originalPort === undefined) delete process.env.BATTY_PORT;
    else process.env.BATTY_PORT = originalPort;
    await fs.rm(root, { recursive: true, force: true });
  }
});

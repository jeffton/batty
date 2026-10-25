// @vitest-environment node
import dns from "node:dns/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { isPublicSiteAddress, requestSiteConnection, validateSiteConnection } from "./site-http";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function transport(value: unknown, statusCode = 200) {
  return vi.spyOn(https, "request").mockImplementation(((
    _url: URL,
    _options: unknown,
    receive: (response: unknown) => void,
  ) => {
    const request = new EventEmitter() as EventEmitter & { end: (body?: string) => void };
    request.end = () =>
      queueMicrotask(() => {
        const response = new PassThrough() as PassThrough & { statusCode: number };
        response.statusCode = statusCode;
        receive(response);
        response.end(JSON.stringify(value));
      });
    return request;
  }) as typeof https.request);
}

test("broker rejects nonpublic IPv4, IPv6, metadata and every reserved block before socket creation", async () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.1.2",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::ffff:127.0.0.1",
  ])
    expect(isPublicSiteAddress(address)).toBe(false);
  expect(isPublicSiteAddress("93.184.216.34")).toBe(true);
  const request = transport({ ok: true });
  vi.spyOn(dns.Resolver.prototype, "resolve4").mockResolvedValue(["127.0.0.1"]);
  for (const url of ["https://127.0.0.1/", "https://169.254.169.254/", "https://rebind.example/"]) {
    await expect(
      requestSiteConnection({ url }, { connection: "api" }, AbortSignal.timeout(5000)),
    ).rejects.toThrow("Connection request failed");
  }
  expect(request).not.toHaveBeenCalled();
});

test("broker pins checked DNS while keeping original TLS hostname, injects only site secrets, redacts decoded echoes", async () => {
  const secret = 'private-"token';
  vi.stubEnv("BATTY_SITE_SECRET_IMAGES", secret);
  const resolve = vi.spyOn(dns.Resolver.prototype, "resolve4").mockResolvedValue(["93.184.216.34"]);
  const request = transport({ nested: [`Bearer ${secret}`], result: "animal.png" });
  const result = await requestSiteConnection(
    {
      url: "https://trusted.example/queue/",
      secretHeaders: { Authorization: { env: "BATTY_SITE_SECRET_IMAGES", prefix: "Bearer " } },
    },
    { connection: "images", path: "id/status", method: "GET" },
    AbortSignal.timeout(5000),
  );
  expect(result).toEqual({ nested: ["Bearer [redacted]"], result: "animal.png" });
  expect(resolve).toHaveBeenCalledExactlyOnceWith("trusted.example");
  const [url, options] = request.mock.calls[0]! as unknown as [URL, https.RequestOptions];
  expect(url.href).toBe("https://trusted.example/queue/id/status");
  expect(options.headers).toMatchObject({ authorization: `Bearer ${secret}` });
  expect(options.family).toBe(4);
  const checked = vi.fn();
  (options.lookup as Function)("trusted.example", {}, checked);
  expect(checked).toHaveBeenCalledWith(null, "93.184.216.34", 4);
});

test("redirects, escaping paths and malformed secrets fail without revealing values", async () => {
  vi.spyOn(dns.Resolver.prototype, "resolve4").mockResolvedValue(["93.184.216.34"]);
  const request = transport({ secret: "must-not-return" }, 302);
  await expect(
    requestSiteConnection(
      { url: "https://trusted.example/" },
      { connection: "api" },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow("Connection request failed");
  expect(request).toHaveBeenCalledTimes(1);
  for (const path of [
    "https://evil.example/",
    "../admin",
    "%2e%2e/admin",
    "a%2fb",
    "a%252fb",
    "//evil.example/",
  ]) {
    await expect(
      requestSiteConnection(
        { url: "https://trusted.example/queue/" },
        { connection: "api", path },
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow("Connection request failed");
  }
  expect(request).toHaveBeenCalledTimes(1);
  vi.stubEnv("BATTY_SITE_SECRET_BAD", "private-secret\nsecond-line");
  await expect(
    requestSiteConnection(
      {
        url: "https://trusted.example/",
        secretHeaders: { Authorization: { env: "BATTY_SITE_SECRET_BAD" } },
      },
      { connection: "api" },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow(/^Connection request failed/);
  expect(request).toHaveBeenCalledTimes(1);
  expect(() =>
    validateSiteConnection({
      url: "https://trusted.example/",
      secretHeaders: { Authorization: { env: "BATTY_AUTH_SECRET" } },
    }),
  ).toThrow("namespace");
});

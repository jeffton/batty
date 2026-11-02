// @vitest-environment node
import { expect, it, vi } from "vite-plus/test";
import Fastify from "fastify";
import { registerSettingsCopyRoute } from "./routes/settings-copy";
import { ProviderAuthService } from "./provider-auth";

it("only reveals stored values to authenticated explicit POSTs without caching", async () => {
  const logs: string[] = [];
  const app = Fastify({ logger: { stream: { write: (line: string) => logs.push(line) } } });
  app.decorateRequest("auth", false);
  app.addHook("onRequest", async (request) => {
    request.auth = request.headers.authorization === "test-owner";
  });
  const read = vi.fn(async (kind: string, name: string) =>
    kind === "environment" && name === "EMPTY"
      ? ""
      : name === "missing"
        ? undefined
        : "test-saved-value",
  );
  registerSettingsCopyRoute(app, read);
  try {
    const post = (payload: object, authenticated = true) =>
      app.inject({
        method: "POST",
        url: "/api/settings/copy-value",
        payload,
        headers: authenticated ? { authorization: "test-owner" } : {},
      });
    expect((await post({ kind: "provider", name: "google" }, false)).statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect((await app.inject("/api/settings/copy-value")).statusCode).toBe(404);
    for (const kind of ["provider", "environment", "brave-search"]) {
      const response = await post({ kind, name: "saved" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ value: "test-saved-value" });
    }
    expect((await post({ kind: "environment", name: "EMPTY" })).json()).toEqual({ value: "" });
    expect((await post({ kind: "provider", name: "missing" })).statusCode).toBe(404);
    expect((await post({ kind: "oauth", name: "openai" })).statusCode).toBe(400);
    expect(logs.join("")).not.toContain("test-saved-value");
  } finally {
    await app.close();
  }
});

it("copies API-key credentials including subscription providers, never OAuth tokens", () => {
  const service = new ProviderAuthService(
    { login: vi.fn() },
    (id) => {
      if (id === "openai") return { type: "api_key", key: "test-openai-key" };
      if (id === "google") return { type: "api_key", key: "test-google-key" };
      if (id === "anthropic")
        return { type: "oauth", access: "test-access", refresh: "test-refresh", expires: 0 };
      return undefined;
    },
    () => "test-device",
  );
  expect(service.getApiKey("openai")).toBe("test-openai-key");
  expect(service.getApiKey("google")).toBe("test-google-key");
  expect(service.getApiKey("anthropic")).toBeUndefined();
  expect(service.getApiKey("unknown")).toBeUndefined();
  expect(JSON.stringify(service.getStatus())).not.toContain("test-openai-key");
  expect(JSON.stringify(service.getStatus())).not.toContain("test-access");
});

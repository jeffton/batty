// @vitest-environment node
import { expect, it, vi } from "vite-plus/test";
import { ProviderAuthService } from "./provider-auth";
import { createOwnerRpcHandler, type OwnerRpcServices } from "./owner-rpc";
import type { Runtime } from "./runtime";

it("reveals saved API keys only through explicit native copy operations", async () => {
  const getApiKey = vi.fn((name: string) => (name === "saved" ? "test-saved-value" : undefined));
  const handler = createOwnerRpcHandler(
    {
      config: { braveSearchKey: "search-value" },
      tools: {},
      providerAuth: { getApiKey },
    } as unknown as Runtime,
    {} as OwnerRpcServices,
  );
  const copy = async (input: object) =>
    (await handler("settings.copy-value", input, { signal: new AbortController().signal })).value;
  expect(await copy({ kind: "provider", name: "saved" })).toEqual({ value: "test-saved-value" });
  expect(await copy({ kind: "brave-search", name: "saved" })).toEqual({ value: "search-value" });
  await expect(copy({ kind: "provider", name: "missing" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(copy({ kind: "oauth", name: "openai" })).rejects.toMatchObject({
    code: "BAD_INPUT",
  });
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

// @vitest-environment node
import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import { compile, type Static } from "@earendil-works/pi-schema";
import { BrowserToolSchema, type BrowserActionInput } from "./browser-schemas";
import { SitesToolSchema, WebSearchToolSchema } from "./tool-schemas";

describe("Pi tool schema compatibility", () => {
  test("preserves enum argument types across TypeBox and Pi schema inference", () => {
    expectTypeOf<Static<typeof BrowserToolSchema>>().toEqualTypeOf<BrowserActionInput>();
    expectTypeOf<BrowserActionInput["state"]>().toEqualTypeOf<
      "attached" | "detached" | "visible" | "hidden" | undefined
    >();
    expectTypeOf<Static<typeof WebSearchToolSchema>["action"]>().toEqualTypeOf<
      "search" | "content"
    >();
    expectTypeOf<Static<typeof SitesToolSchema>["action"]>().toEqualTypeOf<
      "create" | "share" | "delete" | "function" | "delete_function"
    >();
  });

  test("validates native string enums and optional browser states", () => {
    const browser = compile(BrowserToolSchema);
    expect(browser.check({ action: "open", url: "https://example.com" })).toBe(true);
    expect(browser.check({ action: "wait", state: "visible" })).toBe(true);
    expect(browser.check({ action: "wait", state: "invalid" })).toBe(false);
    expect(browser.check({ action: "invalid" })).toBe(false);
    expect(BrowserToolSchema.properties.action).toMatchObject({
      type: "string",
      enum: expect.arrayContaining(["open"]),
    });
    expect(BrowserToolSchema.required).not.toContain("state");

    expect(compile(WebSearchToolSchema).check({ action: "search" })).toBe(true);
    expect(compile(WebSearchToolSchema).check({ action: "invalid" })).toBe(false);
    expect(compile(SitesToolSchema).check({ action: "share", siteId: "example" })).toBe(true);
    expect(compile(SitesToolSchema).check({ action: "invalid" })).toBe(false);
  });
});

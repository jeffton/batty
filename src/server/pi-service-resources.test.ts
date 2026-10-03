import { describe, expect, it, vi } from "vite-plus/test";
import { PiService } from "./pi-service";
import type { WebSession } from "./pi-service-types";

function createService(sdk: unknown): PiService {
  const service = Object.create(PiService.prototype) as PiService;
  const internals = service as unknown as { sessions: Map<string, WebSession> };
  internals.sessions = new Map([["session-1", { session: { sdk } } as unknown as WebSession]]);
  return service;
}

describe("PiService.getSessionResources", () => {
  it("projects loaded skills and includes direct, codemode, and deferred non-MCP tools", () => {
    const getSkills = vi.fn(() => ({
      skills: [
        {
          name: "notes",
          description: "Manage notes",
          filePath: "/workspace/.batty/skills/notes/SKILL.md",
          baseDir: "/workspace/.batty/skills/notes",
          disableModelInvocation: false,
        },
      ],
      diagnostics: [],
    }));
    const getAllTools = vi.fn(() => [
      { name: "read", description: "Read files", exposure: "direct", parameters: {} },
      { name: "extension-tool", description: "Extension tool", exposure: "codemode" },
      { name: "deferred-tool", description: "Deferred tool", exposure: "deferred" },
      { name: "hidden-tool", description: "Hidden tool", exposure: "hidden" },
      { name: "mcp__docs__search", description: "Search docs", exposure: "direct" },
    ]);
    const service = createService({ resourceLoader: { getSkills }, getAllTools });

    expect(service.getSessionResources("session-1")).toEqual({
      skills: [
        {
          name: "notes",
          description: "Manage notes",
          filePath: "/workspace/.batty/skills/notes/SKILL.md",
        },
      ],
      tools: [
        { name: "read", description: "Read files" },
        { name: "extension-tool", description: "Extension tool" },
        { name: "deferred-tool", description: "Deferred tool" },
      ],
    });
  });

  it("rejects unknown sessions", () => {
    const service = createService({});
    expect(() => service.getSessionResources("missing")).toThrow("Unknown session: missing");
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBashTool, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { environmentFilePath } from "@/server/config";
import {
  BATTY_FIND_DEFAULT_LIMIT,
  createEnvironmentReloadExtension,
  createFindDefaultsExtension,
} from "@/server/pi-agent-session";

const tempDirs: string[] = [];
const testEnvKey = `BATTY_DYNAMIC_ENV_TEST_${process.pid}`;
const originalEnvValue = process.env[testEnvKey];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  if (originalEnvValue == null) {
    delete process.env[testEnvKey];
  } else {
    process.env[testEnvKey] = originalEnvValue;
  }
});

async function createEnvironmentFile(value: string): Promise<string> {
  const battyDir = await fs.mkdtemp(path.join(os.tmpdir(), "batty-pi-session-"));
  tempDirs.push(battyDir);
  await fs.mkdir(path.dirname(environmentFilePath(battyDir)), { recursive: true });
  await fs.writeFile(
    environmentFilePath(battyDir),
    `${JSON.stringify({ [testEnvKey]: value }, null, 2)}\n`,
    "utf8",
  );
  return battyDir;
}

describe("Batty find defaults extension", () => {
  it("overrides the built-in find default while preserving explicit limits", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "batty-find-defaults-"));
    tempDirs.push(cwd);
    const requestedLimits: number[] = [];
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: path.join(cwd, ".agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        createFindDefaultsExtension(cwd, {
          operations: {
            exists: () => true,
            glob: (_pattern, _searchPath, options) => {
              requestedLimits.push(options.limit);
              return Array.from({ length: options.limit }, (_, index) => `file-${index + 1}.ts`);
            },
          },
        }),
      ],
    });
    await resourceLoader.reload();

    const extension = resourceLoader.getExtensions().extensions[0];
    const findTool = extension?.tools.get("find")?.definition;
    expect(extension?.hidden).toBe(true);
    expect(findTool).toBeDefined();
    expect(findTool!.description).toContain(`${BATTY_FIND_DEFAULT_LIMIT} results`);
    expect(
      (findTool!.parameters as { properties: { limit: { description?: string } } }).properties.limit
        .description,
    ).toBe(`Maximum number of results (default: ${BATTY_FIND_DEFAULT_LIMIT})`);

    await findTool!.execute("default", { pattern: "*.ts" }, undefined, undefined, {} as never);
    await findTool!.execute(
      "explicit",
      { pattern: "*.ts", limit: 7 },
      undefined,
      undefined,
      {} as never,
    );

    expect(requestedLimits).toEqual([BATTY_FIND_DEFAULT_LIMIT, 7]);
  });
});

describe("Batty environment extension", () => {
  it("reloads environment.json before each bash tool invocation", async () => {
    const battyDir = await createEnvironmentFile("first");
    const resourceLoader = new DefaultResourceLoader({
      cwd: battyDir,
      agentDir: path.join(battyDir, ".agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [createEnvironmentReloadExtension(battyDir)],
    });
    await resourceLoader.reload();

    const extension = resourceLoader.getExtensions().extensions[0];
    const handler = extension?.handlers.get("tool_call")?.[0];
    expect(extension?.hidden).toBe(true);
    expect(handler).toBeDefined();

    const bashTool = createBashTool(battyDir);
    const invokeBash = async (toolCallId: string): Promise<string> => {
      const input = { command: `printf %s "$${testEnvKey}"` };
      await handler?.({ type: "tool_call", toolCallId, toolName: "bash", input }, {});
      const result = await bashTool.execute(toolCallId, input);
      return result.content[0]?.type === "text" ? result.content[0].text : "";
    };

    expect(await invokeBash("first")).toBe("first");

    await fs.writeFile(
      environmentFilePath(battyDir),
      `${JSON.stringify({ [testEnvKey]: "second" }, null, 2)}\n`,
      "utf8",
    );
    expect(await invokeBash("second")).toBe("second");
  });

  it("reloads environment.json before each PowerShell tool invocation", async () => {
    const battyDir = await createEnvironmentFile("first");
    const resourceLoader = new DefaultResourceLoader({
      cwd: battyDir,
      agentDir: path.join(battyDir, ".agent"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [createEnvironmentReloadExtension(battyDir)],
    });
    await resourceLoader.reload();

    const handler = resourceLoader.getExtensions().extensions[0]?.handlers.get("tool_call")?.[0];
    await handler?.(
      { type: "tool_call", toolCallId: "first", toolName: "powershell", input: {} },
      {},
    );
    expect(process.env[testEnvKey]).toBe("first");

    await fs.writeFile(
      environmentFilePath(battyDir),
      `${JSON.stringify({ [testEnvKey]: "second" }, null, 2)}\n`,
      "utf8",
    );
    await handler?.(
      { type: "tool_call", toolCallId: "second", toolName: "powershell", input: {} },
      {},
    );
    expect(process.env[testEnvKey]).toBe("second");
  });
});

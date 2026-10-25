// @vitest-environment node
import { expect, test } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { ToolExecutionDetails } from "@/shared/types";
import type { AppConfig } from "./config";
import { BrowserService, workspaceBrowserKey } from "./browser-service";
import { createBrowserTool } from "./custom-tools";
import type { BrowserActionInput } from "./browser-schemas";

// Exercise the actual tool boundary: conversation IDs differ, workspace IDs do not.
test("main and workers share tabs, login and cloud attachments within their workspace across restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-workspace-browser-"));
  const website = http.createServer((_, response) =>
    response.end("<html><head><title>Workspace browser</title></head><body>Shared</body></html>"),
  );
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
  let service = new BrowserService(undefined, 4, root);
  const call = async (workspaceId: string, conversation: string, input: BrowserActionInput) => {
    const tool = createBrowserTool({
      browserService: service,
      workspace: {
        id: workspaceId,
        path: root,
        label: workspaceId,
        kind: "workspace",
        isPinned: false,
        isAssistant: workspaceId === "roy",
      },
      config: {} as AppConfig,
    });
    const ctx = {
      sessionManager: {
        getSessionId: () => conversation,
        getSessionFile: () => path.join(root, `${conversation}.jsonl`),
      },
    } as Parameters<typeof tool.execute>[4];
    const result = await tool.execute(
      `call-${conversation}`,
      input,
      new AbortController().signal,
      undefined,
      ctx,
    );
    return { ...result, details: result.details as ToolExecutionDetails };
  };
  try {
    const first = await call("roy", "main", { action: "open", url });
    const pageId = first.details!.pageId as string;
    await call("roy", "main", {
      action: "evaluate",
      script: 'document.cookie = "login=fixture; path=/"; globalThis.sharedState = 42',
    });
    const worker = await call("roy", "worker", { action: "pages" });
    expect(JSON.stringify(worker.content)).toContain(pageId);
    const login = await call("roy", "worker", {
      action: "evaluate",
      pageId,
      script: "document.cookie + ':' + globalThis.sharedState",
    });
    expect(login.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("login=fixture:42") }),
    );
    const second = await call("roy", "worker", { action: "open", url, newPage: true });
    expect(second.details!.pageId).not.toBe(pageId);
    const pages = await call("roy", "main", { action: "pages" });
    expect(JSON.stringify(pages.content)).toContain(second.details!.pageId);
    await call("roy", "main", { action: "switch", pageId });

    // An unrelated workspace cannot see the shared browser or its cookie jar.
    await expect(call("other", "other-worker", { action: "pages" })).rejects.toThrow(
      "No active browser",
    );
    await call("other", "other-worker", { action: "open", url });
    const isolated = await call("other", "other-worker", {
      action: "evaluate",
      script: "document.cookie",
    });
    expect(JSON.stringify(isolated.content)).not.toContain("login=fixture");

    const attachment =
      process.platform === "linux"
        ? await call("roy", "worker", { action: "attach", cloud: true })
        : undefined;
    const descriptor = attachment?.details.sites?.[0];
    const browserId = descriptor && "browserId" in descriptor ? descriptor.browserId : undefined;
    await service.dispose();
    service = new BrowserService(undefined, 4, root);
    const restored = await call("roy", "resumed-worker", {
      action: "evaluate",
      pageId,
      script: "document.cookie + ':' + globalThis.sharedState",
    });
    expect(restored.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("login=fixture:42") }),
    );
    if (browserId) {
      const attached = await call("roy", "main", { action: "attach" });
      expect(attached.details.sites![0]).toMatchObject({ browserId });
      expect((await service.cloudState(browserId)).pageId).toBe(pageId);
    }
    await call("roy", "worker", { action: "close" });
    await expect(call("roy", "main", { action: "pages" })).rejects.toThrow("No active browser");
    if (browserId) await expect(service.cloudState(browserId)).rejects.toThrow();
    expect(await service.hasSession(workspaceBrowserKey("other"))).toBe(true);
  } finally {
    await service.closeSession(workspaceBrowserKey("roy"));
    await service.closeSession(workspaceBrowserKey("other"));
    await service.dispose();
    website.closeAllConnections();
    await new Promise<void>((resolve) => website.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

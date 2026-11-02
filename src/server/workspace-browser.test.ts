// @vitest-environment node
import { expect, test } from "vite-plus/test";
import fs from "node:fs/promises";
import { removeTestBrowserRoot } from "./test-browser-cleanup";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { ToolExecutionDetails } from "@/shared/types";
import type { AppConfig } from "./config";
import { BrowserService, workspaceBrowserKey } from "./browser-service";
import { createBrowserTool } from "./custom-tools";
import type { BrowserActionInput } from "./browser-schemas";

test("agents and viewer share an explicit tab while popups belong only to their interacting client", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batty-popup-owner-"));
  const website = http.createServer((request, response) =>
    response.end(`<html><body><input id="shared" value="initial">
      <button onclick="setTimeout(() => window.open('/child'), 1200)">Popup</button>
      ${request.url === "/auto" ? "<script>setTimeout(() => window.open('/child'), 1200)</script>" : ""}
      </body></html>`),
  );
  website.listen(0, "127.0.0.1");
  await once(website, "listening");
  const url = `http://127.0.0.1:${(website.address() as { port: number }).port}/`;
  let service = new BrowserService(undefined, 4, root);
  const owner = workspaceBrowserKey("shared");
  const call = async (client: string, input: BrowserActionInput) => {
    const tool = createBrowserTool({
      browserService: service,
      workspace: {
        id: "shared",
        path: root,
        label: "Shared",
        kind: "workspace",
        isPinned: false,
        isAssistant: true,
      },
      config: {} as AppConfig,
    });
    const ctx = {
      sessionManager: {
        getSessionId: () => client,
        getSessionFile: () => path.join(root, `${client}.jsonl`),
      },
    } as Parameters<typeof tool.execute>[4];
    const result = await tool.execute(
      `call-${client}`,
      input,
      new AbortController().signal,
      undefined,
      ctx,
    );
    return { ...result, details: result.details as ToolExecutionDetails };
  };
  const selected = async (client: string) =>
    (
      (await call(client, { action: "pages" })).details.pages as Array<{
        id: string;
        active: boolean;
      }>
    )?.find((page) => page.active)?.id;
  try {
    const first = await call("a", { action: "open", url });
    const pageId = first.details.pageId as string;
    await call("b", { action: "switch", pageId });
    const viewer = process.platform === "linux" ? await service.openCloudBrowser(owner) : undefined;
    await call("a", { action: "fill", selector: "#shared", value: "from agent" });
    if (viewer) {
      const state = await service.cloudState(viewer.browserId);
      expect(state.pageId).toBe(pageId);
      await service.cloudControl(viewer.browserId, {
        action: "text",
        pageId,
        revision: state.revision,
        text: " and viewer",
      });
    }
    for (const client of ["a", "b"]) {
      const shared = await call(client, {
        action: "evaluate",
        pageId,
        script: "document.querySelector('#shared').value",
      });
      expect(JSON.stringify(shared.content)).toContain(
        viewer ? "from agent and viewer" : "from agent",
      );
      expect(await selected(client)).toBe(pageId);
    }
    const temporary = await call("b", { action: "open", url, newPage: true });
    await call("b", { action: "snapshot", pageId });
    expect(await selected("b")).toBe(temporary.details.pageId);
    expect(await selected("a")).toBe(pageId);
    await call("b", { action: "close-page", pageId: temporary.details.pageId as string });
    await call("b", { action: "switch", pageId });
    await call("a", { action: "click", selector: "button" });
    await call("b", { action: "snapshot" });
    if (viewer)
      await service.cloudVideoGeometry(
        viewer.browserId,
        await service.cloudState(viewer.browserId),
      );
    await expect.poll(() => selected("a"), { timeout: 5000 }).not.toBe(pageId);
    expect(await selected("b")).toBe(pageId);
    if (viewer) {
      expect((await service.cloudState(viewer.browserId)).pageId).toBe(pageId);
      await service.cloudControl(viewer.browserId, { action: "navigate", url: `${url}auto` });
      expect((await call("b", { action: "snapshot" })).details.url).toBe(`${url}auto`);
      await service.cloudVideoGeometry(
        viewer.browserId,
        await service.cloudState(viewer.browserId),
      );
      await expect
        .poll(async () => (await service.cloudState(viewer.browserId)).pageId, { timeout: 5000 })
        .not.toBe(pageId);
      expect(await selected("b")).toBe(pageId);
      const sharedPopup = (await service.cloudState(viewer.browserId)).pageId;
      await call("a", { action: "switch", pageId: sharedPopup });
      await call("b", { action: "switch", pageId: sharedPopup });
      await call("a", { action: "open", pageId: sharedPopup, url: `${url}?shared` });
      expect((await service.cloudState(viewer.browserId)).url).toBe(`${url}?shared`);
      expect((await call("b", { action: "snapshot" })).details.url).toBe(`${url}?shared`);
      await service.dispose();
      service = new BrowserService(undefined, 4, root);
      for (const client of ["a", "b"])
        expect((await call(client, { action: "snapshot" })).details.pageId).toBe(sharedPopup);
      expect((await service.cloudState(viewer.browserId)).pageId).toBe(sharedPopup);
      expect((await call("b", { action: "attach" })).details.sites![0]).toMatchObject({
        browserId: viewer.browserId,
      });
    }
  } finally {
    await service.closeSession(owner);
    await service.dispose();
    website.closeAllConnections();
    await new Promise<void>((resolve) => website.close(() => resolve()));
    await removeTestBrowserRoot(root);
  }
}, 30_000);

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
    if (process.platform === "linux") {
      const [opened, concurrent] = await Promise.all([
        service.openCloudBrowser(workspaceBrowserKey("roy")),
        service.openCloudBrowser(workspaceBrowserKey("roy")),
      ]);
      expect(concurrent.browserId).toBe(opened.browserId);
      expect((await service.cloudState(opened.browserId)).pages).toHaveLength(1);
    } else {
      await expect(service.openCloudBrowser(workspaceBrowserKey("roy"))).rejects.toThrow("Linux");
    }
    const first = await call("roy", "main", { action: "open", url });
    const pageId = first.details!.pageId as string;
    if (process.platform === "linux") {
      const viewer = await service.openCloudBrowser(workspaceBrowserKey("roy"));
      // Opening an agent tab must leave the viewer's blank tab alone.
      expect((await service.cloudState(viewer.browserId)).url).toBe("about:blank");
      await service.cloudControl(viewer.browserId, {
        action: "close-page",
        pageId: (await service.cloudState(viewer.browserId)).pageId,
      });
    }
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
    if (process.platform === "linux") {
      const opened = await service.openCloudBrowser(workspaceBrowserKey("roy"));
      const unchanged = await service.cloudState(opened.browserId);
      expect(unchanged.url).toBe(url);
      expect(unchanged.pages).toHaveLength(1);
      expect(unchanged.pageId).toBe(pageId);
      expect(
        (await call("roy", "main", { action: "evaluate", script: "globalThis.sharedState" }))
          .content,
      ).toContainEqual(expect.objectContaining({ text: expect.stringContaining("42") }));
    }
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
    if (browserId) {
      const opened = await service.openCloudBrowser(workspaceBrowserKey("roy"));
      expect(opened.browserId).toBe(browserId);
      expect((await service.cloudState(browserId)).pages).toHaveLength(2);
    }
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
      // Main and worker retain different selections across a service restart.
      expect((await call("roy", "main", { action: "snapshot" })).details.pageId).toBe(pageId);
      expect((await call("roy", "worker", { action: "snapshot" })).details.pageId).toBe(
        second.details.pageId,
      );
      // Concurrent agent navigation stays on each client's own tab.
      await Promise.all([
        call("roy", "main", { action: "open", url: url + "?main" }),
        call("roy", "worker", { action: "open", url: url + "?worker" }),
      ]);
      expect((await service.cloudState(browserId)).url).toBe(url + "?main");
      const extra = await service.cloudControl(browserId, { action: "new-page" });
      expect(extra.url).toBe("about:blank");
      expect((await call("roy", "main", { action: "snapshot" })).details.pageId).toBe(pageId);
      await service.cloudControl(browserId, { action: "close-page", pageId: extra.pageId });
      await service.cloudControl(browserId, {
        action: "switch",
        pageId: second.details.pageId as string,
      });
      await call("roy", "main", { action: "close-page", pageId: second.details.pageId as string });
      await expect(call("roy", "worker", { action: "snapshot" })).rejects.toThrow(
        "Unknown browser page",
      );
      const listed = await call("roy", "worker", { action: "pages" });
      expect(
        (listed.details.pages as Array<{ active: boolean }>).every((page) => !page.active),
      ).toBe(true);
      await call("roy", "worker", { action: "switch", pageId });
      // Closing the last viewer tab creates a blank one; cookies remain shared.
      await expect(service.cloudState(browserId)).rejects.toMatchObject({
        statusCode: 409,
        pages: [expect.objectContaining({ id: pageId, active: false })],
      });
      await service.cloudControl(browserId, { action: "switch", pageId });
      const blank = await service.cloudControl(browserId, { action: "close-page", pageId });
      expect(blank.url).toBe("about:blank");
      await expect(call("roy", "main", { action: "snapshot" })).rejects.toThrow(
        "Unknown browser page",
      );
      await service.cloudControl(browserId, { action: "navigate", url });
      expect(
        (
          await call("roy", "resumed-worker", {
            action: "evaluate",
            pageId: blank.pageId,
            script: "document.cookie",
          })
        ).content,
      ).toContainEqual(expect.objectContaining({ text: expect.stringContaining("login=fixture") }));
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
    await removeTestBrowserRoot(root);
  }
}, 30_000);

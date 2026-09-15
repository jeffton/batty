import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { chromium } from "playwright";
import { BrowserService } from "@/server/browser-service";
import { resetSharedBrowserStateForTests } from "@/server/browser-runtime";

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

function createFixture() {
  const pages: any[] = [];
  const contextHandlers = new Map<string, Array<(value: any) => void>>();
  const context = {
    close: vi.fn(async () => undefined),
    newPage: vi.fn(async () => createPage()),
    on: vi.fn((event: string, handler: (value: any) => void) => {
      const handlers = contextHandlers.get(event) ?? [];
      handlers.push(handler);
      contextHandlers.set(event, handlers);
    }),
  };

  function createPage(options: { title?: string; url?: string; parentFrame?: any } = {}) {
    const pageHandlers = new Map<string, Array<(value: any) => void>>();
    let closed = false;
    const locator = {
      ariaSnapshot: vi.fn(async () => '- heading "Example" [level=1]'),
      click: vi.fn(async () => undefined),
      fill: vi.fn(async () => undefined),
      hover: vi.fn(async () => undefined),
      press: vi.fn(async () => undefined),
      scrollIntoViewIfNeeded: vi.fn(async () => undefined),
      selectOption: vi.fn(async () => undefined),
      setInputFiles: vi.fn(async () => undefined),
      waitFor: vi.fn(async () => undefined),
    };
    const page: any = {
      close: vi.fn(async () => {
        closed = true;
        for (const handler of pageHandlers.get("close") ?? []) handler(undefined);
      }),
      evaluate: vi.fn(async () => undefined),
      frames: vi.fn(() => [frame]),
      goBack: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      isClosed: vi.fn(() => closed),
      locator: vi.fn(() => locator),
      mainFrame: vi.fn(() => frame),
      on: vi.fn((event: string, handler: (value: any) => void) => {
        const handlers = pageHandlers.get(event) ?? [];
        handlers.push(handler);
        pageHandlers.set(event, handlers);
      }),
      reload: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => Buffer.from("png data")),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      setViewportSize: vi.fn(async () => undefined),
      title: vi.fn(async () => options.title ?? "Example"),
      url: vi.fn(() => options.url ?? "https://example.com/"),
      waitForEvent: vi.fn(),
    };
    const frame: any = {
      evaluate: vi.fn(async () => undefined),
      locator: vi.fn(() => locator),
      name: vi.fn(() => ""),
      page: vi.fn(() => page),
      parentFrame: vi.fn(() => options.parentFrame),
      url: vi.fn(() => options.url ?? "https://example.com/"),
    };
    page.frame = frame;
    page.locatorMock = locator;
    page.emit = (event: string, value: any) => {
      for (const handler of pageHandlers.get(event) ?? []) handler(value);
    };
    pages.push(page);
    return page;
  }

  const firstPage = createPage();
  context.newPage.mockResolvedValueOnce(firstPage);
  const browser = {
    isConnected: vi.fn(() => true),
    newContext: vi.fn(async () => context),
    on: vi.fn(),
  };
  vi.mocked(chromium.launch).mockResolvedValue(browser as never);

  return {
    browser,
    context,
    firstPage,
    pages,
    createPopup(options: { title?: string; url?: string } = {}) {
      const page = createPage(options);
      for (const handler of contextHandlers.get("page") ?? []) handler(page);
      return page;
    },
  };
}

afterEach(() => {
  resetSharedBrowserStateForTests();
  vi.clearAllMocks();
});

describe("BrowserService", () => {
  it("opens a page and returns an accessibility snapshot", async () => {
    const fixture = createFixture();
    const service = new BrowserService();

    const result = await service.execute("session-1", {
      action: "open",
      url: "https://example.com",
    });

    expect(chromium.launch).toHaveBeenCalledOnce();
    expect(fixture.browser.newContext).toHaveBeenCalledWith({
      acceptDownloads: true,
      locale: "en-US",
      permissions: [],
    });
    expect(fixture.firstPage.goto).toHaveBeenCalledWith("https://example.com/", {
      waitUntil: "domcontentloaded",
    });
    expect(result.text).toContain('heading "Example"');
    expect(result.text).toContain("Page ID: page-1 (active)");
    expect(result.details).toMatchObject({
      action: "open",
      pageId: "page-1",
      frameId: "frame-1",
      url: "https://example.com/",
      title: "Example",
    });
  });

  it("sets the initial viewport before opening a page", async () => {
    const fixture = createFixture();
    const service = new BrowserService();

    await service.execute("session-1", {
      action: "open",
      url: "https://example.com",
      viewport: { width: 390, height: 844 },
    });

    expect(fixture.browser.newContext).toHaveBeenCalledWith({
      acceptDownloads: true,
      locale: "en-US",
      permissions: [],
      viewport: { width: 390, height: 844 },
    });
    expect(fixture.firstPage.setViewportSize).not.toHaveBeenCalled();
  });

  it("tracks popups and switches between stable page IDs", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });
    fixture.createPopup({ title: "Popup", url: "https://example.com/popup" });

    const listed = await service.execute("session-1", { action: "pages" });
    expect(listed.text).toContain("page-1 (active)");
    expect(listed.text).toContain("page-2");

    const switched = await service.execute("session-1", {
      action: "switch",
      pageId: "page-2",
    });
    expect(switched.text).toContain("Page: Popup");
    expect(switched.text).toContain("Page ID: page-2 (active)");
  });

  it("does not create an extra blank page when the initial open requests a new page", async () => {
    const fixture = createFixture();
    const service = new BrowserService();

    const opened = await service.execute("session-1", {
      action: "open",
      url: "https://example.com",
      newPage: true,
    });

    expect(fixture.context.newPage).toHaveBeenCalledOnce();
    expect(opened.text).toContain("Page ID: page-1 (active)");
    expect(opened.details.pages).toHaveLength(1);
  });

  it("opens and closes explicit pages without closing the context", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });

    const opened = await service.execute("session-1", {
      action: "open",
      url: "https://example.org",
      newPage: true,
    });
    expect(opened.text).toContain("Page ID: page-2 (active)");

    const closed = await service.execute("session-1", { action: "close-page" });
    expect(fixture.pages[1].close).toHaveBeenCalledOnce();
    expect(fixture.context.close).not.toHaveBeenCalled();
    expect(closed.text).toContain("page-1 (active)");
  });

  it("lists frames and targets actions by frame ID", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });
    const childLocator = {
      ariaSnapshot: vi.fn(async () => "child snapshot"),
      click: vi.fn(async () => undefined),
    };
    const childFrame: any = {
      evaluate: vi.fn(),
      locator: vi.fn(() => childLocator),
      name: vi.fn(() => "checkout"),
      page: vi.fn(() => fixture.firstPage),
      parentFrame: vi.fn(() => fixture.firstPage.frame),
      url: vi.fn(() => "https://pay.example/frame"),
    };
    fixture.firstPage.frames.mockReturnValue([fixture.firstPage.frame, childFrame]);
    fixture.firstPage.emit("frameattached", childFrame);

    const frames = await service.execute("session-1", { action: "frames" });
    expect(frames.text).toContain("frame-2 (parent frame-1)");
    expect(frames.text).toContain("checkout");

    const clicked = await service.execute("session-1", {
      action: "click",
      frameId: "frame-2",
      selector: "button",
    });
    expect(childLocator.click).toHaveBeenCalledOnce();
    expect(clicked.text).toContain("child snapshot");
  });

  it("uploads files and supports hover and both scroll modes", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });

    await service.execute("session-1", {
      action: "upload",
      selector: "input[type=file]",
      paths: ["/tmp/example.txt"],
    });
    await service.execute("session-1", { action: "hover", selector: "nav" });
    await service.execute("session-1", { action: "scroll", selector: "footer" });
    await service.execute("session-1", { action: "scroll", deltaY: 800 });

    expect(fixture.firstPage.locatorMock.setInputFiles).toHaveBeenCalledWith(["/tmp/example.txt"]);
    expect(fixture.firstPage.locatorMock.hover).toHaveBeenCalledOnce();
    expect(fixture.firstPage.locatorMock.scrollIntoViewIfNeeded).toHaveBeenCalledOnce();
    expect(fixture.firstPage.frame.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      deltaX: 0,
      deltaY: 800,
    });
  });

  it("downloads a file to a durable temp path", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    const download = {
      saveAs: vi.fn(async (target: string) => fs.writeFile(target, "report")),
      suggestedFilename: vi.fn(() => "report.csv"),
    };
    fixture.firstPage.waitForEvent.mockResolvedValue(download);
    await service.execute("session-1", { action: "open", url: "https://example.com" });

    const result = await service.execute("session-1", {
      action: "download",
      selector: "text=Export",
    });

    expect(fixture.firstPage.waitForEvent).toHaveBeenCalledWith("download");
    expect(fixture.firstPage.locatorMock.click).toHaveBeenCalledOnce();
    expect(result.downloadPaths?.[0]).toMatch(/batty-browser-download-.*report\.csv$/);
    await expect(fs.readFile(result.downloadPaths![0]!, "utf8")).resolves.toBe("report");

    await service.closeSession("session-1");
    await expect(fs.readFile(result.downloadPaths![0]!, "utf8")).rejects.toThrow();
  });

  it("evaluates JavaScript and returns inspectable output without a snapshot", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    fixture.firstPage.frame.evaluate.mockResolvedValue({ count: 3, ready: true });
    await service.execute("session-1", { action: "open", url: "https://example.com" });

    const result = await service.execute("session-1", {
      action: "evaluate",
      script: "(args) => ({ count: document.links.length, ready: args.ready })",
      args: { ready: true },
    });

    expect(fixture.firstPage.frame.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      script: "(args) => ({ count: document.links.length, ready: args.ready })",
      args: { ready: true },
    });
    expect(result.text).toContain("Frame ID: frame-1 (main)");
    expect(result.text).toContain("count: 3");
    expect(result.text).toContain("ready: true");
    expect(result.details.frameId).toBe("frame-1");
  });

  it("navigates back, reloads, and captures screenshots", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });

    await service.execute("session-1", { action: "back" });
    await service.execute("session-1", { action: "reload" });
    const screenshot = await service.execute("session-1", {
      action: "screenshot",
      fullPage: true,
    });

    expect(fixture.firstPage.goBack).toHaveBeenCalledWith({ waitUntil: "domcontentloaded" });
    expect(fixture.firstPage.reload).toHaveBeenCalledWith({ waitUntil: "domcontentloaded" });
    expect(fixture.firstPage.screenshot).toHaveBeenCalledWith({ fullPage: true, type: "png" });
    expect(screenshot.image).toEqual({
      data: Buffer.from("png data").toString("base64"),
      mimeType: "image/png",
    });
  });

  it("allows fill to clear a field or preserve whitespace", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });

    await service.execute("session-1", { action: "fill", selector: "input", value: "" });
    await service.execute("session-1", { action: "fill", selector: "input", value: "  " });

    expect(fixture.firstPage.locatorMock.fill).toHaveBeenNthCalledWith(1, "");
    expect(fixture.firstPage.locatorMock.fill).toHaveBeenNthCalledWith(2, "  ");
  });

  it("closes session state and requires open before more actions", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });

    await expect(service.execute("session-1", { action: "close" })).resolves.toMatchObject({
      text: "Browser session closed.",
    });
    expect(fixture.context.close).toHaveBeenCalledOnce();
    await expect(service.execute("session-1", { action: "snapshot" })).rejects.toThrow(
      'Start with action="open"',
    );
  });

  it("closes a context when page creation fails", async () => {
    const fixture = createFixture();
    fixture.context.newPage.mockReset().mockRejectedValueOnce(new Error("page failed"));
    const service = new BrowserService();

    await expect(
      service.execute("session-1", { action: "open", url: "https://example.com" }),
    ).rejects.toThrow("page failed");
    expect(fixture.context.close).toHaveBeenCalledOnce();
  });

  it("closes the context to interrupt an aborted action", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    const controller = new AbortController();
    await service.execute("session-1", { action: "open", url: "https://example.com" });

    let rejectClick!: (error: Error) => void;
    fixture.firstPage.locatorMock.click.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectClick = reject;
        }),
    );
    fixture.context.close.mockImplementationOnce(async () => {
      rejectClick(new Error("Target page has been closed"));
    });
    const clicking = service.execute(
      "session-1",
      { action: "click", selector: "button" },
      controller.signal,
    );
    await vi.waitFor(() => expect(fixture.firstPage.locatorMock.click).toHaveBeenCalledOnce());
    controller.abort();

    await expect(clicking).rejects.toThrow("Target page has been closed");
    expect(fixture.context.close).toHaveBeenCalledOnce();
  });

  it("rejects non-web URL schemes", async () => {
    createFixture();
    const service = new BrowserService();
    await expect(
      service.execute("session-1", { action: "open", url: "file:///etc/passwd" }),
    ).rejects.toThrow("only supports http and https URLs");
    expect(chromium.launch).not.toHaveBeenCalled();
  });
});

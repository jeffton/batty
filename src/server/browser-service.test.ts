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
  const locator = {
    ariaSnapshot: vi.fn(async () => '- heading "Example" [level=1]'),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => undefined),
    waitFor: vi.fn(async () => undefined),
  };
  const page = {
    goto: vi.fn(async () => undefined),
    isClosed: vi.fn(() => false),
    locator: vi.fn(() => locator),
    screenshot: vi.fn(async () => Buffer.from("png data")),
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    setViewportSize: vi.fn(async () => undefined),
    title: vi.fn(async () => "Example"),
    url: vi.fn(() => "https://example.com/"),
  };
  const context = {
    close: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
  };
  const browser = {
    isConnected: vi.fn(() => true),
    newContext: vi.fn(async () => context),
    on: vi.fn(),
  };
  vi.mocked(chromium.launch).mockResolvedValue(browser as never);
  return { browser, context, locator, page };
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
      acceptDownloads: false,
      locale: "en-US",
      permissions: [],
    });
    expect(fixture.page.goto).toHaveBeenCalledWith("https://example.com/", {
      waitUntil: "domcontentloaded",
    });
    expect(result.text).toContain('heading "Example"');
    expect(result.details).toEqual({
      action: "open",
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
      acceptDownloads: false,
      locale: "en-US",
      permissions: [],
      viewport: { width: 390, height: 844 },
    });
    expect(fixture.page.setViewportSize).not.toHaveBeenCalled();
  });

  it("resizes an active page before performing an action", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });

    await service.execute("session-1", {
      action: "snapshot",
      viewport: { width: 1440, height: 900 },
    });

    expect(fixture.page.setViewportSize).toHaveBeenCalledWith({ width: 1440, height: 900 });
    expect(fixture.page.setViewportSize.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.locator.ariaSnapshot.mock.invocationCallOrder[1]!,
    );
  });

  it("captures screenshots as PNG image results", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });

    const result = await service.execute("session-1", {
      action: "screenshot",
      fullPage: true,
    });

    expect(fixture.page.screenshot).toHaveBeenCalledWith({ fullPage: true, type: "png" });
    expect(result.text).toContain("Screenshot captured.");
    expect(result.text).not.toContain('heading "Example"');
    expect(result.image).toEqual({
      data: Buffer.from("png data").toString("base64"),
      mimeType: "image/png",
    });
  });

  it("reuses one isolated context for actions in a session", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });

    await service.execute("session-1", {
      action: "fill",
      selector: "input[name=q]",
      value: "Batty",
    });
    await service.execute("session-1", {
      action: "click",
      selector: 'button:has-text("Search")',
    });

    expect(fixture.browser.newContext).toHaveBeenCalledOnce();
    expect(fixture.page.locator).toHaveBeenCalledWith("input[name=q]");
    expect(fixture.locator.fill).toHaveBeenCalledWith("Batty");
    expect(fixture.locator.click).toHaveBeenCalledOnce();
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

  it("rebuilds a closed page when open is called again", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });
    fixture.page.isClosed.mockReturnValue(true);

    await service.execute("session-1", { action: "open", url: "https://example.org" });

    expect(fixture.context.close).toHaveBeenCalledOnce();
    expect(fixture.browser.newContext).toHaveBeenCalledTimes(2);
  });

  it("closes a context when page creation fails", async () => {
    const fixture = createFixture();
    fixture.context.newPage.mockRejectedValueOnce(new Error("page failed"));
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
    fixture.locator.click.mockImplementationOnce(
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
    await vi.waitFor(() => expect(fixture.locator.click).toHaveBeenCalledOnce());
    controller.abort();

    await expect(clicking).rejects.toThrow("Target page has been closed");
    expect(fixture.context.close).toHaveBeenCalledOnce();
  });

  it("closes existing state for a pre-aborted action", async () => {
    const fixture = createFixture();
    const service = new BrowserService();
    await service.execute("session-1", { action: "open", url: "https://example.com" });
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.execute("session-1", { action: "snapshot" }, controller.signal),
    ).rejects.toThrow();
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

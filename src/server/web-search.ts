import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { Browser } from "playwright";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const PAGE_FETCH_TIMEOUT_MS = 15_000;
const BROWSER_SETTLE_TIMEOUT_MS = 3_000;
const BROWSER_FALLBACK_CONCURRENCY = 2;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
type PageFetchResult =
  | {
      ok: true;
      body: string;
      contentType?: string;
      finalUrl: string;
      status?: number;
      statusText?: string;
    }
  | {
      ok: false;
      finalUrl: string;
      status?: number;
      statusText?: string;
      error?: string;
    };

export interface WebSearchOptions {
  apiKey: string;
  action: "search" | "content";
  query?: string;
  url?: string;
  count?: number;
  includeContent?: boolean;
  country?: string;
  freshness?: string;
}

export interface WebSearchResultItem {
  title: string;
  link: string;
  snippet: string;
  age: string;
  content?: string;
}

export interface WebSearchResult {
  text: string;
  details: {
    action: "search" | "content";
    query?: string;
    url?: string;
    count?: number;
    country?: string;
    freshness?: string;
    includeContent?: boolean;
    results?: WebSearchResultItem[];
    content?: string;
  };
}

let activeBrowser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

export function resetWebSearchStateForTests(): void {
  activeBrowser = null;
  browserLaunchPromise = null;
}

function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  turndown.use(gfm);
  turndown.addRule("removeEmptyLinks", {
    filter: (node: Node) => node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => "",
  });
  return turndown
    .turndown(html)
    .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
    .replace(/ +/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractReadableContent(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();

  if (article?.content) {
    const title = article.title ? `# ${article.title}\n\n` : "";
    return `${title}${htmlToMarkdown(article.content)}`.trim();
  }

  const fallbackDoc = new JSDOM(html, { url });
  const body = fallbackDoc.window.document;
  body
    .querySelectorAll("script, style, noscript, nav, header, footer, aside")
    .forEach((el: Element) => el.remove());

  const title = body.querySelector("title")?.textContent?.trim();
  const main = body.querySelector("main, article, [role='main'], .content, #content") || body.body;
  const text = main?.innerHTML || "";
  if (text.trim().length > 100) {
    const heading = title ? `# ${title}\n\n` : "";
    return `${heading}${htmlToMarkdown(text)}`.trim();
  }

  return "Could not extract readable content from this page.";
}

function isUsefulContent(content: string): boolean {
  if (
    content === "Could not extract readable content from this page." ||
    content.startsWith("Error:") ||
    content.startsWith("(HTTP ")
  ) {
    return false;
  }

  const withoutHeading = content.replace(/^# .*\n+/, "").trim();
  return withoutHeading.length >= 40;
}

function isHtmlContentType(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function extractContent(result: Extract<PageFetchResult, { ok: true }>): string {
  if (isHtmlContentType(result.contentType)) {
    return extractReadableContent(result.body, result.finalUrl);
  }

  return result.body;
}

function shouldUseBrowserFallback(result: PageFetchResult, content?: string): boolean {
  if (!result.ok) {
    return result.status === 401 || result.status === 403 || result.status === 429;
  }

  if (!isHtmlContentType(result.contentType)) {
    return false;
  }

  return !isUsefulContent(content ?? "");
}

function formatFetchFailure(result: PageFetchResult): string {
  if (typeof result.status === "number") {
    return `(HTTP ${result.status}: ${result.statusText || "Unknown"})`;
  }

  if (!result.ok) {
    return `Error: ${result.error || "Unknown fetch failure"}`;
  }

  return "Error: Unknown fetch failure";
}

function formatFallbackFailure(
  httpResult: PageFetchResult,
  browserResult: PageFetchResult,
): string {
  return `${formatFetchFailure(httpResult)}\nBrowser fallback failed: ${formatFetchFailure(browserResult)}`;
}

async function fetchPageViaHttp(url: string): Promise<PageFetchResult> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Accept: DEFAULT_ACCEPT,
        "Accept-Language": DEFAULT_ACCEPT_LANGUAGE,
      },
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        ok: false,
        finalUrl: response.url || url,
        status: response.status,
        statusText: response.statusText,
      };
    }

    return {
      ok: true,
      body: await response.text(),
      contentType: response.headers.get("content-type") || undefined,
      finalUrl: response.url || url,
      status: response.status,
      statusText: response.statusText,
    };
  } catch (error) {
    return {
      ok: false,
      finalUrl: url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });

  if (!browser || typeof browser.newContext !== "function") {
    throw new Error("Playwright did not return a browser instance");
  }

  activeBrowser = browser;
  browser.on("disconnected", () => {
    if (activeBrowser === browser) {
      activeBrowser = null;
    }
  });
  return browser;
}

async function getBrowser(): Promise<Browser> {
  if (activeBrowser?.isConnected()) {
    return activeBrowser;
  }

  activeBrowser = null;
  browserLaunchPromise ??= launchBrowser();
  const launchPromise = browserLaunchPromise;

  try {
    return await launchPromise;
  } finally {
    if (browserLaunchPromise === launchPromise) {
      browserLaunchPromise = null;
    }
  }
}

function isClosedBrowserError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:target page, context or browser|browser) has been closed/i.test(error.message)
  );
}

function createConcurrencyLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    if (activeCount >= limit) {
      return;
    }

    const next = queue.shift();
    if (!next) {
      return;
    }

    activeCount += 1;
    next();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      runNext();
    });

    try {
      return await task();
    } finally {
      activeCount -= 1;
      runNext();
    }
  };
}

const withBrowserFallbackSlot = createConcurrencyLimiter(BROWSER_FALLBACK_CONCURRENCY);

async function fetchPageViaBrowser(url: string): Promise<PageFetchResult> {
  return withBrowserFallbackSlot(async () => {
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let browser: Browser | undefined;
      let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;

      try {
        browser = await getBrowser();
        context = await browser.newContext({
          userAgent: DEFAULT_USER_AGENT,
          locale: "en-US",
          extraHTTPHeaders: {
            Accept: DEFAULT_ACCEPT,
            "Accept-Language": DEFAULT_ACCEPT_LANGUAGE,
          },
        });

        const page = await context.newPage();
        page.setDefaultNavigationTimeout(PAGE_FETCH_TIMEOUT_MS);
        page.setDefaultTimeout(PAGE_FETCH_TIMEOUT_MS);

        await page.route("**/*", async (route) => {
          const resourceType = route.request().resourceType();
          if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
            await route.abort();
            return;
          }

          await route.continue();
        });

        const response = await page.goto(url, { waitUntil: "domcontentloaded" });
        await page
          .waitForLoadState("networkidle", { timeout: BROWSER_SETTLE_TIMEOUT_MS })
          .catch(() => {});
        await page.waitForTimeout(250);

        const contentType = response?.headers()["content-type"] ?? "text/html";
        const body = isHtmlContentType(contentType)
          ? await page.content()
          : await (response?.text() ?? page.content());

        return {
          ok: true,
          body,
          contentType,
          finalUrl: page.url(),
          status: response?.status(),
          statusText: response?.statusText(),
        };
      } catch (error) {
        lastError = error;
        const browserClosed = browser ? !browser.isConnected() : false;
        if (attempt === 0 && (browserClosed || isClosedBrowserError(error))) {
          if (activeBrowser === browser) {
            activeBrowser = null;
          }
          continue;
        }
        break;
      } finally {
        await context?.close().catch(() => {});
      }
    }

    return {
      ok: false,
      finalUrl: url,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    };
  });
}

async function fetchPageContent(url: string): Promise<string> {
  const httpResult = await fetchPageViaHttp(url);
  if (httpResult.ok) {
    const content = extractContent(httpResult);
    if (!shouldUseBrowserFallback(httpResult, content)) {
      return content;
    }
  } else if (!shouldUseBrowserFallback(httpResult)) {
    return formatFetchFailure(httpResult);
  }

  const browserResult = await fetchPageViaBrowser(url);
  if (!browserResult.ok) {
    return formatFallbackFailure(httpResult, browserResult);
  }

  const browserContent = extractContent(browserResult);
  if (isHtmlContentType(browserResult.contentType) && !isUsefulContent(browserContent)) {
    return formatFallbackFailure(httpResult, {
      ok: false,
      finalUrl: browserResult.finalUrl,
      status: browserResult.status,
      statusText: browserResult.statusText || "Unusable rendered content",
      error: "Unusable rendered content",
    });
  }

  return browserContent;
}

async function fetchBraveResults(
  apiKey: string,
  query: string,
  count: number,
  country: string,
  freshness?: string,
): Promise<WebSearchResultItem[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(Math.max(Math.floor(count), 1), 20)),
    country,
  });

  if (freshness) {
    params.append("freshness", freshness);
  }

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${response.statusText}\n${errorText}`);
  }

  const data = (await response.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        age?: string;
        page_age?: string;
      }>;
    };
  };

  return (data.web?.results ?? []).slice(0, count).map((result) => ({
    title: result.title || "",
    link: result.url || "",
    snippet: result.description || "",
    age: result.age || result.page_age || "",
  }));
}

function formatSearchResults(results: WebSearchResultItem[]): string {
  if (results.length === 0) {
    return "No results found.";
  }

  return results
    .map((result, index) => {
      const lines = [
        `--- Result ${index + 1} ---`,
        `Title: ${result.title}`,
        `Link: ${result.link}`,
        ...(result.age ? [`Age: ${result.age}`] : []),
        `Snippet: ${result.snippet}`,
        ...(typeof result.content === "string" ? [`Content:\n${result.content}`] : []),
      ];
      return `${lines.join("\n")}\n`;
    })
    .join("\n");
}

export async function runWebSearch(options: WebSearchOptions): Promise<WebSearchResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error(
      "Missing Brave Search API key. Set braveSearchKey in <batty-root>/.batty/options.json.",
    );
  }

  if (options.action === "content") {
    const url = options.url?.trim();
    if (!url) {
      throw new Error("url is required for web-search content");
    }
    const content = await fetchPageContent(url);
    return {
      text: content,
      details: {
        action: "content",
        url,
        content,
      },
    };
  }

  const query = options.query?.trim();
  if (!query) {
    throw new Error("query is required for web-search search");
  }

  const count = Math.min(Math.max(Math.floor(options.count ?? 5), 1), 20);
  const country = (options.country?.trim() || "US").toUpperCase();
  const freshness = options.freshness?.trim() || undefined;
  const includeContent = Boolean(options.includeContent);
  const results = await fetchBraveResults(apiKey, query, count, country, freshness);

  if (includeContent) {
    await Promise.all(
      results.map(async (result) => {
        result.content = await fetchPageContent(result.link);
      }),
    );
  }

  return {
    text: formatSearchResults(results),
    details: {
      action: "search",
      query,
      count,
      country,
      ...(freshness ? { freshness } : {}),
      includeContent,
      results,
    },
  };
}

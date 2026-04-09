import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

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

async function fetchPageContent(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return `(HTTP ${response.status}: ${response.statusText})`;
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();

    if (article?.content) {
      const title = article.title ? `# ${article.title}\n\n` : "";
      return `${title}${htmlToMarkdown(article.content)}`.trim().slice(0, 5000);
    }

    const fallbackDoc = new JSDOM(html, { url });
    const body = fallbackDoc.window.document;
    body
      .querySelectorAll("script, style, noscript, nav, header, footer, aside")
      .forEach((el: Element) => el.remove());

    const title = body.querySelector("title")?.textContent?.trim();
    const main =
      body.querySelector("main, article, [role='main'], .content, #content") || body.body;
    const text = main?.innerHTML || "";
    if (text.trim().length > 100) {
      const heading = title ? `# ${title}\n\n` : "";
      return `${heading}${htmlToMarkdown(text)}`.trim().slice(0, 5000);
    }

    return "Could not extract readable content from this page.";
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
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

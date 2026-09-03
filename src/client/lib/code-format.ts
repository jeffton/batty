import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const AUTO_DETECT_LANGUAGES = [
  "bash",
  "css",
  "javascript",
  "json",
  "markdown",
  "powershell",
  "typescript",
  "xml",
  "yaml",
];

function normalizeLanguage(language?: string): string | undefined {
  if (!language) {
    return undefined;
  }

  switch (language) {
    case "html":
    case "vue":
      return "xml";
    case "js":
    case "javascript":
      return "javascript";
    case "ts":
    case "typescript":
      return "typescript";
    case "md":
    case "markdown":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "shell":
    case "sh":
    case "bash":
      return "bash";
    case "powershell":
    case "ps1":
      return "powershell";
    default:
      return AUTO_DETECT_LANGUAGES.includes(language) ? language : undefined;
  }
}

export function highlightCode(code: string, language?: string): string {
  const normalized = normalizeLanguage(language);
  const value = normalized
    ? hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value
    : hljs.highlightAuto(code, AUTO_DETECT_LANGUAGES).value;

  return value;
}

function encodedTextLength(html: string): number {
  let length = 0;
  for (let index = 0; index < html.length; index += 1) {
    if (html[index] === "&") {
      const entity = html.slice(index).match(/^&(?:#\d+|#x[\da-f]+|[a-z][\w]+);/i)?.[0];
      if (entity) {
        index += entity.length - 1;
      }
    }
    length += 1;
  }
  return length;
}

function encodedIndexAtOffset(html: string, targetOffset: number): number {
  let offset = 0;
  let index = 0;

  while (index < html.length && offset < targetOffset) {
    if (html[index] === "&") {
      const entity = html.slice(index).match(/^&(?:#\d+|#x[\da-f]+|[a-z][\w]+);/i)?.[0];
      if (entity) {
        index += entity.length;
        offset += 1;
        continue;
      }
    }

    index += 1;
    offset += 1;
  }

  return index;
}

export function highlightDiffCode(
  code: string,
  language: string | undefined,
  range: { start: number; end: number },
): string {
  const highlighted = highlightCode(code, language);
  if (range.start >= range.end) {
    return highlighted;
  }

  const tagPattern = /<[^>]+>/g;
  let htmlOffset = 0;
  let codeOffset = 0;
  let result = "";

  for (const match of highlighted.matchAll(tagPattern)) {
    const tagOffset = match.index;
    const text = highlighted.slice(htmlOffset, tagOffset);
    const textLength = encodedTextLength(text);
    const changeStart = Math.max(0, range.start - codeOffset);
    const changeEnd = Math.min(textLength, range.end - codeOffset);

    if (changeStart < changeEnd) {
      const startIndex = encodedIndexAtOffset(text, changeStart);
      const endIndex = encodedIndexAtOffset(text, changeEnd);
      result += `${text.slice(0, startIndex)}<span class="diff-block__inline-change">${text.slice(startIndex, endIndex)}</span>${text.slice(endIndex)}`;
    } else {
      result += text;
    }

    result += match[0];
    htmlOffset = tagOffset + match[0].length;
    codeOffset += textLength;
  }

  const text = highlighted.slice(htmlOffset);
  const textLength = encodedTextLength(text);
  const changeStart = Math.max(0, range.start - codeOffset);
  const changeEnd = Math.min(textLength, range.end - codeOffset);
  if (changeStart < changeEnd) {
    const startIndex = encodedIndexAtOffset(text, changeStart);
    const endIndex = encodedIndexAtOffset(text, changeEnd);
    result += `${text.slice(0, startIndex)}<span class="diff-block__inline-change">${text.slice(startIndex, endIndex)}</span>${text.slice(endIndex)}`;
  } else {
    result += text;
  }

  return result;
}

export function languageFromPath(path?: string): string | undefined {
  if (!path) {
    return undefined;
  }

  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) {
    return "typescript";
  }
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return "javascript";
  }
  if (lower.endsWith(".vue") || lower.endsWith(".html")) {
    return "xml";
  }
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (lower.endsWith(".css")) {
    return "css";
  }
  if (lower.endsWith(".md")) {
    return "markdown";
  }
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) {
    return "yaml";
  }
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) {
    return "bash";
  }
  if (lower.endsWith(".ps1") || lower.endsWith(".psm1") || lower.endsWith(".psd1")) {
    return "powershell";
  }
  return undefined;
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value == null) {
    return "";
  }

  return JSON.stringify(value, null, 2);
}

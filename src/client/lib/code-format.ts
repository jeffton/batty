import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const AUTO_DETECT_LANGUAGES = [
  "bash",
  "css",
  "javascript",
  "json",
  "markdown",
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
    default:
      return AUTO_DETECT_LANGUAGES.includes(language) ? language : undefined;
  }
}

export function highlightCode(code: string, language?: string): string {
  const normalized = normalizeLanguage(language);
  const value = normalized
    ? hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value
    : hljs.highlightAuto(code, AUTO_DETECT_LANGUAGES).value;

  return DOMPurify.sanitize(value, {
    ALLOWED_TAGS: ["span"],
    ALLOWED_ATTR: ["class"],
  });
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

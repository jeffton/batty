function normalizeBaseUrl(value: string | undefined): string {
  if (!value || value === "/") {
    return "/";
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "/") {
    return "/";
  }

  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

export function appBaseUrl(): string {
  return normalizeBaseUrl(window.__BATTY_BASE_URL__);
}

export function withBaseUrl(pathname: string): string {
  const baseUrl = appBaseUrl();
  if (baseUrl === "/") {
    return pathname;
  }
  return pathname === "/" ? baseUrl : `${baseUrl}${pathname}`;
}

export function stripBaseUrl(pathname: string): string | undefined {
  const baseUrl = appBaseUrl();
  if (baseUrl === "/") {
    return pathname;
  }
  if (pathname === baseUrl) {
    return "/";
  }
  if (!pathname.startsWith(`${baseUrl}/`)) {
    return undefined;
  }
  return pathname.slice(baseUrl.length);
}

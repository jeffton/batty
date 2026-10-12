export function appBasePath(baseUrl: string): string {
  return baseUrl === "/" ? "/" : `${baseUrl}/`;
}

export function renderAppShell(html: string, baseUrl: string): string {
  const base = appBasePath(baseUrl)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
  const value = JSON.stringify(baseUrl).replaceAll("<", "\\u003c");
  return html.replace(
    "<head>",
    `<head><base href="${base}"><script>window.__BATTY_BASE_URL__=${value}</script>`,
  );
}

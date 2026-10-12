import { expect, test } from "vite-plus/test";
import { appBasePath, renderAppShell } from "./app-shell";

test("IIS subpath shell supplies router/API base and resolves assets on nested routes", () => {
  const html = renderAppShell(
    '<html><head></head><body><script src="./assets/app.js"></script></body></html>',
    "/batty",
  );
  expect(html).toContain('<base href="/batty/">');
  expect(html).toContain('window.__BATTY_BASE_URL__="/batty"');
  expect(appBasePath("/")).toBe("/");
  expect(appBasePath("/batty")).toBe("/batty/");
});

test("shell configuration cannot close the injected script or base attribute", () => {
  const html = renderAppShell("<head></head>", '/x"&</script>');
  expect(html).toContain("&quot;&amp;");
  expect(html).toContain("\\u003c/script>");
  expect(html.match(/<\/script>/g)).toHaveLength(1);
});

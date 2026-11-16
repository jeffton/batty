# Browser identity

`browser` accepts `identity: "mobile" | "desktop" | "auto"` on `open` and `reload`.

Identity selects the website's Chrome User-Agent and client hints. It does not change the viewport, touch input, cookies or login. An explicit setting belongs to one tab and survives viewer resizing and service restarts. Other tabs retain their own settings. `auto` follows the viewer; omitting the field preserves the tab's setting. `pages` reports each tab's identity.

Desktop mode identifies as Chrome on macOS, including the default `auto` mode with a desktop viewer. Phone viewing uses the existing Android identity. Chrome versions in the UA and client hints come from the running browser. The macOS UA uses Chrome’s frozen `10_15_7` token; client hints identify macOS 14 on Intel x86-64. CDP supplies `MacIntel` to the page’s `navigator.platform`. Isolated tool-evaluation contexts can still expose the native platform; this is browser identity emulation, not a change to the host operating system or every JavaScript OS API.

Subsequent links, navigation and reloads retain a tab’s explicit setting. Separate tabs keep their own identity. No website-specific identity rule or automatic retry is applied.

Chrome format reference: https://www.chromium.org/updates/ua-reduction/

This is an explicit website mode, not an automatic retry after an error. CAPTCHA, identity verification, login and purchase approval requirements remain visible and unchanged.

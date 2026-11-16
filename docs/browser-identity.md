# Browser identity

`browser` accepts `identity: "mobile" | "desktop" | "auto"` on `open` and `reload`.

Identity selects the website's Chrome User-Agent and client hints. It does not change the viewport, touch input, cookies or login. An explicit setting belongs to one tab and survives viewer resizing and service restarts. Other tabs retain their own settings. `auto` follows the viewer; omitting the field preserves the tab's setting. `pages` reports each tab's identity.

For Amazon.se shopping, open a dedicated tab with `identity: "mobile"` before the first request. This requests Amazon's mobile website from a desktop or phone viewer without changing the shared profile. Subsequent links, navigation and reloads in that tab retain the setting. Separate tabs must select their own identity.

This is an explicit website mode, not an automatic retry after an error. CAPTCHA, identity verification, login and purchase approval requirements remain visible and unchanged.

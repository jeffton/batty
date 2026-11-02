# Neon

Choose **Settings → Appearance → Neon**. Both system light/dark variants recolor the functional UI: mint user messages, electric-blue system messages, vivid hover/selection, green/red diffs, and violet/mint/cyan/amber syntax. Neutral surfaces and ordinary text stay calm. There are no decorative neon stripes or bloom.

HDR-capable displays receive solid 16-bit Rec.2100 PQ swatches (`cICP 9/16/0/1`, BT.2020 primaries, ST 2084 transfer, full-range RGB). Light mode uses pastel HDR fills behind dark message/diff text and on hovered controls. Dark mode clips saturated HDR swatches to syntax glyphs, green/red diff prefixes, user-message text and system-notice headings, keeping large backgrounds dark. Broad fills encode 215 cd/m² luminance; colored glyphs encode 235 cd/m². This is approximately 1.06×/1.16× the 203 cd/m² reference white, not maximum display brightness. The swatches request the browser's constrained dynamic range (including the earlier `constrained-high` spelling). Regenerate with `node scripts/generate-neon-hdr.mjs`.

The enhancement is selected with `(dynamic-range: high)`. The complete SDR palette remains functional without HDR. Wide-gamut OKLCH/P3 is not HDR. Native CSS HDR color spaces remain an evolving specification; the implementation uses actual PQ image data, not unsupported color syntax or a brightness filter.

Chrome/Safari image decoding and compositing, OS HDR mode and display headroom determine emitted brightness. Background-clipped HDR glyphs require preservation of HDR through that compositor path. Encoded HDR, successful decoding and CSS selection can be checked on the server; physical HDR output cannot be verified on its SDR display. Screenshots are SDR.

References:

- [CSS HDR specification](https://drafts.csswg.org/css-color-hdr/)
- [PNG cICP specification](https://www.w3.org/TR/png-3/#cICP-chunk)
- [cICP explanation and implementations](https://svgees.us/blog/cICP.html)
- [Safari HDR image support](https://gregbenzphotography.com/photography-reviews/apple-safari-now-supports-hdr-photography/)

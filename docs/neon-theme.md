# Neon

Choose **Settings → Appearance → Neon**. The set follows the system light/dark preference. Ice-white and blue-black chrome carry cyan/violet/magenta washes and a two-pixel emissive seam; transcript, text and controls retain Neutral colors.

On displays reporting `(dynamic-range: high)`, the seam uses a lossless 16-bit Rec.2100 PQ PNG: BT.2020 primaries, ST 2084 transfer, full-range RGB (`cICP 9/16/0/1`). Its brightest cyan endpoint has approximately 440 cd/m² luminance, above 203 cd/m² HDR reference white. It is opaque, unfiltered and requests `dynamic-range-limit: no-limit`; the surrounding UI stays SDR. Regenerate it with `node scripts/generate-neon-hdr.mjs`.

Other displays use the CSS neon gradient. Wide-gamut CSS alone is not HDR. Actual brightness depends on browser image decoding/compositing, OS HDR mode and available display headroom; an SDR screenshot cannot verify emitted HDR light. Chrome and Safari support HDR images on compatible hardware, but reporting HDR capability alone does not prove every image/compositor path produces HDR.

References:

- [CSS HDR terminology and dynamic-range-limit](https://drafts.csswg.org/css-color-hdr/)
- [PNG cICP specification](https://www.w3.org/TR/png-3/#cICP-chunk)
- [XHDR's Rec.2100 PQ example](https://xhdr.app/)

# Header logo

Only the Settings logo in the chat header uses HDR. Its shape, alpha, colors, size and button behavior match `public/favicon.png`. Other icons, themes and UI are unchanged.

`src/client/assets/logo-hdr.png` is 16-bit straight-alpha Rec.2100 PQ, signaled with PNG `cICP` (9/16/0/1). Linear sRGB is converted to BT.2020 without a saturation change. White is encoded at 420 cd/m² versus 203 cd/m² SDR reference white: 2.07× headroom, not a screen-peak effect. Actual output depends on display brightness and OS tone mapping.

The HDR image replaces the original only inside `(dynamic-range: high)` and `@supports (dynamic-range-limit: no-limit)`. SDR displays and older browsers retain the exact original PNG. No CSS brightness filter, glow, animation or theme preference is involved. The asset itself bounds brightness; `no-limit` permits its encoded headroom rather than raising it.

Safari 26 supports HDR images on iOS/iPadOS/macOS, including HDR PNG, and the `no-limit` CSS value. The CSS support gate is a compatibility baseline, not an HDR decoder test. Current Chromium supports cICP HDR PNG. A compatible HDR display and OS configuration are required. iPhone Low Power Mode can disable HDR; available display headroom also varies with brightness and power conditions. Headless SDR screenshots verify layout and SDR appearance, not emitted HDR luminance.

Regenerate after changing the original logo:

```sh
node scripts/generate-logo-hdr.mjs
```

References:

- [WebKit: HDR images and dynamic-range-limit in Safari 26](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#hdr-images)
- [W3C: Using the ITU BT.2100 PQ EOTF with PNG](https://www.w3.org/TR/png-hdr-pq/)
- [cICP in PNG](https://svgees.us/blog/cICP.html)

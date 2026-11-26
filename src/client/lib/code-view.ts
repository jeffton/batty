import type { CodeView, CodeViewOptions } from "@pierre/diffs";

export function codeViewOptions(wrap = true): CodeViewOptions<undefined, undefined> {
  return {
    theme: { dark: "pierre-dark", light: "pierre-light" },
    themeType: "system",
    overflow: wrap ? "wrap" : "scroll",
    disableFileHeader: true,
    layout: { paddingTop: 12, paddingBottom: 12, gap: 0 },
    unsafeCSS: `
      :host { --diffs-font-family: var(--font-family-mono); }
      [data-line], [data-line] span { font-weight: 400; }
    `,
  };
}

export function mountCodeView(View: typeof CodeView, root: HTMLElement, wrap = true): CodeView {
  const view = new View(codeViewOptions(wrap));
  view.setup(root);
  return view;
}

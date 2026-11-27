import type { CodeView } from "@pierre/diffs";

export function mountCodeView(View: typeof CodeView, root: HTMLElement): CodeView {
  const view = new View({
    theme: { dark: "pierre-dark", light: "pierre-light" },
    themeType: "system",
    overflow: "wrap",
    disableFileHeader: true,
    layout: { paddingTop: 12, paddingBottom: 12, gap: 0 },
    unsafeCSS: `
      :host { --diffs-font-family: var(--font-family-mono); }
      [data-line], [data-line] span { font-weight: 400; }
    `,
  });
  view.setup(root);
  return view;
}

export interface CloudBrowserViewport {
  width: number;
  height: number;
  mobile: boolean;
}

export interface CloudBrowserState {
  pageId: string;
  revision: string;
  url: string;
  title: string;
  width: number;
  height: number;
  mobile: boolean;
  focused?: { id: string; value: string; type: string; multiline: boolean };
  pages: Array<{ id: string; title: string; url: string; active: boolean }>;
}

export interface CloudBrowserFrame {
  image: string;
  pageId: string;
  revision: string;
  width: number;
  height: number;
}

type ViewTarget = { pageId: string; revision: string };
export type CloudBrowserControl =
  | (ViewTarget & { action: "click"; x: number; y: number })
  | (ViewTarget & {
      action: "scroll";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    })
  | (ViewTarget & { action: "drag"; x: number; y: number; endX: number; endY: number })
  | (ViewTarget & { action: "fill-focused"; focusId: string; value: string })
  | (ViewTarget & { action: "text"; text: string })
  | (ViewTarget & { action: "key"; key: string; focusId?: string })
  | { action: "navigate"; url: string }
  | { action: "back" | "reload" }
  | { action: "switch" | "close-page"; pageId: string }
  | ({ action: "viewport" } & CloudBrowserViewport);

export const CLOUD_BROWSER_KEYS = [
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Delete",
] as const;

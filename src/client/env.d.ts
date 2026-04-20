/// <reference types="vite/client" />

interface Window {
  __BATTY_BASE_URL__?: string;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, never>, Record<string, never>, any>;
  export default component;
}

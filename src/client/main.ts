import { createApp } from "vue";
import { installBrowserErrorReporting } from "@/client/lib/browser-errors";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { withBaseUrl } from "@/client/lib/base-url";
import { appServiceWorkerScope } from "@/client/lib/service-worker";
import polyfillAnchorPositioning from "@oddbird/css-anchor-positioning/fn";
import App from "@/client/App.vue";
import { installPopoverBackdropClickGuard } from "@/client/lib/popover-backdrop";
import { router } from "@/client/router";
import "@/client/styles.css";

const app = createApp(App);
installBrowserErrorReporting(app);

// The worker claims clients without reloading them. Version checks reload only
// when the composer and uploads are idle.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register(withBaseUrl("/sw.js"), {
    scope: appServiceWorkerScope(),
    updateViaCache: "none",
  });
}

if (!("anchorName" in document.documentElement.style)) {
  await polyfillAnchorPositioning();
}

installPopoverBackdropClickGuard();

const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

app.use(pinia);
app.use(router);
app.mount("#app");

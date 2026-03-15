import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { registerSW } from "virtual:pwa-register";
import polyfillAnchorPositioning from "@oddbird/css-anchor-positioning/fn";
import App from "@/client/App.vue";
import { router } from "@/client/router";
import "@/client/styles.css";

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    void updateSW(true);
  },
});

if (!("anchorName" in document.documentElement.style)) {
  await polyfillAnchorPositioning();
}

const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

const app = createApp(App);
app.use(pinia);
app.use(router);
app.mount("#app");

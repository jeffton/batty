import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { registerSW } from "virtual:pwa-register";
import App from "@/client/App.vue";
import { router } from "@/client/router";
import "@/client/styles.css";

registerSW({ immediate: true });

const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);

const app = createApp(App);
app.use(pinia);
app.use(router);
app.mount("#app");

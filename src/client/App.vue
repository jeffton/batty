<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useAppStore } from "@/client/stores/app";
const store = useAppStore();
const router = useRouter();
const online = () => {
  void store.checkForUpdates();
  void store.recoverConnection();
  void store.persistMainCache();
};
const visible = () => {
  if (document.visibilityState === "hidden") store.pauseReadingCache();
  else online();
};
onMounted(() => {
  window.addEventListener("online", online);
  window.addEventListener("offline", store.pauseReadingCache);
  window.addEventListener("pagehide", store.pauseReadingCache);
  window.addEventListener("pageshow", online);
  document.addEventListener("visibilitychange", visible);
  void store.bootstrap();
});
onUnmounted(() => {
  window.removeEventListener("online", online);
  window.removeEventListener("offline", store.pauseReadingCache);
  window.removeEventListener("pagehide", store.pauseReadingCache);
  window.removeEventListener("pageshow", online);
  document.removeEventListener("visibilitychange", visible);
  store.closeStream();
});
watch(
  () => [store.bootstrapped, store.authenticated],
  () => {
    if (!store.bootstrapped) return;
    if (!store.authenticated) void router.replace("/login");
    else if (router.currentRoute.value.path === "/login") void router.replace("/");
  },
);
</script>
<template>
  <div class="app-shell">
    <div v-if="!store.bootstrapped" class="center-panel">
      <template v-if="store.bootstrapFailed">
        <p role="alert">{{ store.lastError }}</p>
        <button type="button" @click="store.bootstrap()">Retry</button>
      </template>
      <template v-else
        ><div class="spinner" />
        <p>Booting Batty…</p></template
      >
    </div>
    <RouterView v-else />
  </div>
</template>

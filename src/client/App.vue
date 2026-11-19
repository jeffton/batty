<script setup lang="ts">
import LoadingIndicator from "@/client/components/LoadingIndicator.vue";
import { onMounted, onUnmounted, ref, watch } from "vue";
import WorkingHoursGate from "@/client/components/WorkingHoursGate.vue";
import { useRouter } from "vue-router";
import { useAppStore } from "@/client/stores/app";
const store = useAppStore();
const router = useRouter();
// A cached bootstrap can render before the network config arrives. Keep the
// entire routed UI unmounted until that first config request has settled.
const configurationReady = ref(false);
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
  void store.bootstrap().finally(() => {
    configurationReady.value = true;
  });
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
    <div v-if="!store.bootstrapped || !configurationReady" class="center-panel">
      <template v-if="store.bootstrapFailed">
        <p role="alert">{{ store.lastError }}</p>
        <button type="button" @click="store.bootstrap()">Retry</button>
      </template>
      <LoadingIndicator :label="store.bootstrapFailed ? undefined : 'Booting Batty'" large />
    </div>
    <WorkingHoursGate v-else :schedule="store.settings.workingHours">
      <RouterView />
    </WorkingHoursGate>
  </div>
</template>

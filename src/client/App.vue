<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const route = useRoute();
const router = useRouter();

const handleOffline = () => store.markOffline();
const handleOnline = () => store.markOnline();

onMounted(async () => {
  window.addEventListener("offline", handleOffline);
  window.addEventListener("online", handleOnline);
  await store.bootstrap();
});

onUnmounted(() => {
  window.removeEventListener("offline", handleOffline);
  window.removeEventListener("online", handleOnline);
});

watch(
  () => ({
    bootstrapped: store.bootstrapped,
    authenticated: store.authenticated,
    path: route.path,
  }),
  ({ bootstrapped, authenticated, path }) => {
    if (!bootstrapped) {
      return;
    }
    if (!authenticated && path !== "/login") {
      router.replace("/login");
    }
    if (authenticated && path === "/login") {
      router.replace("/");
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="app-shell">
    <div v-if="!store.bootstrapped" class="center-panel">
      <div class="spinner" />
      <p>Booting pi-face…</p>
    </div>
    <RouterView v-else />
  </div>
</template>

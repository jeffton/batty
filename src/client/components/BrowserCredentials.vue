<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { withBaseUrl } from "@/client/lib/base-url";
import type { CloudBrowserCredentialTarget, CloudBrowserState } from "@/shared/cloud-browser";

const props = defineProps<{ browserId: string; state: CloudBrowserState }>();
const target = ref<CloudBrowserCredentialTarget>();
const origin = computed(() => new URL(props.state.url).origin);
const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(true);
const controller = new AbortController();
const initialBrowserId = props.browserId;
const initialKey = identity();
const endpoint = `/api/cloud-browser/${encodeURIComponent(initialBrowserId)}/credentials`;
function identity(): string {
  return JSON.stringify([
    props.browserId,
    props.state.pageId,
    props.state.revision,
    props.state.url,
    props.state.login?.id,
  ]);
}
function clear(): void {
  username.value = "";
  password.value = "";
}
function invalidate(): void {
  controller.abort();
  clear();
  target.value = undefined;
}
onBeforeUnmount(invalidate);
watch(
  identity,
  () => {
    if (identity() !== initialKey) invalidate();
  },
  { flush: "sync" },
);
async function prepare(): Promise<void> {
  const response = await fetch(withBaseUrl(`${endpoint}/prepare`), {
    method: "POST",
    signal: controller.signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error();
  const value = (await response.json()) as CloudBrowserCredentialTarget;
  if (
    controller.signal.aborted ||
    identity() !== initialKey ||
    props.state.pageId !== value.pageId ||
    props.state.revision !== value.revision ||
    props.state.url !== value.url ||
    props.state.login?.id !== value.loginId
  )
    throw new Error();
  target.value = value;
}
async function refresh(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await prepare();
  } catch {
    if (!controller.signal.aborted) error.value = "Login fields changed. Retry to refresh.";
  } finally {
    busy.value = false;
  }
}
onMounted(refresh);
async function fill(): Promise<void> {
  if (!target.value || busy.value || controller.signal.aborted || identity() !== initialKey) return;
  busy.value = true;
  error.value = "";
  try {
    const response = await fetch(withBaseUrl(`${endpoint}/fill`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: target.value,
        username: username.value,
        password: password.value,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    clear();
    target.value = undefined;
    if (!response.ok) throw new Error();
    // Each handoff is one-shot. Keep the pair available for correction without
    // retaining credentials across steps, navigation or reconnects.
    await prepare();
  } catch {
    clear();
    target.value = undefined;
    if (!controller.signal.aborted)
      error.value = "Login fields changed or fill failed. Retry to refresh.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form
    class="browser-credentials"
    autocomplete="on"
    aria-label="Remote login"
    @submit.prevent="fill"
  >
    <div class="browser-credentials__origin">{{ target?.origin || origin }}</div>
    <p v-if="error" role="alert">
      {{ error }} <button type="button" :disabled="busy" @click="refresh">Retry</button>
    </p>
    <div class="browser-credentials__fields">
      <input
        v-model="username"
        type="text"
        name="username"
        autocomplete="username"
        aria-label="Username or email"
        placeholder="Username or email"
        autocapitalize="none"
        autocorrect="off"
        :spellcheck="false"
        :required="state.login?.username"
        :disabled="busy || !target"
        enterkeyhint="next"
      />
      <input
        v-model="password"
        type="password"
        name="password"
        autocomplete="current-password"
        aria-label="Password"
        placeholder="Password"
        :required="state.login?.password"
        :disabled="busy || !target"
        enterkeyhint="done"
      />
      <button
        type="submit"
        class="chrome-button chrome-button--primary"
        :disabled="busy || !target"
      >
        Fill
      </button>
    </div>
  </form>
</template>

<style scoped>
.browser-credentials {
  flex-shrink: 0;
  padding: 0.4rem;
  border-top: 1px solid var(--color-border-soft);
}
.browser-credentials__origin {
  font-size: 0.8rem;
  overflow-wrap: anywhere;
  margin-bottom: 0.3rem;
}
p {
  margin: 0 0 0.3rem;
}
.browser-credentials__fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 0.35rem;
}
input {
  min-width: 0;
  min-height: 2.4rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-chrome-border);
  border-radius: var(--chrome-control-radius);
  background: var(--color-bg-panel-strong);
  color: var(--color-text);
  font: inherit;
  font-size: 1rem;
}
input:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
@media (max-width: 420px) {
  .browser-credentials__fields {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  input[name="username"] {
    grid-column: 1 / -1;
  }
}
</style>

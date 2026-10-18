<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { withBaseUrl } from "@/client/lib/base-url";
import type { CloudBrowserCredentialTarget, CloudBrowserState } from "@/shared/cloud-browser";

const props = defineProps<{ browserId: string; state?: CloudBrowserState }>();
const emit = defineEmits<{ close: [] }>();
const target = ref<CloudBrowserCredentialTarget>();
const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(true);
const controller = new AbortController();
const initialBrowserId = props.browserId;
const endpoint = `/api/cloud-browser/${encodeURIComponent(initialBrowserId)}/credentials`;
function clear(): void {
  username.value = "";
  password.value = "";
}
onBeforeUnmount(() => {
  controller.abort();
  clear();
});
watch(
  () => [props.browserId, props.state?.pageId, props.state?.revision],
  () => {
    if (
      props.browserId !== initialBrowserId ||
      (target.value &&
        (props.state?.pageId !== target.value.pageId ||
          props.state?.revision !== target.value.revision))
    ) {
      clear();
      emit("close");
    }
  },
);
onMounted(async () => {
  try {
    const response = await fetch(withBaseUrl(`${endpoint}/prepare`), {
      method: "POST",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error();
    target.value = await response.json();
    if (
      props.state?.pageId !== target.value!.pageId ||
      props.state?.revision !== target.value!.revision
    ) {
      emit("close");
    }
  } catch {
    if (!controller.signal.aborted)
      error.value =
        "Show a single username and password form, then reopen this panel. Embedded and multi-step logins are not supported.";
  } finally {
    busy.value = false;
  }
});
async function fill(): Promise<void> {
  if (!target.value || busy.value) return;
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
    if (!response.ok) throw new Error();
    emit("close");
  } catch {
    clear();
    target.value = undefined;
    if (!controller.signal.aborted)
      error.value =
        "Could not complete credential fill. The page or session may have changed. Close and reopen this panel.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="browser-credentials" aria-label="Fill remote login">
    <p v-if="target" class="browser-credentials__origin">{{ target.origin }}</p>
    <p>
      Choose a saved login on this device. Selected credentials are sent to the remote browser, not
      chat. Then sign in on the remote page.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <form v-if="target" autocomplete="on" @submit.prevent="fill">
      <label
        >Username
        <input
          v-model="username"
          name="username"
          autocomplete="username"
          autocapitalize="none"
          autocorrect="off"
          :spellcheck="false"
          :disabled="busy"
        />
      </label>
      <label
        >Password
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          :disabled="busy"
          required
        />
      </label>
      <button type="submit" :disabled="busy">Fill remote login</button>
    </form>
    <button type="button" @click="emit('close')">Cancel</button>
  </section>
</template>

<style scoped>
.browser-credentials {
  position: absolute;
  z-index: 2;
  inset: 0;
  padding: 1rem;
  overflow: auto;
  background: var(--color-bg-panel);
}
p {
  margin: 0 0 0.8rem;
}
.browser-credentials__origin {
  font-weight: 600;
  overflow-wrap: anywhere;
}
form,
label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
form {
  gap: 0.8rem;
  margin-bottom: 0.8rem;
}
input,
button {
  min-height: 2.4rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.45rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
  font: inherit;
  font-size: 1rem;
}
</style>

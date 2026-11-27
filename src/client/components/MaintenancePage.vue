<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { startAuthentication } from "@simplewebauthn/browser";
import illustration from "@/client/assets/logo-maintenance.webp";
import type { MaintenanceMessage } from "@/server/maintenance-chat";

type Status =
  | { active: false }
  | { active: true; authenticated: false }
  | {
      active: true;
      authenticated: true;
      id: string;
      message: string;
      progress: number | null;
      model: string;
    };

const owner = ref<Extract<Status, { authenticated: true }>>();
const loaded = ref(false);
const messages = ref<MaintenanceMessage[]>([]);
const draft = ref("");
const statusError = ref("");
const formError = ref("");
const pending = ref(false);
const signingIn = ref(false);
let request: AbortController | undefined;
let poll: ReturnType<typeof setInterval> | undefined;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/maintenance/${path}`, { cache: "no-store", ...init });
  if (!response.ok) {
    const failure = (await response.json()) as { error: string };
    throw new Error(failure.error);
  }
  return response.json() as Promise<T>;
}
function post(body?: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    signal,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}
let checking = false;
async function refresh() {
  if (checking) return;
  checking = true;
  try {
    const status = await api<Status>("status", { signal: AbortSignal.timeout(5000) });
    if (!status.active) {
      if (
        location.pathname === "/maintenance" ||
        location.pathname === "/maintenance.html" ||
        location.pathname.startsWith("/maintenance/")
      )
        location.replace("/");
      else location.reload();
      return;
    }
    const next = status.authenticated ? status : undefined;
    if (owner.value?.id !== next?.id) {
      request?.abort();
      messages.value = [];
      draft.value = "";
      formError.value = "";
    }
    owner.value = next;
    loaded.value = true;
    statusError.value = "";
  } catch {
    statusError.value = "Can't reach the maintenance service.";
  } finally {
    checking = false;
  }
}
async function signIn() {
  signingIn.value = true;
  formError.value = "";
  try {
    const { optionsJSON, requestId } = await api<{
      optionsJSON: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      requestId: string;
    }>("auth/login/options", post());
    const response = await startAuthentication({ optionsJSON });
    await api("auth/login/verify", post({ requestId, response }));
    await refresh();
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error);
  } finally {
    signingIn.value = false;
  }
}
async function ask() {
  if (!owner.value || !draft.value.trim() || pending.value) return;
  const id = owner.value.id;
  const text = draft.value.trim();
  const question: MaintenanceMessage = { role: "user", text };
  const transcript = [...messages.value, question];
  messages.value = transcript;
  draft.value = "";
  formError.value = "";
  pending.value = true;
  const controller = new AbortController();
  request = controller;
  try {
    const { answer } = await api<{ answer: string }>(
      "chat",
      post({ id, messages: transcript }, controller.signal),
    );
    if (owner.value?.id === id) messages.value.push({ role: "assistant", text: answer });
  } catch (error) {
    if (owner.value?.id !== id) return;
    messages.value.pop();
    if (!draft.value) draft.value = text;
    if (!controller.signal.aborted)
      formError.value = error instanceof Error ? error.message : String(error);
  } finally {
    request = undefined;
    pending.value = false;
  }
}
onMounted(() => {
  void refresh();
  poll = setInterval(refresh, 2500);
});
onUnmounted(() => {
  clearInterval(poll);
  request?.abort();
});
</script>

<template>
  <main class="repair" aria-labelledby="title">
    <img class="illustration" :src="illustration" alt="" width="512" height="512" />
    <h1 id="title">Batty is under maintenance</h1>
    <div class="status" role="status">
      <p v-if="owner">{{ owner.message }}</p>
      <div class="meter">
        <progress
          :value="owner?.progress ?? undefined"
          max="100"
          aria-label="Maintenance progress"
        />
        <span v-if="owner?.progress != null">{{ owner.progress }}%</span>
      </div>
      <p v-if="statusError" class="error">{{ statusError }}</p>
    </div>
    <section v-if="owner" class="chat" aria-labelledby="chat-title">
      <div class="chat-title">
        <h2 id="chat-title">Ask about maintenance</h2>
        <p>Not saved</p>
      </div>
      <ol v-if="messages.length" class="transcript" aria-live="polite">
        <li v-for="(message, index) in messages" :key="index" :class="message.role">
          <strong>{{ message.role === "user" ? "You" : "Batty" }}</strong>
          {{ message.text }}
        </li>
      </ol>
      <p v-if="pending" class="quiet" role="status">Checking…</p>
      <form @submit.prevent="ask">
        <label class="sr-only" for="question">Question</label>
        <input id="question" v-model="draft" placeholder="How is it going?" autocomplete="off" />
        <button v-if="pending" class="chrome-button" type="button" @click="request?.abort()">
          Stop
        </button>
        <button
          v-else
          class="chrome-button chrome-button--primary"
          type="submit"
          :disabled="!draft.trim()"
        >
          Ask
        </button>
      </form>
    </section>
    <button
      v-else-if="loaded"
      class="chrome-button chrome-button--primary"
      type="button"
      :disabled="signingIn"
      @click="signIn"
    >
      Sign in with a passkey
    </button>
    <p v-if="formError" class="error" role="alert">{{ formError }}</p>
  </main>
</template>

<style>
html:has(#maintenance),
body:has(#maintenance) {
  height: auto;
  overflow: visible;
  background: var(--color-bg-app);
}
</style>

<style scoped>
.repair {
  min-height: 100dvh;
  max-width: 38rem;
  margin: auto;
  padding: max(2rem, var(--safe-area-top)) max(1.5rem, var(--safe-area-right))
    max(2rem, var(--safe-area-bottom)) max(1.5rem, var(--safe-area-left));
  display: flex;
  flex-direction: column;
  justify-content: safe center;
  align-items: center;
  text-align: center;
}
.illustration {
  width: 7.5rem;
  height: 7.5rem;
  margin-bottom: 1.25rem;
}
h1 {
  margin: 0;
  font-size: 1.6rem;
  font-weight: 600;
}
.status {
  width: min(100%, 20rem);
  margin: 0.6rem 0 1.5rem;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.status p {
  margin: 0 0 0.4rem;
}
.meter {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.4rem;
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
}
progress {
  flex: 1;
  min-width: 0;
  height: 0.65rem;
  accent-color: var(--color-accent);
}
.chat {
  width: 100%;
  text-align: start;
  border-top: 1px solid var(--color-border-soft);
  padding-top: 0.7rem;
}
.chat-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.6rem;
}
.chat-title h2 {
  font-size: 1.05rem;
  margin: 0;
}
.chat-title p,
.quiet {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  margin: 0;
}
.transcript {
  list-style: none;
  padding: 0;
  margin: 0 0 0.8rem;
  display: grid;
  gap: 0.65rem;
}
.transcript li {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.transcript .user {
  justify-self: end;
  max-width: 90%;
  padding: 0.45rem 0.75rem;
  border-radius: var(--chrome-control-radius);
  background: var(--color-user-bg);
  color: var(--color-user-text);
}
.transcript strong {
  display: block;
  font-weight: 600;
}
form {
  display: flex;
  gap: 0.45rem;
}
input {
  flex: 1;
  min-width: 0;
  height: var(--button-size);
  padding: 0 0.75rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--chrome-control-radius);
  background: var(--color-bg-panel-strong);
  color: inherit;
  font-size: 16px;
}
input::placeholder {
  color: var(--color-text-muted);
}
input:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.quiet {
  margin-bottom: 0.5rem;
}
.repair .error {
  color: var(--color-error);
  overflow-wrap: anywhere;
  max-width: 100%;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>

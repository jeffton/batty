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
    <img class="illustration" :src="illustration" alt="" width="160" height="160" />
    <h1 id="title">Under maintenance</h1>
    <div class="status" role="status" aria-live="polite">
      <p>{{ owner?.message ?? "Batty will be back here when maintenance is complete." }}</p>
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
        <button v-if="pending" type="button" @click="request?.abort()">Stop</button>
        <button v-else type="submit" :disabled="!draft.trim()">Ask</button>
      </form>
    </section>
    <button v-else-if="loaded" type="button" :disabled="signingIn" @click="signIn">
      Sign in with a passkey
    </button>
    <p v-if="formError" class="error" role="alert">{{ formError }}</p>
  </main>
</template>

<style>
:root {
  font-family: "Source Sans 3", system-ui, sans-serif;
  color-scheme: light dark;
  --surface: #f7f7f5;
  --panel: #fff;
  --ink: #242726;
  --muted: #5d625e;
  --line: #dadeda;
  --accent: #795418;
  --error: #a62c2c;
  background: var(--surface);
  color: var(--ink);
}

@media (prefers-color-scheme: dark) {
  :root {
    --surface: #151817;
    --panel: #202423;
    --ink: #f0f1ed;
    --muted: #bdc2bd;
    --line: #3a413e;
    --accent: #e8ba70;
    --error: #ff9b99;
  }
}

* {
  box-sizing: border-box;
}
body {
  margin: 0;
}
.repair {
  min-height: 100dvh;
  max-width: 38rem;
  margin: auto;
  padding: max(1.75rem, env(safe-area-inset-top)) 1.25rem max(2rem, env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  justify-content: safe center;
  align-items: center;
  text-align: center;
}
.illustration {
  display: block;
  object-fit: contain;
}
h1 {
  margin: 0.15rem 0 0.4rem;
  font-size: 2rem;
  line-height: 1.1;
  letter-spacing: -0.02em;
}
.status {
  width: min(100%, 28rem);
  margin-bottom: 1.75rem;
}
.status p {
  margin: 0.35rem 0 0.7rem;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.meter {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  font-variant-numeric: tabular-nums;
}
progress {
  flex: 1;
  height: 0.8rem;
  accent-color: var(--accent);
}
.chat {
  width: 100%;
  text-align: start;
  border: 1px solid var(--line);
  border-radius: 1rem;
  background: var(--panel);
  padding: 0.9rem;
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
  color: var(--muted);
  font-size: 0.95rem;
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
  padding: 0.55rem 0.75rem;
  border-radius: 0.55rem;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.transcript .user {
  background: var(--surface);
}
.transcript strong {
  display: block;
}
form {
  display: flex;
  gap: 0.45rem;
}
input,
button {
  font: inherit;
  min-height: 2.75rem;
  border: 1px solid var(--line);
  border-radius: 0.55rem;
  padding: 0.35rem 0.75rem;
}
input {
  flex: 1;
  min-width: 0;
  background: var(--surface);
  color: inherit;
}
button {
  background: var(--panel);
  color: var(--ink);
  cursor: pointer;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
.quiet {
  margin-bottom: 0.5rem;
}
.error,
.status .error {
  color: var(--error);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>

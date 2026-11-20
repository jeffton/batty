<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { rpcCall } from "@/client/lib/rpc";
import type { CloudBrowserState } from "@/shared/cloud-browser";

const props = defineProps<{ browserId: string; state: CloudBrowserState }>();
const form = ref<HTMLFormElement>();
const username = ref<HTMLInputElement>();
const password = ref<HTMLInputElement>();
const origin = computed(() => new URL(props.state.url).origin);
const error = ref(false);
const transferring = ref(false);
const incompleteAfterTransfer = ref(false);
const controller = new AbortController();
const initialKey = identity();
const initialBrowserId = props.browserId;
const settleMs = 300;
type Values = { username: string; password: string };
let observed: Values | undefined;
let filled: Values | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let autofillPoll: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let pending = false;
let transferAttempted = false;
let composing = false;
let lastFocusedField: HTMLInputElement | undefined;

function identity(): string {
  return JSON.stringify([
    props.browserId,
    props.state.pageId,
    props.state.revision,
    props.state.url,
    props.state.login?.id,
  ]);
}
function current(): boolean {
  return !controller.signal.aborted && identity() === initialKey;
}
function invalidate(): void {
  controller.abort();
  clearTimeout(timer);
  clearInterval(autofillPoll);
  observed = filled = undefined;
  if (username.value) username.value.value = "";
  if (password.value) password.value.value = "";
}
onBeforeUnmount(invalidate);
watch(identity, invalidate, { flush: "sync" });

function equal(a: Values | undefined, b: Values): boolean {
  return a?.username === b.username && a?.password === b.password;
}
function values(): Values {
  return {
    username: props.state.login?.username ? (username.value?.value ?? "") : "",
    password: props.state.login?.password ? (password.value?.value ?? "") : "",
  };
}
function complete(value: Values): boolean {
  const login = props.state.login;
  return !!login && (!login.username || !!value.username) && (!login.password || !!value.password);
}
function observe(immediate = false): void {
  if (!current() || composing) return;
  const value = values();
  incompleteAfterTransfer.value = transferAttempted && !complete(value);
  transferring.value = inFlight || (!error.value && complete(value) && !equal(filled, value));
  if (!immediate && equal(observed, value)) return;
  observed = value;
  pending = false;
  clearTimeout(timer);
  if (error.value || !complete(value) || equal(filled, value)) return;
  if (immediate) void fill();
  else timer = setTimeout(() => void fill(), settleMs);
}
function focusIn(event: FocusEvent): void {
  if (event.target === username.value || event.target === password.value)
    lastFocusedField = event.target as HTMLInputElement;
  observe();
  // Some iOS password managers write DOM values without input/change on both fields.
  // Observe only while editing the login panel, and take one last reading on blur.
  autofillPoll ??= setInterval(observe, 150);
}
function focusOut(event: FocusEvent): void {
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return;
  clearInterval(autofillPoll);
  autofillPoll = undefined;
  if (composing) finishComposition();
  else observe();
}
function finishComposition(): void {
  composing = false;
  // A debounce may have expired during a composition that was later cancelled.
  observed = undefined;
  observe();
}
function enter(event: KeyboardEvent): void {
  if (
    (event.target !== username.value && event.target !== password.value) ||
    event.isComposing ||
    composing
  )
    return;
  event.preventDefault();
  if (event.target === username.value && props.state.login?.password) {
    password.value?.focus();
    return;
  }
  observe(true);
  (event.target as HTMLInputElement).blur();
}
async function fill(): Promise<void> {
  if (!current() || composing || error.value) return;
  const snapshot = values();
  // An eventless change may have arrived since the debounce was started.
  if (!equal(observed, snapshot)) return observe();
  if (!complete(snapshot) || equal(filled, snapshot)) return;
  if (inFlight) {
    pending = true;
    return;
  }
  inFlight = true;
  try {
    const { value: target } = await rpcCall(
      "browser.credentials.prepare",
      { browserId: initialBrowserId },
      { signal: controller.signal },
    );
    if (!current()) return;
    if (
      target.pageId !== props.state.pageId ||
      target.revision !== props.state.revision ||
      target.url !== props.state.url ||
      target.origin !== origin.value ||
      target.loginId !== props.state.login?.id
    )
      throw new Error();
    if (composing || !equal(snapshot, values())) return;
    transferAttempted = true;
    await rpcCall(
      "browser.credentials.fill",
      { browserId: initialBrowserId, credentials: { target, ...snapshot } },
      { signal: controller.signal },
    );
    if (current()) filled = snapshot;
  } catch {
    if (current()) {
      filled = undefined;
      error.value = true;
    }
  } finally {
    inFlight = false;
    if (pending) {
      pending = false;
      observe(true);
    } else observe();
  }
}
function canInteractWithPage(): boolean {
  observe();
  const value = values();
  return !inFlight && !composing && (complete(value) ? equal(filled, value) : !transferAttempted);
}
function isEditing(): boolean {
  return transferring.value || !!form.value?.contains(document.activeElement);
}
defineExpose({ canInteractWithPage, isEditing, transferring });

function retry(): void {
  // Retry disappears once activated. Return focus to the field, not the page body.
  (lastFocusedField ?? (props.state.login?.username ? username.value : password.value))?.focus();
  error.value = false;
  observe(true);
}
</script>

<template>
  <form
    ref="form"
    class="browser-credentials"
    autocomplete="on"
    :aria-label="`Remote login at ${origin}`"
    @submit.prevent="observe(true)"
    @input="observe()"
    @change="observe()"
    @focusin="focusIn"
    @focusout="focusOut"
    @animationstart="observe()"
    @compositionstart="composing = true"
    @compositionend="finishComposition"
    @keydown.enter="enter"
  >
    <p v-if="error" role="alert">
      Could not fill the login fields. <button type="button" @click="retry">Retry</button>
    </p>
    <p v-else-if="incompleteAfterTransfer" role="status">
      Complete the missing field to update the remote login.
    </p>
    <div class="browser-credentials__fields">
      <input
        ref="username"
        type="text"
        name="username"
        autocomplete="username"
        aria-label="Username or email"
        placeholder="Username or email"
        autocapitalize="none"
        autocorrect="off"
        :spellcheck="false"
        :required="state.login?.username"
        :enterkeyhint="state.login?.password ? 'next' : 'done'"
      />
      <input
        ref="password"
        type="password"
        name="password"
        autocomplete="current-password"
        aria-label="Password"
        placeholder="Password"
        :required="state.login?.password"
        enterkeyhint="done"
      />
    </div>
  </form>
</template>

<style scoped>
.browser-credentials {
  flex: 0 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0.4rem;
  border-top: 1px solid var(--color-border-soft);
}
p {
  margin: 0 0 0.3rem;
}
.browser-credentials__fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
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
input:is(:autofill, :-webkit-autofill) {
  animation: credentials-autofill 1ms;
}
@keyframes credentials-autofill {
  from {
    --credential-autofill: 0;
  }
  to {
    --credential-autofill: 1;
  }
}
</style>

<script setup lang="ts">
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ref } from "vue";
import {
  beginPasskeyLogin,
  beginPasskeyRegistration,
  finishPasskeyLogin,
  finishPasskeyRegistration,
} from "@/client/lib/api";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const setupCode = ref("");
const pending = ref<"login" | "register" | undefined>();

function updateSetupCode(value: string): void {
  setupCode.value = value.toLowerCase();
}

async function signIn(): Promise<void> {
  pending.value = "login";
  store.authError = undefined;
  try {
    const { requestId, optionsJSON } = await beginPasskeyLogin();
    const response = await startAuthentication({ optionsJSON });
    await finishPasskeyLogin(requestId, response);
    await store.bootstrap();
  } catch (error) {
    store.setAuthError(error);
  } finally {
    pending.value = undefined;
  }
}

async function register(): Promise<void> {
  pending.value = "register";
  store.authError = undefined;
  try {
    const { requestId, optionsJSON } = await beginPasskeyRegistration(setupCode.value);
    const response = await startRegistration({ optionsJSON });
    await finishPasskeyRegistration(requestId, response);
    setupCode.value = "";
    await store.bootstrap();
  } catch (error) {
    store.setAuthError(error);
  } finally {
    pending.value = undefined;
  }
}
</script>

<template>
  <main class="login-view">
    <section class="login-card">
      <img src="/favicon.png" alt="Batty" class="login-card__icon" />
      <div class="login-card__header">
        <h1>Batty</h1>
        <p>Sign in with your passkey, or enter a setup code from the server terminal.</p>
      </div>

      <button class="login-card__submit" :disabled="Boolean(pending)" @click="signIn">
        {{ pending === "login" ? "Waiting for passkey…" : "Sign in with passkey" }}
      </button>

      <div class="login-card__register">
        <label class="login-card__field">
          <span>Setup code</span>
          <input
            :value="setupCode"
            name="setup-code"
            type="text"
            inputmode="text"
            autocomplete="one-time-code"
            autocapitalize="off"
            spellcheck="false"
            placeholder="abcd ef12"
            :disabled="Boolean(pending)"
            @input="updateSetupCode(($event.target as HTMLInputElement).value)"
          />
        </label>

        <button
          class="login-card__submit login-card__submit--secondary"
          :disabled="Boolean(pending) || setupCode.trim().length === 0"
          @click="register"
        >
          {{ pending === "register" ? "Registering passkey…" : "Register passkey" }}
        </button>
      </div>

      <p class="login-card__hint">
        Need a new setup code? Run <code>pnpm add-user -- /path/to/batty-root</code> on the server.
      </p>
      <p v-if="store.authError" class="login-card__error">{{ store.authError }}</p>
    </section>
  </main>
</template>

<style scoped>
.login-view {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  padding: 1.5rem;
}

.login-card {
  width: min(100%, 25rem);
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  border-radius: 1rem;
  border: 1px solid var(--color-border);
  background: var(--color-bg-panel);
  box-shadow: 0 1rem 2.5rem rgba(15, 23, 42, 0.08);
}

.login-card__icon {
  width: 4rem;
  height: 4rem;
  border-radius: 1rem;
  align-self: center;
}

.login-card__header {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  text-align: center;
}

.login-card h1 {
  margin: 0;
  font-size: 1.8rem;
  color: var(--color-text-strong);
}

.login-card__header p,
.login-card__hint {
  margin: 0;
  color: var(--color-text-muted);
}

.login-card__register {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.login-card__field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.login-card__field span {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--color-text-muted);
}

.login-card__field input {
  width: 100%;
  border-radius: 0.75rem;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-app);
  color: inherit;
  padding: 0.8rem 0.9rem;
  font-size: 0.95rem;
  text-transform: lowercase;
}

.login-card__field input:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 18%, transparent);
}

.login-card__submit {
  width: 100%;
  border: 0;
  border-radius: 0.75rem;
  padding: 0.8rem 1rem;
  color: white;
  background: var(--color-accent);
  font-weight: 600;
  transition: background 80ms ease;
}

.login-card__submit:hover:not(:disabled) {
  background: var(--color-accent-strong);
}

.login-card__submit:disabled {
  opacity: 0.6;
}

.login-card__submit--secondary {
  background: color-mix(in srgb, var(--color-accent) 82%, black);
}

.login-card__submit--secondary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-accent-strong) 82%, black);
}

.login-card__hint code {
  font-family: var(--font-family-mono);
  font-size: 0.85em;
}

.login-card__error {
  margin: 0;
  color: var(--color-error);
  font-size: 0.88rem;
  text-align: center;
}
</style>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const username = ref("");
const password = ref("");
const pending = ref(false);

watch(
  () => store.authUsername,
  (value) => {
    if (!username.value) {
      username.value = value;
    }
  },
  { immediate: true },
);

async function submit(): Promise<void> {
  pending.value = true;
  try {
    await store.login(username.value, password.value);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <main class="login-view">
    <form class="login-card" @submit.prevent="submit">
      <img src="/favicon.png" alt="pi-face" class="login-card__icon" />
      <div class="login-card__header">
        <h1>pi-face</h1>
        <p>Sign in to continue.</p>
      </div>

      <label class="login-card__field">
        <span>Username</span>
        <input
          v-model="username"
          name="username"
          type="text"
          autocomplete="username"
          placeholder="Username"
          :disabled="pending"
        />
      </label>

      <label class="login-card__field">
        <span>Password</span>
        <input
          v-model="password"
          name="password"
          type="password"
          autocomplete="current-password"
          placeholder="Password"
          :disabled="pending"
        />
      </label>

      <button class="login-card__submit" :disabled="pending">
        {{ pending ? "Signing in…" : "Sign in" }}
      </button>
      <p v-if="store.authError" class="login-card__error">{{ store.authError }}</p>
    </form>
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
  width: min(100%, 24rem);
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

.login-card__header p {
  margin: 0;
  color: var(--color-text-muted);
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

.login-card__error {
  margin: 0;
  color: var(--color-error);
  font-size: 0.88rem;
  text-align: center;
}
</style>

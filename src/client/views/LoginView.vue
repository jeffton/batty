<script setup lang="ts">
import { ref } from "vue";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const password = ref("");
const pending = ref(false);

async function submit(): Promise<void> {
  pending.value = true;
  try {
    await store.login(password.value);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <main class="login-view">
    <form class="login-card" @submit.prevent="submit">
      <img src="/favicon.png" alt="pi-face" class="login-card__icon" />
      <h1>pi-face</h1>
      <label class="login-card__field">
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="Password"
        />
      </label>
      <button class="login-card__submit" :disabled="pending">
        {{ pending ? "Unlocking…" : "Unlock" }}
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
  width: min(100%, 22rem);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

.login-card__icon {
  width: 4rem;
  height: 4rem;
  border-radius: 1rem;
}

.login-card h1 {
  margin: 0;
  font-size: 1.8rem;
  color: var(--color-text-strong);
}

.login-card__field {
  width: 100%;
}

.login-card__field input {
  width: 100%;
  border-radius: 0.6rem;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-panel);
  color: inherit;
  padding: 0.7rem 0.8rem;
  text-align: center;
  font-size: 0.95rem;
}

.login-card__field input:focus {
  outline: none;
  border-color: var(--color-accent);
}

.login-card__submit {
  width: 100%;
  border: 0;
  border-radius: 0.6rem;
  padding: 0.7rem 1rem;
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
}
</style>

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
    <form class="login-card panel" @submit.prevent="submit">
      <div>
        <div class="pill">pi.dev, but with more pixels</div>
        <h1>pi-face</h1>
        <p class="muted">
          Hardcoded password auth for now. Fancy later, pirate mode maybe never 🏴‍☠️
        </p>
      </div>
      <label class="login-card__field">
        <span>Password</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="Enter the random password"
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
  padding: calc(var(--safe-area-top) + 1.5rem) calc(var(--safe-area-right) + 1.5rem)
    calc(var(--safe-area-bottom) + 1.5rem) calc(var(--safe-area-left) + 1.5rem);
}

.login-card {
  width: min(100%, 28rem);
  padding: 1.35rem;
  display: grid;
  gap: 0.9rem;
}

.login-card h1 {
  margin: 0.65rem 0 0.35rem;
  font-size: clamp(2rem, 8vw, 3rem);
}

.login-card__field {
  display: grid;
  gap: 0.4rem;
}

.login-card__field input {
  border-radius: 0.6rem;
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-panel-soft);
  color: inherit;
  padding: 0.8rem 0.9rem;
}

.login-card__submit {
  border: 1px solid var(--color-border-strong);
  border-radius: 0.6rem;
  padding: 0.85rem 1rem;
  color: inherit;
  background: var(--color-success-soft);
}

.login-card__error {
  margin: 0;
  color: var(--color-error);
}
</style>

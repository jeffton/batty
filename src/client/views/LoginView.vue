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
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 1.5rem;
}

.login-card {
  width: min(100%, 28rem);
  padding: 1.5rem;
  display: grid;
  gap: 1rem;
}

.login-card h1 {
  margin: 0.75rem 0 0.35rem;
  font-size: clamp(2rem, 8vw, 3rem);
}

.login-card__field {
  display: grid;
  gap: 0.4rem;
}

.login-card__field input {
  border-radius: 0.85rem;
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(2, 6, 23, 0.7);
  color: inherit;
  padding: 0.9rem 1rem;
}

.login-card__submit {
  border: 0;
  border-radius: 0.85rem;
  padding: 0.95rem 1rem;
  color: white;
  background: linear-gradient(135deg, #2563eb, #0ea5e9);
}

.login-card__error {
  margin: 0;
  color: #fca5a5;
}
</style>

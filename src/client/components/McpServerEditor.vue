<script setup lang="ts">
import { Save, X } from "@lucide/vue";

const props = defineProps<{ editing: boolean; saving: boolean; canSave: boolean }>();
const name = defineModel<string>("name", { required: true });
const config = defineModel<string>("config", { required: true });
const global = defineModel<boolean>("global", { required: true });
const emit = defineEmits<{ save: []; cancel: [] }>();
</script>

<template>
  <form class="mcp-settings__form" @submit.prevent="emit('save')">
    <label class="mcp-editor__switch">
      <input
        v-model="global"
        type="checkbox"
        role="switch"
        aria-label="Global server"
        :disabled="saving"
      />
      <span class="mcp-editor__switch-track" aria-hidden="true" />
      <span>Global server</span>
    </label>
    <label v-if="!props.editing" class="mcp-editor__field">
      <span>Name</span>
      <input v-model="name" aria-label="MCP server name" autocomplete="off" :disabled="saving" />
    </label>
    <label class="mcp-editor__field">
      <span>Server configuration (JSON)</span>
      <textarea
        v-model="config"
        aria-label="MCP server configuration"
        rows="9"
        spellcheck="false"
        :disabled="saving"
      />
    </label>
    <div class="mcp-editor__actions">
      <button type="submit" class="mcp-editor__save" :disabled="saving || !canSave">
        <Save :size="14" /> {{ saving ? "Saving…" : "Save server" }}
      </button>
      <button type="button" class="mcp-editor__cancel" :disabled="saving" @click="emit('cancel')">
        <X :size="14" /> Cancel
      </button>
    </div>
  </form>
</template>

<style scoped>
.mcp-settings__form {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding-top: 0.5rem;
}
.mcp-editor__field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  color: var(--color-text-subtle);
  font-size: 0.78rem;
}
.mcp-editor__field input,
.mcp-editor__field textarea {
  width: 100%;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.6rem;
  background: var(--color-bg-app);
  color: var(--color-text);
  font: 0.86rem/1.5 var(--font-family-mono);
  resize: vertical;
}
.mcp-editor__field input:focus,
.mcp-editor__field textarea:focus {
  outline: none;
  border-color: var(--color-accent);
}
.mcp-editor__actions {
  display: flex;
  gap: 0.4rem;
}
.mcp-editor__actions button {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.45rem 0.65rem;
  border: 0;
  border-radius: 0.45rem;
  font: inherit;
  font-size: 0.82rem;
  cursor: pointer;
}
.mcp-editor__save {
  background: var(--color-bg-selection);
  color: var(--color-accent-strong);
  font-weight: 600;
}
.mcp-editor__cancel {
  background: transparent;
  color: var(--color-text-muted);
}
.mcp-editor__switch {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  cursor: pointer;
}
.mcp-editor__switch input {
  position: absolute;
  opacity: 0;
}
.mcp-editor__switch-track {
  position: relative;
  width: 2rem;
  height: 1.1rem;
  border-radius: 999px;
  background: var(--color-border-strong);
}
.mcp-editor__switch-track::after {
  content: "";
  position: absolute;
  top: 0.15rem;
  left: 0.15rem;
  width: 0.8rem;
  height: 0.8rem;
  border-radius: 50%;
  background: var(--color-bg-overlay);
  transition: transform 120ms ease;
}
.mcp-editor__switch input:checked + .mcp-editor__switch-track {
  background: var(--color-accent);
}
.mcp-editor__switch input:checked + .mcp-editor__switch-track::after {
  transform: translateX(0.9rem);
}
.mcp-editor__switch input:focus-visible + .mcp-editor__switch-track {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
button:disabled,
input:disabled,
textarea:disabled {
  opacity: 0.6;
}
</style>

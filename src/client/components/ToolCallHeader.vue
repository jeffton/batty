<script setup lang="ts">
import { Check, CircleAlert, LoaderCircle } from "@lucide/vue";
import { isPiShellToolName } from "@/shared/pi-tools";

const props = defineProps<{
  name: string;
  path?: string;
  timeout?: string;
  status?: "running" | "success" | "error";
}>();
</script>

<template>
  <header class="tool-call__header">
    <strong class="tool-call__name">{{ props.name }}</strong>
    <span v-if="isPiShellToolName(props.name) && props.timeout" class="tool-call__timeout">
      {{ props.timeout }}
    </span>
    <code v-if="props.path" class="tool-call__path">{{ props.path }}</code>
    <span v-if="props.status" :class="['tool-call__status', `tool-call__status--${props.status}`]">
      <LoaderCircle
        v-if="props.status === 'running'"
        :size="14"
        class="tool-call__status-icon tool-call__status-icon--spin"
      />
      <Check v-else-if="props.status === 'success'" :size="14" class="tool-call__status-icon" />
      <CircleAlert v-else :size="14" class="tool-call__status-icon" />
    </span>
  </header>
</template>

<style scoped>
.tool-call__header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.tool-call__name {
  color: var(--color-text-strong);
}

.tool-call__timeout {
  color: var(--color-text-subtle);
  font-size: 0.78rem;
}

.tool-call__path {
  display: inline-block;
  white-space: normal;
  overflow-wrap: anywhere;
  vertical-align: baseline;
  color: var(--color-info);
  background: var(--color-bg-inline-code);
  border-radius: 0.2rem;
  padding: 0.12rem 0.35rem;
}

.tool-call__status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tool-call__status--success {
  color: var(--color-success-contrast);
}

.tool-call__status--error {
  color: var(--color-error);
}

.tool-call__status--running {
  color: var(--color-info);
}

.tool-call__status-icon {
  display: block;
}

.tool-call__status-icon--spin {
  animation: tool-call-header-spin 0.9s linear infinite;
}

@keyframes tool-call-header-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

<script setup lang="ts">
import { Check, Copy } from "@lucide/vue";
import { ref } from "vue";
import { getSettingsCopyValue } from "@/client/lib/api";

const props = defineProps<{
  kind: "provider" | "environment" | "brave-search";
  name: string;
  label: string;
  disabled?: boolean;
}>();
const pending = ref(false);
const copied = ref(false);
const failed = ref(false);

async function copy(): Promise<void> {
  pending.value = true;
  copied.value = false;
  failed.value = false;
  try {
    // Start clipboard access within the click gesture, including on Safari.
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": getSettingsCopyValue(props.kind, props.name).then(
          ({ value }) => new Blob([value], { type: "text/plain" }),
        ),
      }),
    ]);
    copied.value = true;
  } catch {
    failed.value = true;
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <button
    class="settings-popover__action"
    type="button"
    :aria-label="`Copy ${label}`"
    :title="failed ? 'Copy failed. Try again.' : copied ? 'Copied' : `Copy ${label}`"
    :disabled="disabled || pending"
    @click="copy"
  >
    <component :is="copied ? Check : Copy" :size="16" aria-hidden="true" />
    <span v-if="copied || failed" :role="failed ? 'alert' : 'status'">{{
      failed ? "Copy failed" : "Copied"
    }}</span>
  </button>
</template>

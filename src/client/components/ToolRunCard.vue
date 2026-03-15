<script setup lang="ts">
import ToolCallBlock from "@/client/components/ToolCallBlock.vue";
import type { ActiveToolRun } from "@/shared/types";

const props = defineProps<{
  tool: ActiveToolRun;
}>();
</script>

<template>
  <ToolCallBlock
    :name="props.tool.toolName"
    :arguments="props.tool.args"
    :result-blocks="props.tool.blocks"
    :result-details="props.tool.details"
    :status="props.tool.isError ? 'error' : 'running'"
    compact
  />
</template>

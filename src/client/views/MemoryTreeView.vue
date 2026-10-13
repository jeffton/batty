<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ByteCache } from "@/shared/byte-cache";
import { getMemoryTree, expandMemoryNode } from "@/client/lib/api";
import type { MemoryTreeNode, MemoryTreeOverview, MemoryTreeExpansion } from "@/shared/memory-tree";

defineProps<{ embedded?: boolean }>();

const overview = ref<MemoryTreeOverview>();
const path = ref<MemoryTreeNode[]>([]);
const expansion = ref<MemoryTreeExpansion>();
const loading = ref(false);
const error = ref("");
const cache = new ByteCache<MemoryTreeExpansion>(
  512 * 1024,
  (value) => new TextEncoder().encode(JSON.stringify(value)).length,
);
const heading = ref<HTMLElement>();
const container = ref<HTMLElement>();

function date(value: string) {
  return new Date(value).toLocaleString();
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    overview.value = await getMemoryTree();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    loading.value = false;
  }
}
async function open(node: MemoryTreeNode) {
  loading.value = true;
  error.value = "";
  try {
    const key = `${node.id}+${node.count}`;
    const result = cache.get(key) ?? (await expandMemoryNode(node.id, node.count));
    cache.set(key, result);
    path.value.push(node);
    expansion.value = result;
    heading.value?.focus();
    container.value?.scrollTo(0, 0);
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    loading.value = false;
  }
}
async function back(depth: number) {
  loading.value = true;
  error.value = "";
  try {
    const next = path.value.slice(0, depth);
    const node = next.at(-1);
    let result: MemoryTreeExpansion | undefined;
    if (node) {
      const key = `${node.id}+${node.count}`;
      result = cache.get(key) ?? (await expandMemoryNode(node.id, node.count));
      cache.set(key, result);
    }
    path.value = next;
    expansion.value = result;
    heading.value?.focus();
    container.value?.scrollTo(0, 0);
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<template>
  <main ref="container" class="memory-tree" :aria-busy="loading">
    <header>
      <RouterLink v-if="!embedded" to="/">Back to chat</RouterLink>
      <h1 v-if="!embedded" ref="heading" tabindex="-1">Memory tree</h1>
      <p v-if="overview">
        {{ overview.prepared.toLocaleString() }} prepared messages ·
        {{ overview.total.toLocaleString() }} indexed
      </p>
    </header>
    <nav aria-label="Memory breadcrumbs">
      <button type="button" :disabled="loading || !path.length" @click="back(0)">Overview</button>
      <button
        v-for="(node, index) in path"
        :key="`${node.id}+${node.count}`"
        type="button"
        :disabled="loading || index === path.length - 1"
        @click="back(index + 1)"
      >
        {{ node.id }}+{{ node.count }}
      </button>
    </nav>
    <div v-if="path.length" class="tree-controls">
      <button type="button" :disabled="loading" @click="back(path.length - 1)">
        Back / collapse
      </button>
    </div>
    <p v-if="loading" role="status">Loading…</p>
    <div v-if="error" role="alert">
      <p>{{ error }}</p>
      <button v-if="!overview" type="button" :disabled="loading" @click="load">Retry</button>
    </div>
    <section v-if="path.length" class="selected-node" aria-label="Selected node">
      <h2>{{ path.at(-1)!.id }}+{{ path.at(-1)!.count }}</h2>
      <p>{{ path.at(-1)!.summary }}</p>
    </section>
    <section
      v-if="expansion?.text !== undefined"
      aria-label="Original message"
      class="original-message"
    >
      <h2>Original message</h2>
      <pre>{{ expansion.text }}</pre>
    </section>
    <section v-else aria-label="Memory nodes" class="nodes">
      <p v-if="overview && !overview.nodes.length">No prepared memory yet.</p>
      <button
        v-for="node in expansion?.children ?? overview?.nodes ?? []"
        :key="`${node.id}+${node.count}`"
        type="button"
        class="node"
        :disabled="loading"
        @click="open(node)"
      >
        <span class="node-title"
          >{{ node.id }}+{{ node.count }} · {{ node.count.toLocaleString() }} messages</span
        >
        <span class="node-meta"
          >IDs {{ node.id }}–{{ node.id + node.count - 1 }} ·
          {{ node.bytes.toLocaleString() }} summary bytes</span
        >
        <span class="node-meta"
          >{{ date(node.startDate)
          }}<template v-if="node.count > 1"> – {{ date(node.endDate) }}</template></span
        >
        <span class="node-summary">{{ node.summary }}</span>
        <span class="node-action"
          >{{ node.count === 1 ? "Read original" : "Open two children" }} →</span
        >
      </button>
    </section>
  </main>
</template>

<style scoped>
.memory-tree {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  max-width: 900px;
  margin: 0 auto;
  padding: 16px;
  overflow-y: auto;
}
header a,
nav button,
.tree-controls button,
[role="alert"] button {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 8px 12px;
}
h1 {
  font-size: 1.6rem;
  margin: 12px 0;
}
h2 {
  font-size: 1.1rem;
}
nav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 16px 0;
}
.nodes {
  display: grid;
  gap: 12px;
}
.node {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  height: auto;
  text-align: left;
  padding: 16px;
  border: 1px solid currentColor;
  border-radius: 12px;
  background: transparent;
  color: inherit;
}
.node-meta {
  font-size: 0.9rem;
  opacity: 0.75;
}
.node-summary,
.selected-node p,
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.node-action {
  font-size: 0.9rem;
  text-decoration: underline;
}
.selected-node,
.original-message {
  margin: 16px 0;
}
pre {
  font: inherit;
  line-height: 1.5;
}
button:not(:disabled) {
  cursor: pointer;
}
</style>

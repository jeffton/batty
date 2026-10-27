<script setup lang="ts">
import ChatMessage from "./ChatMessage.vue";
import DeleteButton from "./DeleteButton.vue";
import ModelConfigPopover from "./ModelConfigPopover.vue";
import ProviderUsageIndicator from "./ProviderUsageIndicator.vue";
import TasksControl from "./TasksControl.vue";
import type { UiMessage } from "@/shared/types";
import "@/client/styles.css";
const artifacts = {
  sentFiles: [
    {
      id: "f",
      name: "Cabin.jpg",
      size: 123,
      mimeType: "image/jpeg",
      kind: "image" as const,
      downloadUrl: "/fixture.jpg",
      previewUrl: "/fixture.jpg",
    },
    {
      id: "document",
      name: "Report.pdf",
      size: 456,
      mimeType: "application/pdf",
      kind: "file" as const,
      downloadUrl: "/fixture.pdf",
    },
    {
      id: "video",
      name: "Wildlife.mp4",
      size: 789,
      mimeType: "video/mp4",
      kind: "video" as const,
      downloadUrl: "/fixture.mp4",
      previewUrl: "/fixture.mp4",
    },
  ],
  sites: [
    {
      kind: "site" as const,
      id: "s",
      name: "Morning report",
      url: "https://example.com/report",
      public: false as const,
    },
  ],
  fileChanges: [
    { path: "hello.ts", patch: "--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1 @@\n-before\n+after\n" },
  ],
};
const messages: UiMessage[] = ["cron", "subagent"].map((kind) => ({
  role: "custom",
  id: kind,
  timestamp: 0,
  customType: `batty-runtime-notice:${kind}`,
  text: "Report",
  data: {
    runtimeNotice: { text: `${kind} result`, markdown: "Cabin attached. `inline code`" },
    runtimeResultArtifacts: artifacts,
    [kind]: { sessionId: "42", runId: kind },
  },
}));
messages.push({
  role: "assistant",
  id: "ordinary",
  timestamp: 0,
  turnPhase: "final",
  blocks: [{ type: "text", text: "Ordinary reply `inline code`" }],
  ...artifacts,
});
messages.push({
  role: "custom",
  id: "worker-input",
  timestamp: 0,
  customType: "batty-runtime-notice:subagent",
  text: "Inspect the attached files",
  data: {
    inputFiles: [{ ...artifacts.sentFiles[1], id: "input-document", name: "Input evidence.pdf" }],
  },
});
</script>
<template>
  <nav>
    <DeleteButton label="Delete fixture" />
    <button popovertarget="fixture-model" style="anchor-name: --fixture-model">Choose model</button>
    <ModelConfigPopover
      popover-id="fixture-model"
      anchor-name="--fixture-model"
      :models="[]"
      current-thinking-level="medium"
      :thinking-options="[]"
    />
    <ProviderUsageIndicator
      model="fixture/model"
      :update="{ provider: 'fixture', error: 'Fixture usage unavailable' }"
    />
  </nav>
  <main style="padding: 12px; max-width: 800px; height: 100vh; overflow-y: auto">
    <ChatMessage
      v-for="message in messages"
      :key="message.id"
      :message="message"
      :allow-session-popovers="true"
    />
  </main>
  <footer
    style="position: fixed; z-index: 10; bottom: 0; right: 8px; display: flex; align-items: center"
  >
    <TasksControl :subagents="[]" :cron-runs="[]" :memory-pending="3" />
    <button popovertarget="fixture-footer-model" style="min-width: 44px; min-height: 44px">
      Footer model
    </button>
    <ModelConfigPopover
      popover-id="fixture-footer-model"
      anchor-name="--fixture-footer-model"
      placement="up"
      :models="[{ id: 'fixture/model', label: 'Fixture', provider: 'fixture' }]"
      current-thinking-level="medium"
      :thinking-options="['low', 'medium', 'high']"
    />
  </footer>
</template>

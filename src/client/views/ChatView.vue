<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import ChatMessage from "@/client/components/ChatMessage.vue";
import MessageComposer from "@/client/components/MessageComposer.vue";
import SessionSidebar from "@/client/components/SessionSidebar.vue";
import ToolRunCard from "@/client/components/ToolRunCard.vue";
import { useAppStore } from "@/client/stores/app";

const store = useAppStore();
const transcript = ref<HTMLElement>();
const modelId = computed({
  get: () => store.activeSession?.model ?? "",
  set: (value: string) => {
    if (value) {
      void store.setModel(value);
    }
  },
});

const connectionClass = computed(() => `status-${store.connectionState}`);

async function scrollToBottom(behavior: ScrollBehavior = "auto"): Promise<void> {
  await nextTick();
  transcript.value?.scrollTo({ top: transcript.value.scrollHeight, behavior });
}

watch(
  () => store.activeSession,
  (current, previous) => {
    const openedSession = current?.id !== previous?.id;
    void scrollToBottom(openedSession ? "auto" : current?.isStreaming ? "auto" : "smooth");
  },
  { deep: true },
);
</script>

<template>
  <main class="chat-view">
    <SessionSidebar />
    <section class="chat-main">
      <header class="chat-main__header panel">
        <button class="chat-main__menu" @click="store.mobileSidebarOpen = true">☰</button>
        <div class="chat-main__heading">
          <h2>{{ store.selectedWorkspace?.label || "Choose a workspace" }}</h2>
          <p class="muted">
            {{ store.activeSession?.cwd || "Pick a folder and start a session." }}
          </p>
        </div>
        <div class="chat-main__toolbar">
          <span :class="['pill', connectionClass]">{{ store.connectionState }}</span>
          <select v-model="modelId" class="chat-main__select" :disabled="!store.activeSession">
            <option value="">Select model</option>
            <option v-for="model in store.models" :key="model.id" :value="model.id">
              {{ model.label }}
            </option>
          </select>
          <button class="chat-main__logout" @click="store.logout">Logout</button>
        </div>
      </header>

      <div v-if="!store.activeSession" class="chat-main__empty panel">
        <h3>No active session yet</h3>
        <p class="muted">
          Pick a workspace on the left, then start a fresh session or resume one of the recent
          sessions.
        </p>
      </div>

      <template v-else>
        <section ref="transcript" class="chat-main__transcript panel">
          <ChatMessage
            v-for="message in store.activeSession.messages"
            :key="message.id"
            :message="message"
          />
          <ToolRunCard
            v-for="tool in store.activeSession.activeTools"
            :key="tool.toolCallId"
            :tool="tool"
          />
          <ChatMessage
            v-if="store.activeSession.activeAssistant"
            :message="store.activeSession.activeAssistant"
          />
        </section>

        <MessageComposer
          :streaming="store.activeSession.isStreaming"
          @submit="(text, files) => store.sendPrompt(text, files)"
          @steer="(text, files) => store.steerPrompt(text, files)"
        />
      </template>
    </section>
  </main>
</template>

<style scoped>
.chat-view {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(17rem, 19rem) minmax(0, 1fr);
  gap: 0.75rem;
  padding: 0.75rem;
  overflow: hidden;
}

.chat-main {
  min-width: 0;
  min-height: 0;
  display: grid;
  gap: 0.75rem;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
}

.chat-main__header {
  min-width: 0;
  padding: 0.75rem 0.9rem;
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
}

.chat-main__heading {
  min-width: 0;
  display: grid;
  gap: 0.15rem;
}

.chat-main__header h2,
.chat-main__header p,
.chat-main__empty h3,
.chat-main__empty p {
  margin: 0;
}

.chat-main__header h2 {
  font-size: 1rem;
}

.chat-main__heading p {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-main__toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.chat-main__select,
.chat-main__logout,
.chat-main__menu {
  border-radius: 0.55rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(22, 27, 34, 0.95);
  color: inherit;
  padding: 0.55rem 0.75rem;
}

.chat-main__logout {
  background: rgba(127, 29, 29, 0.18);
}

.chat-main__menu {
  display: none;
}

.chat-main__empty {
  min-height: 0;
  padding: 1.25rem;
  display: grid;
  align-content: center;
  gap: 0.5rem;
}

.chat-main__transcript {
  min-height: 0;
  overflow: auto;
  padding: 0.85rem;
  display: grid;
  gap: 0.75rem;
  align-content: start;
  scroll-padding-bottom: 0.75rem;
}

@media (max-width: 900px) {
  .chat-view {
    grid-template-columns: 1fr;
    padding: 0.5rem;
  }

  .chat-main__header {
    align-items: start;
    flex-wrap: wrap;
  }

  .chat-main__menu {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .chat-main__toolbar {
    width: 100%;
  }
}
</style>

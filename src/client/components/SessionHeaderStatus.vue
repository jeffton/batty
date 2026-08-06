<script setup lang="ts">
import { LoaderCircle, Wifi, WifiOff } from "@lucide/vue";
import { computed } from "vue";
import { formatTokenCount } from "@/client/lib/formatting";

const props = defineProps<{
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  connectionState: "online" | "connecting" | "offline";
}>();

const connectionDescription = computed(() => {
  switch (props.connectionState) {
    case "online":
      return "Connected";
    case "connecting":
      return "Connecting";
    default:
      return "Offline";
  }
});
const contextUsageLabel = computed(() => {
  const tokensLabel = props.contextTokens == null ? "?" : formatTokenCount(props.contextTokens);
  const windowLabel = props.contextWindow == null ? "?" : formatTokenCount(props.contextWindow);
  const percentLabel = props.contextPercent == null ? "?" : `${props.contextPercent.toFixed(1)}%`;

  return `ctx ${tokensLabel}/${windowLabel} · ${percentLabel}`;
});
const contextPercentValue = computed(() => {
  if (typeof props.contextPercent !== "number" || !Number.isFinite(props.contextPercent)) {
    return 0;
  }
  return Math.min(100, Math.max(0, props.contextPercent));
});
const contextArcStyle = computed(() => {
  const radius = 15.9155;
  const circumference = 2 * Math.PI * radius;
  const progress = circumference * (contextPercentValue.value / 100);

  return {
    strokeDasharray: `${progress} ${circumference}`,
    strokeDashoffset: "0",
  };
});
const contextArcClass = computed(() => {
  if (contextPercentValue.value >= 90) {
    return "session-header-status__context-arc--danger";
  }
  if (contextPercentValue.value >= 70) {
    return "session-header-status__context-arc--warn";
  }
  return "session-header-status__context-arc--good";
});
</script>

<template>
  <div class="session-header-status">
    <div
      class="session-header-status__context"
      :aria-label="contextUsageLabel"
      :title="contextUsageLabel"
    >
      <svg class="session-header-status__context-chart" viewBox="0 0 36 36" aria-hidden="true">
        <circle class="session-header-status__context-track" cx="18" cy="18" r="15.9155" />
        <circle
          :class="['session-header-status__context-arc', contextArcClass]"
          :style="contextArcStyle"
          cx="18"
          cy="18"
          r="15.9155"
        />
      </svg>
    </div>

    <span
      class="session-header-status__connection"
      :aria-label="connectionDescription"
      :title="connectionDescription"
    >
      <Wifi
        v-if="props.connectionState === 'online'"
        :size="15"
        class="session-header-status__connection-icon--online"
      />
      <LoaderCircle
        v-else-if="props.connectionState === 'connecting'"
        :size="15"
        class="session-header-status__connection-icon--connecting session-header-status__connection-icon--spin"
      />
      <WifiOff v-else :size="15" class="session-header-status__connection-icon--offline" />
    </span>
  </div>
</template>

<style scoped>
.session-header-status {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
}

.session-header-status__context,
.session-header-status__connection {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  flex-shrink: 0;
}

.session-header-status__context-chart {
  width: 1.15rem;
  height: 1.15rem;
  transform: rotate(-90deg);
}

.session-header-status__context-track,
.session-header-status__context-arc {
  fill: none;
  stroke-width: 3.2;
}

.session-header-status__context-track {
  stroke: var(--color-border-soft);
}

.session-header-status__context-arc {
  stroke-linecap: round;
  transition:
    stroke-dasharray 180ms ease,
    stroke 180ms ease;
}

.session-header-status__context-arc--good,
.session-header-status__connection-icon--online {
  stroke: var(--color-success);
  color: var(--color-success);
}

.session-header-status__context-arc--warn {
  stroke: var(--color-warning);
}

.session-header-status__context-arc--danger {
  stroke: var(--color-error);
}

.session-header-status__connection-icon--connecting {
  color: var(--color-text-subtle);
}

.session-header-status__connection-icon--offline {
  color: var(--color-warning);
}

.session-header-status__connection-icon--spin {
  animation: session-header-status-spin 0.9s linear infinite;
}

@keyframes session-header-status-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import sleepingLogo from "@/client/assets/logo-sleeping.png";
import {
  isWithinWorkingHours,
  workingHoursDateKey,
  type WorkingHours,
} from "@/shared/working-hours";

const props = defineProps<{ schedule?: WorkingHours }>();
const now = ref(new Date());
const overrideDay = ref<string>();
const heading = ref<HTMLHeadingElement>();
const day = computed(() =>
  props.schedule ? workingHoursDateKey(props.schedule, now.value) : undefined,
);
const blocked = computed(
  () =>
    !isWithinWorkingHours(props.schedule, now.value) &&
    (overrideDay.value === undefined || overrideDay.value !== day.value),
);
let timer: ReturnType<typeof setTimeout> | undefined;

function checkClock() {
  now.value = new Date();
  if (overrideDay.value !== day.value) overrideDay.value = undefined;
  clearTimeout(timer);
  // Every boundary is a local minute boundary, including midnight. Align rather
  // than drifting from mount time; resume events cover suspended browser tabs.
  timer = setTimeout(checkClock, 60_000 - (Date.now() % 60_000));
}
function override() {
  checkClock();
  overrideDay.value = day.value;
}
watch(
  () => {
    const schedule = props.schedule;
    return schedule
      ? JSON.stringify([
          schedule.timeZone,
          [...schedule.days].sort((a, b) => a - b),
          schedule.start,
          schedule.end,
        ])
      : undefined;
  },
  () => {
    overrideDay.value = undefined;
  },
);
watch(blocked, async (value) => {
  if (value) {
    await nextTick();
    heading.value?.focus();
  }
});
onMounted(() => {
  checkClock();
  document.addEventListener("visibilitychange", checkClock);
  window.addEventListener("pageshow", checkClock);
  window.addEventListener("focus", checkClock);
});
onUnmounted(() => {
  clearTimeout(timer);
  document.removeEventListener("visibilitychange", checkClock);
  window.removeEventListener("pageshow", checkClock);
  window.removeEventListener("focus", checkClock);
});
</script>

<template>
  <main v-if="blocked" class="working-hours-rest" aria-labelledby="working-hours-title">
    <div class="working-hours-scene" aria-hidden="true">
      <svg class="working-hours-moon" viewBox="0 0 48 48">
        <path d="M36 4a22 22 0 1 0 8 32A24 24 0 0 1 36 4Z" />
      </svg>
      <img class="working-hours-logo" :src="sleepingLogo" alt="" width="512" height="512" />
      <span class="working-hours-zzz"><span>z</span><span>z</span><span>z</span></span>
    </div>
    <h1 id="working-hours-title" ref="heading" tabindex="-1">Off the clock.</h1>
    <p>Batty can wait.</p>
    <button type="button" class="chrome-button working-hours-override" @click="override">
      Open anyway
    </button>
  </main>
  <!-- Unmount the entire app, including its Teleports and global shortcuts. -->
  <slot v-else />
</template>

<style scoped>
.working-hours-rest {
  min-height: 100dvh;
  padding: max(2rem, env(safe-area-inset-top)) max(1.5rem, env(safe-area-inset-right))
    max(2rem, env(safe-area-inset-bottom)) max(1.5rem, env(safe-area-inset-left));
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--color-text);
  background: var(--color-bg-app);
}
.working-hours-scene {
  width: 11rem;
  height: 10rem;
  position: relative;
  margin-bottom: 1.25rem;
}
.working-hours-moon {
  position: absolute;
  top: 0;
  right: 0.25rem;
  width: 3rem;
  height: 3rem;
  fill: #e8d9a3;
  filter: drop-shadow(0 0 0.8rem #e8d9a31c);
}
.working-hours-logo {
  position: absolute;
  bottom: 0;
  left: 1.75rem;
  width: 7.5rem;
  height: 7.5rem;
  transform: rotate(-6deg);
}
.working-hours-zzz {
  position: absolute;
  top: 0.75rem;
  left: 0;
  width: 2rem;
  height: 3rem;
  color: var(--color-text-muted);
}
.working-hours-zzz span {
  position: absolute;
  line-height: 1;
}
.working-hours-zzz span:nth-child(1) {
  top: 2.5rem;
  left: 1.3rem;
  font-size: 0.65rem;
  transform: rotate(8deg);
}
.working-hours-zzz span:nth-child(2) {
  top: 1.5rem;
  left: 0.65rem;
  font-size: 0.8rem;
  transform: rotate(-12deg);
}
.working-hours-zzz span:nth-child(3) {
  top: 0.4rem;
  left: 0.15rem;
  font-size: 1rem;
  transform: rotate(-5deg);
}
.working-hours-rest h1 {
  margin: 0;
  font-size: 1.6rem;
  font-weight: 600;
  outline: none;
}
.working-hours-rest p {
  margin: 0.5rem 0 2rem;
  color: var(--color-text-muted);
}
.working-hours-override {
  --chrome-button-ink: var(--color-text-muted);
  --chrome-button-hover: var(--color-bg-panel);
  --chrome-button-active: var(--color-bg-hover);
  font-size: 0.875rem;
}
.working-hours-override:focus-visible {
  outline-color: var(--color-text-muted);
}
</style>

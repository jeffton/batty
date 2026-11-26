<script setup lang="ts">
import { ExternalLink } from "@lucide/vue";
import BrowserPopover from "@/client/components/BrowserPopover.vue";
import SitePopover from "@/client/components/SitePopover.vue";
import { confirmedSitePublic } from "@/client/lib/site-visibility";
import type { SiteAttachmentDescriptor } from "@/shared/types";

const props = defineProps<{ sites: SiteAttachmentDescriptor[]; idPrefix?: string }>();

function popoverId(siteId: string): string {
  return `site-preview-${props.idPrefix ?? ""}-${siteId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}
</script>

<template>
  <div class="shared-sites">
    <article v-for="site in props.sites" :key="site.id" class="shared-sites__card">
      <div class="shared-sites__meta">
        <strong>{{ site.name }}</strong>
        <span v-if="site.kind === 'browser'">Cloud browser</span>
        <span v-else>{{
          (confirmedSitePublic(site.id) ?? site.public) ? "Public site" : "Private site"
        }}</span>
      </div>
      <button type="button" class="shared-sites__open" :popovertarget="popoverId(site.id)">
        <ExternalLink :size="15" />
        {{ site.kind === "browser" ? "Open browser" : "Open site" }}
      </button>

      <BrowserPopover
        v-if="site.kind === 'browser'"
        :popover-id="popoverId(site.id)"
        :browser-id="site.browserId"
        :title="site.name"
      />
      <SitePopover v-else :popover-id="popoverId(site.id)" :site="site" />
    </article>
  </div>
</template>

<style scoped>
.shared-sites {
  display: grid;
  clear: both;
  width: 100%;
  min-width: 0;
  gap: 0.6rem;
}

.shared-sites__card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 0.65rem;
  background: var(--color-bg-panel);
}

.shared-sites__meta {
  display: grid;
  flex: 1 1 8rem;
  gap: 0.1rem;
  min-width: 0;
  margin-right: auto;
}

.shared-sites__meta strong {
  overflow-wrap: anywhere;
}

.shared-sites__meta span {
  color: var(--color-text-muted);
  font-size: 0.82rem;
}

.shared-sites__open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  padding: 0.35rem 0.65rem;
  border: 1px solid var(--color-border-soft);
  border-radius: 0.5rem;
  background: var(--color-bg-panel);
  color: var(--color-text);
  font-family: inherit;
  cursor: pointer;
}

.shared-sites__open {
  flex: 0 0 auto;
  margin-left: auto;
  white-space: nowrap;
}

@media (hover: hover) {
  .shared-sites__open:hover {
    background: var(--color-bg-elevated-soft);
  }
}
</style>

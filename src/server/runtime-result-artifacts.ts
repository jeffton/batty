import type { EntryRecord } from "@earendil-works/pi-durable";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { AgentTurnArtifacts, DurableFileChange } from "./agent-turn-file-changes";
import type { SentFileDescriptor, SiteAttachmentDescriptor } from "@/shared/types";
import { artifactRefs, mergeResponseArtifacts } from "./artifact-forwarding";
import { decodeRuntimeNotice } from "./runtime-notices";
import { decodeSiteAttachmentDescriptor } from "./site-attachments";

export type RuntimeResultArtifacts = AgentTurnArtifacts & {
  battyFileChanges?: DurableFileChange[];
  forwardedArtifacts?: AgentTurnArtifacts;
};

/** Only the answered input's own transcript contributes report artifacts. */
export function runtimeResultArtifacts(entries: readonly EntryRecord[]): RuntimeResultArtifacts {
  const files = new Map<string, SentFileDescriptor>();
  const sites = new Map<string, SiteAttachmentDescriptor>();
  const changes = new Map<string, DurableFileChange>();
  const mutations: DurableFileChange[] = [];
  const mutationKeys = new Set<string>();
  const deliveredChanges = new Map<
    string,
    NonNullable<AgentTurnArtifacts["fileChanges"]>[number]
  >();
  const add = (details: RuntimeResultArtifacts | undefined) => {
    for (const file of details?.sentFiles ?? []) files.set(file.id, file);
    for (const site of details?.sites ?? [])
      sites.set(site.id, decodeSiteAttachmentDescriptor(site));
    // Saved diffs are immutable artifacts, not mutation snapshots. Only local
    // snapshots are aggregated; forwarded patches never enter that calculation.
    const saved = mergeResponseArtifacts(details?.forwardedArtifacts ?? {}, {
      fileChanges: (details?.fileChanges ?? []).filter(
        (change) => !details?.battyFileChanges?.some((snapshot) => snapshot.path === change.path),
      ),
    });
    for (const item of artifactRefs(saved)) {
      if (item.kind === "diff") deliveredChanges.set(item.ref, item.value);
    }
    for (const change of details?.battyFileChanges ?? []) {
      const key = `${change.path}:${change.order}`;
      if (change.order !== undefined && mutationKeys.has(key)) continue;
      mutationKeys.add(key);
      mutations.push(change);
    }
  };
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "user") {
        const notice = decodeRuntimeNotice(message.content);
        add(notice?.data?.runtimeResultArtifacts as RuntimeResultArtifacts | undefined);
      }
      if (message.role === "toolResult") add(message.details as RuntimeResultArtifacts | undefined);
    }
  }
  // Child reports can arrive after later parent edits. Keep raw snapshots across
  // nesting so interleaved mutations remain sortable, rather than flattening ranges.
  mutations.sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  for (const change of mutations) {
    const first = changes.get(change.path);
    changes.set(change.path, { ...change, before: first ? first.before : change.before });
  }
  const immutableDiffs = [...deliveredChanges.values()];
  for (const change of changes.values()) {
    if (change.before !== change.after) {
      const diff = {
        path: change.path,
        patch: generateUnifiedPatch(change.path, change.before ?? "", change.after),
      };
      deliveredChanges.set(artifactRefs({ fileChanges: [diff] })[0]!.ref, diff);
    }
  }
  return {
    ...(files.size ? { sentFiles: [...files.values()] } : {}),
    ...(sites.size ? { sites: [...sites.values()] } : {}),
    ...(mutations.length ? { battyFileChanges: mutations } : {}),
    ...(mutations.length && immutableDiffs.length
      ? { forwardedArtifacts: { fileChanges: immutableDiffs } }
      : {}),
    ...(deliveredChanges.size ? { fileChanges: [...deliveredChanges.values()] } : {}),
  };
}

import { createHash } from "node:crypto";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { DurableFileChange } from "./agent-turn-file-changes";
import type { MessagePresentation as AgentTurnArtifacts } from "./message-presentation";
import type { SentFileDescriptor, SiteAttachmentDescriptor } from "@/shared/types";
import { decodeRuntimeNotice } from "./runtime-notices";
import { decodeSiteAttachmentDescriptor } from "./site-attachments";

function artifactRefs(artifacts: AgentTurnArtifacts = {}) {
  return [
    ...(artifacts.sentFiles ?? []).map((file) => ({ kind: "file" as const, value: file })),
    ...(artifacts.fileChanges ?? []).map((diff) => ({ kind: "diff" as const, value: diff })),
    ...(artifacts.sites ?? []).map(decodeSiteAttachmentDescriptor).map((site) => ({
      kind: site.kind,
      value: site,
    })),
  ].map((item) => ({
    ...item,
    // A discriminator does not create a new version of an existing attachment.
    ref: `${item.kind}:${createHash("sha256")
      .update(
        JSON.stringify(
          item.kind === "site" || item.kind === "browser"
            ? Object.fromEntries(Object.entries(item.value).filter(([key]) => key !== "kind"))
            : item.value,
        ),
      )
      .digest("hex")}`,
  }));
}

type ArtifactReferences = AgentTurnArtifacts & { referencedArtifacts?: AgentTurnArtifacts };
type ArtifactToolResult = ArtifactReferences & {
  action?: string;
  forwardedArtifacts?: AgentTurnArtifacts;
};
type ArtifactDetails = ArtifactToolResult & {
  calls?: Array<ArtifactToolResult & { name?: string; details?: ArtifactToolResult }>;
};

export function mergeResponseArtifacts(...sources: AgentTurnArtifacts[]): AgentTurnArtifacts {
  const unique = new Map(
    sources.flatMap((source) => artifactRefs(source)).map((item) => [item.ref, item]),
  );
  const items = [...unique.values()];
  const fileChanges = items.flatMap((item) => (item.kind === "diff" ? [item.value] : []));
  const sites = items.flatMap((item) =>
    item.kind === "site" || item.kind === "browser" ? [item.value] : [],
  );
  const sentFiles = items.flatMap((item) => (item.kind === "file" ? [item.value] : []));
  return {
    ...(fileChanges.length ? { fileChanges } : {}),
    ...(sites.length ? { sites } : {}),
    ...(sentFiles.length ? { sentFiles } : {}),
  };
}

function forwardedResponseArtifacts(
  messages: readonly NonNullable<EntryRecord["model"]>[number][],
): AgentTurnArtifacts[] {
  const sources: AgentTurnArtifacts[] = [];
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const details = message.details as ArtifactDetails | undefined;
    if (details?.forwardedArtifacts) sources.push(details.forwardedArtifacts);
    if (message.toolName === "codemode") {
      for (const call of details?.calls ?? []) {
        const forwarded = (call.details ?? call).forwardedArtifacts;
        if (forwarded) sources.push(forwarded);
      }
    }
  }
  return sources;
}

export function legacyNativeCarrier(
  message: NonNullable<EntryRecord["model"]>[number],
): AgentTurnArtifacts | undefined {
  if (message.role !== "toolResult") return;
  const details = message.details as ArtifactDetails | undefined;
  if (message.toolName === "codemode") {
    const native =
      details?.calls?.filter(({ name }) => name === "attach_files" || name === "sites") ?? [];
    const sentFiles = native.flatMap((call) => call.sentFiles ?? []);
    const sites = native.flatMap((call) => call.sites ?? []);
    if (sentFiles.length || sites.length) return { sentFiles, sites };
  }
  if (message.isError) return;
  if (message.toolName === "attach_files" && details?.sentFiles?.length)
    return { sentFiles: details.sentFiles };
  if (message.toolName === "sites" && details?.sites?.length) return { sites: details.sites };
}

export function legacyReplySources(messages: readonly NonNullable<EntryRecord["model"]>[number][]) {
  const owned = messages.flatMap((message) => {
    if (message.role !== "toolResult" || (message.isError && message.toolName !== "codemode"))
      return [];
    const details = message.details as ArtifactDetails | undefined;
    const owned =
      message.toolName === "codemode"
        ? (details?.calls ?? []).map((call) => ({
            name: call.name,
            artifacts: call.details ?? call,
          }))
        : [{ name: message.toolName, artifacts: details }];
    return owned.flatMap(({ name, artifacts }): AgentTurnArtifacts[] => {
      if (name === "attach_files" || name === "sites")
        return [{ sentFiles: artifacts?.sentFiles, sites: artifacts?.sites }];
      if (name === "browser")
        return [
          {
            sites: (artifacts?.sites ?? [])
              .map(decodeSiteAttachmentDescriptor)
              .filter((site) => site.kind === "browser"),
          },
        ];
      return [];
    });
  });
  return { forwarded: forwardedResponseArtifacts(messages), owned };
}

type RuntimeResultArtifacts = AgentTurnArtifacts & {
  battyFileChanges?: DurableFileChange[];
  forwardedArtifacts?: AgentTurnArtifacts;
  reportAttachments?: AgentTurnArtifacts;
};

type HistoricalCodemodeCall = {
  name?: string;
  args?: string;
  details?: RuntimeResultArtifacts;
};

function isHistoricalInspection(call: HistoricalCodemodeCall): boolean {
  if (call.name !== "subagent" || !call.args || !call.details) return false;
  const { sentFiles, sites, fileChanges, battyFileChanges } = call.details;
  if (!sentFiles && !sites && !fileChanges && !battyFileChanges) return false;
  try {
    return (JSON.parse(call.args) as { action?: string } | null)?.action === "inspect";
  } catch {
    return false;
  }
}

/** Only the assignment's own effects and child deliveries contribute report artifacts. */
export function legacyRuntimeResultArtifacts(
  entries: readonly EntryRecord[],
): RuntimeResultArtifacts {
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
  const inspections = new Set<string>();
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "assistant") {
        for (const block of message.content)
          if (
            block.type === "toolCall" &&
            block.name === "subagent" &&
            block.arguments?.action === "inspect"
          )
            inspections.add(block.id);
      }
      if (message.role === "user") {
        const notice = decodeRuntimeNotice(message.content);
        add(notice?.data?.runtimeResultArtifacts as RuntimeResultArtifacts | undefined);
      }
      if (message.role !== "toolResult" || inspections.has(message.toolCallId)) continue;
      const details = message.details as
        | (RuntimeResultArtifacts & { calls?: HistoricalCodemodeCall[] })
        | undefined;
      // Older codemode rows flattened inspected artifacts into the batch's effects.
      // Recover effects from individual calls in affected batches without rewriting history.
      if (message.toolName === "codemode" && details?.calls?.some(isHistoricalInspection)) {
        for (const call of details.calls) if (!isHistoricalInspection(call)) add(call.details);
      } else {
        add(details);
      }
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

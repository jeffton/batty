import { createHash } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type Cursor, type EntryRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentTurnArtifacts } from "./agent-turn-file-changes";
import { decodeRuntimeNotice } from "./runtime-notices";
import { decodeSiteAttachmentDescriptor } from "./site-attachments";

export const ARTIFACT_FORWARDING_INSTRUCTION =
  "Files, diffs, sites and live browsers belong to the execution scope that produced them. To attach selected existing artifacts from a report to your own response, call attach_artifacts with the listed refs. This reuses the original immutable descriptors, including file IDs, diff contents and live browser handles, without copying files or opening another browser. Forwarded browsers share the same live session, login and expiry; forwarding does not publish them or keep them alive. Use attach_files only to import local files. Links or copied patch text do not forward response metadata. Do not automatically forward every draft. Do not rerun actions or reconstruct diffs.";

export function artifactRefs(artifacts: AgentTurnArtifacts = {}) {
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

export function reportWithArtifacts(text: string, artifacts: AgentTurnArtifacts = {}): string {
  if (artifacts.importErrors?.length)
    text += `\n\nRemote attachment import failed:\n${artifacts.importErrors.join("\n")}`;
  const refs = artifactRefs(artifacts);
  if (!refs.length) return text;
  return [
    text,
    "Existing response artifacts available for explicit forwarding:",
    ...refs.map(({ ref, kind, value }) =>
      JSON.stringify({
        ref,
        kind,
        ...(kind === "diff"
          ? { path: value.path }
          : kind === "file"
            ? { name: value.name, id: value.id, downloadUrl: value.downloadUrl }
            : {
                id: value.id,
                name: value.name,
                url: value.url,
                public: value.public,
                ...(value.kind === "browser" ? { browserId: value.browserId } : {}),
              }),
      }),
    ),
    ARTIFACT_FORWARDING_INSTRUCTION,
  ].join("\n\n");
}

type ArtifactDetails = AgentTurnArtifacts & {
  calls?: Array<AgentTurnArtifacts & { name?: string; details?: AgentTurnArtifacts }>;
};

export function artifactsFromModelMessages(
  messages: readonly NonNullable<EntryRecord["model"]>[number][],
): AgentTurnArtifacts[] {
  return messages.flatMap((message) => {
    if (message.role === "user") {
      const notice = decodeRuntimeNotice(message.content);
      return notice?.data?.runtimeResultArtifacts
        ? [notice.data.runtimeResultArtifacts as AgentTurnArtifacts]
        : [];
    }
    if (message.role !== "toolResult") return [];
    const details = message.details as ArtifactDetails | undefined;
    return [details ?? {}, ...(details?.calls ?? []).map((call) => call.details ?? call)];
  });
}

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

export function forwardedResponseArtifacts(entries: readonly EntryRecord[]): AgentTurnArtifacts {
  const sources: AgentTurnArtifacts[] = [];
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role !== "toolResult") continue;
      const forwarded = (message.details as { forwardedArtifacts?: AgentTurnArtifacts })
        ?.forwardedArtifacts;
      if (forwarded) sources.push(forwarded);
    }
  }
  return mergeResponseArtifacts(...sources);
}

/** Browser tools attach their own live session; received reports still require explicit forwarding. */
export function responseArtifacts(entries: readonly EntryRecord[]): AgentTurnArtifacts {
  const browsers = entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) => {
      if (message.role !== "toolResult") return [];
      const details = message.details as ArtifactDetails | undefined;
      const owned =
        message.toolName === "browser"
          ? [details]
          : message.toolName === "codemode"
            ? (details?.calls ?? [])
                .filter((call) => call.name === "browser")
                .map((call) => call.details ?? call)
            : [];
      return owned.flatMap((artifacts) =>
        (artifacts?.sites ?? [])
          .map(decodeSiteAttachmentDescriptor)
          .filter((site) => site.kind === "browser"),
      );
    }),
  );
  return mergeResponseArtifacts(forwardedResponseArtifacts(entries), { sites: browsers });
}

export function createAttachArtifactsTool() {
  return defineTool({
    name: "attach_artifacts",
    description: `Attach selected existing files, diffs, sites and live browsers from reports to the current response. ${ARTIFACT_FORWARDING_INSTRUCTION}`,
    parameters: Type.Object(
      {
        refs: Type.Array(Type.String(), {
          minItems: 1,
          description:
            "Stable file/diff/site/browser refs listed in a received report. Only artifacts already present in this conversation can be forwarded.",
        }),
      },
      { additionalProperties: false },
    ),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const wanted = new Set(args.refs);
      const found = new Map<string, ReturnType<typeof artifactRefs>[number]>();
      await api.commit(async (tx) => {
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanEntries({ conversationId: api.conversationId }, 200, cursor);
          for (const entry of page.items) {
            for (const artifacts of artifactsFromModelMessages(entry.model ?? [])) {
              for (const item of artifactRefs(artifacts)) {
                if (wanted.has(item.ref)) found.set(item.ref, item);
              }
            }
          }
          cursor = page.next;
        } while (cursor && found.size < wanted.size);
      }, ctx);
      const missing = [...wanted].filter((ref) => !found.has(ref));
      if (missing.length)
        throw new Error(`Artifact refs not received in this conversation: ${missing.join(", ")}`);
      const selected = [...wanted].map((ref) => found.get(ref)!);
      const fileChanges = selected.flatMap((item) => (item.kind === "diff" ? [item.value] : []));
      const sites = selected.flatMap((item) =>
        item.kind === "site" || item.kind === "browser" ? [item.value] : [],
      );
      const sentFiles = selected.flatMap((item) => (item.kind === "file" ? [item.value] : []));
      return {
        output: [
          {
            type: "text" as const,
            text: `Attached ${selected.length} existing artifacts to this response.`,
          },
        ],
        details: {
          forwardedArtifacts: { fileChanges, sites, ...(sentFiles.length ? { sentFiles } : {}) },
          ...(sentFiles.length ? { sentFiles } : {}),
          ...(fileChanges.length ? { fileChanges } : {}),
          ...(sites.length ? { sites } : {}),
        } as unknown as JsonValue,
      };
    },
  });
}

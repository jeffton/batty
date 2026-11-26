import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentTurnFileChange,
  SentFileDescriptor,
  SiteAttachmentDescriptor,
} from "@/shared/types";
import { fileArtifactRef, siteArtifactRef } from "@/shared/artifacts";
import type { ArtifactResolver } from "./artifact-resolver";
import { decodeSiteAttachmentDescriptor } from "./site-attachments";

export interface MessagePresentation {
  sentFiles?: SentFileDescriptor[];
  sites?: SiteAttachmentDescriptor[];
  fileChanges?: AgentTurnFileChange[];
  importErrors?: string[];
  historical?: true;
}

export type PresentedAssistant = AssistantMessage & { battyPresentation?: MessagePresentation };

export interface AttachmentSelection {
  artifactRefs?: string[];
  browserId?: string;
}

const opener = "\n\n<batty-attachments>";
const closer = "</batty-attachments>";

export const ATTACHMENT_DELIVERY_INSTRUCTION = [
  "Get refs with import_files or sites action=create. Neither sends an attachment.",
  'To attach to this answer (including cron/worker finals), append a blank line then: <batty-attachments>{"artifactRefs":["file:…","site:…"]}</batty-attachments>',
  'For an intermediate report: subagent({action:"report",prompt:"…",artifactRefs:["file:…"]}).',
  "Either accepts browserId for a live browser in this workspace. Only selected files cross installations.",
].join("\n");

function insideFence(text: string) {
  let active: string | undefined;
  for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})(.*)$/gm)) {
    const [, fence, info] = match;
    if (!active) active = fence;
    else if (fence!.startsWith(active) && !info!.trim()) active = undefined;
  }
  return active !== undefined;
}

function envelopeStart(text: string) {
  const start = text.lastIndexOf(opener);
  if (
    start < 0 ||
    text
      .slice(start + opener.length)
      .trimEnd()
      .includes("\n")
  )
    return -1;
  return insideFence(text.slice(0, start)) ? -1 : start;
}

export function attachmentText(text: string) {
  const start = envelopeStart(text);
  if (start !== -1) return text.slice(0, start);
  for (let length = opener.length - 1; length >= 3; length--) {
    if (!text.endsWith(opener.slice(0, length))) continue;
    const body = text.slice(0, -length);
    return insideFence(body) ? text : body;
  }
  return text;
}

function parseSelection(metadata: string): AttachmentSelection {
  if (!metadata.endsWith(closer)) throw new Error("Incomplete message attachment metadata");
  let value: AttachmentSelection;
  try {
    value = JSON.parse(metadata.slice(0, -closer.length));
  } catch {
    throw new Error("Invalid message attachment JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "artifactRefs" && key !== "browserId") ||
    (value.artifactRefs !== undefined &&
      (!Array.isArray(value.artifactRefs) ||
        value.artifactRefs.some((ref) => typeof ref !== "string"))) ||
    (value.browserId !== undefined && typeof value.browserId !== "string")
  )
    throw new Error("Invalid message attachment metadata");
  return value;
}

export function extractSelection(message: AssistantMessage): AttachmentSelection | undefined {
  const part = message.content.findLast((block) => block.type === "text");
  if (!part) return undefined;
  const start = envelopeStart(part.text);
  if (start === -1) return undefined;
  const metadata = part.text.slice(start + opener.length).trimEnd();
  part.text = part.text.slice(0, start);
  return parseSelection(metadata);
}

export async function resolvePresentation(
  resolver: ArtifactResolver,
  { artifactRefs, browserId }: AttachmentSelection,
  browser: (id: string) => Promise<Extract<SiteAttachmentDescriptor, { kind: "browser" }>>,
): Promise<MessagePresentation> {
  const { sentFiles, sites: localSites } = await resolver.resolve(artifactRefs ?? []);
  const sites: SiteAttachmentDescriptor[] = localSites;
  if (browserId) sites.push(await browser(browserId));
  return {
    ...(sentFiles.length ? { sentFiles } : {}),
    ...(sites.length ? { sites } : {}),
  };
}

export function describePresentation(text: string, presentation?: MessagePresentation): string {
  const refs = [
    ...(presentation?.sentFiles ?? []).map((file) =>
      JSON.stringify({ ref: fileArtifactRef(file.id), name: file.name }),
    ),
    ...(presentation?.sites ?? [])
      .map(decodeSiteAttachmentDescriptor)
      .filter((site) => site.kind === "site")
      .map((site) => JSON.stringify({ ref: siteArtifactRef(site.id), name: site.name })),
  ];
  const errors = presentation?.importErrors ?? [];
  return [
    text,
    ...(refs.length ? ["Selected files and local sites:", ...refs] : []),
    ...(errors.length ? ["Remote file import failed:", ...errors] : []),
  ].join("\n");
}

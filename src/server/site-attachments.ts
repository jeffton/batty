import type { SiteAttachmentDescriptor } from "@/shared/types";

/** The stored descriptor predates the domain discriminator; storage is immutable. */
type StoredSiteAttachmentDescriptor =
  | SiteAttachmentDescriptor
  | {
      id: string;
      name: string;
      url: string;
      public: boolean;
      browserId?: string;
    };

/** Decode immutable storage at the projection boundary, without changing its payload or ref. */
export function decodeSiteAttachmentDescriptor(
  descriptor: StoredSiteAttachmentDescriptor,
): SiteAttachmentDescriptor {
  if ("kind" in descriptor) return descriptor;
  return {
    ...descriptor,
    kind: descriptor.browserId === undefined ? "site" : "browser",
  } as SiteAttachmentDescriptor;
}

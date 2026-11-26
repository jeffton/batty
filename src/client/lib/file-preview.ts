import type { SentFileDescriptor } from "@/shared/types";

export function fileThumbnailUrl(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}preview=1`;
}

export function imageViewerUrl(file: SentFileDescriptor, url: string): string {
  return file.mimeType === "image/svg+xml" ? fileThumbnailUrl(url) : url;
}

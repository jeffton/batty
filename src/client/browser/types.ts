import type { CloudBrowserFrame } from "@/shared/cloud-browser";

export type RemoteFrame = Omit<CloudBrowserFrame, "image"> & { frameId: number };
export type Point = { x: number; y: number };

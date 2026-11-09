export type WorkspaceFileSearchEvent =
  | { kind: "match"; path: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

export interface WorkspaceFileEntry {
  path: string;
  kind: "directory" | "file";
}

export type WorkspaceFilesResponse =
  | { kind: "directory"; path: string; entries: WorkspaceFileEntry[] }
  | { kind: "text"; path: string; contents: string }
  | { kind: "binary" | "unsupported"; path: string };

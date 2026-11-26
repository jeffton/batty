import type { AgentTurnFileChange } from "@/shared/types";

export interface DurableFileChange extends AgentTurnFileChange {
  order?: number;
  before: string | null;
  after: string;
}

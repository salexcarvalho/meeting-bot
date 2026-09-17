import type { Channel, MeetingStatus, Permission, RoleKey, TranscriptPass } from "@meeting-bot/contracts";

export type {
  Channel,
  ItemType,
  MeetingSource,
  MeetingStatus,
  Platform,
  ReviewStatus,
  TranscriptPass,
} from "@meeting-bot/contracts";

// Estados em que a reunião pode ser reprocessada/excluída.
export const TERMINAL_STATUSES: MeetingStatus[] = ["done", "error", "skipped", "missed", "cancelled", "scheduled"];

export interface TranscriptSegment {
  speaker: string | null;
  text: string;
  start: number;
  end: number;
  channel?: Channel;
  pass?: TranscriptPass;
}

export interface User {
  id: string;
  username: string;
  roles: RoleKey[];
  permissions: Permission[];
}

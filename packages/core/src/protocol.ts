export type AdapterKind = "spicetify" | "tampermonkey";
export type RoomRole = "host" | "speaker";
export type SyncQuality = "tight" | "usable" | "loose" | "unsynced";

export interface PlayerState {
  uri: string | null;
  progressMs: number;
  durationMs: number;
  isPlaying: boolean;
  volume: number | null;
  observedAtMs: number;
}

export interface RoomMember {
  id: string;
  name: string;
  role: RoomRole;
  adapter: AdapterKind;
  joinedAtServerMs: number;
  lastSeenServerMs: number;
  syncQuality: SyncQuality;
  uncertaintyMs: number | null;
}

export interface ClockSamplePayload {
  seq: number;
  clientSendMs: number;
}

export interface ClockPongPayload extends ClockSamplePayload {
  serverReceiveMs: number;
  serverSendMs: number;
}

export interface SchedulePlaybackPayload {
  commandId: string;
  trackUri: string;
  startServerMs: number;
  startPositionMs: number;
  durationMs: number | null;
  issuedAtServerMs: number;
}

export type ClientMessage =
  | {
      type: "hello";
      clientId?: string;
      name: string;
      role: RoomRole;
      adapter: AdapterKind;
      hostToken?: string;
      calibrationMs: number;
    }
  | {
      type: "clock_ping";
      payload: ClockSamplePayload;
    }
  | {
      type: "member_state";
      state: PlayerState;
      syncQuality: SyncQuality;
      uncertaintyMs: number | null;
    }
  | {
      type: "schedule_playback";
      payload: Omit<SchedulePlaybackPayload, "issuedAtServerMs">;
      hostToken: string;
    }
  | {
      type: "pause_all";
      commandId: string;
      hostToken: string;
    }
  | {
      type: "resume_all";
      commandId: string;
      startServerMs: number;
      hostToken: string;
    }
  | {
      type: "seek_all";
      commandId: string;
      positionMs: number;
      startServerMs: number;
      hostToken: string;
    }
  | {
      type: "set_volume_all";
      commandId: string;
      volume: number;
      hostToken: string;
    }
  | {
      type: "drift_report";
      commandId: string;
      driftMs: number;
      expectedPositionMs: number;
      observedPositionMs: number;
      uncertaintyMs: number;
    };

export type ServerMessage =
  | {
      type: "hello_ack";
      clientId: string;
      roomCode: string;
      hostToken?: string;
      members: RoomMember[];
      serverNowMs: number;
    }
  | {
      type: "clock_pong";
      payload: ClockPongPayload;
    }
  | {
      type: "members";
      members: RoomMember[];
    }
  | {
      type: "schedule_playback";
      payload: SchedulePlaybackPayload;
    }
  | {
      type: "pause_all";
      commandId: string;
      issuedAtServerMs: number;
    }
  | {
      type: "resume_all";
      commandId: string;
      startServerMs: number;
      issuedAtServerMs: number;
    }
  | {
      type: "seek_all";
      commandId: string;
      positionMs: number;
      startServerMs: number;
      issuedAtServerMs: number;
    }
  | {
      type: "set_volume_all";
      commandId: string;
      volume: number;
      issuedAtServerMs: number;
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return null;
    }

    return parsed as ClientMessage;
  } catch {
    return null;
  }
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

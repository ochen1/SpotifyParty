import type { PlayerState } from "./protocol";

export type SyncMode = "managed" | "selfhosted";

export const MANAGED_SYNC_URL = "https://spotify-party-sync.stanwithme.workers.dev";

export interface SpotifyPartyAdapter {
  kind: "spicetify" | "tampermonkey";
  getState(): Promise<PlayerState>;
  playUri(uri: string, positionMs: number): Promise<void>;
  seek(positionMs: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  setVolume(level: number): Promise<void>;
  onStateChange(listener: (state: PlayerState) => void): () => void;
}

export interface ClientSettings {
  roomCode: string;
  syncMode: SyncMode;
  syncUrl: string;
  name: string;
  role: "host" | "speaker";
  hostToken: string;
  calibrationMs: number;
  commandLeadMs: number;
}

export const DEFAULT_SETTINGS: ClientSettings = {
  roomCode: "",
  syncMode: "managed",
  syncUrl: MANAGED_SYNC_URL,
  name: "Speaker",
  role: "speaker",
  hostToken: "",
  calibrationMs: 0,
  commandLeadMs: 250
};

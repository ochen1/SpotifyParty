import { clamp } from "./time";

export const DEFAULT_START_DELAY_MS = 5000;
export const DEFAULT_SPICETIFY_COMMAND_LEAD_MS = 180;
export const DEFAULT_TAMPERMONKEY_COMMAND_LEAD_MS = 350;
export const HARD_CORRECTION_THRESHOLD_MS = 80;
export const WARN_CORRECTION_THRESHOLD_MS = 30;

export interface ScheduledPlayback {
  commandId: string;
  trackUri: string;
  startServerMs: number;
  startPositionMs: number;
  durationMs: number | null;
}

export interface PlaybackTiming {
  expectedPositionMs: number;
  driftMs: number;
  correction: "none" | "warn" | "hard";
}

export function commandLocalRunAtMs(input: {
  startServerMs: number;
  offsetMs: number;
  commandLeadMs: number;
}): number {
  return input.startServerMs - input.offsetMs - input.commandLeadMs;
}

export function expectedPositionMs(input: {
  schedule: ScheduledPlayback;
  serverNowMs: number;
  audioOffsetMs: number;
}): number {
  const elapsed = input.serverNowMs - input.schedule.startServerMs;
  const raw = input.schedule.startPositionMs + elapsed + input.audioOffsetMs;
  const max = input.schedule.durationMs ?? Number.POSITIVE_INFINITY;
  return clamp(raw, 0, max);
}

export function evaluatePlaybackTiming(input: {
  schedule: ScheduledPlayback;
  serverNowMs: number;
  observedPositionMs: number;
  audioOffsetMs: number;
}): PlaybackTiming {
  const expected = expectedPositionMs(input);
  const driftMs = input.observedPositionMs - expected;
  const abs = Math.abs(driftMs);
  const correction =
    abs >= HARD_CORRECTION_THRESHOLD_MS ? "hard" : abs >= WARN_CORRECTION_THRESHOLD_MS ? "warn" : "none";

  return {
    expectedPositionMs: expected,
    driftMs,
    correction
  };
}

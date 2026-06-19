import { describe, expect, it } from "vitest";
import {
  commandLocalRunAtMs,
  evaluatePlaybackTiming,
  expectedPositionMs,
  type ScheduledPlayback
} from "../src/scheduler";

const schedule: ScheduledPlayback = {
  commandId: "play_1",
  trackUri: "spotify:track:test",
  startServerMs: 10_000,
  startPositionMs: 20_000,
  durationMs: 200_000
};

describe("playback scheduler", () => {
  it("converts server target time to local command time", () => {
    expect(
      commandLocalRunAtMs({
        startServerMs: 10_000,
        offsetMs: 250,
        commandLeadMs: 180
      })
    ).toBe(9570);
  });

  it("computes expected position with calibration offset", () => {
    expect(
      expectedPositionMs({
        schedule,
        serverNowMs: 12_500,
        audioOffsetMs: -30
      })
    ).toBe(22_470);
  });

  it("classifies drift thresholds", () => {
    expect(
      evaluatePlaybackTiming({
        schedule,
        serverNowMs: 11_000,
        observedPositionMs: 21_010,
        audioOffsetMs: 0
      }).correction
    ).toBe("none");

    expect(
      evaluatePlaybackTiming({
        schedule,
        serverNowMs: 11_000,
        observedPositionMs: 21_040,
        audioOffsetMs: 0
      }).correction
    ).toBe("warn");

    expect(
      evaluatePlaybackTiming({
        schedule,
        serverNowMs: 11_000,
        observedPositionMs: 21_100,
        audioOffsetMs: 0
      }).correction
    ).toBe("hard");
  });
});

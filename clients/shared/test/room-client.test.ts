import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  monotonicNowMs,
  type ClientSettings,
  type PlayerState,
  type SpotifyPartyAdapter
} from "../../../packages/core/src";
import { SpotifyPartyRuntime } from "../src/room-client";
import type { SettingsStore } from "../src/settings";

interface RuntimePrivate {
  handleRawMessage(raw: string): Promise<void>;
}

const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("SpotifyPartyRuntime calibration", () => {
  it("adds calibration to the initial scheduled play position", async () => {
    (globalThis as { window?: unknown }).window = globalThis;

    const playCalls: Array<{ uri: string; positionMs: number }> = [];
    const adapter = createAdapter({ playCalls });
    const store = memoryStore({
      ...DEFAULT_SETTINGS,
      calibrationMs: 5_000,
      commandLeadMs: 0
    });
    const runtime = new SpotifyPartyRuntime(adapter, store);

    try {
      await (runtime as unknown as RuntimePrivate).handleRawMessage(
        JSON.stringify({
          type: "schedule_playback",
          payload: {
            commandId: "play_test",
            trackUri: "spotify:track:test",
            startServerMs: monotonicNowMs() - 1,
            startPositionMs: 12_345,
            durationMs: 240_000,
            issuedAtServerMs: monotonicNowMs() - 2
          }
        })
      );

      expect(playCalls).toEqual([{ uri: "spotify:track:test", positionMs: 17_345 }]);
    } finally {
      runtime.disconnect();
    }
  });

  it("reloads the scheduled track when drift sync sees a different track", async () => {
    (globalThis as { window?: unknown }).window = globalThis;

    const playCalls: Array<{ uri: string; positionMs: number }> = [];
    const adapter = createAdapter({
      playCalls,
      state: {
        uri: "spotify:track:wrong",
        progressMs: 1_000,
        durationMs: 240_000,
        isPlaying: true,
        volume: 1,
        observedAtMs: monotonicNowMs()
      }
    });
    const runtime = new SpotifyPartyRuntime(
      adapter,
      memoryStore({
        ...DEFAULT_SETTINGS,
        calibrationMs: 5_000,
        commandLeadMs: 0
      })
    );

    try {
      await (runtime as unknown as RuntimePrivate).handleRawMessage(
        JSON.stringify({
          type: "schedule_playback",
          payload: {
            commandId: "play_test",
            trackUri: "spotify:track:test",
            startServerMs: monotonicNowMs() - 1,
            startPositionMs: 12_345,
            durationMs: 240_000,
            issuedAtServerMs: monotonicNowMs() - 2
          }
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 650));

      expect(playCalls.length).toBeGreaterThanOrEqual(2);
      expect(playCalls[0]).toEqual({ uri: "spotify:track:test", positionMs: 17_345 });
      expect(playCalls[1].uri).toBe("spotify:track:test");
      expect(playCalls[1].positionMs).toBeGreaterThanOrEqual(17_345);
      expect(runtime.getSnapshot().logs.some((entry) => entry.message.includes("wrong track"))).toBe(true);
    } finally {
      runtime.disconnect();
    }
  });
});

function createAdapter(input: {
  playCalls: Array<{ uri: string; positionMs: number }>;
  state?: PlayerState;
}): SpotifyPartyAdapter {
  return {
    kind: "tampermonkey",
    async getState(): Promise<PlayerState> {
      return (
        input.state ?? {
          uri: "spotify:track:test",
          progressMs: 0,
          durationMs: 240_000,
          isPlaying: true,
          volume: 1,
          observedAtMs: monotonicNowMs()
        }
      );
    },
    async playUri(uri, positionMs) {
      input.playCalls.push({ uri, positionMs });
    },
    async seek() {},
    async play() {},
    async pause() {},
    async setVolume() {},
    onStateChange() {
      return () => {};
    }
  };
}

function memoryStore(initial: ClientSettings): SettingsStore {
  let settings = initial;

  return {
    load: () => settings,
    save: (next) => {
      settings = next;
    }
  };
}

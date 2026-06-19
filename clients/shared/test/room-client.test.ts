import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("SpotifyPartyRuntime calibration", () => {
  it("adds calibration to the initial scheduled play position", async () => {
    (globalThis as { window?: unknown }).window = globalThis;

    const playCalls: Array<{ uri: string; positionMs: number }> = [];
    const adapter: SpotifyPartyAdapter = {
      kind: "tampermonkey",
      async getState(): Promise<PlayerState> {
        return {
          uri: "spotify:track:test",
          progressMs: 0,
          durationMs: 240_000,
          isPlaying: true,
          volume: 1,
          observedAtMs: monotonicNowMs()
        };
      },
      async playUri(uri, positionMs) {
        playCalls.push({ uri, positionMs });
      },
      async seek() {},
      async play() {},
      async pause() {},
      async setVolume() {},
      onStateChange() {
        return () => {};
      }
    };
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
});

function memoryStore(initial: ClientSettings): SettingsStore {
  let settings = initial;

  return {
    load: () => settings,
    save: (next) => {
      settings = next;
    }
  };
}

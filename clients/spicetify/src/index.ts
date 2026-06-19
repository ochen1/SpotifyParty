import {
  DEFAULT_SPICETIFY_COMMAND_LEAD_MS,
  monotonicNowMs,
  sleep,
  type PlayerState,
  type SpotifyPartyAdapter
} from "../../../packages/core/src";
import { mountPanel } from "../../shared/src/panel";
import { SpotifyPartyRuntime } from "../../shared/src/room-client";
import { createLocalSettingsStore } from "../../shared/src/settings";

declare global {
  interface Window {
    Spicetify?: SpicetifyApi;
  }
}

interface SpicetifyApi {
  Player: {
    data?: {
      item?: {
        uri?: string;
        duration?: {
          milliseconds?: number;
        };
      };
    };
    addEventListener?: (event: string, listener: () => void) => void;
    removeEventListener?: (event: string, listener: () => void) => void;
    getProgress: () => number;
    getDuration?: () => number;
    getVolume?: () => number;
    isPlaying: () => boolean;
    playUri: (uri: string) => Promise<void> | void;
    seek: (positionMs: number) => Promise<void> | void;
    play: () => Promise<void> | void;
    pause: () => Promise<void> | void;
    setVolume: (level: number) => Promise<void> | void;
  };
  showNotification?: (message: string) => void;
}

void boot();

async function boot(): Promise<void> {
  await waitForDocument();
  const spicetify = await waitForSpicetify();
  const adapter = createSpicetifyAdapter(spicetify);
  const runtime = new SpotifyPartyRuntime(
    adapter,
    createLocalSettingsStore("spotify-party:spicetify", {
      name: "Spicetify Speaker",
      commandLeadMs: DEFAULT_SPICETIFY_COMMAND_LEAD_MS
    })
  );

  mountPanel(runtime, {
    title: "SpotifyParty",
    host: document.body,
    initiallyOpen: false
  });

  spicetify.showNotification?.("SpotifyParty loaded");
}

function createSpicetifyAdapter(spicetify: SpicetifyApi): SpotifyPartyAdapter {
  return {
    kind: "spicetify",
    async getState() {
      return readState(spicetify);
    },
    async playUri(uri, positionMs) {
      await Promise.resolve(spicetify.Player.playUri(uri));
      await sleep(120);
      await Promise.resolve(spicetify.Player.seek(Math.max(0, Math.round(positionMs))));
      await Promise.resolve(spicetify.Player.play());
    },
    async seek(positionMs) {
      await Promise.resolve(spicetify.Player.seek(Math.max(0, Math.round(positionMs))));
    },
    async play() {
      await Promise.resolve(spicetify.Player.play());
    },
    async pause() {
      await Promise.resolve(spicetify.Player.pause());
    },
    async setVolume(level) {
      await Promise.resolve(spicetify.Player.setVolume(Math.max(0, Math.min(1, level))));
    },
    onStateChange(listener) {
      const handler = () => {
        listener(readState(spicetify));
      };
      const events = ["onprogress", "songchange", "onplaypause"];

      for (const event of events) {
        spicetify.Player.addEventListener?.(event, handler);
      }

      const timer = window.setInterval(handler, 1000);
      handler();

      return () => {
        clearInterval(timer);

        for (const event of events) {
          spicetify.Player.removeEventListener?.(event, handler);
        }
      };
    }
  };
}

function readState(spicetify: SpicetifyApi): PlayerState {
  const item = spicetify.Player.data?.item;
  const duration = spicetify.Player.getDuration?.() ?? item?.duration?.milliseconds ?? 0;

  return {
    uri: item?.uri ?? null,
    progressMs: Math.max(0, spicetify.Player.getProgress() || 0),
    durationMs: Math.max(0, duration || 0),
    isPlaying: spicetify.Player.isPlaying(),
    volume: spicetify.Player.getVolume?.() ?? null,
    observedAtMs: monotonicNowMs()
  };
}

async function waitForDocument(): Promise<void> {
  if (document.body) {
    return;
  }

  await new Promise<void>((resolve) => {
    document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
  });
}

async function waitForSpicetify(): Promise<SpicetifyApi> {
  for (;;) {
    const spicetify = window.Spicetify;

    if (
      typeof spicetify?.Player?.getProgress === "function" &&
      typeof spicetify.Player.playUri === "function"
    ) {
      return spicetify;
    }

    await sleep(100);
  }
}

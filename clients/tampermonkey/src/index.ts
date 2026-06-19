import {
  DEFAULT_TAMPERMONKEY_COMMAND_LEAD_MS,
  monotonicNowMs,
  type PlayerState,
  type SpotifyPartyAdapter
} from "../../../packages/core/src";
import { mountPanel } from "../../shared/src/panel";
import { SpotifyPartyRuntime } from "../../shared/src/room-client";
import { createLocalSettingsStore } from "../../shared/src/settings";

declare const unsafeWindow: Window | undefined;

interface SpotifyPlayerResponse {
  item?: {
    uri?: string;
    duration_ms?: number;
  };
  progress_ms?: number;
  is_playing?: boolean;
  device?: {
    volume_percent?: number;
  };
}

type SpotifyWebpackRequire = {
  (id: number | string): Record<string, unknown>;
  m?: Record<string, unknown>;
};

interface SpotifyWebpackWindow extends Window {
  webpackChunkclient_web?: Array<unknown>;
}

const INTERNAL_TOKEN_WAIT_MS = 5_000;
const INTERNAL_TOKEN_POLL_MS = 250;

let capturedToken: string | null = null;
let tokenExpiresAtMs = 0;
let legacyTokenRetryAfterMs = 0;
let apiRetryAfterMs = 0;
let spotifyRequire: SpotifyWebpackRequire | null = null;

installTokenBridge();
void boot();

async function boot(): Promise<void> {
  await waitForDocument();
  const adapter = createWebAdapter();
  const runtime = new SpotifyPartyRuntime(
    adapter,
    createLocalSettingsStore("spotify-party:tampermonkey", {
      name: "Web Speaker",
      commandLeadMs: DEFAULT_TAMPERMONKEY_COMMAND_LEAD_MS
    })
  );

  mountPanel(runtime, {
    title: "SpotifyParty Web",
    host: document.body,
    initiallyOpen: false
  });
}

function createWebAdapter(): SpotifyPartyAdapter {
  const listeners = new Set<(state: PlayerState) => void>();
  let timer: number | null = null;

  async function emitState(): Promise<void> {
    const state = await getState().catch(() => null);

    if (!state) {
      return;
    }

    for (const listener of listeners) {
      listener(state);
    }
  }

  async function getState(): Promise<PlayerState> {
    if (Date.now() < apiRetryAfterMs) {
      return readFallbackState();
    }

    const response = await spotifyFetch<SpotifyPlayerResponse>("https://api.spotify.com/v1/me/player").catch(
      () => null
    );

    if (!response) {
      return readFallbackState();
    }

    return {
      uri: response.item?.uri ?? null,
      progressMs: response.progress_ms ?? 0,
      durationMs: response.item?.duration_ms ?? 0,
      isPlaying: response.is_playing ?? false,
      volume:
        typeof response.device?.volume_percent === "number" ? response.device.volume_percent / 100 : null,
      observedAtMs: monotonicNowMs()
    };
  }

  return {
    kind: "tampermonkey",
    getState,
    async playUri(uri, positionMs) {
      await spotifyFetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        body: JSON.stringify({
          uris: [uri],
          position_ms: Math.max(0, Math.round(positionMs))
        })
      });
    },
    async seek(positionMs) {
      const url = new URL("https://api.spotify.com/v1/me/player/seek");
      url.searchParams.set("position_ms", String(Math.max(0, Math.round(positionMs))));
      await spotifyFetch(url.toString(), { method: "PUT" });
    },
    async play() {
      await spotifyFetch("https://api.spotify.com/v1/me/player/play", { method: "PUT" });
    },
    async pause() {
      await spotifyFetch("https://api.spotify.com/v1/me/player/pause", { method: "PUT" });
    },
    async setVolume(level) {
      const url = new URL("https://api.spotify.com/v1/me/player/volume");
      url.searchParams.set("volume_percent", String(Math.round(Math.max(0, Math.min(1, level)) * 100)));
      await spotifyFetch(url.toString(), { method: "PUT" });
    },
    onStateChange(listener) {
      listeners.add(listener);

      if (timer === null) {
        timer = window.setInterval(() => void emitState(), 5000);
      }

      void emitState();

      return () => {
        listeners.delete(listener);

        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    }
  };
}

async function spotifyFetch<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await getSpotifyToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers
    }
  });

  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));

      if (Number.isFinite(retryAfterSeconds)) {
        apiRetryAfterMs = Math.max(apiRetryAfterMs, Date.now() + retryAfterSeconds * 1000);
      }
    }

    const body = await response.text().catch(() => "");
    throw new Error(`Spotify API failed: HTTP ${response.status} ${body}`.trim());
  }

  return (await response.json()) as T;
}

async function getSpotifyToken(): Promise<string> {
  const internalToken = readInternalSpotifyToken();

  if (internalToken) {
    capturedToken = internalToken;
    tokenExpiresAtMs = Date.now() + 5 * 60_000;
    return internalToken;
  }

  if (capturedToken && Date.now() < tokenExpiresAtMs - 60_000) {
    return capturedToken;
  }

  const delayedInternalToken = await waitForInternalSpotifyToken();

  if (delayedInternalToken) {
    capturedToken = delayedInternalToken;
    tokenExpiresAtMs = Date.now() + 5 * 60_000;
    return delayedInternalToken;
  }

  if (Date.now() < legacyTokenRetryAfterMs) {
    throw new Error("Spotify web token unavailable; waiting before retrying the legacy token endpoint.");
  }

  const response = await fetch(
    "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
    {
      credentials: "include"
    }
  );

  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      legacyTokenRetryAfterMs = Date.now() + 60_000;
    }

    throw new Error("Could not read Spotify web token. Refresh Spotify and start playback once.");
  }

  const body = (await response.json()) as {
    accessToken?: string;
    accessTokenExpirationTimestampMs?: number;
  };

  if (!body.accessToken) {
    throw new Error("Spotify web token missing. Make sure you are logged in to open.spotify.com.");
  }

  capturedToken = body.accessToken;
  tokenExpiresAtMs = body.accessTokenExpirationTimestampMs ?? Date.now() + 30 * 60_000;
  return capturedToken;
}

async function waitForInternalSpotifyToken(): Promise<string | null> {
  const expiresAt = Date.now() + INTERNAL_TOKEN_WAIT_MS;

  while (Date.now() < expiresAt) {
    await new Promise((resolve) => window.setTimeout(resolve, INTERNAL_TOKEN_POLL_MS));

    const token = readInternalSpotifyToken();

    if (token) {
      return token;
    }
  }

  return null;
}

function readInternalSpotifyToken(): string | null {
  try {
    const require = getSpotifyRequire();

    if (!require?.m) {
      return null;
    }

    for (const [id, factory] of Object.entries(require.m)) {
      if (typeof factory !== "function") {
        continue;
      }

      const source = Function.prototype.toString.call(factory);

      if (
        !source.includes("accessToken") ||
        !source.includes("setSession") ||
        !source.includes("getInstance") ||
        !source.includes("resetInstance")
      ) {
        continue;
      }

      const moduleExports = require(Number(id));

      for (const value of Object.values(moduleExports)) {
        if (!isTokenStoreClass(value)) {
          continue;
        }

        const instance = value.getInstance();
        const token = instance.accessToken || instance._accessToken;

        if (typeof token === "string" && token.length > 80) {
          return token;
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

function getSpotifyRequire(): SpotifyWebpackRequire | null {
  if (spotifyRequire) {
    return spotifyRequire;
  }

  const page = (typeof unsafeWindow === "undefined" ? window : unsafeWindow) as SpotifyWebpackWindow;
  const chunk = page.webpackChunkclient_web;

  if (!Array.isArray(chunk)) {
    return null;
  }

  const chunkId = `spotify_party_runtime_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  chunk.push([[chunkId], {}, (runtimeRequire: SpotifyWebpackRequire) => {
    spotifyRequire = runtimeRequire;
  }]);

  return spotifyRequire;
}

function isTokenStoreClass(value: unknown): value is {
  getInstance: () => { accessToken?: string; _accessToken?: string };
} {
  return typeof value === "function" && typeof (value as { getInstance?: unknown }).getInstance === "function";
}

function readFallbackState(): PlayerState {
  const progressSlider = document.querySelector("[aria-label='Change progress']");
  const volumeSlider = document.querySelector("[aria-label='Change volume']");
  const url = new URL(location.href);
  const uriParam = url.searchParams.get("uri");
  const trackLink = document.querySelector<HTMLAnchorElement>("a[href*='/track/']");
  const trackIdFromLink = trackLink?.href.match(/\/track\/([A-Za-z0-9]+)/)?.[1] ?? null;
  const uri =
    uriParam?.startsWith("spotify:track:")
      ? uriParam
      : trackIdFromLink
        ? `spotify:track:${trackIdFromLink}`
        : null;

  return {
    uri,
    progressMs: readSliderNumber(progressSlider, "value"),
    durationMs: readSliderNumber(progressSlider, "max"),
    isPlaying: !!document.querySelector("button[aria-label='Pause']"),
    volume: readSliderNumber(volumeSlider, "value"),
    observedAtMs: monotonicNowMs()
  };
}

function readSliderNumber(element: Element | null, key: "value" | "max"): number {
  if (!element) {
    return 0;
  }

  const htmlValue =
    element instanceof HTMLInputElement
      ? key === "value"
        ? element.value
        : element.max
      : element.getAttribute(key) ?? element.getAttribute(`aria-value${key === "max" ? "max" : "now"}`);
  const value = Number(htmlValue);

  return Number.isFinite(value) ? value : 0;
}

function installTokenBridge(): void {
  window.addEventListener("spotify-party-token", (event) => {
    const detail = (event as CustomEvent<{ token?: string }>).detail;

    if (detail?.token) {
      capturedToken = detail.token;
      tokenExpiresAtMs = Date.now() + 30 * 60_000;
    }
  });

  const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const script = document.createElement("script");
  script.textContent = `(() => {
    const send = (value) => {
      const match = String(value || "").match(/^Bearer\\s+(.+)$/i);
      if (match) window.dispatchEvent(new CustomEvent("spotify-party-token", { detail: { token: match[1] } }));
    };
    const readHeaders = (headers) => {
      try {
        if (!headers) return;
        if (headers instanceof Headers) send(headers.get("authorization"));
        else if (Array.isArray(headers)) {
          for (const [key, value] of headers) if (String(key).toLowerCase() === "authorization") send(value);
        } else if (typeof headers === "object") {
          for (const key of Object.keys(headers)) if (key.toLowerCase() === "authorization") send(headers[key]);
        }
      } catch {}
    };
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      readHeaders(init && init.headers);
      if (input && input.headers) readHeaders(input.headers);
      return originalFetch.apply(this, arguments);
    };
    const open = XMLHttpRequest.prototype.open;
    const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function() {
      this.__spotifyPartyHeaders = {};
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(key, value) {
      if (String(key).toLowerCase() === "authorization") send(value);
      return setRequestHeader.apply(this, arguments);
    };
  })();`;
  (page.document.documentElement || page.document.head || page.document.body).appendChild(script);
  script.remove();
}

async function waitForDocument(): Promise<void> {
  if (document.body) {
    return;
  }

  await new Promise<void>((resolve) => {
    document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
  });
}

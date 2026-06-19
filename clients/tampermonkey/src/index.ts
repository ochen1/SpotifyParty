import {
  DEFAULT_TAMPERMONKEY_COMMAND_LEAD_MS,
  monotonicNowMs,
  sleep,
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

interface CapturedPlaybackState {
  uri: string | null;
  progressMs: number;
  durationMs: number;
  isPlaying: boolean;
  volume: number | null;
  capturedAtMs: number;
}

type SpotifyWebpackRequire = {
  (id: number | string): Record<string, unknown>;
  m?: Record<string, unknown>;
};

interface SpotifyWebpackWindow extends Window {
  webpackChunkclient_web?: Array<unknown>;
}

interface ReactFiber {
  child?: ReactFiber | null;
  sibling?: ReactFiber | null;
  elementType?: {
    _context?: unknown;
  };
  memoizedProps?: {
    value?: unknown;
  };
  type?: {
    _context?: unknown;
  };
}

interface SpotifyRegistry {
  resolve: (token: symbol) => unknown;
}

interface SpotifyInternalPlayerApi {
  getReferrer?: () => string;
  getState?: () => SpotifyInternalPlayerState | null;
  pause?: (origin?: SpotifyCommandOrigin) => Promise<void> | void;
  play?: (
    context: { uri: string },
    origin?: SpotifyCommandOrigin,
    options?: { paused?: boolean; seekTo?: number }
  ) => Promise<void> | void;
  resume?: (origin?: SpotifyCommandOrigin) => Promise<void> | void;
  seekTo?: (positionMs: number) => Promise<void> | void;
}

interface SpotifyInternalPlaybackApi {
  getVolume?: () => Promise<number> | number;
  setVolume?: (level: number) => Promise<void> | void;
}

interface SpotifyCommandOrigin {
  featureIdentifier: string;
  referrerIdentifier?: string;
}

interface SpotifyInternalPlayerState {
  duration?: unknown;
  hasContext?: unknown;
  isBuffering?: unknown;
  isPaused?: unknown;
  item?: {
    duration?: {
      milliseconds?: unknown;
    };
    metadata?: Record<string, unknown>;
    uri?: unknown;
  };
  position?: unknown;
  positionAsOfTimestamp?: unknown;
  speed?: unknown;
  timestamp?: unknown;
}

const INTERNAL_TOKEN_WAIT_MS = 5_000;
const INTERNAL_TOKEN_POLL_MS = 250;
const SPOTIFY_RATE_LIMIT_BACKOFF_MS = 60_000;
const SPOTIFY_PARTY_FEATURE = "spotify_party";

let capturedToken: string | null = null;
let tokenExpiresAtMs = 0;
let legacyTokenRetryAfterMs = 0;
let apiRetryAfterMs = 0;
let spotifyRequire: SpotifyWebpackRequire | null = null;
let spotifyRegistry: SpotifyRegistry | null = null;
let spotifyPlayerApi: SpotifyInternalPlayerApi | null = null;
let spotifyPlaybackApi: SpotifyInternalPlaybackApi | null = null;
let capturedPlaybackState: CapturedPlaybackState | null = null;

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
    const internalState = readInternalPlayerState();

    if (internalState?.uri) {
      return internalState;
    }

    const capturedState = readCapturedPlaybackState();

    if (capturedState?.uri) {
      return capturedState;
    }

    const localState = readFallbackState();

    if (localState.uri) {
      return localState;
    }

    if (Date.now() < apiRetryAfterMs) {
      return localState;
    }

    const response = await spotifyFetch<SpotifyPlayerResponse>("https://api.spotify.com/v1/me/player").catch(
      () => null
    );

    if (!response) {
      return localState;
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
      if (await playUriWithInternalPlayer(uri, positionMs)) {
        return;
      }

      await spotifyFetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        body: JSON.stringify({
          uris: [uri],
          position_ms: Math.max(0, Math.round(positionMs))
        })
      });
    },
    async seek(positionMs) {
      if (await seekWithInternalPlayer(positionMs)) {
        return;
      }

      const url = new URL("https://api.spotify.com/v1/me/player/seek");
      url.searchParams.set("position_ms", String(Math.max(0, Math.round(positionMs))));
      await spotifyFetch(url.toString(), { method: "PUT" });
    },
    async play() {
      if (await resumeWithInternalPlayer()) {
        return;
      }

      await spotifyFetch("https://api.spotify.com/v1/me/player/play", { method: "PUT" });
    },
    async pause() {
      if (await pauseWithInternalPlayer()) {
        return;
      }

      await spotifyFetch("https://api.spotify.com/v1/me/player/pause", { method: "PUT" });
    },
    async setVolume(level) {
      if (await setVolumeWithInternalPlayer(level)) {
        return;
      }

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
      const retryAfterMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : SPOTIFY_RATE_LIMIT_BACKOFF_MS;
      apiRetryAfterMs = Math.max(apiRetryAfterMs, Date.now() + retryAfterMs);
    }

    const body = await response.text().catch(() => "");
    const message =
      response.status === 429
        ? "Spotify is rate limiting this browser. Wait a minute, refresh Spotify, start any track once, then reconnect."
        : `Spotify API failed: HTTP ${response.status} ${body}`.trim();
    throw new Error(message);
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

function readInternalPlayerState(): PlayerState | null {
  try {
    const player = getSpotifyPlayerApi();
    const state = player?.getState?.();

    if (!state) {
      return null;
    }

    return normalizeInternalPlayerState(state);
  } catch {
    spotifyPlayerApi = null;
    return null;
  }
}

function normalizeInternalPlayerState(state: SpotifyInternalPlayerState): PlayerState | null {
  const uri = typeof state.item?.uri === "string" ? state.item.uri : null;

  if (!uri?.startsWith("spotify:track:")) {
    return null;
  }

  const durationMs =
    finiteNumber(state.duration) ||
    finiteNumber(state.item?.duration?.milliseconds) ||
    finiteNumber(state.item?.metadata?.duration);
  const progressMs = readInternalProgressMs(state, durationMs);

  return {
    uri,
    progressMs,
    durationMs,
    isPlaying: state.hasContext !== false && state.isPaused !== true,
    volume: readFallbackState().volume,
    observedAtMs: monotonicNowMs()
  };
}

function readInternalProgressMs(state: SpotifyInternalPlayerState, durationMs: number): number {
  const metadataPosition = finiteNumber(state.item?.metadata?.["segment.position_as_of_timestamp"]);
  const positionMs = finiteNumber(state.positionAsOfTimestamp) || finiteNumber(state.position) || metadataPosition;

  if (state.hasContext === false || state.isPaused === true || state.isBuffering === true) {
    return clampProgress(positionMs, durationMs);
  }

  const timestampMs = finiteNumber(state.timestamp);
  const speed = state.speed === undefined || state.speed === null ? 1 : finiteNumber(state.speed);
  const elapsedMs = timestampMs > 0 && speed > 0 ? (Date.now() - timestampMs) * speed : 0;
  return clampProgress(positionMs + elapsedMs, durationMs);
}

function clampProgress(positionMs: number, durationMs: number): number {
  const safePositionMs = Math.max(0, positionMs);
  return durationMs > 0 ? Math.min(durationMs, safePositionMs) : safePositionMs;
}

function getSpotifyPlayerApi(): SpotifyInternalPlayerApi | null {
  if (isSpotifyPlayerApi(spotifyPlayerApi)) {
    return spotifyPlayerApi;
  }

  spotifyPlayerApi = getSpotifyService<SpotifyInternalPlayerApi>("PlayerAPI", isSpotifyPlayerApi);
  return spotifyPlayerApi;
}

function getSpotifyPlaybackApi(): SpotifyInternalPlaybackApi | null {
  if (isSpotifyPlaybackApi(spotifyPlaybackApi)) {
    return spotifyPlaybackApi;
  }

  spotifyPlaybackApi = getSpotifyService<SpotifyInternalPlaybackApi>("PlaybackAPI", isSpotifyPlaybackApi);
  return spotifyPlaybackApi;
}

function getSpotifyService<T>(name: string, isService: (value: unknown) => value is T): T | null {
  const registry = getSpotifyRegistry();

  if (!registry) {
    return null;
  }

  try {
    const service = registry.resolve(Symbol.for(name));
    return isService(service) ? service : null;
  } catch {
    return null;
  }
}

function getSpotifyRegistry(): SpotifyRegistry | null {
  if (isSpotifyRegistry(spotifyRegistry) && getSpotifyServiceNoCache(spotifyRegistry, "PlayerAPI", isSpotifyPlayerApi)) {
    return spotifyRegistry;
  }

  spotifyRegistry = findSpotifyRegistryFromReact();
  return spotifyRegistry;
}

function getSpotifyServiceNoCache<T>(
  registry: SpotifyRegistry,
  name: string,
  isService: (value: unknown) => value is T
): T | null {
  try {
    const service = registry.resolve(Symbol.for(name));
    return isService(service) ? service : null;
  } catch {
    return null;
  }
}

function findSpotifyRegistryFromReact(): SpotifyRegistry | null {
  const stack = collectReactFibers();
  const seen = new Set<ReactFiber>();
  let visited = 0;

  while (stack.length > 0 && visited < 120_000) {
    const fiber = stack.pop();

    if (!fiber || seen.has(fiber)) {
      continue;
    }

    seen.add(fiber);
    visited += 1;

    const value = fiber.memoizedProps?.value;

    if (isSpotifyRegistry(value) && getSpotifyServiceNoCache(value, "PlayerAPI", isSpotifyPlayerApi)) {
      return value;
    }

    if (fiber.child) {
      stack.push(fiber.child);
    }

    if (fiber.sibling) {
      stack.push(fiber.sibling);
    }
  }

  return null;
}

function collectReactFibers(): ReactFiber[] {
  const roots: ReactFiber[] = [];
  const candidates = new Set<Element>();

  for (const element of [document.getElementById("main"), document.body, document.documentElement]) {
    if (element) {
      candidates.add(element);
    }
  }

  for (const element of document.querySelectorAll("[data-testid], main, div")) {
    candidates.add(element);

    if (candidates.size > 250) {
      break;
    }
  }

  for (const element of candidates) {
    for (const key of Object.getOwnPropertyNames(element)) {
      if (key.startsWith("__reactContainer$") || key.startsWith("__reactFiber$")) {
        const fiber = (element as unknown as Record<string, unknown>)[key];

        if (isReactFiber(fiber)) {
          roots.push(fiber);
        }
      }
    }
  }

  return roots;
}

function isReactFiber(value: unknown): value is ReactFiber {
  return !!value && typeof value === "object";
}

function isSpotifyRegistry(value: unknown): value is SpotifyRegistry {
  return !!value && typeof value === "object" && typeof (value as SpotifyRegistry).resolve === "function";
}

function isSpotifyPlayerApi(value: unknown): value is SpotifyInternalPlayerApi {
  return !!value && typeof value === "object" && typeof (value as SpotifyInternalPlayerApi).getState === "function";
}

function isSpotifyPlaybackApi(value: unknown): value is SpotifyInternalPlaybackApi {
  return (
    !!value &&
    typeof value === "object" &&
    (typeof (value as SpotifyInternalPlaybackApi).setVolume === "function" ||
      typeof (value as SpotifyInternalPlaybackApi).getVolume === "function")
  );
}

async function playUriWithInternalPlayer(uri: string, positionMs: number): Promise<boolean> {
  const player = getSpotifyPlayerApi();

  if (typeof player?.play !== "function") {
    return false;
  }

  try {
    await Promise.resolve(
      player.play(
        { uri },
        createInternalCommandOrigin(player),
        { paused: false, seekTo: Math.max(0, Math.round(positionMs)) }
      )
    );
    await sleep(80);

    if (typeof player.seekTo === "function") {
      await Promise.resolve(player.seekTo(Math.max(0, Math.round(positionMs))));
    }

    if (typeof player.resume === "function") {
      await Promise.resolve(player.resume(createInternalCommandOrigin(player)));
    }

    return true;
  } catch {
    spotifyPlayerApi = null;
    return false;
  }
}

async function seekWithInternalPlayer(positionMs: number): Promise<boolean> {
  const player = getSpotifyPlayerApi();

  if (typeof player?.seekTo !== "function") {
    return false;
  }

  try {
    await Promise.resolve(player.seekTo(Math.max(0, Math.round(positionMs))));
    return true;
  } catch {
    spotifyPlayerApi = null;
    return false;
  }
}

async function resumeWithInternalPlayer(): Promise<boolean> {
  const player = getSpotifyPlayerApi();

  if (typeof player?.resume !== "function") {
    return false;
  }

  try {
    await Promise.resolve(player.resume(createInternalCommandOrigin(player)));
    return true;
  } catch {
    spotifyPlayerApi = null;
    return false;
  }
}

async function pauseWithInternalPlayer(): Promise<boolean> {
  const player = getSpotifyPlayerApi();

  if (typeof player?.pause !== "function") {
    return false;
  }

  try {
    await Promise.resolve(player.pause(createInternalCommandOrigin(player)));
    return true;
  } catch {
    spotifyPlayerApi = null;
    return false;
  }
}

async function setVolumeWithInternalPlayer(level: number): Promise<boolean> {
  const playback = getSpotifyPlaybackApi();

  if (typeof playback?.setVolume !== "function") {
    return false;
  }

  try {
    await Promise.resolve(playback.setVolume(Math.max(0, Math.min(1, level))));
    return true;
  } catch {
    spotifyPlaybackApi = null;
    return false;
  }
}

function createInternalCommandOrigin(player: SpotifyInternalPlayerApi): SpotifyCommandOrigin {
  return {
    featureIdentifier: SPOTIFY_PARTY_FEATURE,
    referrerIdentifier: player.getReferrer?.() ?? SPOTIFY_PARTY_FEATURE
  };
}

function readCapturedPlaybackState(): PlayerState | null {
  if (!capturedPlaybackState?.uri) {
    return null;
  }

  const elapsedMs =
    capturedPlaybackState.isPlaying && Number.isFinite(capturedPlaybackState.capturedAtMs)
      ? Math.max(0, Date.now() - capturedPlaybackState.capturedAtMs)
      : 0;
  const durationMs = Math.max(0, capturedPlaybackState.durationMs || 0);
  const progressMs = Math.max(
    0,
    durationMs > 0
      ? Math.min(durationMs, capturedPlaybackState.progressMs + elapsedMs)
      : capturedPlaybackState.progressMs + elapsedMs
  );

  return {
    uri: capturedPlaybackState.uri,
    progressMs,
    durationMs,
    isPlaying: capturedPlaybackState.isPlaying,
    volume: capturedPlaybackState.volume,
    observedAtMs: monotonicNowMs()
  };
}

function readFallbackState(): PlayerState {
  const progressSlider = document.querySelector("[aria-label='Change progress']");
  const volumeSlider = document.querySelector("[aria-label='Change volume']");
  const progressFromText = readProgressFromPlayerControls();
  const progressMs = readSliderNumber(progressSlider, "value") || progressFromText.progressMs;
  const durationMs = readSliderNumber(progressSlider, "max") || progressFromText.durationMs;

  return {
    uri: readNowPlayingUri(),
    progressMs,
    durationMs,
    isPlaying: isSpotifyPlayingFromPage(),
    volume: readSliderNumber(volumeSlider, "value") || readStoredVolume(),
    observedAtMs: monotonicNowMs()
  };
}

function readNowPlayingUri(): string | null {
  const uriFromUrl = uriFromHref(location.href);

  if (uriFromUrl) {
    return uriFromUrl;
  }

  const nowPlayingLinks = [
    ...document.querySelectorAll<HTMLAnchorElement>(
      "a[aria-label^='Now playing:'], [aria-label='Now playing bar'] a[href], [aria-label='Now playing view'] a[href]"
    )
  ];

  for (const link of nowPlayingLinks) {
    const uri = uriFromHref(link.href);

    if (uri) {
      return uri;
    }
  }

  const trackLink = document.querySelector<HTMLAnchorElement>(
    "a[href*='uri=spotify%3Atrack'], a[href*='uri=spotify:track'], a[href*='/track/']"
  );
  const uriFromLink = trackLink ? uriFromHref(trackLink.href) : null;

  if (uriFromLink) {
    return uriFromLink;
  }

  const trackIdFromLink = trackLink?.href.match(/\/track\/([A-Za-z0-9]+)/)?.[1] ?? null;
  return trackIdFromLink ? `spotify:track:${trackIdFromLink}` : null;
}

function uriFromHref(href: string): string | null {
  try {
    const url = new URL(href, location.href);
    const uriParam = url.searchParams.get("uri");

    if (uriParam?.startsWith("spotify:track:")) {
      return uriParam;
    }

    const trackId = url.pathname.match(/\/track\/([A-Za-z0-9]+)/)?.[1];
    return trackId ? `spotify:track:${trackId}` : null;
  } catch {
    return null;
  }
}

function readProgressFromPlayerControls(): { progressMs: number; durationMs: number } {
  const controls = document.querySelector("[aria-label='Player controls']");
  const matches = (controls?.textContent ?? "").match(/\b(?:\d+:)?\d+:\d{2}\b/g) ?? [];

  return {
    progressMs: timeTextToMs(matches[0]),
    durationMs: timeTextToMs(matches[1])
  };
}

function timeTextToMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const parts = value.split(":").map((part) => Number(part));

  if (parts.some((part) => !Number.isFinite(part))) {
    return 0;
  }

  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds * 1000;
}

function isSpotifyPlayingFromPage(): boolean {
  return (
    !!document.querySelector("button[aria-label='Pause']") ||
    !!document.querySelector("[aria-label='Now playing bar'] button[aria-label^='Pause']")
  );
}

function readStoredVolume(): number | null {
  try {
    const body = JSON.parse(localStorage.getItem("playback") ?? "{}") as { volume?: unknown };
    return typeof body.volume === "number" ? body.volume : null;
  } catch {
    return null;
  }
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
  window.addEventListener("spotify-party-player-state", (event) => {
    const state = normalizeCapturedPlaybackState((event as CustomEvent<unknown>).detail);

    if (state) {
      capturedPlaybackState = state;
    }
  });

  const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const script = document.createElement("script");
  script.textContent = `(() => {
    let lastTrackPlaybackState = null;
    const send = (value) => {
      const match = String(value || "").match(/^Bearer\\s+(.+)$/i);
      if (match) window.dispatchEvent(new CustomEvent("spotify-party-token", { detail: { token: match[1] } }));
    };
    const sendPlayerState = (value) => {
      if (!value || !value.uri) return;
      lastTrackPlaybackState = value;
      window.dispatchEvent(new CustomEvent("spotify-party-player-state", { detail: value }));
    };
    const isTrackPlaybackStateUrl = (url) => /\\/track-playback\\/v1\\/devices\\/[^/]+\\/state(?:$|[?#])/.test(String(url || ""));
    const readRequestBody = (body) => {
      try {
        if (typeof body === "string") return body;
        if (body instanceof URLSearchParams) return body.toString();
      } catch {}
      return null;
    };
    const parseJson = (value) => {
      try {
        return typeof value === "string" && value ? JSON.parse(value) : value && typeof value === "object" ? value : null;
      } catch {
        return null;
      }
    };
    const parseTrackPlaybackState = (requestBody, responseBody) => {
      const request = parseJson(requestBody);
      const response = parseJson(responseBody);
      const machine = response && response.state_machine;
      const states = Array.isArray(machine && machine.states) ? machine.states : [];
      const tracks = Array.isArray(machine && machine.tracks) ? machine.tracks : [];
      const stateIndex = response && response.updated_state_ref && Number.isInteger(response.updated_state_ref.state_index)
        ? response.updated_state_ref.state_index
        : -1;
      const state =
        states[stateIndex] ||
        states.find((candidate) => candidate && request && request.state_ref && candidate.state_id === request.state_ref.state_id);
      const track = state && Number.isInteger(state.track) ? tracks[state.track] : null;
      const metadata = track && track.metadata;
      const uri = metadata && (metadata.uri || metadata.linked_from_uri);

      if (!uri || !String(uri).startsWith("spotify:track:")) {
        return null;
      }

      const requestSubState = request && request.sub_state;
      const responsePaused = response && response.updated_state_ref && response.updated_state_ref.paused;
      const requestPaused = request && request.state_ref && request.state_ref.paused;
      return {
        uri,
        progressMs: Number(requestSubState && requestSubState.position) || 0,
        durationMs: Number((requestSubState && requestSubState.duration) || (metadata && metadata.duration)) || 0,
        isPlaying: !(typeof responsePaused === "boolean" ? responsePaused : !!requestPaused),
        volume: null,
        capturedAtMs: Date.now()
      };
    };
    const maybeCaptureTrackPlaybackState = (url, requestBody, response) => {
      if (!isTrackPlaybackStateUrl(url) || !response) return;
      try {
        response.clone().json().then((body) => {
          const state = parseTrackPlaybackState(requestBody, body);
          if (state) sendPlayerState(state);
        }).catch(() => {});
      } catch {}
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
      const url = typeof input === "string" ? input : input && input.url;
      const requestBody = init && readRequestBody(init.body);
      return originalFetch.apply(this, arguments).then((response) => {
        maybeCaptureTrackPlaybackState(url, requestBody, response);
        return response;
      });
    };
    const open = XMLHttpRequest.prototype.open;
    const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const sendRequest = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function() {
      this.__spotifyPartyHeaders = {};
      this.__spotifyPartyMethod = arguments[0];
      this.__spotifyPartyUrl = arguments[1];
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(key, value) {
      if (String(key).toLowerCase() === "authorization") send(value);
      return setRequestHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      const url = this.__spotifyPartyUrl;
      const requestBody = readRequestBody(body);
      if (isTrackPlaybackStateUrl(url)) {
        this.addEventListener("loadend", () => {
          try {
            const state = parseTrackPlaybackState(requestBody, parseJson(this.responseText));
            if (state) sendPlayerState(state);
          } catch {}
        });
      }
      return sendRequest.apply(this, arguments);
    };
  })();`;
  (page.document.documentElement || page.document.head || page.document.body).appendChild(script);
  script.remove();
}

function normalizeCapturedPlaybackState(value: unknown): CapturedPlaybackState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const state = value as Partial<CapturedPlaybackState>;

  if (typeof state.uri !== "string" || !state.uri.startsWith("spotify:track:")) {
    return null;
  }

  return {
    uri: state.uri,
    progressMs: finiteNumber(state.progressMs),
    durationMs: finiteNumber(state.durationMs),
    isPlaying: state.isPlaying !== false,
    volume: typeof state.volume === "number" ? state.volume : null,
    capturedAtMs: finiteNumber(state.capturedAtMs) || Date.now()
  };
}

function finiteNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

async function waitForDocument(): Promise<void> {
  if (document.body) {
    return;
  }

  await new Promise<void>((resolve) => {
    document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
  });
}

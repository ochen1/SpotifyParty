import { DEFAULT_SETTINGS, MANAGED_SYNC_URL, type ClientSettings, type SyncMode } from "../../../packages/core/src";

const PLACEHOLDER_SYNC_URL = "https://spotify-party-sync.YOUR_SUBDOMAIN.workers.dev";

export interface SettingsStore {
  load(): ClientSettings;
  save(settings: ClientSettings): void;
}

export function createLocalSettingsStore(key: string, defaults: Partial<ClientSettings> = {}): SettingsStore {
  return {
    load() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        const parsed = raw ? (JSON.parse(raw) as Partial<ClientSettings>) : {};
        return normalizeSettings({ ...defaults, ...parsed });
      } catch {
        return normalizeSettings(defaults);
      }
    },
    save(settings) {
      globalThis.localStorage?.setItem(key, JSON.stringify(settings));
    }
  };
}

export function normalizeSettings(settings: Partial<ClientSettings>): ClientSettings {
  const syncUrl =
    typeof settings.syncUrl === "string" && settings.syncUrl.trim()
      ? settings.syncUrl.trim()
      : MANAGED_SYNC_URL;
  const inferredMode: SyncMode =
    settings.syncMode === "selfhosted" ||
    (settings.syncMode === undefined && syncUrl !== MANAGED_SYNC_URL && syncUrl !== PLACEHOLDER_SYNC_URL)
      ? "selfhosted"
      : "managed";

  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    syncMode: inferredMode,
    syncUrl: syncUrl === PLACEHOLDER_SYNC_URL ? MANAGED_SYNC_URL : syncUrl,
    calibrationMs: finite(settings.calibrationMs, DEFAULT_SETTINGS.calibrationMs),
    commandLeadMs: finite(settings.commandLeadMs, DEFAULT_SETTINGS.commandLeadMs)
  };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

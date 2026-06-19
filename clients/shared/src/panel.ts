import type { ClientSettings } from "../../../packages/core/src";
import type { RuntimeSnapshot, SpotifyPartyRuntime } from "./room-client";

export interface PanelOptions {
  title: string;
  host: HTMLElement;
  initiallyOpen?: boolean;
}

export function mountPanel(runtime: SpotifyPartyRuntime, options: PanelOptions): () => void {
  const root = document.createElement("div");
  root.className = "spotify-party-root";
  root.innerHTML = markup(options.title);
  options.host.appendChild(root);
  injectStyles();

  const form = collectForm(root);

  root.querySelector<HTMLButtonElement>("[data-action='create']")!.addEventListener("click", () => {
    void runtime.createRoom().catch((error) => setError(form.status, error));
  });
  root.querySelector<HTMLButtonElement>("[data-action='connect']")!.addEventListener("click", () => runtime.connect());
  root.querySelector<HTMLButtonElement>("[data-action='disconnect']")!.addEventListener("click", () => runtime.disconnect());
  root.querySelector<HTMLButtonElement>("[data-action='schedule']")!.addEventListener("click", () => {
    void runtime.scheduleCurrentTrack().catch((error) => setError(form.status, error));
  });
  root.querySelector<HTMLButtonElement>("[data-action='pause']")!.addEventListener("click", () => runtime.pauseAll());
  root.querySelector<HTMLButtonElement>("[data-action='resume']")!.addEventListener("click", () => runtime.resumeAll());
  root.querySelector<HTMLButtonElement>("[data-action='max-volume']")!.addEventListener("click", () => {
    void runtime.maxVolumeAll().catch((error) => setError(form.status, error));
  });

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-cal]")) {
    button.addEventListener("click", () => runtime.nudgeCalibration(Number(button.dataset.cal)));
  }

  const save = () => {
    runtime.setSettings(readSettings(form));
  };

  for (const element of [
    form.syncMode,
    form.syncUrl,
    form.roomCode,
    form.name,
    form.role,
    form.hostToken,
    form.calibrationMs,
    form.commandLeadMs
  ]) {
    element.addEventListener("change", save);
    element.addEventListener("input", save);
  }

  const unsubscribe = runtime.subscribe((snapshot) => render(snapshot, form));

  if (!options.initiallyOpen) {
    root.classList.add("spotify-party-closed");
  }

  root.querySelector<HTMLButtonElement>("[data-action='toggle']")!.addEventListener("click", () => {
    root.classList.toggle("spotify-party-closed");
  });

  return () => {
    unsubscribe();
    root.remove();
  };
}

function render(snapshot: RuntimeSnapshot, form: ReturnType<typeof collectForm>): void {
  form.root.dataset.syncMode = snapshot.settings.syncMode;
  form.root.dataset.role = snapshot.settings.role;
  writeIfBlurred(form.syncMode, snapshot.settings.syncMode);
  writeIfBlurred(form.syncUrl, snapshot.settings.syncUrl);
  writeIfBlurred(form.roomCode, snapshot.settings.roomCode);
  writeIfBlurred(form.name, snapshot.settings.name);
  writeIfBlurred(form.role, snapshot.settings.role);
  writeIfBlurred(form.hostToken, snapshot.settings.hostToken);
  writeIfBlurred(form.calibrationMs, String(snapshot.settings.calibrationMs));
  writeIfBlurred(form.commandLeadMs, String(snapshot.settings.commandLeadMs));

  form.status.textContent = snapshot.status;
  form.clock.textContent =
    snapshot.clock.quality === "unsynced"
      ? "Clock unsynced"
      : `${snapshot.clock.quality} | ${snapshot.clock.uncertaintyMs.toFixed(1)} ms uncertainty`;
  form.track.textContent = snapshot.player?.uri ? compactUri(snapshot.player.uri) : "No track";
  form.drift.textContent =
    snapshot.lastDriftMs === null ? "Drift n/a" : `Drift ${snapshot.lastDriftMs.toFixed(0)} ms`;
  form.members.replaceChildren(
    ...snapshot.members.map((member) => {
      const row = document.createElement("div");
      row.className = "spotify-party-member";
      const nowMs = Date.now();
      const state = member.playerState;
      const drift = member.lastDriftReport;

      const title = document.createElement("div");
      title.className = "spotify-party-member-title";
      title.textContent = `${member.name} | ${member.role} | ${member.adapter}`;

      const sync = document.createElement("div");
      sync.textContent = `Sync ${member.syncQuality} | ${formatNullableMs(member.uncertaintyMs)} uncertainty | cal ${formatSignedMs(member.calibrationMs)}`;

      const playback = document.createElement("div");
      playback.textContent = state
        ? `${state.isPlaying ? "Playing" : "Paused"} ${compactOrNone(state.uri)} | ${formatPosition(state.progressMs, state.durationMs)} | vol ${formatVolume(state.volume)}`
        : "Playback unknown";

      const heartbeat = document.createElement("div");
      heartbeat.textContent = `Last state ${formatAge(member.playerStateAtServerMs, nowMs)} | last seen ${formatAge(member.lastSeenServerMs, nowMs)}`;

      const driftLine = document.createElement("div");
      driftLine.textContent = drift
        ? `Drift ${formatSignedMs(drift.driftMs)} | action ${drift.correctionAction} | report ${formatAge(drift.reportedAtServerMs, nowMs)}`
        : "Drift not reported yet";

      const detail = document.createElement("div");
      detail.className = "spotify-party-member-detail";
      detail.textContent = drift
        ? `expected ${compactOrNone(drift.expectedTrackUri)} @ ${formatMs(drift.expectedPositionMs)} | observed ${compactOrNone(drift.actualTrackUri)} @ ${formatMs(drift.observedPositionMs)} | ${drift.isPlaying ? "playing" : "paused"}`
        : `joined ${formatAge(member.joinedAtServerMs, nowMs)}`;

      row.appendChild(title);
      row.appendChild(sync);
      row.appendChild(playback);
      row.appendChild(heartbeat);
      row.appendChild(driftLine);
      row.appendChild(detail);
      return row;
    })
  );
  form.logs.replaceChildren(
    ...snapshot.logs.map((entry) => {
      const row = document.createElement("div");
      row.className = `spotify-party-log spotify-party-log-${entry.level}`;

      const meta = document.createElement("span");
      meta.className = "spotify-party-log-meta";
      meta.textContent = `${formatTime(entry.atMs)} ${entry.level}`;

      const messageElement = document.createElement("span");
      messageElement.className = "spotify-party-log-message";
      messageElement.textContent = entry.message;

      row.appendChild(meta);
      row.appendChild(messageElement);

      if (entry.details) {
        const detailsElement = document.createElement("span");
        detailsElement.className = "spotify-party-log-details";
        detailsElement.textContent = entry.details;
        row.appendChild(detailsElement);
      }

      return row;
    })
  );
}

function markup(title: string): string {
  return `
    <button class="spotify-party-toggle" type="button" data-action="toggle" title="SpotifyParty">SP</button>
    <section class="spotify-party-panel" aria-label="SpotifyParty">
      <header>
        <strong>${escapeHtml(title)}</strong>
        <span data-field="status">Idle</span>
      </header>
      <div class="spotify-party-join">
        <label>Room <input data-field="room-code" spellcheck="false"></label>
        <div class="spotify-party-buttons spotify-party-connection-buttons">
          <button type="button" data-action="create" class="spotify-party-host-only">Create</button>
          <button type="button" data-action="connect">Connect</button>
          <button type="button" data-action="disconnect">Disconnect</button>
        </div>
      </div>
      <button class="spotify-party-primary spotify-party-host-only" type="button" data-action="schedule">Sync Track</button>
      <details class="spotify-party-setup">
        <summary>Setup</summary>
        <div class="spotify-party-grid">
          <label>Role
            <select data-field="role">
              <option value="speaker">speaker</option>
              <option value="host">host</option>
            </select>
          </label>
          <label>Name <input data-field="name" spellcheck="false"></label>
        </div>
        <label class="spotify-party-host-only">Host token <input data-field="host-token" spellcheck="false"></label>
      </details>
      <details class="spotify-party-host-controls spotify-party-host-only">
        <summary>Host controls</summary>
        <div class="spotify-party-buttons">
          <button type="button" data-action="pause">Pause</button>
          <button type="button" data-action="resume">Resume</button>
          <button type="button" data-action="max-volume">Max Vol</button>
        </div>
      </details>
      <details class="spotify-party-tuning">
        <summary>Tuning</summary>
        <div class="spotify-party-grid">
          <label>Calibration <input data-field="calibration-ms" type="number" step="10"></label>
          <label>Command lead <input data-field="command-lead-ms" type="number" step="10"></label>
        </div>
        <div class="spotify-party-buttons">
          <button type="button" data-cal="-50">-50</button>
          <button type="button" data-cal="-10">-10</button>
          <button type="button" data-cal="10">+10</button>
          <button type="button" data-cal="50">+50</button>
        </div>
      </details>
      <details class="spotify-party-advanced">
        <summary>Advanced</summary>
        <label>Sync service
          <select data-field="sync-mode">
            <option value="managed">Managed</option>
            <option value="selfhosted">Self-hosted</option>
          </select>
        </label>
        <label class="spotify-party-selfhosted">Self-hosted URL <input data-field="sync-url" spellcheck="false"></label>
      </details>
      <footer>
        <span data-field="clock">Clock unsynced</span>
        <span data-field="track">No track</span>
        <span data-field="drift">Drift n/a</span>
      </footer>
      <div class="spotify-party-members" data-field="members"></div>
      <details class="spotify-party-activity">
        <summary>Activity</summary>
        <div class="spotify-party-logs" data-field="logs"></div>
      </details>
    </section>
  `;
}

function collectForm(root: HTMLElement) {
  return {
    root,
    syncMode: select(root, "sync-mode"),
    syncUrl: input(root, "sync-url"),
    roomCode: input(root, "room-code"),
    name: input(root, "name"),
    role: select(root, "role"),
    hostToken: input(root, "host-token"),
    calibrationMs: input(root, "calibration-ms"),
    commandLeadMs: input(root, "command-lead-ms"),
    status: text(root, "status"),
    clock: text(root, "clock"),
    track: text(root, "track"),
    drift: text(root, "drift"),
    members: root.querySelector("[data-field='members']") as HTMLDivElement,
    logs: root.querySelector("[data-field='logs']") as HTMLDivElement
  };
}

function readSettings(form: ReturnType<typeof collectForm>): Partial<ClientSettings> {
  return {
    syncMode: form.syncMode.value === "selfhosted" ? "selfhosted" : "managed",
    syncUrl: form.syncUrl.value.trim(),
    roomCode: form.roomCode.value.trim().toUpperCase(),
    name: form.name.value.trim() || "Speaker",
    role: form.role.value === "host" ? "host" : "speaker",
    hostToken: form.hostToken.value.trim(),
    calibrationMs: Number(form.calibrationMs.value) || 0,
    commandLeadMs: Number(form.commandLeadMs.value) || 0
  };
}

function input(root: HTMLElement, field: string): HTMLInputElement {
  return root.querySelector(`[data-field='${field}']`) as HTMLInputElement;
}

function select(root: HTMLElement, field: string): HTMLSelectElement {
  return root.querySelector(`[data-field='${field}']`) as unknown as HTMLSelectElement;
}

function text(root: HTMLElement, field: string): HTMLElement {
  return root.querySelector(`[data-field='${field}']`) as HTMLElement;
}

function writeIfBlurred(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  if (document.activeElement !== element) {
    element.value = value;
  }
}

function setError(element: HTMLElement, error: unknown): void {
  element.textContent = error instanceof Error ? error.message : String(error);
}

function compactUri(uri: string): string {
  return uri.replace("spotify:track:", "track:");
}

function compactOrNone(uri: string | null): string {
  return uri ? compactUri(uri) : "none";
}

function formatPosition(progressMs: number, durationMs: number): string {
  return durationMs > 0 ? `${formatMs(progressMs)} / ${formatMs(durationMs)}` : formatMs(progressMs);
}

function formatMs(value: number): string {
  return `${Math.max(0, Math.round(value))}ms`;
}

function formatSignedMs(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded}ms`;
}

function formatNullableMs(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}ms` : "n/a";
}

function formatVolume(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "n/a";
}

function formatAge(valueMs: number | null, nowMs: number): string {
  if (typeof valueMs !== "number" || !Number.isFinite(valueMs)) {
    return "n/a";
  }

  const ageMs = Math.max(0, nowMs - valueMs);

  if (ageMs < 1000) {
    return `${Math.round(ageMs)}ms ago`;
  }

  if (ageMs < 60_000) {
    return `${(ageMs / 1000).toFixed(1)}s ago`;
  }

  return `${Math.round(ageMs / 60_000)}m ago`;
}

function escapeHtml(value: string): string {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

function formatTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) {
    return;
  }

  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .spotify-party-root {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      color: #f8fafc;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
    }
    .spotify-party-toggle {
      width: 40px;
      height: 40px;
      border: 0;
      border-radius: 20px;
      color: #06120b;
      background: #1ed760;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    }
    .spotify-party-panel {
      width: min(360px, calc(100vw - 32px));
      margin-bottom: 10px;
      padding: 12px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      background: #111827;
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
      display: grid;
      gap: 8px;
    }
    .spotify-party-closed .spotify-party-panel {
      display: none;
    }
    .spotify-party-panel header,
    .spotify-party-panel footer {
      display: grid;
      gap: 3px;
    }
    .spotify-party-panel label {
      display: grid;
      gap: 4px;
      color: #cbd5e1;
    }
    .spotify-party-root[data-role="speaker"] .spotify-party-host-only {
      display: none;
    }
    .spotify-party-advanced {
      display: grid;
      gap: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      padding-top: 8px;
    }
    .spotify-party-advanced summary {
      color: #cbd5e1;
      cursor: pointer;
      font-weight: 700;
    }
    .spotify-party-setup,
    .spotify-party-host-controls,
    .spotify-party-tuning,
    .spotify-party-activity {
      display: grid;
      gap: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      padding-top: 8px;
    }
    .spotify-party-setup summary,
    .spotify-party-host-controls summary,
    .spotify-party-tuning summary,
    .spotify-party-activity summary {
      color: #cbd5e1;
      cursor: pointer;
      font-weight: 700;
    }
    .spotify-party-root[data-sync-mode="managed"] .spotify-party-selfhosted {
      display: none;
    }
    .spotify-party-panel input,
    .spotify-party-panel select {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 6px;
      padding: 6px 8px;
      color: #f8fafc;
      background: #0f172a;
      font: inherit;
    }
    .spotify-party-grid,
    .spotify-party-buttons,
    .spotify-party-join {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .spotify-party-buttons {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    .spotify-party-connection-buttons {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      align-self: end;
    }
    .spotify-party-buttons button {
      min-height: 30px;
      border: 0;
      border-radius: 6px;
      padding: 5px;
      color: #f8fafc;
      background: #334155;
      cursor: pointer;
      font: inherit;
      white-space: nowrap;
    }
    .spotify-party-buttons button:hover {
      background: #475569;
    }
    .spotify-party-primary {
      min-height: 40px;
      border: 0;
      border-radius: 6px;
      color: #06120b;
      background: #1ed760;
      cursor: pointer;
      font: inherit;
      font-weight: 800;
    }
    .spotify-party-primary:hover {
      background: #22c55e;
    }
    .spotify-party-members {
      display: grid;
      gap: 4px;
      max-height: 220px;
      overflow: auto;
    }
    .spotify-party-member {
      display: grid;
      gap: 3px;
      padding: 5px 6px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.07);
      color: #e2e8f0;
      overflow-wrap: anywhere;
    }
    .spotify-party-member-title {
      font-weight: 800;
    }
    .spotify-party-member-detail {
      color: #94a3b8;
    }
    .spotify-party-logs {
      display: grid;
      gap: 5px;
      max-height: 180px;
      overflow: auto;
    }
    .spotify-party-log {
      display: grid;
      gap: 2px;
      padding: 6px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.07);
      color: #e2e8f0;
      overflow-wrap: anywhere;
    }
    .spotify-party-log-meta {
      color: #94a3b8;
      font-size: 10px;
      text-transform: uppercase;
    }
    .spotify-party-log-message {
      font-weight: 700;
    }
    .spotify-party-log-details {
      color: #cbd5e1;
    }
    .spotify-party-log-warn {
      background: rgba(245, 158, 11, 0.16);
    }
    .spotify-party-log-error {
      background: rgba(239, 68, 68, 0.18);
    }
  `;
  document.documentElement.appendChild(style);
}

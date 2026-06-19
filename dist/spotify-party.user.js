// ==UserScript==
// @name         SpotifyParty
// @namespace    https://github.com/local/spotify-party
// @version      0.1.10
// @description  Sync Spotify web playback with SpotifyParty rooms.
// @match        https://open.spotify.com/*
// @homepageURL  https://github.com/ochen1/SpotifyParty
// @downloadURL  https://raw.githubusercontent.com/ochen1/SpotifyParty/main/dist/spotify-party.user.js
// @updateURL    https://raw.githubusercontent.com/ochen1/SpotifyParty/main/dist/spotify-party.user.js
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// ==/UserScript==
"use strict";
(() => {
  // packages/core/src/adapter.ts
  var MANAGED_SYNC_URL = "https://spotify-party-sync.stanwithme.workers.dev";
  var DEFAULT_SETTINGS = {
    roomCode: "",
    syncMode: "managed",
    syncUrl: MANAGED_SYNC_URL,
    name: "Speaker",
    role: "speaker",
    hostToken: "",
    calibrationMs: 0,
    commandLeadMs: 250
  };

  // packages/core/src/time.ts
  function monotonicNowMs() {
    const perf = globalThis.performance;
    if (perf && typeof perf.now === "function") {
      const origin = typeof perf.timeOrigin === "number" ? perf.timeOrigin : Date.now() - perf.now();
      return origin + perf.now();
    }
    return Date.now();
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function randomId(prefix = "") {
    const random = Math.random().toString(36).slice(2, 10);
    const time = Date.now().toString(36).slice(-6);
    return `${prefix}${time}${random}`;
  }

  // packages/core/src/clock.ts
  function createClockSample(input2) {
    const offsetMs = (input2.serverReceiveMs - input2.clientSendMs + input2.serverSendMs - input2.clientReceiveMs) / 2;
    const delayMs = Math.max(
      0,
      input2.clientReceiveMs - input2.clientSendMs - (input2.serverSendMs - input2.serverReceiveMs)
    );
    return {
      ...input2,
      offsetMs,
      delayMs,
      capturedAtMs: monotonicNowMs()
    };
  }
  var ClockEstimator = class {
    constructor(maxSamples = 24) {
      this.maxSamples = maxSamples;
    }
    samples = [];
    add(sample) {
      this.samples.push(sample);
      if (this.samples.length > this.maxSamples) {
        this.samples.shift();
      }
      return this.getStats();
    }
    clear() {
      this.samples.length = 0;
    }
    getStats() {
      if (this.samples.length === 0) {
        return {
          offsetMs: 0,
          delayMs: Number.POSITIVE_INFINITY,
          jitterMs: Number.POSITIVE_INFINITY,
          uncertaintyMs: Number.POSITIVE_INFINITY,
          sampleCount: 0,
          quality: "unsynced"
        };
      }
      const ranked = [...this.samples].sort((a, b) => a.delayMs - b.delayMs);
      const best = ranked.slice(0, Math.min(8, Math.max(3, Math.ceil(ranked.length / 2))));
      const offsets = best.map((sample) => sample.offsetMs).sort((a, b) => a - b);
      const delays = best.map((sample) => sample.delayMs).sort((a, b) => a - b);
      const offsetMs = median(offsets);
      const delayMs = median(delays);
      const deviations = offsets.map((offset) => Math.abs(offset - offsetMs)).sort((a, b) => a - b);
      const jitterMs = median(deviations);
      const uncertaintyMs = delayMs / 2 + jitterMs;
      return {
        offsetMs,
        delayMs,
        jitterMs,
        uncertaintyMs,
        sampleCount: this.samples.length,
        quality: qualityForUncertainty(uncertaintyMs)
      };
    }
    serverNowMs(localNowMs = monotonicNowMs()) {
      return localNowMs + this.getStats().offsetMs;
    }
  };
  function qualityForUncertainty(uncertaintyMs) {
    if (!Number.isFinite(uncertaintyMs)) {
      return "unsynced";
    }
    if (uncertaintyMs <= 20) {
      return "tight";
    }
    if (uncertaintyMs <= 60) {
      return "usable";
    }
    return "loose";
  }
  function median(values) {
    if (values.length === 0) {
      return 0;
    }
    const middle = Math.floor(values.length / 2);
    if (values.length % 2 === 1) {
      return values[middle] ?? 0;
    }
    return ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
  }

  // packages/core/src/protocol.ts
  function encodeClientMessage(message) {
    return JSON.stringify(message);
  }

  // packages/core/src/scheduler.ts
  var DEFAULT_START_DELAY_MS = 5e3;
  var DEFAULT_TAMPERMONKEY_COMMAND_LEAD_MS = 350;
  var HARD_CORRECTION_THRESHOLD_MS = 80;
  var WARN_CORRECTION_THRESHOLD_MS = 30;
  function expectedPositionMs(input2) {
    const elapsed = input2.serverNowMs - input2.schedule.startServerMs;
    const raw = input2.schedule.startPositionMs + elapsed + input2.audioOffsetMs;
    const max = input2.schedule.durationMs ?? Number.POSITIVE_INFINITY;
    return clamp(raw, 0, max);
  }
  function evaluatePlaybackTiming(input2) {
    const expected = expectedPositionMs(input2);
    const driftMs = input2.observedPositionMs - expected;
    const abs = Math.abs(driftMs);
    const correction = abs >= HARD_CORRECTION_THRESHOLD_MS ? "hard" : abs >= WARN_CORRECTION_THRESHOLD_MS ? "warn" : "none";
    return {
      expectedPositionMs: expected,
      driftMs,
      correction
    };
  }

  // clients/shared/src/panel.ts
  function mountPanel(runtime, options) {
    const root = document.createElement("div");
    root.className = "spotify-party-root";
    root.innerHTML = markup(options.title);
    options.host.appendChild(root);
    injectStyles();
    const form = collectForm(root);
    root.querySelector("[data-action='create']").addEventListener("click", () => {
      void runtime.createRoom().catch((error) => setError(form.status, error));
    });
    root.querySelector("[data-action='connect']").addEventListener("click", () => runtime.connect());
    root.querySelector("[data-action='disconnect']").addEventListener("click", () => runtime.disconnect());
    root.querySelector("[data-action='schedule']").addEventListener("click", () => {
      void runtime.scheduleCurrentTrack().catch((error) => setError(form.status, error));
    });
    root.querySelector("[data-action='pause']").addEventListener("click", () => runtime.pauseAll());
    root.querySelector("[data-action='resume']").addEventListener("click", () => runtime.resumeAll());
    root.querySelector("[data-action='max-volume']").addEventListener("click", () => {
      void runtime.maxVolumeAll().catch((error) => setError(form.status, error));
    });
    for (const button of root.querySelectorAll("[data-cal]")) {
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
    root.querySelector("[data-action='toggle']").addEventListener("click", () => {
      root.classList.toggle("spotify-party-closed");
    });
    return () => {
      unsubscribe();
      root.remove();
    };
  }
  function render(snapshot, form) {
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
    form.clock.textContent = snapshot.clock.quality === "unsynced" ? "Clock unsynced" : `${snapshot.clock.quality} | ${snapshot.clock.uncertaintyMs.toFixed(1)} ms uncertainty`;
    form.track.textContent = snapshot.player?.uri ? compactUri(snapshot.player.uri) : "No track";
    form.drift.textContent = snapshot.lastDriftMs === null ? "Drift n/a" : `Drift ${snapshot.lastDriftMs.toFixed(0)} ms`;
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
        playback.textContent = state ? `${state.isPlaying ? "Playing" : "Paused"} ${compactOrNone(state.uri)} | ${formatPosition(state.progressMs, state.durationMs)} | vol ${formatVolume(state.volume)}` : "Playback unknown";
        const heartbeat = document.createElement("div");
        heartbeat.textContent = `Last state ${formatAge(member.playerStateAtServerMs, nowMs)} | last seen ${formatAge(member.lastSeenServerMs, nowMs)}`;
        const driftLine = document.createElement("div");
        driftLine.textContent = drift ? `Drift ${formatSignedMs(drift.driftMs)} | action ${drift.correctionAction} | report ${formatAge(drift.reportedAtServerMs, nowMs)}` : "Drift not reported yet";
        const detail = document.createElement("div");
        detail.className = "spotify-party-member-detail";
        detail.textContent = drift ? `expected ${compactOrNone(drift.expectedTrackUri)} @ ${formatMs(drift.expectedPositionMs)} | observed ${compactOrNone(drift.actualTrackUri)} @ ${formatMs(drift.observedPositionMs)} | ${drift.isPlaying ? "playing" : "paused"}` : `joined ${formatAge(member.joinedAtServerMs, nowMs)}`;
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
  function markup(title) {
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
  function collectForm(root) {
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
      members: root.querySelector("[data-field='members']"),
      logs: root.querySelector("[data-field='logs']")
    };
  }
  function readSettings(form) {
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
  function input(root, field) {
    return root.querySelector(`[data-field='${field}']`);
  }
  function select(root, field) {
    return root.querySelector(`[data-field='${field}']`);
  }
  function text(root, field) {
    return root.querySelector(`[data-field='${field}']`);
  }
  function writeIfBlurred(element, value) {
    if (document.activeElement !== element) {
      element.value = value;
    }
  }
  function setError(element, error) {
    element.textContent = error instanceof Error ? error.message : String(error);
  }
  function compactUri(uri) {
    return uri.replace("spotify:track:", "track:");
  }
  function compactOrNone(uri) {
    return uri ? compactUri(uri) : "none";
  }
  function formatPosition(progressMs, durationMs) {
    return durationMs > 0 ? `${formatMs(progressMs)} / ${formatMs(durationMs)}` : formatMs(progressMs);
  }
  function formatMs(value) {
    return `${Math.max(0, Math.round(value))}ms`;
  }
  function formatSignedMs(value) {
    const rounded = Math.round(value);
    return `${rounded > 0 ? "+" : ""}${rounded}ms`;
  }
  function formatNullableMs(value) {
    return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}ms` : "n/a";
  }
  function formatVolume(value) {
    return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "n/a";
  }
  function formatAge(valueMs, nowMs) {
    if (typeof valueMs !== "number" || !Number.isFinite(valueMs)) {
      return "n/a";
    }
    const ageMs = Math.max(0, nowMs - valueMs);
    if (ageMs < 1e3) {
      return `${Math.round(ageMs)}ms ago`;
    }
    if (ageMs < 6e4) {
      return `${(ageMs / 1e3).toFixed(1)}s ago`;
    }
    return `${Math.round(ageMs / 6e4)}m ago`;
  }
  function escapeHtml(value) {
    const span = document.createElement("span");
    span.textContent = value;
    return span.innerHTML;
  }
  function formatTime(atMs) {
    return new Date(atMs).toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }
  var stylesInjected = false;
  function injectStyles() {
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

  // clients/shared/src/settings.ts
  var PLACEHOLDER_SYNC_URL = "https://spotify-party-sync.YOUR_SUBDOMAIN.workers.dev";
  function createLocalSettingsStore(key, defaults = {}) {
    return {
      load() {
        try {
          const raw = globalThis.localStorage?.getItem(key);
          const parsed = raw ? JSON.parse(raw) : {};
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
  function normalizeSettings(settings) {
    const syncUrl = typeof settings.syncUrl === "string" && settings.syncUrl.trim() ? settings.syncUrl.trim() : MANAGED_SYNC_URL;
    const inferredMode = settings.syncMode === "selfhosted" || settings.syncMode === void 0 && syncUrl !== MANAGED_SYNC_URL && syncUrl !== PLACEHOLDER_SYNC_URL ? "selfhosted" : "managed";
    return {
      ...DEFAULT_SETTINGS,
      ...settings,
      syncMode: inferredMode,
      syncUrl: syncUrl === PLACEHOLDER_SYNC_URL ? MANAGED_SYNC_URL : syncUrl,
      calibrationMs: finite(settings.calibrationMs, DEFAULT_SETTINGS.calibrationMs),
      commandLeadMs: finite(settings.commandLeadMs, DEFAULT_SETTINGS.commandLeadMs)
    };
  }
  function finite(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  // clients/shared/src/room-client.ts
  var MAX_LOG_ENTRIES = 80;
  var CORRECTION_RETRY_MS = 2e3;
  var SpotifyPartyRuntime = class {
    constructor(adapter, store) {
      this.adapter = adapter;
      this.store = store;
      this.settings = normalizeSettings(this.store.load());
      this.adapter.onStateChange((state) => {
        this.player = state;
        this.emit();
      });
    }
    settings;
    socket = null;
    clock = new ClockEstimator();
    listeners = /* @__PURE__ */ new Set();
    members = [];
    player = null;
    clientId = null;
    status = "Idle";
    pingSeq = 0;
    pingTimer = null;
    stateTimer = null;
    driftTimer = null;
    activeSchedule = null;
    lastDriftMs = null;
    correctionRetryAfterMs = 0;
    logSeq = 0;
    lastLoggedClockQuality = null;
    logs = [];
    pendingPings = /* @__PURE__ */ new Map();
    subscribe(listener) {
      this.listeners.add(listener);
      listener(this.snapshot());
      return () => this.listeners.delete(listener);
    }
    getSnapshot() {
      return this.snapshot();
    }
    setSettings(patch) {
      this.settings = normalizeSettings({ ...this.settings, ...patch });
      this.store.save(this.settings);
      this.log("Updated settings", summarizeSettingsPatch(patch));
      this.emit();
    }
    nudgeCalibration(deltaMs) {
      this.setSettings({ calibrationMs: this.settings.calibrationMs + deltaMs });
    }
    async createRoom() {
      this.setStatus("Creating room...");
      const response = await fetch(roomHttpUrl(this.syncBaseUrl(), "/rooms"), {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(`Room creation failed: HTTP ${response.status}`);
      }
      const body = await response.json();
      this.setSettings({
        roomCode: body.roomCode,
        hostToken: body.hostToken,
        role: "host"
      });
      this.setStatus(`Room ${body.roomCode} created`, `room=${body.roomCode}`);
    }
    connect() {
      if (this.socket) {
        this.disconnect();
      }
      if (!this.settings.roomCode.trim()) {
        this.setStatus("Enter a room code first");
        return;
      }
      const socket = new WebSocket(roomWsUrl(this.syncBaseUrl(), this.settings.roomCode));
      this.socket = socket;
      this.setStatus("Connecting...", `room=${this.settings.roomCode}, mode=${this.settings.syncMode}`);
      socket.addEventListener("open", () => {
        this.log("WebSocket opened", `role=${this.settings.role}, adapter=${this.adapter.kind}`);
        this.send({
          type: "hello",
          clientId: this.clientId || void 0,
          name: this.settings.name,
          role: this.settings.role,
          adapter: this.adapter.kind,
          hostToken: this.settings.role === "host" ? this.settings.hostToken : void 0,
          calibrationMs: this.settings.calibrationMs
        });
        this.startTimers();
        this.setStatus("Connected");
      });
      socket.addEventListener("message", (event) => {
        void this.handleRawMessage(String(event.data)).catch((error) => {
          this.setStatus(formatRuntimeError(error), void 0, "error");
        });
      });
      socket.addEventListener("close", () => {
        this.stopTimers();
        if (this.socket === socket) {
          this.socket = null;
        }
        this.setStatus("Disconnected");
      });
      socket.addEventListener("error", () => {
        this.setStatus("WebSocket error", void 0, "error");
      });
    }
    disconnect() {
      this.log("Disconnect requested");
      this.stopTimers();
      this.socket?.close(1e3, "Client disconnect");
      this.socket = null;
      this.setStatus("Disconnected");
    }
    async scheduleCurrentTrack() {
      const state = await this.safeGetState();
      if (!state.uri) {
        this.setStatus("No Spotify track is playing", void 0, "warn");
        return;
      }
      this.log("Scheduling current track", `${compactTrackUri(state.uri)} at ${formatMs2(state.progressMs)}`);
      await this.adapter.setVolume(1).catch(() => {
        this.log("Skipped local max-volume before schedule", "Spotify rejected volume command", "warn");
      });
      const startServerMs = this.clock.serverNowMs() + DEFAULT_START_DELAY_MS;
      const commandId = randomId("play_");
      this.send({
        type: "schedule_playback",
        hostToken: this.settings.hostToken,
        payload: {
          commandId,
          trackUri: state.uri,
          startServerMs,
          startPositionMs: state.progressMs + DEFAULT_START_DELAY_MS,
          durationMs: state.durationMs || null
        }
      });
      this.setStatus("Scheduled playback", `command=${commandId}, startsIn=${DEFAULT_START_DELAY_MS}ms`);
    }
    pauseAll() {
      const commandId = randomId("pause_");
      this.log("Broadcasting pause", `command=${commandId}`);
      this.send({
        type: "pause_all",
        commandId,
        hostToken: this.settings.hostToken
      });
    }
    resumeAll() {
      const commandId = randomId("resume_");
      const startServerMs = this.clock.serverNowMs() + 750;
      this.log("Broadcasting resume", `command=${commandId}, startsIn=750ms`);
      this.send({
        type: "resume_all",
        commandId,
        startServerMs,
        hostToken: this.settings.hostToken
      });
    }
    async maxVolumeAll() {
      this.log("Setting local max volume");
      await this.adapter.setVolume(1);
      const commandId = randomId("volume_");
      this.log("Broadcasting max volume", `command=${commandId}`);
      this.send({
        type: "set_volume_all",
        commandId,
        volume: 1,
        hostToken: this.settings.hostToken
      });
    }
    async handleRawMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        this.setStatus("Invalid server message", void 0, "error");
        return;
      }
      switch (message.type) {
        case "hello_ack":
          this.clientId = message.clientId;
          this.members = message.members;
          this.setStatus(`Connected to ${message.roomCode}`, `members=${message.members.length}`);
          return;
        case "clock_pong": {
          const clientReceiveMs = monotonicNowMs();
          this.pendingPings.delete(message.payload.seq);
          const stats = this.clock.add(createClockSample({ ...message.payload, clientReceiveMs }));
          if (stats.quality !== this.lastLoggedClockQuality) {
            this.lastLoggedClockQuality = stats.quality;
            this.log("Clock quality changed", `quality=${stats.quality}, uncertainty=${stats.uncertaintyMs.toFixed(1)}ms`);
          }
          this.emit();
          return;
        }
        case "members":
          this.members = message.members;
          this.log("Member list updated", `members=${message.members.length}`);
          this.emit();
          return;
        case "schedule_playback":
          await this.executeSchedule(message.payload);
          return;
        case "pause_all":
          this.log("Applying pause command", `command=${message.commandId}`);
          await this.adapter.pause();
          this.setStatus("Paused");
          return;
        case "resume_all":
          this.log("Applying resume command", `command=${message.commandId}`);
          await this.runAtServerTime(message.startServerMs, () => this.adapter.play(), "resume");
          this.setStatus("Resumed");
          return;
        case "seek_all":
          this.log("Applying seek command", `command=${message.commandId}, position=${formatMs2(message.positionMs)}`);
          await this.runAtServerTime(message.startServerMs, () => this.adapter.seek(message.positionMs), "seek");
          this.setStatus("Seeked", `position=${formatMs2(message.positionMs)}`);
          return;
        case "set_volume_all":
          this.log("Applying volume command", `volume=${message.volume}`);
          await this.adapter.setVolume(message.volume);
          this.setStatus("Volume set");
          return;
        case "error":
          this.setStatus(`${message.code}: ${message.message}`, void 0, "error");
          return;
      }
    }
    async executeSchedule(schedule) {
      this.activeSchedule = schedule;
      this.lastDriftMs = null;
      this.emit();
      this.setStatus(
        "Preparing playback...",
        `${compactTrackUri(schedule.trackUri)} at ${formatMs2(schedule.startPositionMs)}`
      );
      await this.adapter.setVolume(1).catch(() => {
        this.log("Skipped max-volume before playback", "Spotify rejected volume command", "warn");
      });
      const stats = this.clock.getStats();
      const runAtLocalMs = schedule.startServerMs - stats.offsetMs - this.settings.commandLeadMs;
      this.log(
        "Waiting for scheduled start",
        `wait=${Math.max(0, runAtLocalMs - monotonicNowMs()).toFixed(0)}ms, lead=${this.settings.commandLeadMs}ms`
      );
      await sleep(runAtLocalMs - monotonicNowMs());
      const commandPositionMs = Math.max(0, schedule.startPositionMs + this.settings.calibrationMs);
      this.log(
        "Starting scheduled track",
        `${compactTrackUri(schedule.trackUri)} at ${formatMs2(commandPositionMs)} (cal=${this.settings.calibrationMs}ms)`
      );
      await this.adapter.playUri(schedule.trackUri, commandPositionMs);
      this.setStatus("Playback started");
      this.startDriftMonitor(schedule);
    }
    async runAtServerTime(serverTimeMs, action, label) {
      const stats = this.clock.getStats();
      this.log("Waiting for timed command", `action=${label}, wait=${Math.max(0, serverTimeMs - stats.offsetMs - monotonicNowMs()).toFixed(0)}ms`);
      await sleep(serverTimeMs - stats.offsetMs - monotonicNowMs());
      await action();
    }
    startDriftMonitor(schedule) {
      if (this.driftTimer !== null) {
        clearInterval(this.driftTimer);
      }
      this.driftTimer = window.setInterval(async () => {
        const state = await this.adapter.getState().catch((error) => {
          this.setStatus(formatRuntimeError(error));
          return null;
        });
        if (!state) {
          return;
        }
        const stats = this.clock.getStats();
        const timing = evaluatePlaybackTiming({
          schedule,
          serverNowMs: this.clock.serverNowMs(),
          observedPositionMs: state.progressMs,
          audioOffsetMs: this.settings.calibrationMs
        });
        this.player = state;
        this.lastDriftMs = timing.driftMs;
        let correctionAction = "none";
        const needsCorrection = state.uri !== schedule.trackUri || !state.isPlaying || timing.correction === "hard";
        if (Date.now() >= this.correctionRetryAfterMs) {
          correctionAction = await this.correctPlaybackIfNeeded(schedule, state, timing);
        } else if (needsCorrection) {
          correctionAction = "throttled";
        }
        this.send({
          type: "drift_report",
          commandId: schedule.commandId,
          expectedTrackUri: schedule.trackUri,
          actualTrackUri: state.uri,
          isPlaying: state.isPlaying,
          driftMs: timing.driftMs,
          expectedPositionMs: timing.expectedPositionMs,
          observedPositionMs: state.progressMs,
          uncertaintyMs: stats.uncertaintyMs,
          correction: timing.correction,
          correctionAction
        });
        this.emit();
      }, 500);
    }
    async correctPlaybackIfNeeded(schedule, state, timing) {
      const expectedMs = expectedPositionMs({
        schedule,
        serverNowMs: this.clock.serverNowMs(),
        audioOffsetMs: this.settings.calibrationMs
      });
      const wrongTrack = state.uri !== schedule.trackUri;
      const wrongPlaybackState = !state.isPlaying;
      if (!wrongTrack && !wrongPlaybackState && timing.correction !== "hard") {
        return "none";
      }
      this.correctionRetryAfterMs = Date.now() + CORRECTION_RETRY_MS;
      try {
        if (wrongTrack) {
          this.log(
            "Correcting playback state: wrong track",
            `expected=${compactTrackUri(schedule.trackUri)}, actual=${state.uri ? compactTrackUri(state.uri) : "none"}, position=${formatMs2(expectedMs)}`,
            "warn"
          );
          await this.adapter.playUri(schedule.trackUri, expectedMs);
          this.setStatus("Corrected track", compactTrackUri(schedule.trackUri));
          return "play_track";
        }
        if (wrongPlaybackState) {
          this.log(
            "Correcting playback state: paused",
            `track=${compactTrackUri(schedule.trackUri)}, position=${formatMs2(expectedMs)}`,
            "warn"
          );
          await this.adapter.playUri(schedule.trackUri, expectedMs);
          this.setStatus("Corrected playback state");
          return "resume_track";
        }
        this.log(
          "Correcting out-of-sync playback",
          `drift=${timing.driftMs.toFixed(0)}ms, position=${formatMs2(expectedMs)}`,
          "warn"
        );
        await this.adapter.seek(expectedMs);
        this.setStatus("Corrected drift", `drift=${timing.driftMs.toFixed(0)}ms`);
        return "seek";
      } catch (error) {
        this.correctionRetryAfterMs = Date.now() + 1e4;
        this.setStatus(formatRuntimeError(error), void 0, "error");
        return "failed";
      }
    }
    startTimers() {
      this.stopTimers();
      this.pingTimer = window.setInterval(() => this.ping(), 750);
      this.stateTimer = window.setInterval(() => void this.reportState(), 5e3);
      this.log("Started sync timers", "clock=750ms, state=5000ms");
      this.ping();
      void this.reportState();
    }
    stopTimers() {
      let stoppedAny = false;
      if (this.pingTimer !== null) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        stoppedAny = true;
      }
      if (this.stateTimer !== null) {
        clearInterval(this.stateTimer);
        this.stateTimer = null;
        stoppedAny = true;
      }
      if (this.driftTimer !== null) {
        clearInterval(this.driftTimer);
        this.driftTimer = null;
        stoppedAny = true;
      }
      if (stoppedAny) {
        this.log("Stopped sync timers");
      }
    }
    ping() {
      const seq = ++this.pingSeq;
      const clientSendMs = monotonicNowMs();
      this.pendingPings.set(seq, clientSendMs);
      this.send({
        type: "clock_ping",
        payload: { seq, clientSendMs }
      });
    }
    async reportState() {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const state = await this.safeGetState();
      const stats = this.clock.getStats();
      this.player = state;
      this.log(
        "Reported member state",
        `${state.uri ? compactTrackUri(state.uri) : "no track"}, quality=${stats.quality}`
      );
      this.send({
        type: "member_state",
        state,
        calibrationMs: this.settings.calibrationMs,
        syncQuality: stats.quality,
        uncertaintyMs: Number.isFinite(stats.uncertaintyMs) ? stats.uncertaintyMs : null
      });
      this.emit();
    }
    async safeGetState() {
      try {
        return await this.adapter.getState();
      } catch (error) {
        this.setStatus(error instanceof Error ? error.message : "Could not read Spotify state", void 0, "error");
        return {
          uri: null,
          progressMs: 0,
          durationMs: 0,
          isPlaying: false,
          volume: null,
          observedAtMs: monotonicNowMs()
        };
      }
    }
    send(message) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        this.setStatus("Not connected", summarizeClientMessage(message), "warn");
        return;
      }
      this.socket.send(encodeClientMessage(message));
      if (message.type !== "clock_ping" && message.type !== "member_state") {
        this.log("Sent room message", summarizeClientMessage(message));
      }
    }
    setStatus(status, details, level = "info") {
      this.status = status;
      this.log(status, details, level);
      this.emit();
    }
    snapshot() {
      return {
        settings: this.settings,
        connected: this.socket?.readyState === WebSocket.OPEN,
        clientId: this.clientId,
        status: this.status,
        members: this.members,
        clock: this.clock.getStats(),
        player: this.player,
        activeSchedule: this.activeSchedule,
        lastDriftMs: this.lastDriftMs,
        logs: [...this.logs]
      };
    }
    emit() {
      const snapshot = this.snapshot();
      for (const listener of this.listeners) {
        listener(snapshot);
      }
    }
    syncBaseUrl() {
      return this.settings.syncMode === "managed" ? MANAGED_SYNC_URL : this.settings.syncUrl;
    }
    log(message, details, level = "info") {
      const entry = {
        id: ++this.logSeq,
        atMs: Date.now(),
        level,
        message,
        details
      };
      this.logs.unshift(entry);
      if (this.logs.length > MAX_LOG_ENTRIES) {
        this.logs.length = MAX_LOG_ENTRIES;
      }
      const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
      consoleMethod.call(console, `[SpotifyParty] ${message}${details ? ` | ${details}` : ""}`);
    }
  };
  function roomHttpUrl(syncUrl, path) {
    const url = new URL(syncUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
    return url.toString();
  }
  function roomWsUrl(syncUrl, roomCode) {
    const url = new URL(syncUrl);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/ws/${encodeURIComponent(roomCode.trim())}`;
    return url.toString();
  }
  function formatRuntimeError(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function summarizeSettingsPatch(patch) {
    const entries = Object.entries(patch).filter(([key]) => key !== "hostToken").map(([key, value]) => `${key}=${String(value)}`);
    return entries.join(", ");
  }
  function summarizeClientMessage(message) {
    switch (message.type) {
      case "hello":
        return `hello role=${message.role}, adapter=${message.adapter}, cal=${message.calibrationMs}ms`;
      case "clock_ping":
        return `clock_ping seq=${message.payload.seq}`;
      case "member_state":
        return `member_state ${message.state.uri ? compactTrackUri(message.state.uri) : "no track"}, quality=${message.syncQuality}`;
      case "schedule_playback":
        return `schedule_playback ${compactTrackUri(message.payload.trackUri)} at ${formatMs2(message.payload.startPositionMs)}`;
      case "pause_all":
        return `pause_all command=${message.commandId}`;
      case "resume_all":
        return `resume_all command=${message.commandId}`;
      case "seek_all":
        return `seek_all command=${message.commandId}, position=${formatMs2(message.positionMs)}`;
      case "set_volume_all":
        return `set_volume_all command=${message.commandId}, volume=${message.volume}`;
    }
    return "unknown client message";
  }
  function compactTrackUri(uri) {
    return uri.replace("spotify:track:", "track:");
  }
  function formatMs2(value) {
    return `${Math.max(0, Math.round(value))}ms`;
  }

  // clients/tampermonkey/src/index.ts
  var INTERNAL_TOKEN_WAIT_MS = 5e3;
  var INTERNAL_TOKEN_POLL_MS = 250;
  var SPOTIFY_RATE_LIMIT_BACKOFF_MS = 6e4;
  var SPOTIFY_PARTY_FEATURE = "spotify_party";
  var capturedToken = null;
  var tokenExpiresAtMs = 0;
  var legacyTokenRetryAfterMs = 0;
  var apiRetryAfterMs = 0;
  var spotifyRequire = null;
  var spotifyRegistry = null;
  var spotifyPlayerApi = null;
  var spotifyPlaybackApi = null;
  var capturedPlaybackState = null;
  installTokenBridge();
  void boot();
  async function boot() {
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
  function createWebAdapter() {
    const listeners = /* @__PURE__ */ new Set();
    let timer = null;
    async function emitState() {
      const state = await getState().catch(() => null);
      if (!state) {
        return;
      }
      for (const listener of listeners) {
        listener(state);
      }
    }
    async function getState() {
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
      return localState;
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
          timer = window.setInterval(() => void emitState(), 5e3);
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
  async function spotifyFetch(url, init = {}) {
    if (Date.now() < apiRetryAfterMs) {
      throw new Error("Spotify is rate limiting this browser. Wait a minute, refresh Spotify, start any track once, then reconnect.");
    }
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
      return void 0;
    }
    if (!response.ok) {
      if (response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1e3 : SPOTIFY_RATE_LIMIT_BACKOFF_MS;
        apiRetryAfterMs = Math.max(apiRetryAfterMs, Date.now() + retryAfterMs);
      }
      const body = await response.text().catch(() => "");
      const message = response.status === 429 ? "Spotify is rate limiting this browser. Wait a minute, refresh Spotify, start any track once, then reconnect." : `Spotify API failed: HTTP ${response.status} ${body}`.trim();
      throw new Error(message);
    }
    return await response.json();
  }
  async function getSpotifyToken() {
    const internalToken = readInternalSpotifyToken();
    if (internalToken) {
      capturedToken = internalToken;
      tokenExpiresAtMs = Date.now() + 5 * 6e4;
      return internalToken;
    }
    if (capturedToken && Date.now() < tokenExpiresAtMs - 6e4) {
      return capturedToken;
    }
    const delayedInternalToken = await waitForInternalSpotifyToken();
    if (delayedInternalToken) {
      capturedToken = delayedInternalToken;
      tokenExpiresAtMs = Date.now() + 5 * 6e4;
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
        legacyTokenRetryAfterMs = Date.now() + 6e4;
      }
      throw new Error("Could not read Spotify web token. Refresh Spotify and start playback once.");
    }
    const body = await response.json();
    if (!body.accessToken) {
      throw new Error("Spotify web token missing. Make sure you are logged in to open.spotify.com.");
    }
    capturedToken = body.accessToken;
    tokenExpiresAtMs = body.accessTokenExpirationTimestampMs ?? Date.now() + 30 * 6e4;
    return capturedToken;
  }
  async function waitForInternalSpotifyToken() {
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
  function readInternalSpotifyToken() {
    try {
      const require2 = getSpotifyRequire();
      if (!require2?.m) {
        return null;
      }
      for (const [id, factory] of Object.entries(require2.m)) {
        if (typeof factory !== "function") {
          continue;
        }
        const source = Function.prototype.toString.call(factory);
        if (!source.includes("accessToken") || !source.includes("setSession") || !source.includes("getInstance") || !source.includes("resetInstance")) {
          continue;
        }
        const moduleExports = require2(Number(id));
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
  function getSpotifyRequire() {
    if (spotifyRequire) {
      return spotifyRequire;
    }
    const page = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
    const chunk = page.webpackChunkclient_web;
    if (!Array.isArray(chunk)) {
      return null;
    }
    const chunkId = `spotify_party_runtime_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    chunk.push([[chunkId], {}, (runtimeRequire) => {
      spotifyRequire = runtimeRequire;
    }]);
    return spotifyRequire;
  }
  function isTokenStoreClass(value) {
    return typeof value === "function" && typeof value.getInstance === "function";
  }
  function readInternalPlayerState() {
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
  function normalizeInternalPlayerState(state) {
    const uri = typeof state.item?.uri === "string" ? state.item.uri : null;
    if (!uri?.startsWith("spotify:track:")) {
      return null;
    }
    const durationMs = finiteNumber(state.duration) || finiteNumber(state.item?.duration?.milliseconds) || finiteNumber(state.item?.metadata?.duration);
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
  function readInternalProgressMs(state, durationMs) {
    const metadataPosition = finiteNumber(state.item?.metadata?.["segment.position_as_of_timestamp"]);
    const positionMs = finiteNumber(state.positionAsOfTimestamp) || finiteNumber(state.position) || metadataPosition;
    if (state.hasContext === false || state.isPaused === true || state.isBuffering === true) {
      return clampProgress(positionMs, durationMs);
    }
    const timestampMs = finiteNumber(state.timestamp);
    const speed = state.speed === void 0 || state.speed === null ? 1 : finiteNumber(state.speed);
    const elapsedMs = timestampMs > 0 && speed > 0 ? (Date.now() - timestampMs) * speed : 0;
    return clampProgress(positionMs + elapsedMs, durationMs);
  }
  function clampProgress(positionMs, durationMs) {
    const safePositionMs = Math.max(0, positionMs);
    return durationMs > 0 ? Math.min(durationMs, safePositionMs) : safePositionMs;
  }
  function getSpotifyPlayerApi() {
    if (isSpotifyPlayerApi(spotifyPlayerApi)) {
      return spotifyPlayerApi;
    }
    spotifyPlayerApi = getSpotifyService("PlayerAPI", isSpotifyPlayerApi);
    return spotifyPlayerApi;
  }
  function getSpotifyPlaybackApi() {
    if (isSpotifyPlaybackApi(spotifyPlaybackApi)) {
      return spotifyPlaybackApi;
    }
    spotifyPlaybackApi = getSpotifyService("PlaybackAPI", isSpotifyPlaybackApi);
    return spotifyPlaybackApi;
  }
  function getSpotifyService(name, isService) {
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
  function getSpotifyRegistry() {
    if (isSpotifyRegistry(spotifyRegistry) && getSpotifyServiceNoCache(spotifyRegistry, "PlayerAPI", isSpotifyPlayerApi)) {
      return spotifyRegistry;
    }
    spotifyRegistry = findSpotifyRegistryFromReact();
    return spotifyRegistry;
  }
  function getSpotifyServiceNoCache(registry, name, isService) {
    try {
      const service = registry.resolve(Symbol.for(name));
      return isService(service) ? service : null;
    } catch {
      return null;
    }
  }
  function findSpotifyRegistryFromReact() {
    const stack = collectReactFibers();
    const seen = /* @__PURE__ */ new Set();
    let visited = 0;
    while (stack.length > 0 && visited < 12e4) {
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
  function collectReactFibers() {
    const roots = [];
    const candidates = /* @__PURE__ */ new Set();
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
          const fiber = element[key];
          if (isReactFiber(fiber)) {
            roots.push(fiber);
          }
        }
      }
    }
    return roots;
  }
  function isReactFiber(value) {
    return !!value && typeof value === "object";
  }
  function isSpotifyRegistry(value) {
    return !!value && typeof value === "object" && typeof value.resolve === "function";
  }
  function isSpotifyPlayerApi(value) {
    return !!value && typeof value === "object" && typeof value.getState === "function";
  }
  function isSpotifyPlaybackApi(value) {
    return !!value && typeof value === "object" && (typeof value.setVolume === "function" || typeof value.getVolume === "function");
  }
  async function playUriWithInternalPlayer(uri, positionMs) {
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
  async function seekWithInternalPlayer(positionMs) {
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
  async function resumeWithInternalPlayer() {
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
  async function pauseWithInternalPlayer() {
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
  async function setVolumeWithInternalPlayer(level) {
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
  function createInternalCommandOrigin(player) {
    return {
      featureIdentifier: SPOTIFY_PARTY_FEATURE,
      referrerIdentifier: player.getReferrer?.() ?? SPOTIFY_PARTY_FEATURE
    };
  }
  function readCapturedPlaybackState() {
    if (!capturedPlaybackState?.uri) {
      return null;
    }
    const elapsedMs = capturedPlaybackState.isPlaying && Number.isFinite(capturedPlaybackState.capturedAtMs) ? Math.max(0, Date.now() - capturedPlaybackState.capturedAtMs) : 0;
    const durationMs = Math.max(0, capturedPlaybackState.durationMs || 0);
    const progressMs = Math.max(
      0,
      durationMs > 0 ? Math.min(durationMs, capturedPlaybackState.progressMs + elapsedMs) : capturedPlaybackState.progressMs + elapsedMs
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
  function readFallbackState() {
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
  function readNowPlayingUri() {
    const uriFromUrl = uriFromHref(location.href);
    if (uriFromUrl) {
      return uriFromUrl;
    }
    const nowPlayingLinks = [
      ...document.querySelectorAll(
        "a[aria-label^='Now playing:'], [aria-label='Now playing bar'] a[href], [aria-label='Now playing view'] a[href]"
      )
    ];
    for (const link of nowPlayingLinks) {
      const uri = uriFromHref(link.href);
      if (uri) {
        return uri;
      }
    }
    const trackLink = document.querySelector(
      "a[href*='uri=spotify%3Atrack'], a[href*='uri=spotify:track'], a[href*='/track/']"
    );
    const uriFromLink = trackLink ? uriFromHref(trackLink.href) : null;
    if (uriFromLink) {
      return uriFromLink;
    }
    const trackIdFromLink = trackLink?.href.match(/\/track\/([A-Za-z0-9]+)/)?.[1] ?? null;
    return trackIdFromLink ? `spotify:track:${trackIdFromLink}` : null;
  }
  function uriFromHref(href) {
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
  function readProgressFromPlayerControls() {
    const controls = document.querySelector("[aria-label='Player controls']");
    const matches = (controls?.textContent ?? "").match(/\b(?:\d+:)?\d+:\d{2}\b/g) ?? [];
    return {
      progressMs: timeTextToMs(matches[0]),
      durationMs: timeTextToMs(matches[1])
    };
  }
  function timeTextToMs(value) {
    if (!value) {
      return 0;
    }
    const parts = value.split(":").map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part))) {
      return 0;
    }
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return seconds * 1e3;
  }
  function isSpotifyPlayingFromPage() {
    return !!document.querySelector("button[aria-label='Pause']") || !!document.querySelector("[aria-label='Now playing bar'] button[aria-label^='Pause']");
  }
  function readStoredVolume() {
    try {
      const body = JSON.parse(localStorage.getItem("playback") ?? "{}");
      return typeof body.volume === "number" ? body.volume : null;
    } catch {
      return null;
    }
  }
  function readSliderNumber(element, key) {
    if (!element) {
      return 0;
    }
    const htmlValue = element instanceof HTMLInputElement ? key === "value" ? element.value : element.max : element.getAttribute(key) ?? element.getAttribute(`aria-value${key === "max" ? "max" : "now"}`);
    const value = Number(htmlValue);
    return Number.isFinite(value) ? value : 0;
  }
  function installTokenBridge() {
    window.addEventListener("spotify-party-token", (event) => {
      const detail = event.detail;
      if (detail?.token) {
        capturedToken = detail.token;
        tokenExpiresAtMs = Date.now() + 30 * 6e4;
      }
    });
    window.addEventListener("spotify-party-player-state", (event) => {
      const state = normalizeCapturedPlaybackState(event.detail);
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
  function normalizeCapturedPlaybackState(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const state = value;
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
  function finiteNumber(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }
  async function waitForDocument() {
    if (document.body) {
      return;
    }
    await new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
    });
  }
})();
//# sourceMappingURL=spotify-party.user.js.map

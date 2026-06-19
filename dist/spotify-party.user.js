// ==UserScript==
// @name         SpotifyParty
// @namespace    https://github.com/local/spotify-party
// @version      0.1.0
// @description  Sync Spotify web playback with SpotifyParty rooms.
// @match        https://open.spotify.com/*
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
        row.textContent = `${member.name} | ${member.role} | ${member.syncQuality}`;
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
      <div class="spotify-party-grid">
        <label>Room <input data-field="room-code" spellcheck="false"></label>
        <label>Role
          <select data-field="role">
            <option value="speaker">speaker</option>
            <option value="host">host</option>
          </select>
        </label>
      </div>
      <label>Name <input data-field="name" spellcheck="false"></label>
      <label>Host token <input data-field="host-token" spellcheck="false"></label>
      <div class="spotify-party-grid">
        <label>Calibration <input data-field="calibration-ms" type="number" step="10"></label>
        <label>Command lead <input data-field="command-lead-ms" type="number" step="10"></label>
      </div>
      <div class="spotify-party-buttons">
        <button type="button" data-action="create">Create</button>
        <button type="button" data-action="connect">Connect</button>
        <button type="button" data-action="disconnect">Disconnect</button>
      </div>
      <div class="spotify-party-buttons">
        <button type="button" data-action="schedule">Sync Track</button>
        <button type="button" data-action="pause">Pause</button>
        <button type="button" data-action="resume">Resume</button>
        <button type="button" data-action="max-volume">Max Vol</button>
      </div>
      <div class="spotify-party-buttons">
        <button type="button" data-cal="-50">-50</button>
        <button type="button" data-cal="-10">-10</button>
        <button type="button" data-cal="10">+10</button>
        <button type="button" data-cal="50">+50</button>
      </div>
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
      members: root.querySelector("[data-field='members']")
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
  function escapeHtml(value) {
    const span = document.createElement("span");
    span.textContent = value;
    return span.innerHTML;
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
    .spotify-party-buttons {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .spotify-party-buttons {
      grid-template-columns: repeat(4, minmax(0, 1fr));
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
    .spotify-party-members {
      display: grid;
      gap: 4px;
      max-height: 96px;
      overflow: auto;
    }
    .spotify-party-member {
      padding: 5px 6px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.07);
      color: #e2e8f0;
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
      this.setStatus(`Room ${body.roomCode} created`);
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
      this.setStatus("Connecting...");
      socket.addEventListener("open", () => {
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
      socket.addEventListener("message", (event) => this.handleRawMessage(String(event.data)));
      socket.addEventListener("close", () => {
        this.stopTimers();
        if (this.socket === socket) {
          this.socket = null;
        }
        this.setStatus("Disconnected");
      });
      socket.addEventListener("error", () => {
        this.setStatus("WebSocket error");
      });
    }
    disconnect() {
      this.stopTimers();
      this.socket?.close(1e3, "Client disconnect");
      this.socket = null;
      this.setStatus("Disconnected");
    }
    async scheduleCurrentTrack() {
      const state = await this.safeGetState();
      if (!state.uri) {
        this.setStatus("No Spotify track is playing");
        return;
      }
      await this.adapter.setVolume(1);
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
      this.setStatus("Scheduled playback");
    }
    pauseAll() {
      this.send({
        type: "pause_all",
        commandId: randomId("pause_"),
        hostToken: this.settings.hostToken
      });
    }
    resumeAll() {
      this.send({
        type: "resume_all",
        commandId: randomId("resume_"),
        startServerMs: this.clock.serverNowMs() + 750,
        hostToken: this.settings.hostToken
      });
    }
    async maxVolumeAll() {
      await this.adapter.setVolume(1);
      this.send({
        type: "set_volume_all",
        commandId: randomId("volume_"),
        volume: 1,
        hostToken: this.settings.hostToken
      });
    }
    async handleRawMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        this.setStatus("Invalid server message");
        return;
      }
      switch (message.type) {
        case "hello_ack":
          this.clientId = message.clientId;
          this.members = message.members;
          this.setStatus(`Connected to ${message.roomCode}`);
          return;
        case "clock_pong": {
          const clientReceiveMs = monotonicNowMs();
          this.pendingPings.delete(message.payload.seq);
          this.clock.add(createClockSample({ ...message.payload, clientReceiveMs }));
          this.emit();
          return;
        }
        case "members":
          this.members = message.members;
          this.emit();
          return;
        case "schedule_playback":
          await this.executeSchedule(message.payload);
          return;
        case "pause_all":
          await this.adapter.pause();
          this.setStatus("Paused");
          return;
        case "resume_all":
          await this.runAtServerTime(message.startServerMs, () => this.adapter.play());
          this.setStatus("Resumed");
          return;
        case "seek_all":
          await this.runAtServerTime(message.startServerMs, () => this.adapter.seek(message.positionMs));
          this.setStatus("Seeked");
          return;
        case "set_volume_all":
          await this.adapter.setVolume(message.volume);
          this.setStatus("Volume set");
          return;
        case "error":
          this.setStatus(`${message.code}: ${message.message}`);
          return;
      }
    }
    async executeSchedule(schedule) {
      this.activeSchedule = schedule;
      this.lastDriftMs = null;
      this.emit();
      this.setStatus("Preparing playback...");
      await this.adapter.setVolume(1);
      const stats = this.clock.getStats();
      const runAtLocalMs = schedule.startServerMs - stats.offsetMs - this.settings.commandLeadMs;
      await sleep(runAtLocalMs - monotonicNowMs());
      const commandPositionMs = Math.max(0, schedule.startPositionMs + this.settings.calibrationMs);
      await this.adapter.playUri(schedule.trackUri, commandPositionMs);
      this.setStatus("Playback started");
      this.startDriftMonitor(schedule);
    }
    async runAtServerTime(serverTimeMs, action) {
      const stats = this.clock.getStats();
      await sleep(serverTimeMs - stats.offsetMs - monotonicNowMs());
      await action();
    }
    startDriftMonitor(schedule) {
      if (this.driftTimer !== null) {
        clearInterval(this.driftTimer);
      }
      this.driftTimer = window.setInterval(async () => {
        const state = await this.adapter.getState();
        const stats = this.clock.getStats();
        const timing = evaluatePlaybackTiming({
          schedule,
          serverNowMs: this.clock.serverNowMs(),
          observedPositionMs: state.progressMs,
          audioOffsetMs: this.settings.calibrationMs
        });
        this.player = state;
        this.lastDriftMs = timing.driftMs;
        if (timing.correction === "hard" && state.isPlaying) {
          await this.adapter.seek(expectedPositionMs({
            schedule,
            serverNowMs: this.clock.serverNowMs(),
            audioOffsetMs: this.settings.calibrationMs
          }));
        }
        this.send({
          type: "drift_report",
          commandId: schedule.commandId,
          driftMs: timing.driftMs,
          expectedPositionMs: timing.expectedPositionMs,
          observedPositionMs: state.progressMs,
          uncertaintyMs: stats.uncertaintyMs
        });
        this.emit();
      }, 500);
    }
    startTimers() {
      this.stopTimers();
      this.pingTimer = window.setInterval(() => this.ping(), 750);
      this.stateTimer = window.setInterval(() => void this.reportState(), 5e3);
      this.ping();
      void this.reportState();
    }
    stopTimers() {
      if (this.pingTimer !== null) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.stateTimer !== null) {
        clearInterval(this.stateTimer);
        this.stateTimer = null;
      }
      if (this.driftTimer !== null) {
        clearInterval(this.driftTimer);
        this.driftTimer = null;
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
      this.send({
        type: "member_state",
        state,
        syncQuality: stats.quality,
        uncertaintyMs: Number.isFinite(stats.uncertaintyMs) ? stats.uncertaintyMs : null
      });
      this.emit();
    }
    async safeGetState() {
      try {
        return await this.adapter.getState();
      } catch (error) {
        this.setStatus(error instanceof Error ? error.message : "Could not read Spotify state");
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
        this.setStatus("Not connected");
        return;
      }
      this.socket.send(encodeClientMessage(message));
    }
    setStatus(status) {
      this.status = status;
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
        lastDriftMs: this.lastDriftMs
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

  // clients/tampermonkey/src/index.ts
  var capturedToken = null;
  var tokenExpiresAtMs = 0;
  var legacyTokenRetryAfterMs = 0;
  var apiRetryAfterMs = 0;
  var spotifyRequire = null;
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
      if (Date.now() < apiRetryAfterMs) {
        return readFallbackState();
      }
      const response = await spotifyFetch("https://api.spotify.com/v1/me/player").catch(
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
        volume: typeof response.device?.volume_percent === "number" ? response.device.volume_percent / 100 : null,
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
        if (Number.isFinite(retryAfterSeconds)) {
          apiRetryAfterMs = Math.max(apiRetryAfterMs, Date.now() + retryAfterSeconds * 1e3);
        }
      }
      const body = await response.text().catch(() => "");
      throw new Error(`Spotify API failed: HTTP ${response.status} ${body}`.trim());
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
  function readFallbackState() {
    const progressSlider = document.querySelector("[aria-label='Change progress']");
    const volumeSlider = document.querySelector("[aria-label='Change volume']");
    const url = new URL(location.href);
    const uriParam = url.searchParams.get("uri");
    const trackLink = document.querySelector("a[href*='/track/']");
    const trackIdFromLink = trackLink?.href.match(/\/track\/([A-Za-z0-9]+)/)?.[1] ?? null;
    const uri = uriParam?.startsWith("spotify:track:") ? uriParam : trackIdFromLink ? `spotify:track:${trackIdFromLink}` : null;
    return {
      uri,
      progressMs: readSliderNumber(progressSlider, "value"),
      durationMs: readSliderNumber(progressSlider, "max"),
      isPlaying: !!document.querySelector("button[aria-label='Pause']"),
      volume: readSliderNumber(volumeSlider, "value"),
      observedAtMs: monotonicNowMs()
    };
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

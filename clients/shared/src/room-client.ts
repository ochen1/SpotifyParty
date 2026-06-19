import {
  ClockEstimator,
  DEFAULT_START_DELAY_MS,
  encodeClientMessage,
  evaluatePlaybackTiming,
  expectedPositionMs,
  MANAGED_SYNC_URL,
  monotonicNowMs,
  randomId,
  sleep,
  type ClientMessage,
  type ClientSettings,
  type ClockStats,
  type DriftCorrectionAction,
  type PlayerState,
  type RoomMember,
  type ScheduledPlayback,
  type ServerMessage,
  type SpotifyPartyAdapter
} from "../../../packages/core/src";
import { createClockSample } from "../../../packages/core/src/clock";
import { normalizeSettings, type SettingsStore } from "./settings";

export interface RuntimeSnapshot {
  settings: ClientSettings;
  connected: boolean;
  clientId: string | null;
  status: string;
  members: RoomMember[];
  clock: ClockStats;
  player: PlayerState | null;
  activeSchedule: ScheduledPlayback | null;
  lastDriftMs: number | null;
  logs: RuntimeLogEntry[];
}

export interface RuntimeLogEntry {
  id: number;
  atMs: number;
  level: "info" | "warn" | "error";
  message: string;
  details?: string;
}

const MAX_LOG_ENTRIES = 80;
const CORRECTION_RETRY_MS = 2_000;

export class SpotifyPartyRuntime {
  private settings: ClientSettings;
  private socket: WebSocket | null = null;
  private readonly clock = new ClockEstimator();
  private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  private members: RoomMember[] = [];
  private player: PlayerState | null = null;
  private clientId: string | null = null;
  private status = "Idle";
  private pingSeq = 0;
  private pingTimer: number | null = null;
  private stateTimer: number | null = null;
  private driftTimer: number | null = null;
  private activeSchedule: ScheduledPlayback | null = null;
  private lastDriftMs: number | null = null;
  private correctionRetryAfterMs = 0;
  private logSeq = 0;
  private lastLoggedClockQuality: ClockStats["quality"] | null = null;
  private readonly logs: RuntimeLogEntry[] = [];
  private readonly pendingPings = new Map<number, number>();

  constructor(
    private readonly adapter: SpotifyPartyAdapter,
    private readonly store: SettingsStore
  ) {
    this.settings = normalizeSettings(this.store.load());
    this.adapter.onStateChange((state) => {
      this.player = state;
      this.emit();
    });
  }

  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): RuntimeSnapshot {
    return this.snapshot();
  }

  setSettings(patch: Partial<ClientSettings>): void {
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    this.store.save(this.settings);
    this.log("Updated settings", summarizeSettingsPatch(patch));
    this.emit();
  }

  nudgeCalibration(deltaMs: number): void {
    this.setSettings({ calibrationMs: this.settings.calibrationMs + deltaMs });
  }

  async createRoom(): Promise<void> {
    this.setStatus("Creating room...");
    const response = await fetch(roomHttpUrl(this.syncBaseUrl(), "/rooms"), {
      method: "POST"
    });

    if (!response.ok) {
      throw new Error(`Room creation failed: HTTP ${response.status}`);
    }

    const body = (await response.json()) as { roomCode: string; hostToken: string };
    this.setSettings({
      roomCode: body.roomCode,
      hostToken: body.hostToken,
      role: "host"
    });
    this.setStatus(`Room ${body.roomCode} created`, `room=${body.roomCode}`);
  }

  connect(): void {
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
        clientId: this.clientId || undefined,
        name: this.settings.name,
        role: this.settings.role,
        adapter: this.adapter.kind,
        hostToken: this.settings.role === "host" ? this.settings.hostToken : undefined,
        calibrationMs: this.settings.calibrationMs
      });
      this.startTimers();
      this.setStatus("Connected");
    });

    socket.addEventListener("message", (event) => {
      void this.handleRawMessage(String(event.data)).catch((error) => {
        this.setStatus(formatRuntimeError(error), undefined, "error");
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
      this.setStatus("WebSocket error", undefined, "error");
    });
  }

  disconnect(): void {
    this.log("Disconnect requested");
    this.stopTimers();
    this.socket?.close(1000, "Client disconnect");
    this.socket = null;
    this.setStatus("Disconnected");
  }

  async scheduleCurrentTrack(): Promise<void> {
    const state = await this.safeGetState();

    if (!state.uri) {
      this.setStatus("No Spotify track is playing", undefined, "warn");
      return;
    }

    this.log("Scheduling current track", `${compactTrackUri(state.uri)} at ${formatMs(state.progressMs)}`);
    await this.adapter.setVolume(1).catch(() => {
      // Volume is helpful for party mode, but it should never block scheduling playback.
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

  pauseAll(): void {
    const commandId = randomId("pause_");
    this.log("Broadcasting pause", `command=${commandId}`);
    this.send({
      type: "pause_all",
      commandId,
      hostToken: this.settings.hostToken
    });
  }

  resumeAll(): void {
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

  async maxVolumeAll(): Promise<void> {
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

  private async handleRawMessage(raw: string): Promise<void> {
    let message: ServerMessage;

    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.setStatus("Invalid server message", undefined, "error");
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
        this.log("Applying seek command", `command=${message.commandId}, position=${formatMs(message.positionMs)}`);
        await this.runAtServerTime(message.startServerMs, () => this.adapter.seek(message.positionMs), "seek");
        this.setStatus("Seeked", `position=${formatMs(message.positionMs)}`);
        return;
      case "set_volume_all":
        this.log("Applying volume command", `volume=${message.volume}`);
        await this.adapter.setVolume(message.volume);
        this.setStatus("Volume set");
        return;
      case "error":
        this.setStatus(`${message.code}: ${message.message}`, undefined, "error");
        return;
    }
  }

  private async executeSchedule(schedule: ScheduledPlayback): Promise<void> {
    this.activeSchedule = schedule;
    this.lastDriftMs = null;
    this.emit();
    this.setStatus(
      "Preparing playback...",
      `${compactTrackUri(schedule.trackUri)} at ${formatMs(schedule.startPositionMs)}`
    );

    await this.adapter.setVolume(1).catch(() => {
      // Keep playback scheduling resilient when Spotify rate-limits volume changes.
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
      `${compactTrackUri(schedule.trackUri)} at ${formatMs(commandPositionMs)} (cal=${this.settings.calibrationMs}ms)`
    );
    await this.adapter.playUri(schedule.trackUri, commandPositionMs);
    this.setStatus("Playback started");
    this.startDriftMonitor(schedule);
  }

  private async runAtServerTime(serverTimeMs: number, action: () => Promise<void>, label: string): Promise<void> {
    const stats = this.clock.getStats();
    this.log("Waiting for timed command", `action=${label}, wait=${Math.max(0, serverTimeMs - stats.offsetMs - monotonicNowMs()).toFixed(0)}ms`);
    await sleep(serverTimeMs - stats.offsetMs - monotonicNowMs());
    await action();
  }

  private startDriftMonitor(schedule: ScheduledPlayback): void {
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

      let correctionAction: DriftCorrectionAction = "none";
      const needsCorrection =
        state.uri !== schedule.trackUri || !state.isPlaying || timing.correction === "hard";

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

  private async correctPlaybackIfNeeded(
    schedule: ScheduledPlayback,
    state: PlayerState,
    timing: ReturnType<typeof evaluatePlaybackTiming>
  ): Promise<DriftCorrectionAction> {
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
          `expected=${compactTrackUri(schedule.trackUri)}, actual=${state.uri ? compactTrackUri(state.uri) : "none"}, position=${formatMs(expectedMs)}`,
          "warn"
        );
        await this.adapter.playUri(schedule.trackUri, expectedMs);
        this.setStatus("Corrected track", compactTrackUri(schedule.trackUri));
        return "play_track";
      }

      if (wrongPlaybackState) {
        this.log(
          "Correcting playback state: paused",
          `track=${compactTrackUri(schedule.trackUri)}, position=${formatMs(expectedMs)}`,
          "warn"
        );
        await this.adapter.playUri(schedule.trackUri, expectedMs);
        this.setStatus("Corrected playback state");
        return "resume_track";
      }

      this.log(
        "Correcting out-of-sync playback",
        `drift=${timing.driftMs.toFixed(0)}ms, position=${formatMs(expectedMs)}`,
        "warn"
      );
      await this.adapter.seek(expectedMs);
      this.setStatus("Corrected drift", `drift=${timing.driftMs.toFixed(0)}ms`);
      return "seek";
    } catch (error) {
      this.correctionRetryAfterMs = Date.now() + 10_000;
      this.setStatus(formatRuntimeError(error), undefined, "error");
      return "failed";
    }
  }

  private startTimers(): void {
    this.stopTimers();
    this.pingTimer = window.setInterval(() => this.ping(), 750);
    this.stateTimer = window.setInterval(() => void this.reportState(), 5000);
    this.log("Started sync timers", "clock=750ms, state=5000ms");
    this.ping();
    void this.reportState();
  }

  private stopTimers(): void {
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

  private ping(): void {
    const seq = ++this.pingSeq;
    const clientSendMs = monotonicNowMs();
    this.pendingPings.set(seq, clientSendMs);
    this.send({
      type: "clock_ping",
      payload: { seq, clientSendMs }
    });
  }

  private async reportState(): Promise<void> {
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

  private async safeGetState(): Promise<PlayerState> {
    try {
      return await this.adapter.getState();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : "Could not read Spotify state", undefined, "error");
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

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.setStatus("Not connected", summarizeClientMessage(message), "warn");
      return;
    }

    this.socket.send(encodeClientMessage(message));

    if (message.type !== "clock_ping" && message.type !== "member_state") {
      this.log("Sent room message", summarizeClientMessage(message));
    }
  }

  private setStatus(status: string, details?: string, level: RuntimeLogEntry["level"] = "info"): void {
    this.status = status;
    this.log(status, details, level);
    this.emit();
  }

  private snapshot(): RuntimeSnapshot {
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

  private emit(): void {
    const snapshot = this.snapshot();

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private syncBaseUrl(): string {
    return this.settings.syncMode === "managed" ? MANAGED_SYNC_URL : this.settings.syncUrl;
  }

  private log(message: string, details?: string, level: RuntimeLogEntry["level"] = "info"): void {
    const entry: RuntimeLogEntry = {
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
}

function roomHttpUrl(syncUrl: string, path: string): string {
  const url = new URL(syncUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  return url.toString();
}

function roomWsUrl(syncUrl: string, roomCode: string): string {
  const url = new URL(syncUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws/${encodeURIComponent(roomCode.trim())}`;
  return url.toString();
}

function formatRuntimeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeSettingsPatch(patch: Partial<ClientSettings>): string {
  const entries = Object.entries(patch)
    .filter(([key]) => key !== "hostToken")
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.join(", ");
}

function summarizeClientMessage(message: ClientMessage): string {
  switch (message.type) {
    case "hello":
      return `hello role=${message.role}, adapter=${message.adapter}, cal=${message.calibrationMs}ms`;
    case "clock_ping":
      return `clock_ping seq=${message.payload.seq}`;
    case "member_state":
      return `member_state ${message.state.uri ? compactTrackUri(message.state.uri) : "no track"}, quality=${message.syncQuality}`;
    case "schedule_playback":
      return `schedule_playback ${compactTrackUri(message.payload.trackUri)} at ${formatMs(message.payload.startPositionMs)}`;
    case "pause_all":
      return `pause_all command=${message.commandId}`;
    case "resume_all":
      return `resume_all command=${message.commandId}`;
    case "seek_all":
      return `seek_all command=${message.commandId}, position=${formatMs(message.positionMs)}`;
    case "set_volume_all":
      return `set_volume_all command=${message.commandId}, volume=${message.volume}`;
  }

  return "unknown client message";
}

function summarizeServerMessage(raw: string): string {
  try {
    const message = JSON.parse(raw) as ServerMessage;

    switch (message.type) {
      case "hello_ack":
        return `hello_ack room=${message.roomCode}, members=${message.members.length}`;
      case "clock_pong":
        return `clock_pong seq=${message.payload.seq}`;
      case "members":
        return `members count=${message.members.length}`;
      case "schedule_playback":
        return `schedule_playback ${compactTrackUri(message.payload.trackUri)} at ${formatMs(message.payload.startPositionMs)}`;
      case "pause_all":
        return `pause_all command=${message.commandId}`;
      case "resume_all":
        return `resume_all command=${message.commandId}`;
      case "seek_all":
        return `seek_all command=${message.commandId}, position=${formatMs(message.positionMs)}`;
      case "set_volume_all":
        return `set_volume_all volume=${message.volume}`;
      case "error":
        return `error ${message.code}: ${message.message}`;
    }
  } catch {
    return "unparseable message";
  }
}

function compactTrackUri(uri: string): string {
  return uri.replace("spotify:track:", "track:");
}

function formatMs(value: number): string {
  return `${Math.max(0, Math.round(value))}ms`;
}

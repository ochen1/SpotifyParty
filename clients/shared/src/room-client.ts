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
}

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
    this.setStatus(`Room ${body.roomCode} created`);
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
    this.setStatus("Connecting...");

    socket.addEventListener("open", () => {
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

  disconnect(): void {
    this.stopTimers();
    this.socket?.close(1000, "Client disconnect");
    this.socket = null;
    this.setStatus("Disconnected");
  }

  async scheduleCurrentTrack(): Promise<void> {
    const state = await this.adapter.getState();

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

  pauseAll(): void {
    this.send({
      type: "pause_all",
      commandId: randomId("pause_"),
      hostToken: this.settings.hostToken
    });
  }

  resumeAll(): void {
    this.send({
      type: "resume_all",
      commandId: randomId("resume_"),
      startServerMs: this.clock.serverNowMs() + 750,
      hostToken: this.settings.hostToken
    });
  }

  async maxVolumeAll(): Promise<void> {
    await this.adapter.setVolume(1);
    this.send({
      type: "set_volume_all",
      commandId: randomId("volume_"),
      volume: 1,
      hostToken: this.settings.hostToken
    });
  }

  private async handleRawMessage(raw: string): Promise<void> {
    let message: ServerMessage;

    try {
      message = JSON.parse(raw) as ServerMessage;
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

  private async executeSchedule(schedule: ScheduledPlayback): Promise<void> {
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

  private async runAtServerTime(serverTimeMs: number, action: () => Promise<void>): Promise<void> {
    const stats = this.clock.getStats();
    await sleep(serverTimeMs - stats.offsetMs - monotonicNowMs());
    await action();
  }

  private startDriftMonitor(schedule: ScheduledPlayback): void {
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

  private startTimers(): void {
    this.stopTimers();
    this.pingTimer = window.setInterval(() => this.ping(), 750);
    this.stateTimer = window.setInterval(() => void this.reportState(), 2000);
    this.ping();
    void this.reportState();
  }

  private stopTimers(): void {
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

    const state = await this.adapter.getState();
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

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.setStatus("Not connected");
      return;
    }

    this.socket.send(encodeClientMessage(message));
  }

  private setStatus(status: string): void {
    this.status = status;
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
      lastDriftMs: this.lastDriftMs
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

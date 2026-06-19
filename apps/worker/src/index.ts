import {
  encodeServerMessage,
  parseClientMessage,
  randomId,
  type ClientMessage,
  type RoomMember,
  type ServerMessage
} from "../../../packages/core/src";

export interface Env {
  ROOMS: DurableObjectNamespace;
}

interface RoomMeta {
  roomCode: string;
  hostToken: string;
  createdAtServerMs: number;
}

interface SocketSession {
  id: string;
  name: string;
  role: "host" | "speaker";
  adapter: "spicetify" | "tampermonkey";
  joinedAtServerMs: number;
  lastSeenServerMs: number;
  syncQuality: RoomMember["syncQuality"];
  uncertaintyMs: number | null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        name: "spotify-party-sync",
        version: "0.1.0",
        serverNowMs: Date.now()
      });
    }

    if (request.method === "POST" && url.pathname === "/rooms") {
      const roomCode = makeRoomCode();
      const hostToken = randomId("host_");
      const id = env.ROOMS.idFromName(roomCode);
      const stub = env.ROOMS.get(id);

      await stub.fetch("https://spotify-party.internal/init", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ roomCode, hostToken })
      });

      return json({ roomCode, hostToken });
    }

    const wsMatch = url.pathname.match(/^\/ws\/([a-zA-Z0-9_-]{3,32})$/);

    if (request.method === "GET" && wsMatch) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const roomCode = wsMatch[1].toUpperCase();
      const id = env.ROOMS.idFromName(roomCode);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};

export class RoomDurableObject {
  private readonly sessions = new Map<WebSocket, SocketSession>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
    for (const socket of this.state.getWebSockets()) {
      const session = socket.deserializeAttachment() as SocketSession | undefined;

      if (session?.id) {
        this.sessions.set(socket, session);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      const body = (await request.json()) as Partial<RoomMeta>;

      if (!body.roomCode || !body.hostToken) {
        return new Response("Missing room metadata", { status: 400 });
      }

      const existing = await this.state.storage.get<RoomMeta>("meta");

      if (!existing) {
        await this.state.storage.put<RoomMeta>("meta", {
          roomCode: body.roomCode,
          hostToken: body.hostToken,
          createdAtServerMs: Date.now()
        });
      }

      return json({ ok: true });
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    server.serializeAttachment({ pending: true });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const serverReceiveMs = Date.now();

    if (typeof rawMessage !== "string") {
      this.send(socket, {
        type: "error",
        code: "unsupported_message",
        message: "Binary messages are not supported."
      });
      return;
    }

    const message = parseClientMessage(rawMessage);

    if (!message) {
      this.send(socket, {
        type: "error",
        code: "invalid_json",
        message: "Message could not be parsed."
      });
      return;
    }

    try {
      await this.handleMessage(socket, message, serverReceiveMs);
    } catch (error) {
      this.send(socket, {
        type: "error",
        code: "server_error",
        message: error instanceof Error ? error.message : "Unexpected server error."
      });
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.sessions.delete(socket);
    await this.broadcastMembers();
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.sessions.delete(socket);
    await this.broadcastMembers();
  }

  private async handleMessage(
    socket: WebSocket,
    message: ClientMessage,
    serverReceiveMs: number
  ): Promise<void> {
    switch (message.type) {
      case "hello":
        await this.handleHello(socket, message);
        return;
      case "clock_ping":
        this.send(socket, {
          type: "clock_pong",
          payload: {
            ...message.payload,
            serverReceiveMs,
            serverSendMs: Date.now()
          }
        });
        return;
      case "member_state":
        this.handleMemberState(socket, message);
        await this.broadcastMembers();
        return;
      case "schedule_playback":
        await this.requireHost(message.hostToken);
        await this.broadcast({
          type: "schedule_playback",
          payload: {
            ...message.payload,
            issuedAtServerMs: Date.now()
          }
        });
        return;
      case "pause_all":
        await this.requireHost(message.hostToken);
        await this.broadcast({
          type: "pause_all",
          commandId: message.commandId,
          issuedAtServerMs: Date.now()
        });
        return;
      case "resume_all":
        await this.requireHost(message.hostToken);
        await this.broadcast({
          type: "resume_all",
          commandId: message.commandId,
          startServerMs: message.startServerMs,
          issuedAtServerMs: Date.now()
        });
        return;
      case "seek_all":
        await this.requireHost(message.hostToken);
        await this.broadcast({
          type: "seek_all",
          commandId: message.commandId,
          positionMs: message.positionMs,
          startServerMs: message.startServerMs,
          issuedAtServerMs: Date.now()
        });
        return;
      case "set_volume_all":
        await this.requireHost(message.hostToken);
        await this.broadcast({
          type: "set_volume_all",
          commandId: message.commandId,
          volume: message.volume,
          issuedAtServerMs: Date.now()
        });
        return;
      case "drift_report":
        return;
    }
  }

  private async handleHello(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: "hello" }>
  ): Promise<void> {
    const meta = await this.getMeta();

    if (message.role === "host" && message.hostToken !== meta.hostToken) {
      this.send(socket, {
        type: "error",
        code: "host_token_invalid",
        message: "Host token is invalid for this room."
      });
      socket.close(1008, "Invalid host token");
      return;
    }

    const now = Date.now();
    const session: SocketSession = {
      id: message.clientId || randomId("client_"),
      name: message.name.slice(0, 48) || "Speaker",
      role: message.role,
      adapter: message.adapter,
      joinedAtServerMs: now,
      lastSeenServerMs: now,
      syncQuality: "unsynced",
      uncertaintyMs: null
    };

    this.sessions.set(socket, session);
    socket.serializeAttachment(session);

    this.send(socket, {
      type: "hello_ack",
      clientId: session.id,
      roomCode: meta.roomCode,
      hostToken: message.role === "host" ? meta.hostToken : undefined,
      members: this.members(),
      serverNowMs: now
    });

    await this.broadcastMembers();
  }

  private handleMemberState(
    socket: WebSocket,
    message: Extract<ClientMessage, { type: "member_state" }>
  ): void {
    const session = this.sessions.get(socket);

    if (!session) {
      return;
    }

    session.lastSeenServerMs = Date.now();
    session.syncQuality = message.syncQuality;
    session.uncertaintyMs = message.uncertaintyMs;
    socket.serializeAttachment(session);
  }

  private async getMeta(): Promise<RoomMeta> {
    const meta = await this.state.storage.get<RoomMeta>("meta");

    if (meta) {
      return meta;
    }

    const roomCode = "LOCAL";
    const hostToken = randomId("host_");
    const created: RoomMeta = {
      roomCode,
      hostToken,
      createdAtServerMs: Date.now()
    };

    await this.state.storage.put("meta", created);
    return created;
  }

  private async requireHost(hostToken: string): Promise<void> {
    const meta = await this.getMeta();

    if (hostToken !== meta.hostToken) {
      throw new Error("Host token is invalid for this room.");
    }
  }

  private members(): RoomMember[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      name: session.name,
      role: session.role,
      adapter: session.adapter,
      joinedAtServerMs: session.joinedAtServerMs,
      lastSeenServerMs: session.lastSeenServerMs,
      syncQuality: session.syncQuality,
      uncertaintyMs: session.uncertaintyMs
    }));
  }

  private async broadcastMembers(): Promise<void> {
    await this.broadcast({
      type: "members",
      members: this.members()
    });
  }

  private async broadcast(message: ServerMessage): Promise<void> {
    const encoded = encodeServerMessage(message);

    for (const socket of this.sessions.keys()) {
      try {
        socket.send(encoded);
      } catch {
        this.sessions.delete(socket);
      }
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    socket.send(encodeServerMessage(message));
  }
}

function makeRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let roomCode = "";

  for (let i = 0; i < 6; i += 1) {
    roomCode += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return roomCode;
}

function json(value: unknown, init?: ResponseInit): Response {
  return cors(new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers
    }
  }));
}

function cors(response: Response): Response {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  response.headers.set("access-control-allow-headers", "content-type");
  return response;
}

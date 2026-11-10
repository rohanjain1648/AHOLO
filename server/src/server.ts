import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChatBackend } from "./chatBackend";
import { RoomManager, type Conn } from "./rooms";

/** Browsers keep a chat identity for good, so a handful of new ones per minute is generous. */
const SESSIONS_PER_WINDOW = 30;
const SESSION_WINDOW_MS = 60_000;

export interface RelayOptions {
  heartbeatMs?: number;
  /** Nexconn chat; leave unset and the game still runs, without chat. */
  chat?: { backend: ChatBackend & { issueToken(): Promise<{ userId: string; token: string }> }; appKey: string } | null;
}

export interface RelayServer {
  readonly port: number;
  readonly http: Server;
  readonly wss: WebSocketServer;
  readonly rooms: RoomManager;
  close(): Promise<void>;
}

/**
 * An HTTP server for Render's health check (and the game's wake-up probe)
 * with a WebSocket server on the same port. All room logic lives in
 * RoomManager; this only adapts `ws` sockets to it. Port 0 picks a free port.
 */
export function createRelayServer(port: number, opts: RelayOptions = {}): Promise<RelayServer> {
  const rooms = new RoomManager(Date.now, Math.random, opts.chat?.backend ?? null);
  const sessionLimiter = new Map<string, { count: number; resetAt: number }>();
  const http = createServer((req, res) => {
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain", ...cors });
      res.end("ok");
      return;
    }
    if (req.url === "/chat/session") {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "POST" });
        res.end();
        return;
      }
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST") return json(405, {});
      // A normal answer, not an error status: chat being off isn't a fault in the page.
      if (!opts.chat) return json(200, { off: true });
      // Render puts the real client address first in x-forwarded-for.
      const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress).split(",")[0].trim();
      const now = Date.now();
      let bucket = sessionLimiter.get(ip);
      if (!bucket || now > bucket.resetAt) {
        if (sessionLimiter.size > 10_000) sessionLimiter.clear();
        bucket = { count: 0, resetAt: now + SESSION_WINDOW_MS };
        sessionLimiter.set(ip, bucket);
      }
      if (++bucket.count > SESSIONS_PER_WINDOW) return json(429, { error: "rate_limited" });
      const { backend, appKey } = opts.chat;
      backend.issueToken().then(
        ({ userId, token }) => json(200, { appKey, userId, token }),
        (e: Error) => {
          console.error("chat session failed:", e.message);
          json(502, { error: "chat_failed" });
        },
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: 256 * 1024 });

  // Heartbeat: a phone that drops off the network never sends a close frame,
  // so ping every socket and terminate any that missed the previous pong.
  // terminate() fires "close", which runs RoomManager's normal grace/cleanup.
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.heartbeatMs ?? 15_000);
  heartbeat.unref();

  wss.on("connection", (ws: WebSocket) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    const conn: Conn = {
      send: (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
      close: () => ws.close(),
    };
    rooms.onOpen(conn);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        rooms.onBinary(conn, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      } else {
        rooms.onText(conn, data.toString());
      }
    });
    ws.on("close", () => rooms.onClose(conn));
    ws.on("error", () => ws.close());
  });

  const ticker = setInterval(() => rooms.tick(), 1000);
  ticker.unref();

  return new Promise((resolve) => {
    http.listen(port, () => {
      resolve({
        port: (http.address() as AddressInfo).port,
        http,
        wss,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(ticker);
            clearInterval(heartbeat);
            for (const c of wss.clients) c.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}

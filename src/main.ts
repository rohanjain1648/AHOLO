import "./style.css";
import { Audio } from "./core/audio";
import { Input } from "./core/input";
import { GameLoop } from "./core/loop";
import { IDLE_INPUT, type PlayerInput } from "./game/types";
import { World, type RunStats } from "./game/world";
import { drawHud, pingButtonRect } from "./ui/hud";
import {
  drawGameOver,
  drawLevelUp,
  drawPause,
  drawTitle,
  levelUpLayout,
  muteButtonRect,
  pointInRect,
  quitButtonRect,
  resumeButtonRect,
  titleButtonRects,
  type CoopAvailability,
} from "./ui/screens";
import { toCard, type Upgrade, type UpgradeCard } from "./game/upgrades";
import { Scene3D } from "./render/scene";
import { FollowCamera } from "./render/camera3d";
import { RobotFactory } from "./render/robots";
import { WorldView, type FloatLabel } from "./render/worldView";
import { drawFloatLabels } from "./ui/labels3d";
import {
  coopGameOverRects,
  drawBanner,
  drawCoopGameOver,
  drawCoopMenu,
  drawHuddleWait,
  drawLobby,
  lobbyButtonRects,
  randomCallsign,
} from "./ui/lobby";
import { askRoomCode } from "./ui/codeInput";
import { RelayClient, relayHttpUrl, relayUrl, wakeRelay } from "./net/relayClient";
import { ChatController, type ChatRole } from "./chat/chatController";
import { NexconnTransport } from "./chat/nexconnTransport";
import { quickOptions, type QuickLine } from "./chat/quickChat";
import { ChatPanel, type ChatPanelMode } from "./ui/chatPanel";
import { HostSession } from "./net/hostSession";
import { ClientSession } from "./net/clientSession";
import type { ClientToHost, HostToClient, OverInfo } from "./net/gameProtocol";
import { SPECTATOR_SLOT, type ErrorReason, type RelayToClient, type RosterEntry } from "./net/relayProtocol";

type State = "loading" | "menu" | "lobby" | "playing" | "levelup" | "paused" | "gameover";
type Mode = "solo" | "host" | "client" | "spectator";

const BEST_KEY = "novaswarm.best";
const COOP_BEST_KEY = "novaswarm.best.coop";
const PLAYER_MODEL_HEIGHT = 110; // desired rendered height (game units) of the player robot

const app = document.getElementById("app") as HTMLDivElement;
const sceneCanvas = document.getElementById("scene") as HTMLCanvasElement;
const hudCanvas = document.getElementById("hud") as HTMLCanvasElement;
const hudCtx = hudCanvas.getContext("2d")!;

const audio = new Audio();
const input = new Input(app);

let W = window.innerWidth;
let H = window.innerHeight;

const scene3d = new Scene3D(sceneCanvas);
const world = new World(audio);
const followCamera = new FollowCamera(scene3d.camera);
world.setViewRadius(followCamera.viewRadius);

const robotFactory = new RobotFactory();
let worldView: WorldView | null = null;

let state: State = "loading";
let loadFrac = 0;
let choices: Upgrade[] = [];
let best: RunStats | null = loadBest(BEST_KEY);
let coopBest: RunStats | null = loadBest(COOP_BEST_KEY);
let newBest = false;

// --- Co-op session state ------------------------------------------------------
let mode: Mode = "solo";
const RELAY_URL = relayUrl();
let coop: CoopAvailability = RELAY_URL ? "waking" : "unavailable";
let relay: RelayClient | null = null;
let hostSession: HostSession | null = null;
let clientSession: ClientSession | null = null;
let roster: RosterEntry[] = [];
const callsign = randomCallsign();
let toast: { text: string; until: number } | null = null;
let joining = false;
let chat: ChatController | null = null;
let chatPanel: ChatPanel | null = null;
let spectators = 0;
let quickLines: QuickLine[] = [];
let lastChatUiT = 0;
/** Spectators: the slot the camera follows. */
let followSlot = 0;

if (RELAY_URL) {
  void wakeRelay(RELAY_URL).then((ok) => {
    coop = ok ? "ready" : "unavailable";
  });
}

// --- Canvas sizing (DPR-aware HUD; the WebGL canvas is managed by Scene3D) -
function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  hudCanvas.width = Math.floor(W * dpr);
  hudCanvas.height = Math.floor(H * dpr);
  hudCanvas.style.width = `${W}px`;
  hudCanvas.style.height = `${H}px`;
  hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scene3d.resize(W, H);
}
window.addEventListener("resize", resize);
resize();

robotFactory
  .load(`${import.meta.env.BASE_URL}models/RobotExpressive.glb`, (f) => {
    loadFrac = f;
  })
  .then(() => {
    worldView = new WorldView(scene3d.scene, robotFactory);
    worldView.calibrateScale(PLAYER_MODEL_HEIGHT);
    state = "menu";
    // Invite link: ?room=ABCD joins straight away (and the param is stripped
    // so a refresh doesn't re-join a room that has moved on).
    const params = new URLSearchParams(location.search);
    const code = params.get("room");
    const watch = params.get("watch");
    if (code || watch) {
      params.delete("room");
      params.delete("watch");
      const qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
      if (watch) watchRoom(watch);
      else if (code) joinRoom(code);
    }
  })
  .catch((err) => {
    console.error("Failed to load robot model:", err);
  });

// --- Persistence ------------------------------------------------------------
function loadBest(key: string): RunStats | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as RunStats) : null;
  } catch {
    return null;
  }
}
function saveBest(key: string, s: RunStats): void {
  try {
    localStorage.setItem(key, JSON.stringify(s));
  } catch {
    /* storage may be unavailable in private mode; scores are non-critical */
  }
}

function showToast(text: string, ms = 3500): void {
  toast = { text, until: performance.now() + ms };
}

// --- Transitions ------------------------------------------------------------
/** Shared run start for solo and co-op (the World itself is reset by the caller/session). */
function enterRun(): void {
  audio.unlock();
  audio.startMusic();
  newBest = false;
  state = "playing";
  // Push a history entry so the mobile back button/gesture has something to
  // "consume" — without this, Android back navigates straight off the page
  // mid-run instead of pausing (see the popstate handler below).
  history.pushState({ novaGame: true }, "", location.href);
}

function startGame(): void {
  world.localSlot = 0;
  world.recordEffects = false;
  world.reset();
  enterRun();
}

function openLevelUp(): void {
  choices = world.rollUpgradeChoices();
  state = "levelup";
}

function finishRun(): void {
  const s = world.stats;
  if (!best || s.time > best.time) {
    best = { ...s };
    saveBest(BEST_KEY, best);
    newBest = true;
  }
  state = "gameover";
}

/** Abandon the current run and return to the title screen (still banks a new best). */
function quitToMenu(): void {
  const s = world.stats;
  if (!best || s.time > best.time) {
    best = { ...s };
    saveBest(BEST_KEY, best);
  }
  audio.stopMusic();
  state = "menu";
}

// --- Co-op transitions --------------------------------------------------------
const JOIN_ERRORS: Record<ErrorReason | "unreachable", string> = {
  not_found: "No room with that code",
  full: "Room is full (4/4)",
  started: "That run already started",
  bad_code: "Codes are 4 letters/numbers",
  bad_token: "Couldn't rejoin that room",
  watch_full: "This match has a full crowd right now",
  unreachable: "Couldn't reach the co-op server",
};

function newRelay(): RelayClient {
  const r = new RelayClient(RELAY_URL!);
  r.onMessage = (m) => {
    if (r === relay) onRelayMessage(m);
  };
  r.onBinary = (b) => {
    if (r === relay) clientSession?.onSnapshot(b);
  };
  r.onStatus = (s) => {
    // While host()/join() is pending its own catch reports the real reason.
    if (r !== relay || joining) return;
    if (s === "closed") leaveCoop("Connection lost");
    else if (s === "reconnecting") showToast("Reconnecting…", 2000);
  };
  return r;
}

function hostRoom(): void {
  if (!RELAY_URL || coop !== "ready" || joining) return;
  audio.unlock();
  joining = true;
  relay = newRelay();
  relay
    .host(callsign)
    .then(() => {
      mode = "host";
      hostSession = new HostSession(world, relay!);
      state = "lobby";
      startChat("host", 0);
    })
    .catch((reason: ErrorReason | "unreachable") => {
      relay = null;
      showToast(JOIN_ERRORS[reason] ?? "Couldn't host a room");
    })
    .finally(() => {
      joining = false;
    });
}

function joinRoom(code: string): void {
  if (!RELAY_URL || joining) {
    if (!RELAY_URL) showToast("Co-op unavailable");
    return;
  }
  audio.unlock();
  joining = true;
  relay = newRelay();
  relay
    .join(code, callsign)
    .then(({ slot }) => {
      mode = "client";
      clientSession = new ClientSession(world, relay!, slot);
      state = "lobby";
      startChat("player", slot);
    })
    .catch((reason: ErrorReason | "unreachable") => {
      relay = null;
      showToast(JOIN_ERRORS[reason] ?? "Couldn't join");
    })
    .finally(() => {
      joining = false;
    });
}

/** Join a room's audience: no robot, just the live match and the crowd chat. */
function watchRoom(code: string): void {
  if (!RELAY_URL || joining) {
    if (!RELAY_URL) showToast("Co-op unavailable");
    return;
  }
  audio.unlock();
  joining = true;
  relay = newRelay();
  relay
    .watch(code, callsign)
    .then(() => {
      mode = "spectator";
      clientSession = new ClientSession(world, relay!, SPECTATOR_SLOT);
      world.spectating = true;
      followSlot = 0;
      state = "lobby";
      startChat("spectator", SPECTATOR_SLOT);
    })
    .catch((reason: ErrorReason | "unreachable") => {
      relay = null;
      showToast(JOIN_ERRORS[reason] ?? "Couldn't open that match");
    })
    .finally(() => {
      joining = false;
    });
}

// --- Chat (Nexconn). Purely additive: if it's off or fails, co-op still works. ---
function startChat(role: ChatRole, slot: number): void {
  if (!RELAY_URL) return;
  const c = new ChatController(new NexconnTransport(relayHttpUrl(RELAY_URL)), { role, name: callsign, slot });
  chat = c;
  chatPanel = new ChatPanel(
    c,
    role,
    () => `${import.meta.env.VITE_PUBLIC_URL || `${location.origin}${location.pathname}`}?watch=${relay?.code ?? ""}`,
    sendQuickAt,
    (text) => showToast(text, 2500),
  );
  c.onVoteOpen = () => {
    if (role !== "spectator") showToast("The crowd is voting…", 3000);
  };
  c.onCrowdResult = (choice, supply, surge) => {
    const label = choice === "surge" ? "SWARM SURGE" : "SUPPLY DROP";
    showToast(`The crowd chose ${label}! (${Math.max(supply, surge)}–${Math.min(supply, surge)})`, 4000);
  };
  void c.start((userId) => relay?.send({ t: "chatJoin", userId }));
}

function stopChat(): void {
  chatPanel?.destroy();
  chatPanel = null;
  void chat?.stop();
  chat = null;
  spectators = 0;
  quickLines = [];
}

function sendQuickAt(index: number): void {
  const line = quickLines[index];
  if (line) chat?.sendQuick(line);
}

/** Show the panel that fits this moment, a few times a second. */
function updateChatUi(): void {
  if (!chat || !chatPanel) return;
  const now = performance.now();
  if (now - lastChatUiT < 200) return;
  lastChatUiT = now;

  const inFight = state === "playing" && mode !== "spectator" && !world.player.downed && waitingNames().length === 0;
  let panelMode: ChatPanelMode = "full";
  if (state === "menu" || state === "loading") panelMode = "hidden";
  else if (inFight || state === "levelup") panelMode = "feed";
  chatPanel.setMode(panelMode);
  chatPanel.setWatching(spectators);

  quickLines = [];
  if (state === "playing" && mode !== "spectator" && chat.status === "ready") {
    quickLines = quickOptions({
      meDowned: world.player.downed,
      downedTeammates: world.players.filter((p) => p.active && p.downed && p.slot !== world.localSlot).map((p) => p.name),
      bossAlive: world.bossHpFraction != null,
    });
  }
  chatPanel.setQuick(quickLines);
  chatPanel.tick();
}

/** Speech bubbles over robots, added after WorldView has rebuilt its labels. */
function pushChatBubbles(labels: FloatLabel[]): void {
  if (!chat) return;
  for (const p of world.players) {
    const text = p.active ? chat.bubbleFor(p.slot) : null;
    if (text) labels.push({ x: p.x, y: 190, z: p.y, text: `“${text}”`, color: "#ffffff", alpha: 1, size: 16 });
  }
}

/** Spectators: move the camera to the next robot still in the run. */
function followNext(): void {
  const active = world.players.filter((p) => p.active);
  if (active.length === 0) return;
  const i = active.findIndex((p) => p.slot === followSlot);
  followSlot = active[(i + 1) % active.length].slot;
}

/** Drop out of co-op entirely and go back to the title. */
function leaveCoop(reason?: string): void {
  stopChat();
  world.spectating = false;
  const r = relay;
  relay = null;
  r?.leave();
  hostSession = null;
  clientSession = null;
  roster = [];
  mode = "solo";
  world.localSlot = 0;
  world.recordEffects = false;
  world.reset();
  audio.stopMusic();
  state = "menu";
  if (reason) showToast(reason);
}

function onRelayMessage(m: RelayToClient): void {
  if (m.t === "roster") {
    roster = m.players;
    spectators = m.spectators ?? 0;
    hostSession?.onRoster(m.players);
    // Arriving mid-run: the host's "start" came before we did, so the roster
    // stands in for it. Stats and positions arrive with the first snapshot.
    if (mode === "spectator" && m.started && clientSession && !clientSession.isRunning) {
      onHostMessage({ k: "start", slots: m.players.map((p) => ({ slot: p.slot, name: p.name })) });
    }
  } else if (m.t === "chat") {
    void chat?.onChannels(m);
  } else if (m.t === "chatOff") {
    chat?.onChatOff();
  } else if (m.t === "closed") {
    leaveCoop("Host left the room");
  } else if (m.t === "msg") {
    if (mode === "host") hostSession?.onClientMessage(m.from, m.data as ClientToHost);
    else if (mode === "client" || mode === "spectator") onHostMessage(m.data as HostToClient);
  }
}

function onHostMessage(m: HostToClient): void {
  if (!clientSession) return;
  clientSession.onHostMessage(m);
  if (m.k === "start") enterRun();
  else if (m.k === "lobby") {
    audio.stopMusic();
    state = "lobby";
  }
}

function startCoopRun(): void {
  if (!hostSession || !relay) return;
  const slots = roster.filter((p) => p.connected).map((p) => ({ slot: p.slot, name: p.name }));
  if (slots.length < 2) return;
  relay.send({ t: "start" });
  hostSession.start(slots);
  enterRun();
}

function finishCoopRun(info: OverInfo): void {
  if (mode === "spectator") {
    state = "gameover";
    return;
  }
  const s: RunStats = { time: info.time, kills: info.kills, level: info.level };
  newBest = false;
  if (!coopBest || s.time > coopBest.time) {
    coopBest = s;
    saveBest(COOP_BEST_KEY, s);
    newBest = true;
  }
  state = "gameover";
}

/** Where an invite link should open: the deployed site if configured, else this page. */
function inviteBaseUrl(): string {
  return import.meta.env.VITE_PUBLIC_URL || `${location.origin}${location.pathname}`;
}

function copyInvite(): void {
  if (!relay) return;
  const link = `${inviteBaseUrl()}?room=${relay.code}`;
  navigator.clipboard?.writeText(link).then(
    () => showToast("Invite link copied", 2000),
    () => showToast(link, 6000),
  );
}

// --- Per-state input handling (runs on the fixed update tick) ---------------
function handleMenu(): void {
  if (input.consumeKey("KeyM")) {
    audio.unlock();
    audio.toggleMute();
  }
  const click = input.consumeClick();
  if (click && pointInRect(click.x, click.y, muteButtonRect(W))) {
    audio.unlock();
    audio.toggleMute();
    input.consumeConfirm();
    return;
  }
  if (click && coop !== "ready") {
    // The dimmed co-op row is a disabled control: tapping it must not start solo.
    const r = titleButtonRects(W, H);
    if (pointInRect(click.x, click.y, r.host) || pointInRect(click.x, click.y, r.join)) {
      input.consumeConfirm();
      return;
    }
  }
  if (click && coop === "ready") {
    const r = titleButtonRects(W, H);
    if (pointInRect(click.x, click.y, r.host)) {
      input.consumeConfirm();
      hostRoom();
      return;
    }
    if (pointInRect(click.x, click.y, r.join)) {
      input.consumeConfirm();
      void askRoomCode().then((code) => code && joinRoom(code));
      return;
    }
  }
  if (joining) {
    input.consumeConfirm();
    return;
  }
  if (input.consumeConfirm()) startGame();
}

function handleLobby(): void {
  if (input.consumeKey("KeyM")) audio.toggleMute();
  input.consumeConfirm();
  const click = input.consumeClick();
  if (!click) return;
  const r = lobbyButtonRects(W, H);
  if (pointInRect(click.x, click.y, r.copy)) copyInvite();
  else if (pointInRect(click.x, click.y, r.leave)) leaveCoop();
  else if (mode === "host" && pointInRect(click.x, click.y, r.start)) startCoopRun();
}

function handlePlaying(dt: number): void {
  if (input.consumeKey("KeyM")) audio.toggleMute();
  if (input.consumeKey("Escape") || input.consumeKey("KeyP")) {
    state = "paused";
    input.consumeConfirm();
    return;
  }
  if (mode === "spectator") {
    input.consumeConfirm();
    if (input.consumeClick() || input.consumeKey("Tab")) followNext();
    stepCoop(dt, IDLE_INPUT);
    return;
  }
  if (mode !== "solo") {
    const num = input.consumeNumber();
    if (num > 0) sendQuickAt(num - 1);
  }
  if (mode !== "solo") {
    stepCoop(dt, input.read());
    return;
  }
  world.update(dt, [input.read()]);
  if (world.gameOver) finishRun();
  else if (world.pendingLevelUps > 0) openLevelUp();
}

/** One co-op tick in any in-run state; `inp` is idle while a menu covers the screen. */
function stepCoop(dt: number, inp: PlayerInput): void {
  if (state === "playing") {
    const click = input.consumeClick();
    const pinged = input.consumeKey("KeyG") || (click && pointInRect(click.x, click.y, pingButtonRect(W, H)));
    if (pinged) {
      if (mode === "host") world.addPing(0);
      else clientSession?.ping();
    }
  }
  if (mode === "host" && hostSession) {
    hostSession.step(dt, inp);
    const crowd = chat?.hostTick(dt, spectators > 0 && !hostSession.huddle && !world.gameOver);
    if (crowd === "supply") world.crowdSupplyDrop();
    else if (crowd === "surge") world.crowdSurge();
    if (hostSession.overInfo && state !== "gameover") finishCoopRun(hostSession.overInfo);
    else if (state === "playing" && (hostSession.huddle?.cards.length ?? 0) > 0) state = "levelup";
  } else if ((mode === "client" || mode === "spectator") && clientSession) {
    clientSession.step(dt, inp);
    if (clientSession.overInfo && state !== "gameover") finishCoopRun(clientSession.overInfo);
    else if (state === "playing" && clientSession.cards) state = "levelup";
  }
}

/** The cards this player is choosing from right now. */
function currentCards(): UpgradeCard[] {
  if (mode === "host") return hostSession?.huddle?.cards ?? [];
  if (mode === "client") return clientSession?.cards?.cards ?? [];
  return choices.map((u) => toCard(u, world.player));
}

/** Names of teammates still picking in the open huddle (never yourself). */
function waitingNames(): string[] {
  const slots = mode === "host" ? hostSession?.huddle?.waiting ?? [] : clientSession?.waiting ?? [];
  return slots.filter((s) => s !== world.localSlot).map((s) => world.players[s]?.name ?? "?");
}

function handleLevelUp(dt: number): void {
  if (input.consumeKey("KeyM")) audio.toggleMute();
  const cards = currentCards();
  let pick = -1;
  const num = input.consumeNumber();
  if (num >= 1 && num <= cards.length) pick = num - 1;

  const click = input.consumeClick();
  if (click) {
    const rects = levelUpLayout(W, H);
    for (let i = 0; i < cards.length; i++) {
      if (pointInRect(click.x, click.y, rects[i])) pick = i;
    }
  }
  input.consumeConfirm(); // don't let a stray confirm leak into gameplay

  if (mode !== "solo") {
    if (pick >= 0) {
      if (mode === "host") hostSession?.pickLocal(pick);
      else clientSession?.pick(pick);
    }
    stepCoop(dt, IDLE_INPUT);
    // Picked (or auto-picked by the host's timer): back to the run view, which
    // shows the "waiting on…" overlay until the whole squad has chosen.
    if (state === "levelup" && currentCards().length === 0) state = "playing";
    return;
  }

  if (pick >= 0) {
    world.applyUpgrade(0, choices[pick]);
    world.finishLevelUp();
    if (world.pendingLevelUps > 0) choices = world.rollUpgradeChoices();
    else state = "playing";
  }
}

function handlePaused(dt: number): void {
  if (input.consumeKey("KeyM")) audio.toggleMute();

  if (mode !== "solo") {
    // Co-op menu: the run keeps going underneath with our robot idle.
    stepCoop(dt, IDLE_INPUT);
    if (state !== "paused") return;
    if (input.consumeKey("Escape") || input.consumeKey("KeyP")) {
      input.consumeConfirm();
      state = "playing";
      return;
    }
    const click = input.consumeClick();
    input.consumeConfirm();
    if (click) {
      if (pointInRect(click.x, click.y, resumeButtonRect(W, H))) state = "playing";
      else if (pointInRect(click.x, click.y, quitButtonRect(W, H))) leaveCoop();
    }
    return;
  }

  if (input.consumeKey("KeyQ")) {
    input.consumeConfirm();
    quitToMenu();
    return;
  }
  if (input.consumeKey("Escape") || input.consumeKey("KeyP") || input.consumeKey("Space") || input.consumeKey("Enter")) {
    input.consumeConfirm();
    state = "playing";
    return;
  }

  const click = input.consumeClick();
  if (click) {
    input.consumeConfirm();
    if (pointInRect(click.x, click.y, resumeButtonRect(W, H))) state = "playing";
    else if (pointInRect(click.x, click.y, quitButtonRect(W, H))) quitToMenu();
  }
}

function handleGameOver(): void {
  if (input.consumeKey("KeyM")) audio.toggleMute();
  if (mode !== "solo") {
    input.consumeConfirm();
    const click = input.consumeClick();
    if (!click) return;
    const r = coopGameOverRects(W, H);
    if (pointInRect(click.x, click.y, r.leave)) leaveCoop();
    else if (mode === "host" && pointInRect(click.x, click.y, r.again)) {
      hostSession?.backToLobby();
      audio.stopMusic();
      state = "lobby";
    }
    return;
  }
  if (input.consumeConfirm()) startGame();
}

// Auto-pause when the tab loses focus mid-run (solo only — a co-op run can't
// stop for one player).
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state === "playing" && mode === "solo") state = "paused";
});

// Mobile back button/gesture: pause instead of leaving the page (Android
// Chrome maps back to browser history navigation by default, which would
// otherwise exit the run entirely). Re-push the guard entry each time so
// every subsequent back-press while the game is active is caught the same
// way; once the player is back on the menu we stop re-pushing, so back
// behaves normally (actually leaves) when there's no run to protect.
window.addEventListener("popstate", () => {
  if (state === "playing") state = "paused";
  if (state !== "menu" && state !== "loading") {
    history.pushState({ novaGame: true }, "", location.href);
  }
});

// --- Loop -------------------------------------------------------------------
function update(dt: number): void {
  switch (state) {
    case "loading": break;
    case "menu": handleMenu(); break;
    case "lobby": handleLobby(); break;
    case "playing": handlePlaying(dt); break;
    case "levelup": handleLevelUp(dt); break;
    case "paused": handlePaused(dt); break;
    case "gameover": handleGameOver(); break;
  }
}

let lastRenderT = performance.now();

function render(): void {
  const now = performance.now();
  const rdt = Math.min(0.05, (now - lastRenderT) / 1000);
  lastRenderT = now;
  const t = now / 1000;

  hudCtx.clearRect(0, 0, W, H);

  if (state === "loading" || !worldView) {
    scene3d.render();
    drawLoading(t);
    return;
  }

  // A co-op client's World is written from host snapshots, once per frame.
  if (mode === "spectator") world.localSlot = followSlot;
  if ((mode === "client" || mode === "spectator") && clientSession?.isRunning) clientSession.frame(rdt);
  updateChatUi();
  if (clientSession?.versionMismatch) leaveCoop("Your friend is on a different version — refresh or update the game");

  // Sync the 3D scene from World's data + advance camera/atmosphere on the
  // real render clock (not the fixed sim step) so animation blending stays smooth.
  worldView.sync(world, rdt);
  followCamera.update(world, rdt);
  scene3d.followSun(world.player.x, world.player.y);
  scene3d.updateAtmosphere(rdt, world.player.x, world.player.y);
  scene3d.render();

  pushChatBubbles(worldView.floatLabels);
  drawFloatLabels(hudCtx, worldView.floatLabels, scene3d.camera, W, H);

  if (state === "menu") {
    drawTitle(hudCtx, W, H, t, best, audio.muted, joining ? "waking" : coop);
    drawToast();
    return;
  }
  if (state === "lobby") {
    drawLobby(hudCtx, W, H, t, { code: relay?.code ?? "", players: roster, isHost: mode === "host" });
    drawToast();
    return;
  }

  drawHud(hudCtx, world, audio.muted, W, H, scene3d.camera);
  drawScreenFlash(t);

  const huddleNames = mode === "solo" ? [] : waitingNames();
  if (state === "levelup") {
    drawLevelUp(hudCtx, W, H, currentCards(), input.pointerPosition, t, huddleNames);
  } else if (state === "paused") {
    if (mode === "solo") drawPause(hudCtx, W, H, t);
    else drawCoopMenu(hudCtx, W, H, t);
  } else if (state === "gameover") {
    const info = hostSession?.overInfo ?? clientSession?.overInfo;
    if (mode !== "solo" && info) drawCoopGameOver(hudCtx, W, H, t, info, mode === "host", coopBest, newBest);
    else drawGameOver(hudCtx, W, H, world.stats, best, newBest, t);
  } else if (state === "playing" && huddleNames.length > 0) {
    drawHuddleWait(hudCtx, W, H, huddleNames);
  }

  if (mode === "spectator" && state === "playing" && !toast) {
    drawBanner(hudCtx, W, `Watching ${world.player.name}  ·  tap to switch`, "#eafcff");
  }
  if ((mode === "client" || mode === "spectator") && clientSession?.hostPaused && relay?.status === "open") drawBanner(hudCtx, W, "Host paused — waiting for the host's game…");
  drawToast();
}

function drawToast(): void {
  if (toast && performance.now() < toast.until) drawBanner(hudCtx, W, toast.text, "#eafcff");
}

function drawScreenFlash(t: number): void {
  void t;
  if (world.flashT > 0) {
    hudCtx.fillStyle = `rgba(${world.flashColor},${world.flashT * 0.5})`;
    hudCtx.fillRect(0, 0, W, H);
  }
  const hpFrac = world.player.hp / world.player.maxHp;
  if (hpFrac < 0.35 && !world.gameOver) {
    const pulse = 0.25 + Math.sin(world.time * 6) * 0.1;
    const g = hudCtx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.75);
    g.addColorStop(0, "rgba(255,0,50,0)");
    g.addColorStop(1, `rgba(255,0,50,${(0.35 - hpFrac) * pulse * 2})`);
    hudCtx.fillStyle = g;
    hudCtx.fillRect(0, 0, W, H);
  }
}

function drawLoading(t: number): void {
  hudCtx.fillStyle = "rgba(3,4,8,0.4)";
  hudCtx.fillRect(0, 0, W, H);
  hudCtx.textAlign = "center";
  hudCtx.textBaseline = "middle";
  hudCtx.fillStyle = "#eafcff";
  hudCtx.font = "900 32px 'Segoe UI', system-ui, sans-serif";
  const pulse = 0.6 + Math.sin(t * 3) * 0.4;
  hudCtx.globalAlpha = 0.7 + pulse * 0.3;
  hudCtx.fillText("BOOTING ROBOTS…", W / 2, H / 2 - 20);
  hudCtx.globalAlpha = 1;

  const bw = Math.min(280, W * 0.6);
  const bx = W / 2 - bw / 2;
  const by = H / 2 + 16;
  hudCtx.fillStyle = "rgba(255,255,255,0.1)";
  hudCtx.fillRect(bx, by, bw, 8);
  hudCtx.fillStyle = "#3fe9ff";
  hudCtx.fillRect(bx, by, bw * Math.max(0.04, loadFrac), 8);
}

const loop = new GameLoop(update, render, 60);
loop.start();

// Opt-in, read-only debug probe for automated smoke tests (append ?debug to the
// URL). Harmless in normal play.
if (new URLSearchParams(location.search).has("debug")) {
  (window as unknown as { __nova: () => unknown }).__nova = () => ({
    state,
    mode,
    coop,
    relay: relay?.status ?? null,
    code: relay?.code ?? null,
    slot: world.localSlot,
    roster: roster.length,
    players: world.players.filter((p) => p.active).length,
    spectators,
    chat: chat?.status ?? null,
    chatFeed: chat?.feed.map((f) => f.text) ?? [],
    toast: toast && performance.now() < toast.until ? toast.text : null,
    liveEnemies: world.enemies.reduce((n, e) => n + (e.dead ? 0 : 1), 0),
    peers: world.players
      .filter((p) => p.active && p.slot !== world.localSlot)
      .map((p) => ({ slot: p.slot, x: Math.round(p.x), y: Math.round(p.y), maxHp: p.maxHp })),
    level: world.level,
    xp: Math.round(world.xp),
    xpToNext: world.xpToNext,
    kills: world.kills,
    hp: Math.round(world.player.hp),
    maxHp: world.player.maxHp,
    pending: world.pendingLevelUps,
    time: Math.round(world.time),
    facingDeg: Math.round((world.player.facing * 180) / Math.PI),
    px: Math.round(world.player.x),
    py: Math.round(world.player.y),
    liveBullets: world.bullets.reduce((n, b) => n + (b.dead ? 0 : 1), 0),
    ui: { title: titleButtonRects(W, H), lobby: lobbyButtonRects(W, H), coopOver: coopGameOverRects(W, H) },
  });
}

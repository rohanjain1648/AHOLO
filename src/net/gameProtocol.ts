import type { UpgradeCard } from "../game/upgrades";
import type { SlotInfo } from "../game/world";
import type { ClientToRelay } from "./relayProtocol";

/**
 * Game messages between the host and its clients. They ride inside the
 * relay's `{t:"send"}` / `{t:"msg"}` envelope; world state itself goes as
 * binary snapshots (see snapshot.ts).
 */
export type ClientToHost =
  | { k: "pose"; x: number; y: number; facing: number; firing: boolean }
  | { k: "pick"; round: number; index: number }
  | { k: "ping" }
  /** Sent after joining: this player's robot class (app players only). */
  | { k: "hello"; archetype: string };

export interface OverInfo {
  k: "over";
  time: number;
  kills: number;
  level: number;
  perPlayer: { slot: number; name: string; kills: number }[];
}

/** Where a Forge boss model comes from: a live Lux3D result, or a pre-forged gallery entry. */
export type ForgeSrc = { url: string } | { gallery: string };

export type HostToClient =
  | { k: "start"; slots: SlotInfo[] }
  /** The host's Forge boss: clients load the same model so everyone fights the same thing. */
  | { k: "forge"; src: ForgeSrc; name: string }
  | { k: "cards"; round: number; cards: UpgradeCard[] }
  | OverInfo
  | { k: "lobby" };

/** The slice of RelayClient a session needs (lets tests use a fake). */
export interface Wire {
  send(m: ClientToRelay): void;
  sendBinary(b: Uint8Array): void;
}

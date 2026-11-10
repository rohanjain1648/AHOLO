/**
 * In-match quick chat: fixed lines sent by id, because both thumbs are busy
 * mid-fight. Only known ids render, so a quick line can never smuggle free text
 * past the chat filter. The one variable part is a teammate's callsign.
 */
export interface QuickLine {
  id: string;
  arg?: string;
}

export interface QuickContext {
  meDowned: boolean;
  /** Names of teammates who are down right now. */
  downedTeammates: string[];
  bossAlive: boolean;
}

const LINES: Record<string, (arg?: string) => string | null> = {
  revive_me: () => "Revive me!",
  coming: (arg) => (arg ? `Coming, ${arg.slice(0, 12)}!` : null),
  boss: () => "Focus the Warden!",
  on_me: () => "Group up on me!",
  help: () => "Need help!",
  nice: () => "Nice!",
  thanks: () => "Thanks!",
};

export function renderQuick(line: QuickLine): string | null {
  if (!Object.prototype.hasOwnProperty.call(LINES, line.id)) return null;
  return LINES[line.id](line.arg);
}

/** The 4 lines to offer right now, with what this moment calls for first. */
export function quickOptions(ctx: QuickContext): QuickLine[] {
  const out: QuickLine[] = [];
  if (ctx.meDowned) out.push({ id: "revive_me" });
  else if (ctx.downedTeammates.length > 0) out.push({ id: "coming", arg: ctx.downedTeammates[0] });
  if (ctx.bossAlive && !ctx.meDowned) out.push({ id: "boss" });
  for (const id of ["on_me", "help", "nice", "thanks"]) {
    if (out.length < 4 && !(ctx.meDowned && id === "on_me")) out.push({ id });
  }
  return out.slice(0, 4);
}

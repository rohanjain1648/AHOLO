import type { ChatController, ChatRole, FeedEntry } from "../chat/chatController";
import { renderQuick, type QuickLine } from "../chat/quickChat";
import { COOP } from "../game/config";

export type ChatPanelMode = "hidden" | "feed" | "full";

/**
 * The chat UI. It's real DOM over the game canvas, not canvas drawing, because
 * phones only open a keyboard for a real input and DOM text is safe to fill with
 * whatever strangers type. "full" is the interactive panel for when your hands
 * are free; "feed" is a click-through list of recent lines during a fight.
 */
export class ChatPanel {
  private readonly root = document.createElement("div");
  private readonly list = document.createElement("div");
  private readonly form = document.createElement("form");
  private readonly input = document.createElement("input");
  private readonly watching = document.createElement("span");
  private readonly voteBox = document.createElement("div");
  private readonly quickBar = document.createElement("div");
  private readonly rows = new Map<number, HTMLElement>();
  private mode: ChatPanelMode = "hidden";
  private quickKey = "";
  private collapsed = window.innerWidth < 700 || window.innerHeight < 520;

  constructor(
    private readonly chat: ChatController,
    private readonly role: ChatRole,
    private readonly watchLink: () => string,
    private readonly onQuick: (index: number) => void,
    private readonly notify: (text: string) => void,
  ) {
    this.root.className = "chat-panel";
    this.root.innerHTML = `
      <div class="chat-head">
        <strong></strong>
        <span class="chat-watching"></span>
        <button type="button" class="chat-link" title="Copy a link anyone can use to watch this match">Watch link</button>
        <label class="chat-crowd"><input type="checkbox" checked /> Crowd</label>
        <button type="button" class="chat-toggle" aria-label="Show or hide chat">💬</button>
      </div>`;
    const head = this.root.querySelector(".chat-head") as HTMLElement;
    (head.querySelector("strong") as HTMLElement).textContent = role === "spectator" ? "CROWD CHAT" : "SQUAD CHAT";
    this.watching.className = "chat-watching";
    head.querySelector(".chat-watching")!.replaceWith(this.watching);

    this.voteBox.className = "chat-vote";
    this.list.className = "chat-list";
    this.list.setAttribute("role", "log");
    this.list.setAttribute("aria-live", "polite");
    this.input.maxLength = 140;
    this.input.placeholder = role === "spectator" ? "Cheer them on…" : "Message your squad…";
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-label", "Chat message");
    const send = document.createElement("button");
    send.type = "submit";
    send.textContent = "Send";
    this.form.className = "chat-form";
    this.form.append(this.input, send);
    this.root.append(this.voteBox, this.list, this.form);
    this.quickBar.className = "quick-bar";

    // Typing must never steer the robot. Keyup still reaches the game, so a key
    // that was held when the input took focus doesn't stay stuck down.
    this.root.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") this.input.blur();
    });
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.chat.sendChat(this.input.value);
      this.input.value = "";
    });
    head.querySelector(".chat-link")!.addEventListener("click", () => this.copyWatchLink());
    head.querySelector(".chat-crowd input")!.addEventListener("change", (e) => {
      this.chat.showCrowd = (e.target as HTMLInputElement).checked;
      this.renderFeed();
    });
    head.querySelector(".chat-toggle")!.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      this.applyClasses();
    });
    if (role === "spectator") {
      head.querySelector(".chat-crowd")!.remove();
      head.querySelector(".chat-link")!.remove();
    }
    window.addEventListener("keydown", this.onWindowKey);
    document.body.append(this.root, this.quickBar);
    chat.onChange = () => this.renderFeed();
    this.applyClasses();
  }

  setMode(mode: ChatPanelMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== "full") this.input.blur();
    this.applyClasses();
    this.renderFeed();
  }

  setWatching(n: number): void {
    this.watching.textContent = n > 0 ? `👁 ${n} watching` : "";
  }

  /** Quick lines offered now; pass [] to hide the bar. */
  setQuick(options: QuickLine[]): void {
    const key = JSON.stringify(options);
    if (key === this.quickKey) return;
    this.quickKey = key;
    this.quickBar.replaceChildren(
      ...options.map((line, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = `${i + 1}  ${renderQuick(line) ?? ""}`;
        // pointerdown, not click: this fires mid-fight, usually with another finger down.
        b.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          this.onQuick(i);
        });
        return b;
      }),
    );
  }

  /** Run a few times a second: the vote countdown. */
  tick(): void {
    const v = this.chat.vote;
    if (!v || this.role !== "spectator") {
      if (this.voteBox.childElementCount) this.voteBox.replaceChildren();
      return;
    }
    const left = Math.max(0, Math.ceil((v.endsAt - Date.now()) / 1000));
    if (!this.voteBox.childElementCount || this.voteBox.dataset.round !== String(v.round) || this.voteBox.dataset.mine !== String(v.mine)) {
      this.voteBox.dataset.round = String(v.round);
      this.voteBox.dataset.mine = String(v.mine);
      const title = document.createElement("div");
      title.className = "chat-vote-title";
      const supply = this.voteButton("🛡 Supply drop", "supply");
      const surge = this.voteButton("☠ Swarm surge", "surge");
      this.voteBox.replaceChildren(title, supply, surge);
    }
    (this.voteBox.firstElementChild as HTMLElement).textContent = v.mine ? `You voted. Result in ${left}s` : `Crowd vote: ${left}s left`;
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onWindowKey);
    this.root.remove();
    this.quickBar.remove();
  }

  // ---- Internals ------------------------------------------------------------
  private voteButton(label: string, choice: "supply" | "surge"): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.disabled = this.chat.vote?.mine != null;
    if (this.chat.vote?.mine === choice) b.classList.add("picked");
    b.addEventListener("click", () => this.chat.castVote(choice));
    return b;
  }

  /** Enter jumps into the chat box when the full panel is showing. */
  private onWindowKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter" && this.mode === "full" && !this.collapsed && document.activeElement !== this.input) {
      e.preventDefault();
      e.stopPropagation();
      this.input.focus();
    }
  };

  private copyWatchLink(): void {
    const link = this.watchLink();
    navigator.clipboard?.writeText(link).then(
      () => this.notify("Watch link copied"),
      () => this.notify(link),
    );
  }

  private applyClasses(): void {
    const off = this.chat.status === "off";
    this.root.className = `chat-panel mode-${off ? "hidden" : this.mode}${this.collapsed ? " collapsed" : ""}`;
    this.quickBar.hidden = off || this.quickKey === "[]" || this.quickKey === "";
    this.input.disabled = this.chat.status !== "ready";
    this.input.placeholder =
      this.chat.status === "ready"
        ? this.role === "spectator" ? "Cheer them on…" : "Message your squad…"
        : "Connecting chat…";
  }

  private renderFeed(): void {
    this.applyClasses();
    const entries = this.mode === "feed" ? this.chat.feed.slice(-5) : this.chat.feed;
    const keep = new Set(entries.map((e) => e.id));
    for (const [id, el] of this.rows) {
      if (!keep.has(id)) {
        el.remove();
        this.rows.delete(id);
      }
    }
    const pinned = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    for (const e of entries) {
      if (!this.rows.has(e.id)) {
        const el = this.row(e);
        this.rows.set(e.id, el);
        this.list.append(el);
      }
    }
    if (pinned) this.list.scrollTop = this.list.scrollHeight;
  }

  private row(e: FeedEntry): HTMLElement {
    const el = document.createElement("div");
    el.className = `chat-row${e.crowd ? " crowd" : ""}${e.quick ? " quick" : ""}`;
    const name = document.createElement("button");
    name.type = "button";
    name.className = "chat-name";
    name.textContent = e.name;
    name.style.color = COOP.slotColors[e.slot] ?? "#c7d2e0";
    if (e.mine) name.disabled = true;
    else {
      name.title = `Mute ${e.name}`;
      name.addEventListener("click", () => this.chat.mute(e.userId));
    }
    const text = document.createElement("span");
    text.textContent = e.text;
    el.append(name, text);
    return el;
  }
}

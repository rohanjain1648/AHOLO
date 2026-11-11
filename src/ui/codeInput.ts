import { normalizeCode } from "../net/relayProtocol";

/**
 * Ask for a room code with a real DOM <input>, so phones open their keyboard
 * (a canvas can't). Resolves the normalized code, or null on cancel. Key and
 * pointer events stop at the overlay so typing never steers the robot.
 */
/**
 * Ask for a Forge boss idea. Same overlay as the room code (real <input>, so
 * phones get a keyboard; events stop at the overlay). Resolves the trimmed
 * text, or null on cancel.
 */
export function askForgePrompt(): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "code-overlay";
    overlay.innerHTML = `
      <form class="code-card forge-card" novalidate>
        <label for="forge-prompt">FORGE YOUR BOSS</label>
        <p class="forge-hint">Describe a boss. Aholo Lux3D builds it in 3D, and it hunts you as your next boss.</p>
        <input id="forge-prompt" maxlength="100" autocomplete="off" spellcheck="true" inputmode="text"
               placeholder="a giant mechanical scorpion made of scrap" />
        <p class="code-error" role="alert"></p>
        <div class="code-buttons">
          <button type="button" class="code-cancel">Cancel</button>
          <button type="submit" class="code-join">Forge</button>
        </div>
      </form>`;
    const form = overlay.querySelector("form") as HTMLFormElement;
    const input = overlay.querySelector("input") as HTMLInputElement;
    const error = overlay.querySelector(".code-error") as HTMLParagraphElement;
    const done = (v: string | null): void => {
      overlay.remove();
      resolve(v);
    };
    for (const type of ["keydown", "keyup", "pointerdown", "pointerup"]) {
      overlay.addEventListener(type, (e) => e.stopPropagation());
    }
    overlay.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") done(null);
    });
    input.addEventListener("input", () => (error.textContent = ""));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value.replace(/\s+/g, " ").trim();
      if (v.length >= 3) done(v);
      else error.textContent = "Describe your boss in a few words";
    });
    (overlay.querySelector(".code-cancel") as HTMLButtonElement).addEventListener("click", () => done(null));
    document.body.appendChild(overlay);
    input.focus();
  });
}

export function askRoomCode(): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "code-overlay";
    overlay.innerHTML = `
      <form class="code-card" novalidate>
        <label for="room-code">ENTER ROOM CODE</label>
        <input id="room-code" maxlength="4" autocomplete="off" autocapitalize="characters"
               spellcheck="false" inputmode="text" placeholder="ABCD" />
        <p class="code-error" role="alert"></p>
        <div class="code-buttons">
          <button type="button" class="code-cancel">Cancel</button>
          <button type="submit" class="code-join">Join</button>
        </div>
      </form>`;
    const form = overlay.querySelector("form") as HTMLFormElement;
    const input = overlay.querySelector("input") as HTMLInputElement;
    const error = overlay.querySelector(".code-error") as HTMLParagraphElement;

    const done = (v: string | null): void => {
      overlay.remove();
      resolve(v);
    };
    for (const type of ["keydown", "keyup", "pointerdown", "pointerup"]) {
      overlay.addEventListener(type, (e) => e.stopPropagation());
    }
    overlay.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") done(null);
    });
    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase();
      error.textContent = "";
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const code = normalizeCode(input.value);
      if (code) done(code);
      else error.textContent = "Codes are 4 letters/numbers";
    });
    (overlay.querySelector(".code-cancel") as HTMLButtonElement).addEventListener("click", () => done(null));

    document.body.appendChild(overlay);
    input.focus();
  });
}

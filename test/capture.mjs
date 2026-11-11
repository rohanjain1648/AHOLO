// Headless screenshot capture for checking effects and for the hackathon
// report. Plays the production build (npm run build first) with fire held,
// and saves frames into docs/report/auto/:
//   - kill-N.png  a few frames right after kills (shatter deaths)
//   - intro.png   mid boss intro (spawned via the dev ?boss=now hook? no: a
//                 production build has no dev hooks, so it waits for nothing;
//                 use `node test/capture.mjs dev` against the dev server)
// Usage:  node test/capture.mjs            (production preview, port 4188)
//         node test/capture.mjs dev 5191   (running dev server, enables ?boss=now)
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { preview } from "vite";

const [, , mode = "prod", devPort = "5191"] = process.argv;
const out = "docs/report/auto";
mkdirSync(out, { recursive: true });

let server = null;
let base;
if (mode === "dev") {
  base = `http://localhost:${devPort}/`;
} else {
  server = await preview({ preview: { port: 4188, strictPort: true } });
  base = "http://localhost:4188/";
}

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl"] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", (e) => errors.push(e.message));
  const query = mode === "dev" ? "?debug&boss=now" : "?debug";
  await page.goto(base + query, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__nova && window.__nova().state === "menu", { timeout: 30000 });
  await page.mouse.click(640, 460);
  await page.waitForTimeout(300);

  if (mode === "dev") {
    await page.waitForTimeout(1300);
    await page.screenshot({ path: `${out}/intro.png` });
    console.log("saved intro.png");
  }

  await page.mouse.move(900, 380);
  await page.mouse.down();
  let kills = 0;
  let shots = 0;
  for (let i = 0; i < 400 && shots < 6; i++) {
    await page.keyboard.press("Digit1"); // auto-pick level-up cards
    const s = await page.evaluate(() => window.__nova());
    if (s.kills > kills) {
      kills = s.kills;
      await page.waitForTimeout(120);
      await page.screenshot({ path: `${out}/kill-${++shots}.png` });
    }
    await page.mouse.move(640 + Math.cos(i * 0.3) * 300, 360 + Math.sin(i * 0.3) * 250);
    await page.waitForTimeout(100);
  }
  console.log(`saved ${shots} kill frames (kills=${kills})`);
} finally {
  await browser.close();
  if (server) await new Promise((r) => server.httpServer.close(r));
}
if (errors.length) {
  console.error("Runtime errors:\n  " + errors.join("\n  "));
  process.exit(1);
}

# NOVA SWARM — Devpost Submission

> **A real-time 3D roguelite wave-survivor with online co-op, procedural Web Audio, and zero-GC simulation — running entirely in the browser.**

- 🎮 **Live Demo:** [https://parsewave-sigma.vercel.app/](https://parsewave-sigma.vercel.app/)
- 📦 **Source Code:** [https://github.com/rohanjain1648/parsewave](https://github.com/rohanjain1648/parsewave)
- 🏷️ **Built With:** `TypeScript`, `Three.js`, `WebGL`, `Vite`, `Web Audio API`, `HTML5 Canvas 2D`, `WebSockets`, `Node.js`, `Playwright`, `Vitest`, `Vercel`, `Render`

---

## 💡 Inspiration

Roguelite swarm-survivors and bullet heavens (like *Vampire Survivors*) deliver one of the most addictive loops in modern gaming: dodging dense swarms, vacuuming up glowing XP gems, and building god-tier synergies. However, nearly all existing entries in the genre share familiar drawbacks:
1. **Friction and installation hurdles:** Heavy downloads or account registrations prevent jumping into a quick run with friends.
2. **Missing or clunky multiplayer:** Co-op is either completely absent or burdened by complex networking and desyncs.
3. **Compromised web experiences:** Most browser games in this genre are limited to flat 2D canvas sprites or suffer severe garbage collection frame drops as soon as enemy density climbs.

We set out to build the ultimate zero-friction web experience: **a full real-time 3D, skeletal-animated, neon wave-survivor that loads in under 2 seconds in any browser, runs at a locked 60 FPS without garbage-collection hitching, features seamless 2–4 player co-op with instant room codes, and synthesizes 100% of its audio procedurally at runtime.**

---

## 🎮 What It Does

**NOVA SWARM** drops players into a pulsating neon arena under siege by rogue robot legions. Weapons auto-target the nearest threat, shifting all player focus to **tactical positioning, kiting, and synergistic build-crafting**.

### 🌟 Gameplay Features
- **The Swarm & The Warden Boss:** Survive escalating waves of 5 distinct enemy archetypes (Scouts, Swarmers, Tanks, Shooters, and Disruptors). Every 2 minutes, a massive **Warden Boss** drops into the arena, demanding high maneuverability and focused firepower.
- **Freeze-Frame Upgrade Drafts:** Gathering XP gems triggers time-frozen card drafts, offering choices from 15 stackable upgrades across primary weapons and survivability stats.
- **Four Distinct Combat Archetypes:**
  - 🛡️ **Vanguard:** Armored frontline tank with 150% HP and heavy plating.
  - ⚡ **Recon:** High-mobility scout with +30% movement speed and an expanded XP vacuum radius.
  - 🔥 **Striker:** High-risk glass cannon boasting +35% damage and +15% fire rate.
  - ◉ **Engineer:** High-tech specialist deploying with lethal Orbital Shard blades from second zero.
- **Weapon Arsenal:**
  - 💥 **Blaster:** Rapid auto-targeting plasma bolts that level up with piercing rounds, boosted fire rates, and multi-projectile spreads.
  - 🌀 **Orbital Shards:** Rotating energy crystals that shred melee enemies venturing into proximity.
  - ⚡ **Pulse Nova:** Periodic 360-degree shockwaves dealing devastating radial damage and swarm knockback.

### 🤝 Seamless 2–4 Player Online Co-op
- **Frictionless Lobby System:** No accounts, logins, or server browsers. Click **HOST CO-OP** on the title screen to generate an instant 4-letter room code or shareable direct-link (`?room=ABCD`).
- **Team XP, Personal Builds:** All squad members contribute to one shared XP pool, but each player drafts their own independent build. A synchronized 15-second level-up huddle pauses the run so everyone can pick their upgrade without getting overwhelmed.
- **Downed & Revive Mechanics:** Hitting 0 HP downs your robot instead of ending the run. A living teammate standing within revive range for 3 seconds brings you back at 30% HP. A run only concludes when the entire squad is down.
- **Tactical Ping System:** Press `G` (or tap the on-screen ping button) to place a coordinate beacon visible to your entire squad, complete with off-screen edge indicators.
- **Responsive on Desktop & Mobile Web:** One-handed keyboard/mouse controls on desktop and intuitive single-thumb drag-to-steer controls on mobile browsers.

---

## 🛠️ How We Built It (Technical Architecture)

NOVA SWARM was built from scratch without bloated game engines (no Unity, Godot, or Phaser). The engine, simulation, rendering, networking, and audio are completely hand-crafted:

```
┌─────────────────────────────────────────────────────────────────────┐
│ main.ts — State Machine (Loading → Menu → Playing ⇄ LevelUp/Pause)  │
└───────────────┬───────────────────────────────────┬─────────────────┘
                │ update(dt) fixed @ 60Hz            │ render() every rAF
                ▼                                     ▼
┌───────────────────────────────┐      ┌──────────────────────────────┐
│ game/World — PURE SIMULATION  │      │ render/WorldView — 3D SYNC   │
│  player, enemies[], bullets[],│─────▶│  reads World's pooled arrays │
│  gems[], director, upgrades   │ data │  writes Three.js transforms, │
│  (100% renderer-agnostic)     │ only │  tints, animation clips      │
└───────────────┬───────────────┘      └──────────────┬───────────────┘
                │ SpatialGrid queries                  │ scene graph
                ▼                                       ▼
       core/grid.ts (broad-phase)          render/scene.ts (Bloom, Lights)
                                           render/fx.ts (Instanced VFX)
                                           render/robots.ts (GLTF Bones)
```

### 1. Simulation Engine & Zero-GC Memory Management
- **Fixed-Timestep Accumulator (`core/loop.ts`):** The simulation loop updates physics at a strict 60Hz (`dt = 1/60`) using an accumulator pattern with a 0.25s spiral-of-death clamp. Game balance, spawn pacing, and weapon intervals remain 100% identical on 60Hz, 144Hz, and 240Hz monitors.
- **Index-Stable Pooled Structs (`game/world.ts`):** All active entities (enemies, player bullets, enemy bullets, XP/heal gems, particles) are pre-allocated flat arrays with `dead: boolean` flags. Spawning simply re-initializes dead slots in place. No gameplay allocations occur in the hot path, eliminating garbage collection pauses even deep into a 40-minute run.
- **Index-Matched Three.js Instancing:** Because slot `enemies[i]` retains a stable index, the 3D renderer maintains a parallel array of robot instances at the exact same index (`robots[i]`), updating transforms and visibility without dictionary lookups or array diffing.
- **Broad-Phase Uniform Spatial Grid (`core/grid.ts`):** Spatial partitioning divides the 3200×3200 arena into 128-unit hash buckets. Rebuilt every simulation tick in microseconds, weapon hit-scans and auto-aim queries operate in near constant time rather than $O(N \times M)$ brute force.

### 2. Real-Time 3D Rendering Pipeline (Three.js & WebGL)
- **Deep Skeletal Instancing (`render/robots.ts`):** A single CC0 animated robot model (`RobotExpressive.glb`, ~450 KB) is loaded once. Each of the ~140 live entity slots receives an independent instance via `SkeletonUtils.clone()`. This gives every robot an isolated bone hierarchy for independent animations (idle, walk, run, death) while sharing geometry buffers on the GPU. Individual body materials are cloned to allow unique archetype tints and enemy tier colors.
- **Zero-Draw-Call VFX (`render/fx.ts`):** Bullets, gems, and hit sparks are managed via `THREE.InstancedMesh`. Live entity matrices update into GPU instance buffers each frame, rendering hundreds of glowing objects with single-digit draw calls.
- **Atmosphere & Post-Processing (`render/scene.ts`):** An `EffectComposer` pipeline pairs `RenderPass` with an `UnrealBloomPass` calibrated to selectively bloom high-luminance elements (plasma bolts, XP gems, and arena neon borders) without blowing out physically lit robot bodies.
- **Dual-Canvas Compositing:** The WebGL 3D canvas sits directly beneath a crisp 2D overlay canvas. Floating combat numbers are mapped from 3D world space into 2D screen coordinates using camera normalized device coordinate (NDC) projections (`labels3d.ts`).

### 3. Real-Time Co-op Networking & Relay Server
- **Authoritative Host + Zero-Latency Client Motion:** The hosting player's machine executes the authoritative `World` simulation. Client players simulate and predict their own movement locally (transmitting coordinates at 30Hz), guaranteeing responsive, lag-free movement regardless of network ping.
- **Binary World Snapshots (`src/net/snapshot.ts`):** The host streams quantized binary world snapshots at 20Hz. Event queues (damage, kills, level-ups, revives) are packed into binary buffers, keeping bandwidth consumption well below 50 KB/s even with 140+ enemies on screen.
- **WebSocket Relay (`server/`):** A lightweight Node.js/ws relay hosted on Render forwards packets between squad members. The server contains zero game simulation code, ensuring low resource usage and instant room routing.
- **Smart Cloud Wake-Up:** The title screen automatically fires a lightweight `/health` request upon page load to pre-warm the free-tier relay server, displaying a clear status on lobby buttons ("Waking co-op server...") until the connection is established.

### 4. 100% Procedural Web Audio Engine (`core/audio.ts`)
- **Zero Audio Files:** The game downloads zero audio assets. All sound effects—laser fire, explosions, pickup hums, and UI chimes—are generated in real-time via the browser's `Web Audio API` using oscillators, noise buffers, and shaped gain envelopes.
- **Dynamic Arpeggiator Music:** The synth soundtrack is an algorithmic arpeggiator over a minor pentatonic scale. The musical intensity, tempo, and note density dynamically escalate based on elapsed run time and swarm density.

---

## ⚡ Challenges We Ran Into

1. **The Mid-Build 2D to 3D Pivot:**
   Midway through the project, we pivoted from an initial 2D Canvas prototype to a full 3D skeletal-animated WebGL experience. Because the core engine (`game/world.ts`) was architected to be completely renderer-agnostic, the entire 2D drawing layer was replaced with Three.js without altering a single line of collision physics, spawn math, or weapon balancing.
2. **Root-Causing the Black `InstancedMesh` Bug:**
   Early in 3D development, gems and hit particles rendered solid black. Rather than guessing, we inspected the raw GPU-bound color buffers via browser developer hooks, confirming valid RGB values. Bisecting the render pipeline revealed an internal driver/shader issue with dynamic per-instance vertex colors. We re-engineered the VFX layer into dedicated fixed-color instance pools, completely resolving the bug while maintaining optimal draw calls.
3. **Diagnosing Pacing Stalls via Automated Playtesting:**
   During automated test playthroughs with Playwright, telemetry showed a run logging 32 kills by 47 seconds but remaining stuck at Level 2. The high-velocity blaster was killing enemies outside the default collection radius, leaving XP gems stranded. We implemented a gentle ambient vacuum magnet that draws distant gems toward the player, restoring fast-paced level progression (reaching Level 4 by 55 seconds) and providing satisfying visual feedback.
4. **Optimizing Multiplayer Bandwidth:**
   Broadcasting positions for 140+ enemies and hundreds of projectiles risked saturating browser network buffers. We addressed this by quantizing spatial coordinates into compact binary snapshots and broadcasting only combat events, allowing each client to generate purely cosmetic particles, screen shakes, and audio locally.

---

## 🏆 Accomplishments That We're Proud Of

- **60 FPS Real-Time 3D in the Browser:** Flawlessly animating up to 140 skinned 3D robots with dynamic lighting, trauma-squared camera shake, and bloom effects on a standard web page.
- **Zero-Friction Multiplayer:** Delivering full 2–4 player co-op with instant room codes and direct links—no logins, no installs, and sub-second room joins.
- **Ultra-Lightweight Bundle:** The entire production bundle is tiny, containing just one ~450 KB CC0 robot model and zero external audio files.
- **Headless Dual-Browser CI Smoke Tests:** Built Playwright test suites (`test/smoke.mjs` and `test/coop-smoke.mjs`) that spin up multiple headless Chromium instances to simulate live co-op gameplay, verify level-up card selections, and enforce zero console or runtime errors.

---

## 📚 What We Learned

- **Strict Engine Decoupling Pays Huge Dividends:** Keeping the physics and game state independent of rendering made both the 3D graphics pivot and multiplayer snapshot serialization straightforward.
- **The Web Audio API Is Incredibly Powerful:** Writing procedural synthesizers eliminated megabytes of audio asset downloads and allowed game-intensity parameters to dynamically shape the music.
- **Automated Browser Playtesting Catches Real Game Design Flaws:** Using Playwright to run simulated playthroughs uncovered subtle gameplay balance issues that unit tests and type-checkers could never reveal.

---

## 🔮 What's Next for Nova Swarm

- 🌐 **WebRTC P2P Mesh:** Adding peer-to-peer data channels to bypass relay servers entirely when NAT allows.
- ⚡ **Weapon Evolution Synergies:** Unlocking fused super-weapons at max rank (e.g., Blaster + Orbital Shards = Plasma Vortex).
- 🏆 **Daily Seeded Global Challenges:** Competitive daily runs using synchronized RNG seeds and global high-score leaderboards.
- 👾 **New Arenas & Hazard Biomes:** Introducing dynamic battlefield hazards such as acid pools, plasma traps, and shifting terrain.

---

## 🕹️ Controls Quick Reference

| Action | Desktop Controls | Mobile Web Controls |
|---|---|---|
| **Move / Steer** | `WASD` / Arrow Keys | Single-thumb drag anywhere on screen |
| **Fire** | Automatic (targets nearest enemy) | Automatic |
| **Select Upgrade** | Click Card or press `1` / `2` / `3` | Tap Card |
| **Tactical Ping** | Press `G` | Tap on-screen **PING** button |
| **Pause / Menu** | `Esc` or `P` | Tap on-screen Pause button |
| **Mute Audio** | Press `M` | Tap Speaker icon |

---

## 🎬 60-Second Video Pitch / Demo Script

> **[0:00 - 0:12] The Hook**  
> *"What happens when you bring the intensity of Vampire Survivors into real-time 3D, add instant online co-op, and run it right in your browser? Meet NOVA SWARM."*  
> *(Gameplay footage: neon arena, robot kiting dense enemy waves, auto-blasters firing, XP gems vacuuming).*
>
> **[0:12 - 0:28] Gameplay & Archetypes**  
> *"Built from scratch in TypeScript and Three.js, NOVA SWARM puts you in control of an agile robot fighting off an endless rogue swarm. Choose from four classes like the tanky Vanguard or high-speed Recon. As you collect gems, time freezes to draft from 15 synergistic upgrades—turning your single blaster into a storm of orbital shards and pulse novae."*  
> *(Show level-up cards, selecting Orbital Shards, screen-shake during boss impact).*
>
> **[0:28 - 0:46] Seamless Co-op**  
> *"Best of all, you don't have to survive alone. Click 'Host Co-op', share a 4-letter room code, and your friends jump straight into the arena from any modern browser. Shared team XP, personal builds, tactical pings, and a 3-second revive mechanic keep the squad fighting until the last robot falls."*  
> *(Show two browser windows entering room code, playing together, and reviving a downed teammate).*
>
> **[0:46 - 1:00] Engineering & Call to Action**  
> *"Zero game engine bloat, zero audio files—everything from the 60 FPS physics to the adaptive synth soundtrack is computed live in code. Jump in right now at parsewave-sigma.vercel.app. How long can you survive?"*


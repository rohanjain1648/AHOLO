// The NOVA SWARM cast, generated with Lux3D. Each entry becomes one model in
// public/models/gen/ and one role in public/models/manifest.json.
//
//   id        manifest role the game looks up (see src/render/manifest.ts)
//   phase     land | space | props, so phases can be generated separately
//   rig       humanoid = Lux3D auto-rig + animation retarget; none = rigid,
//             animated procedurally in code (drones, turrets, ships, props)
//   anims     Lux3D retarget animation ids (max 10), humanoids only
//   faceCount Lux3D target faces (API minimum 10000)
//   tris      triangle budget after local simplification (mobile budget)
//   tex       max texture size after local resize
//
// Art direction: neon sci-fi, readable from a high top-down camera, so
// prompts ask for strong silhouettes and one bright accent color per unit.
// Humanoids are prompted in a T-pose because the auto-rigger expects it.

const TPOSE = "full body, standing in a T-pose with arms straight out to the sides, centered, plain background, game character";

const WALKER = ["Idle_Loop", "Walk_Loop", "Sprint_Loop", "Death01", "Hit_Chest"];

export const CAST = [
  // --- Land: player and enemy recast ---------------------------------------
  {
    id: "player.default",
    phase: "land",
    prompt: `a sleek sci-fi combat robot hero, white and cyan armor plates, glowing cyan visor, small jetpack on its back, ${TPOSE}`,
    style: "cyberpunk",
    rig: "humanoid",
    anims: ["Idle_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Death01", "Hit_Chest"],
    tris: 8000,
    tex: 1024,
  },
  {
    id: "enemy.grunt",
    phase: "land",
    prompt: `a rusty scrap-metal robot soldier, mismatched armor plates, single red glowing eye, hunched posture, ${TPOSE}`,
    style: "cyberpunk",
    rig: "humanoid",
    anims: ["Idle_Loop", "Zombie_Walk_Fwd_Loop", "Sprint_Loop", "Death01"],
    tris: 3000,
    tex: 512,
  },
  {
    id: "enemy.fast",
    phase: "land",
    prompt: `a thin agile android sprinter, long legs, streamlined chrome body, orange glowing joints, ${TPOSE}`,
    style: "cyberpunk",
    rig: "humanoid",
    anims: ["Idle_Loop", "Jog_Fwd_Loop", "Sprint_Loop", "Death01"],
    tris: 3000,
    tex: 512,
  },
  {
    id: "enemy.tank",
    phase: "land",
    prompt: `a hulking heavy armored brute robot, huge shoulders and fists, thick purple armor plating, small head, ${TPOSE}`,
    style: "cyberpunk",
    rig: "humanoid",
    anims: WALKER,
    tris: 4000,
    tex: 512,
  },
  {
    id: "enemy.splitter",
    phase: "land",
    prompt: "a round segmented robot beetle with six short stubby legs, green glowing seams between armor segments, toy-like sci-fi creature, centered, plain background",
    style: "cyberpunk",
    rig: "none",
    tris: 2500,
    tex: 512,
  },
  {
    id: "enemy.shooter",
    phase: "land",
    prompt: "a hovering sci-fi gun turret drone, spherical armored body with twin laser cannons on the front, magenta glowing core, no legs, centered, plain background",
    style: "cyberpunk",
    rig: "none",
    tris: 2500,
    tex: 512,
  },
  {
    id: "enemy.boss",
    phase: "land",
    prompt: `a towering war mech boss, massive armored chassis, glowing red reactor core in its chest, shoulder-mounted cannons, menacing, ${TPOSE}`,
    style: "cyberpunk",
    rig: "humanoid",
    anims: WALKER,
    tris: 12000,
    tex: 1024,
  },
];

export const findSpec = (id) => CAST.find((s) => s.id === id);

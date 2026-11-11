/** NOVA SWARM co-op relay entry point (Render runs this via `npm start`). */
import { chatFromEnv } from "./chatBackend";
import { Forge, lux3dForgeApi } from "./forge";
import { createRelayServer } from "./server";

const chat = chatFromEnv(process.env);
const key = process.env.LUX3D_API_KEY;
const forge = key
  ? new Forge(lux3dForgeApi(key), Date.now, {
      perIpPerHour: Number(process.env.FORGE_PER_IP_PER_HOUR ?? 3),
      perDay: Number(process.env.FORGE_PER_DAY ?? 40),
    })
  : null;
const relay = await createRelayServer(Number(process.env.PORT ?? 8787), { chat, forge });
console.log(`novaswarm relay listening on :${relay.port} (chat ${chat ? "on" : "off"}, forge ${forge ? "on" : "off"})`);

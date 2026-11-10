/** NOVA SWARM co-op relay entry point (Render runs this via `npm start`). */
import { chatFromEnv } from "./chatBackend";
import { createRelayServer } from "./server";

const chat = chatFromEnv(process.env);
const relay = await createRelayServer(Number(process.env.PORT ?? 8787), { chat });
console.log(`novaswarm relay listening on :${relay.port} (chat ${chat ? "on" : "off"})`);

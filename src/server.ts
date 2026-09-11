import { createServer } from "node:http";
import { createCoreApp } from "./app.js";

/**
 * Process entry point. Configuration comes only from the environment — no
 * credential or endpoint is ever hardcoded or committed.
 */
const port = Number(process.env["PORT"] ?? 8080);
const app = createCoreApp();

const server = createServer(app.router.nodeListener());

// Outbox relay. In production this runs as a separate process against the same
// database; here it shares the process while persistence is in-memory.
const relayIntervalMs = Number(process.env["OUTBOX_RELAY_INTERVAL_MS"] ?? 1000);
const relay = setInterval(() => {
  void app.publisher.drainOnce().catch((err) => {
    console.error(JSON.stringify({ level: "error", component: "outbox-relay", message: String(err) }));
  });
}, relayIntervalMs);

server.listen(port, () => {
  console.log(JSON.stringify({ level: "info", component: "http", message: `listening on ${port}` }));
});

function shutdown(signal: string) {
  console.log(JSON.stringify({ level: "info", component: "http", message: `shutting down (${signal})` }));
  clearInterval(relay);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { CONFIG } from "./config";
import { openDb, deleteJob, queueDepth } from "./db";
import { ensureSoundfonts, registerSoundfontRoutes } from "./soundfonts";
import { registerJobRoutes } from "./routes";
import { startWorker } from "./worker";
import { getServeUrl } from "./bundle";
import { registerWebUi } from "./web";

const main = async () => {
  mkdirSync(join(CONFIG.dataDir, "jobs"), { recursive: true });
  const db = openDb();
  ensureSoundfonts(db);

  const app = Fastify({ logger: true });
  await app.register(multipart, { limits: { files: 1, fields: 10, fileSize: CONFIG.maxSoundfontBytes } });

  // X-API-Key auth for /api/*; the web UI, /healthz and the internal /assets/*
  // endpoints are exempt (headless Chrome cannot present credentials).
  // Also accepts ?key= so <a> downloads and <video> previews can authenticate
  // (navigation requests cannot carry custom headers).
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (!path.startsWith("/api/")) return;
    if (!CONFIG.apiKey) return;
    const provided = req.headers["x-api-key"] ?? (req.query as { key?: string }).key;
    if (provided !== CONFIG.apiKey) await reply.code(401).send({ error: "unauthorized" });
  });

  registerJobRoutes(app, db);
  registerSoundfontRoutes(app, db);
  registerWebUi(app);
  app.get("/healthz", async () => ({ ok: true, queueDepth: queueDepth(db) }));

  await app.listen({ port: CONFIG.port, host: CONFIG.host });
  startWorker(db);

  // Warm the composition bundle in the background; jobs await the shared promise.
  getServeUrl()
    .then((url) => app.log.info({ url }, "composition bundled"))
    .catch((cause: unknown) => app.log.error({ cause }, "bundle failed"));

  // TTL sweeper: artifacts of finished jobs are dropped after the retention window.
  const sweep = () => {
    const stale = db
      .prepare("SELECT id FROM jobs WHERE status IN ('done', 'failed') AND updated_at < ?")
      .all(Date.now() - CONFIG.jobTtlMs) as unknown as { id: string }[];
    for (const { id } of stale) {
      rmSync(join(CONFIG.dataDir, "jobs", id), { recursive: true, force: true });
      deleteJob(db, id);
      app.log.info({ jobId: id }, "swept expired job");
    }
  };
  const sweeper = setInterval(sweep, 60 * 60 * 1000);

  const shutdown = async () => {
    clearInterval(sweeper);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

main().catch((cause: unknown) => {
  console.error(cause);
  process.exit(1);
});

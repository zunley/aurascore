import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const int = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export const CONFIG = {
  /** Repository root. */
  root,
  port: int(process.env.PORT, 9302),
  host: process.env.HOST ?? "0.0.0.0",
  /** When set, /api/* requires an X-API-Key header with this value. */
  apiKey: process.env.API_KEY ?? null,
  dataDir: process.env.DATA_DIR ?? join(root, "data"),
  /** Concurrency of the in-process render worker. */
  workerConcurrency: int(process.env.WORKER_CONCURRENCY, 1),
  /** Reject submissions when this many jobs are already queued. */
  maxQueueDepth: int(process.env.MAX_QUEUE_DEPTH, 20),
  maxMidiBytes: 5 * 1024 * 1024,
  maxMidiSeconds: 300,
  maxSoundfontBytes: 512 * 1024 * 1024,
  /** Rendered artifacts are deleted after this period. */
  jobTtlMs: 24 * 60 * 60 * 1000,
} as const;

/** Base URL used by the render worker (headless Chrome) to reach this server. */
export const assetBaseUrl = () => `http://127.0.0.1:${CONFIG.port}`;

/** The per-job asset endpoint the composition fetches its inputs from. */
export const jobAssetBaseUrl = (jobId: string) => `${assetBaseUrl()}/assets/${jobId}`;

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { CONFIG } from "./config";

export type JobStatus = "queued" | "rendering" | "done" | "failed";

export type JobRow = {
  id: string;
  status: JobStatus;
  progress: number;
  error: string | null;
  title: string | null;
  fps: number;
  width: number;
  height: number;
  soundfont: string;
  duration_seconds: number;
  render_seconds: number | null;
  created_at: number;
  updated_at: number;
};

export type SoundfontRow = {
  name: string;
  size: number;
  sha256: string;
  builtin: number;
  created_at: number;
};

export type Db = DatabaseSync;

export const openDb = (): Db => {
  const db = new DatabaseSync(join(CONFIG.dataDir, "jobs.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      error TEXT,
      title TEXT,
      fps INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      soundfont TEXT NOT NULL,
      duration_seconds REAL NOT NULL,
      render_seconds REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS soundfonts (
      name TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
};

// --- jobs -----------------------------------------------------------------

export type NewJob = Omit<JobRow, "status" | "progress" | "error" | "render_seconds" | "created_at" | "updated_at">;

export const insertJob = (db: Db, job: NewJob) => {
  const now = Date.now();
  db.prepare(
    `INSERT INTO jobs (id, status, progress, title, fps, width, height, soundfont, duration_seconds, created_at, updated_at)
     VALUES (?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(job.id, job.title, job.fps, job.width, job.height, job.soundfont, job.duration_seconds, now, now);
};

/** All jobs, newest first. */
export const listJobs = (db: Db, limit = 500): JobRow[] =>
  db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as JobRow[];

export const getJob = (db: Db, id: string): JobRow | null => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;

export const queueDepth = (db: Db): number => {
  const row = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get() as { n: number };
  return row.n;
};

/** Atomically claims the oldest queued job. Returns null when the queue is empty. */
export const claimJob = (db: Db): JobRow | null =>
  db
    .prepare(
      `UPDATE jobs SET status = 'rendering', updated_at = ?
       WHERE id IN (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1)
       RETURNING *`,
    )
    .get(Date.now()) as JobRow | null;

export const updateProgress = (db: Db, id: string, progress: number) => {
  db.prepare("UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?").run(progress, Date.now(), id);
};

export const finishJob = (db: Db, id: string, renderSeconds: number) => {
  db.prepare("UPDATE jobs SET status = 'done', progress = 1, render_seconds = ?, updated_at = ? WHERE id = ?").run(renderSeconds, Date.now(), id);
};

export const failJob = (db: Db, id: string, error: string) => {
  db.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 2000), Date.now(), id);
};

export const deleteJob = (db: Db, id: string) => {
  db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
};

/** True when any queued/rendering job still references the given soundfont. */
export const soundfontInUse = (db: Db, name: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM jobs WHERE soundfont = ? AND status IN ('queued', 'rendering') LIMIT 1").get(name));

// --- soundfonts ------------------------------------------------------------

export const listSoundfonts = (db: Db): SoundfontRow[] => db.prepare("SELECT * FROM soundfonts ORDER BY builtin DESC, created_at ASC").all() as unknown as SoundfontRow[];

export const getSoundfont = (db: Db, name: string): SoundfontRow | null => db.prepare("SELECT * FROM soundfonts WHERE name = ?").get(name) as SoundfontRow | null;

export const findSoundfontByHash = (db: Db, sha256: string): SoundfontRow | null =>
  db.prepare("SELECT * FROM soundfonts WHERE sha256 = ? LIMIT 1").get(sha256) as SoundfontRow | null;

export const insertSoundfont = (db: Db, row: Omit<SoundfontRow, "created_at">) => {
  db.prepare("INSERT INTO soundfonts (name, size, sha256, builtin, created_at) VALUES (?, ?, ?, ?, ?)").run(row.name, row.size, row.sha256, row.builtin, Date.now());
};

export const deleteSoundfont = (db: Db, name: string) => {
  db.prepare("DELETE FROM soundfonts WHERE name = ?").run(name);
};

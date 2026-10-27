import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { parseMidi } from "../shared/midi";
import { CONFIG } from "./config";
import { Db, JobRow, deleteJob, getJob, getSoundfont, insertJob, listJobs, queueDepth } from "./db";

const ALLOWED_FPS = [24, 30, 60];
const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const ASSET_FILES: Record<string, string> = { "input.mid": "audio/midi", "input.mp3": "audio/mpeg" };

const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error });

const slug = (title: string | null, id: string) =>
  (title ?? id)
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || id;

const parseIntField = (raw: string | undefined, fallback: number, min: number, max: number, label: string): number | string => {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return `${label} must be an integer in [${min}, ${max}]`;
  return value;
};

const jobToJson = (job: JobRow) => {
  const videoReady = job.status === "done" && existsSync(join(CONFIG.dataDir, "jobs", job.id, "video.mp4"));
  return {
    id: job.id,
    status: job.status,
    progress: Math.round(job.progress * 1000) / 1000,
    error: job.error,
    title: job.title,
    fps: job.fps,
    width: job.width,
    height: job.height,
    soundfont: job.soundfont,
    durationSeconds: job.duration_seconds,
    renderSeconds: job.render_seconds,
    videoUrl: videoReady ? `/api/v1/jobs/${job.id}/video` : null,
    createdAt: job.created_at,
    expiresAt: job.updated_at + CONFIG.jobTtlMs,
  };
};

export const registerJobRoutes = (app: FastifyInstance, db: Db) => {
  app.post("/api/v1/jobs", async (req, reply) => {
    let midiBuffer: Buffer | null = null;
    const fields: Record<string, string> = {};

    for await (const part of req.parts()) {
      if (part.type === "file") {
        const buffer = await part.toBuffer();
        if (part.fieldname === "file" && !part.file.truncated) midiBuffer = buffer;
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!midiBuffer) return fail(reply, 400, "multipart file field is required (.mid)");
    if (midiBuffer.length > CONFIG.maxMidiBytes) return fail(reply, 413, `midi exceeds ${CONFIG.maxMidiBytes} bytes`);

    let parsed;
    try {
      parsed = parseMidi(new Uint8Array(midiBuffer).buffer as ArrayBuffer);
    } catch (cause) {
      return fail(reply, 422, `invalid midi: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (parsed.notes.length === 0) return fail(reply, 422, "midi contains no note events");
    if (parsed.durationSeconds > CONFIG.maxMidiSeconds) return fail(reply, 422, `midi is longer than ${CONFIG.maxMidiSeconds} seconds`);

    let fps = 30;
    if (fields.fps !== undefined && fields.fps !== "") {
      const value = Number(fields.fps);
      if (!Number.isInteger(value) || !ALLOWED_FPS.includes(value)) return fail(reply, 422, `fps must be one of ${ALLOWED_FPS.join(", ")}`);
      fps = value;
    }
    const width = parseIntField(fields.width, 1280, 320, 1920, "width");
    if (typeof width === "string") return fail(reply, 422, width);
    const height = parseIntField(fields.height, 720, 180, 1080, "height");
    if (typeof height === "string") return fail(reply, 422, height);

    const soundfontName = fields.soundfont ?? "default";
    if (!getSoundfont(db, soundfontName)) return fail(reply, 422, `unknown soundfont '${soundfontName}' (see GET /api/v1/soundfonts)`);

    const title = fields.title?.trim() ? fields.title.trim().slice(0, 200) : null;

    if (queueDepth(db) >= CONFIG.maxQueueDepth) return fail(reply, 429, "queue is full, retry later");

    const id = randomUUID();
    const jobDir = join(CONFIG.dataDir, "jobs", id);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "input.mid"), midiBuffer);
    insertJob(db, { id, title, fps, width, height, soundfont: soundfontName, duration_seconds: parsed.durationSeconds });

    reply.code(202);
    return {
      jobId: id,
      status: "queued",
      durationSeconds: parsed.durationSeconds,
      links: { status: `/api/v1/jobs/${id}`, video: `/api/v1/jobs/${id}/video` },
    };
  });

  app.get("/api/v1/jobs", async () => ({ items: listJobs(db).map(jobToJson), queueDepth: queueDepth(db) }));

  app.get("/api/v1/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(db, id);
    if (!job) return fail(reply, 404, "job not found");
    return jobToJson(job);
  });

  app.get("/api/v1/jobs/:id/video", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(db, id);
    if (!job) return fail(reply, 404, "job not found");
    const videoPath = join(CONFIG.dataDir, "jobs", job.id, "video.mp4");
    if (job.status === "done") {
      if (!existsSync(videoPath)) return fail(reply, 410, "artifact expired");
      reply
        .header("content-type", "video/mp4")
        .header("content-disposition", `attachment; filename="${slug(job.title, job.id)}.mp4"`);
      return reply.send(createReadStream(videoPath));
    }
    if (job.status === "failed") return reply.code(409).send({ error: job.error ?? "render failed", status: job.status });
    return reply.code(409).send({ error: "job not finished", status: job.status, progress: job.progress });
  });

  app.delete("/api/v1/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(db, id);
    if (!job) return fail(reply, 404, "job not found");
    if (job.status === "rendering") return fail(reply, 409, "job is rendering");
    rmSync(join(CONFIG.dataDir, "jobs", job.id), { recursive: true, force: true });
    deleteJob(db, job.id);
    return reply.code(204).send();
  });

  // Internal asset endpoint used by the composition running in headless
  // Chrome. Unauthenticated by design (see auth hook exemptions).
  app.get("/assets/:jobId/:file", async (req, reply) => {
    const { jobId, file } = req.params as { jobId: string; file: string };
    if (!JOB_ID_RE.test(jobId) || !(file in ASSET_FILES)) return reply.code(404).send();
    const path = join(CONFIG.dataDir, "jobs", jobId, file);
    if (!existsSync(path)) return reply.code(404).send();
    reply
      .header("content-type", ASSET_FILES[file])
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      // The composition is evaluated in headless Chrome under the Remotion
      // serve origin, so asset fetches are cross-origin by design.
      .header("access-control-allow-origin", "*");
    return reply.send(createReadStream(path));
  });
};

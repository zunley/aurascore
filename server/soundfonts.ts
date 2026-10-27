import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { CONFIG } from "./config";
import { Db, SoundfontRow, deleteSoundfont, findSoundfontByHash, getSoundfont, insertSoundfont, listSoundfonts, soundfontInUse } from "./db";

export const BUILTIN_SOUNDFONT = "default";
export const SOUND_FONT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SF2_MAGIC = "sfbk";

export const soundfontsDir = () => join(CONFIG.dataDir, "soundfonts");
export const soundfontPath = (name: string) => join(soundfontsDir(), `${name}.sf2`);

const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Ensures the data dir holds the built-in SoundFont and its DB row. */
export const ensureSoundfonts = (db: Db) => {
  mkdirSync(soundfontsDir(), { recursive: true });
  const source = join(CONFIG.root, "sounds", "default.sf2");
  const target = soundfontPath(BUILTIN_SOUNDFONT);
  if (existsSync(source) && !existsSync(target)) {
    copyFileSync(source, target);
  }
  if (existsSync(target) && !getSoundfont(db, BUILTIN_SOUNDFONT)) {
    insertSoundfont(db, { name: BUILTIN_SOUNDFONT, size: statSync(target).size, sha256: hashFile(target), builtin: 1 });
  }
};

const toPublic = (row: SoundfontRow) => ({
  name: row.name,
  size: row.size,
  sha256: row.sha256,
  builtin: row.builtin === 1,
  createdAt: row.created_at,
});

export const registerSoundfontRoutes = (app: FastifyInstance, db: Db) => {
  app.get("/api/v1/soundfonts", async () => ({ items: listSoundfonts(db).map(toPublic) }));

  app.post("/api/v1/soundfonts", async (req, reply) => {
    let name: string | null = null;
    let uploadPath: string | null = null;
    let sha256: string | null = null;
    let size = 0;
    let truncated = false;

    for await (const part of req.parts()) {
      if (part.type !== "file") {
        if (part.fieldname === "name") name = String(part.value);
        continue;
      }
      if (part.fieldname !== "file") {
        part.file.resume();
        continue;
      }
      uploadPath = join(soundfontsDir(), `.upload-${randomUUID()}`);
      const hash = createHash("sha256");
      const out = createWriteStream(uploadPath);
      try {
        for await (const chunk of part.file) {
          size += chunk.length;
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
        }
        await new Promise((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve(undefined))));
      } finally {
        part.file.resume();
      }
      truncated = part.file.truncated;
      sha256 = hash.digest("hex");
    }

    const cleanup = () => {
      if (uploadPath) rmSync(uploadPath, { force: true });
    };

    if (!uploadPath || !name) {
      cleanup();
      return reply.code(400).send({ error: "multipart fields file(.sf2) and name are required" });
    }
    if (!SOUND_FONT_NAME_RE.test(name)) {
      cleanup();
      return reply.code(422).send({ error: "name must match ^[a-z0-9][a-z0-9_-]{0,63}$" });
    }
    if (truncated) {
      cleanup();
      return reply.code(413).send({ error: `soundfont exceeds ${CONFIG.maxSoundfontBytes} bytes` });
    }
    if (size === 0) {
      cleanup();
      return reply.code(422).send({ error: "empty file" });
    }
    // SF2 files start with the RIFF chunk id "sfbk".
    const fd = openSync(uploadPath, "r");
    const magic = Buffer.alloc(4);
    readSync(fd, magic, 0, 4, 0);
    closeSync(fd);
    if (magic.toString("latin1") !== SF2_MAGIC) {
      cleanup();
      return reply.code(422).send({ error: "not a SoundFont file (missing 'sfbk' magic)" });
    }
    if (getSoundfont(db, name)) {
      cleanup();
      return reply.code(409).send({ error: `soundfont '${name}' already exists; DELETE it first to replace` });
    }
    const existing = findSoundfontByHash(db, sha256!);
    if (existing) {
      cleanup();
      return reply.code(409).send({ error: `identical file already registered as '${existing.name}'` });
    }
    renameSync(uploadPath, soundfontPath(name));
    insertSoundfont(db, { name, size, sha256: sha256!, builtin: 0 });
    reply.code(201);
    return { name, size, sha256: sha256!, builtin: false };
  });

  app.delete("/api/v1/soundfonts/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const row = getSoundfont(db, name);
    if (!row) return reply.code(404).send({ error: "soundfont not found" });
    if (row.builtin === 1) return reply.code(400).send({ error: "built-in soundfont cannot be deleted" });
    if (soundfontInUse(db, name)) return reply.code(409).send({ error: "soundfont is used by queued/rendering jobs" });
    rmSync(soundfontPath(name), { force: true });
    deleteSoundfont(db, name);
    return reply.code(204).send();
  });
};

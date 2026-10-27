#!/usr/bin/env node
/**
 * Prepares the local development data directories:
 *   data/jobs/dev/       - copy of dev/ assets, served at /assets/dev/*
 *   data/soundfonts/     - copy of the bundled sounds/default.sf2
 *
 * Run before `npm run dev` (the studio defaultProps point at the dev job).
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const devJobDir = join(root, "data", "jobs", "dev");
const soundfontsDir = join(root, "data", "soundfonts");

mkdirSync(devJobDir, { recursive: true });
mkdirSync(soundfontsDir, { recursive: true });

for (const file of ["input.mid", "input.mp3"]) {
  const source = join(root, "dev", file);
  const target = join(devJobDir, file);
  if (existsSync(source) && !existsSync(target)) {
    copyFileSync(source, target);
    console.log(`[dev-setup] copied dev/${file} -> data/jobs/dev/${file}`);
  } else if (!existsSync(target)) {
    console.warn(`[dev-setup] dev/${file} missing, generate it with: npx tsx scripts/generate-audio.ts dev/input.mid dev/input.mp3`);
  }
}

const defaultSoundfont = join(root, "sounds", "default.sf2");
if (existsSync(defaultSoundfont) && !existsSync(join(soundfontsDir, "default.sf2"))) {
  copyFileSync(defaultSoundfont, join(soundfontsDir, "default.sf2"));
  console.log("[dev-setup] copied sounds/default.sf2 -> data/soundfonts/default.sf2");
}

console.log("[dev-setup] done — start the API server with `npm run server`, then `npm run dev`");

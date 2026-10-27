#!/usr/bin/env -S npx tsx
/**
 * CLI wrapper around shared/audio.ts.
 *
 * Usage:
 *   npx tsx scripts/generate-audio.ts <input.mid> <output.mp3> [--soundfont path.sf2]
 *
 * Defaults to the bundled SoundFont at sounds/default.sf2.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AudioGenerationError, generateAudio } from "../shared/audio";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const soundfontFlag = args.indexOf("--soundfont");
const soundfontPath = soundfontFlag === -1 ? join(root, "sounds", "default.sf2") : args[soundfontFlag + 1];
const [midiPath, outputPath] = args.filter((_, index) => index !== soundfontFlag && index !== soundfontFlag + 1);

if (!midiPath || !outputPath || !soundfontPath) {
  console.error("Usage: npx tsx scripts/generate-audio.ts <input.mid> <output.mp3> [--soundfont path.sf2]");
  process.exit(1);
}

try {
  console.log(`[generate-audio] rendering ${midiPath} with ${soundfontPath}`);
  generateAudio({ midiPath, outputPath, soundfontPath });
  console.log(`[generate-audio] wrote ${outputPath}`);
} catch (cause) {
  if (cause instanceof AudioGenerationError) {
    console.error(`[generate-audio] ${cause.message}`);
    process.exit(1);
  }
  throw cause;
}

#!/usr/bin/env node
/**
 * Generates public/input.mp3 from public/input.mid rendered through a SoundFont.
 *
 * Usage:
 *   node scripts/generate-audio.mjs             # always regenerate
 *   node scripts/generate-audio.mjs --if-missing # skip when public/input.mp3 is up to date
 *
 * Requires the `fluidsynth` CLI and `ffmpeg` on PATH.
 */
import {spawnSync} from "node:child_process";
import {existsSync, readdirSync, rmSync} from "node:fs";
import {mkdtempSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const midiPath = join(publicDir, "input.mid");
const preferredSoundfont = join(publicDir, "sounds.sf2");
const outputPath = join(publicDir, "input.mp3");
const skipIfExists = process.argv.includes("--if-missing");

const fail = (message) => {
	console.error(`[generate-audio] ${message}`);
	process.exit(1);
};

const findSoundfont = () => {
	if (existsSync(preferredSoundfont)) return preferredSoundfont;
	const candidate = readdirSync(publicDir).find((name) => name.toLowerCase().endsWith(".sf2"));
	if (!candidate) fail("No SoundFont found. Put sounds.sf2 (or any .sf2) in public/");
	return join(publicDir, candidate);
};

if (!existsSync(midiPath)) fail("public/input.mid not found");
if (skipIfExists && existsSync(outputPath)) {
	console.log("[generate-audio] public/input.mp3 is up to date, skipping");
	process.exit(0);
}

for (const tool of ["fluidsynth", "ffmpeg"]) {
	if (spawnSync(tool, ["--version"], {stdio: "ignore"}).error) {
		fail(`Missing dependency: ${tool}. Install it first (e.g. sudo apt-get install fluidsynth ffmpeg)`);
	}
}

const soundfont = findSoundfont();
console.log(`[generate-audio] rendering ${midiPath} with ${soundfont}`);

const workDir = mkdtempSync(join(tmpdir(), "music-dance-audio-"));
const wavPath = join(workDir, "render.wav");
try {
	const synth = spawnSync(
		"fluidsynth",
		["-ni", "-q", "-F", wavPath, "-r", "48000", "-g", "0.7", soundfont, midiPath],
		{stdio: "inherit"},
	);
	if (synth.status !== 0 || !existsSync(wavPath)) fail("fluidsynth failed to render the MIDI file");

	const encode = spawnSync(
		"ffmpeg",
		["-y", "-hide_banner", "-loglevel", "error", "-i", wavPath, "-codec:a", "libmp3lame", "-q:a", "2", "-ar", "48000", outputPath],
		{stdio: "inherit"},
	);
	if (encode.status !== 0 || !existsSync(outputPath)) fail("ffmpeg failed to encode public/input.mp3");
} finally {
	rmSync(workDir, {recursive: true, force: true});
}

console.log(`[generate-audio] wrote ${outputPath}`);

/**
 * Renders a MIDI file to MP3 through a SoundFont using fluidsynth + ffmpeg.
 * Used by the render worker and available as a CLI (scripts/generate-audio.ts).
 *
 * Requires the `fluidsynth` and `ffmpeg` binaries on PATH.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

export type GenerateAudioOptions = {
  midiPath: string;
  outputPath: string;
  soundfontPath: string;
  /** Overall gain passed to fluidsynth (-g). */
  gain?: number;
  /** Sample rate in Hz. */
  sampleRate?: number;
};

export class AudioGenerationError extends Error {}

const requireTool = (tool: string) => {
  if (spawnSync(tool, ["--version"], { stdio: "ignore" }).error) {
    throw new AudioGenerationError(`Missing dependency: ${tool}. Install it first (e.g. sudo apt-get install fluidsynth ffmpeg)`);
  }
};

/** Generates outputPath from midiPath. Throws AudioGenerationError on failure. */
export const generateAudio = ({ midiPath, outputPath, soundfontPath, gain = 0.7, sampleRate = 48000 }: GenerateAudioOptions): void => {
  requireTool("fluidsynth");
  requireTool("ffmpeg");
  if (!existsSync(midiPath)) throw new AudioGenerationError(`MIDI not found: ${midiPath}`);
  if (!existsSync(soundfontPath)) throw new AudioGenerationError(`SoundFont not found: ${soundfontPath}`);

  const wavPath = `${outputPath}.render.wav`;
  try {
    const synth = spawnSync(
      "fluidsynth",
      ["-ni", "-q", "-F", wavPath, "-r", String(sampleRate), "-g", String(gain), soundfontPath, midiPath],
      { stdio: "ignore" },
    );
    if (synth.status !== 0 || !existsSync(wavPath)) {
      throw new AudioGenerationError(`fluidsynth failed to render ${midiPath} (exit code ${synth.status})`);
    }

    const encode = spawnSync(
      "ffmpeg",
      ["-y", "-hide_banner", "-loglevel", "error", "-i", wavPath, "-codec:a", "libmp3lame", "-q:a", "2", "-ar", String(sampleRate), outputPath],
      { stdio: "ignore" },
    );
    if (encode.status !== 0 || !existsSync(outputPath)) {
      throw new AudioGenerationError(`ffmpeg failed to encode ${outputPath} (exit code ${encode.status})`);
    }
  } finally {
    rmSync(wavPath, { force: true });
  }
};

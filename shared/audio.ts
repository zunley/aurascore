/**
 * Renders a MIDI file to MP3 through a SoundFont using fluidsynth + ffmpeg.
 * Used by the render worker and available as a CLI (scripts/generate-audio.ts).
 *
 * Requires the `fluidsynth` and `ffmpeg` binaries on PATH.
 *
 * Loudness strategy
 * -----------------
 * fluidsynth's output has an *absolute* noise floor (~-90 LUFS, a sub-40 Hz
 * rumble inherent to the synth/SoundFont) that does not scale with MIDI
 * velocity or -g. Quiet MIDIs (low velocity) therefore render with a poor
 * signal-to-noise ratio, and boosting them afterwards lifts the noise floor
 * along with the music. To fix this properly:
 *
 *   1. Render at a base gain and measure integrated loudness / true peak.
 *   2. If too quiet, re-render with a higher fluidsynth gain (-g, capped at
 *      10) — this raises the music while the noise floor stays put, so the
 *      SNR improves. The re-render is additionally bounded by the true-peak
 *      headroom so it can never clip.
 *   3. Apply only the small residual trim (or attenuation for loud pieces)
 *      in post, guarded by the true-peak ceiling.
 *   4. Always strip the synthetic sub-40 Hz rumble with a cascaded 35 Hz
 *      high-pass. It carries no musical content (piano fundamentals live
 *      above it in practice) and removing it costs <0.1 dB on the music.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

export type GenerateAudioOptions = {
  midiPath: string;
  outputPath: string;
  soundfontPath: string;
  /** Base fluidsynth gain (-g) used for the first render pass. */
  gain?: number;
  /** Target integrated loudness in LUFS. Defaults to AUDIO_TARGET_LUFS or -23. */
  targetLufs?: number;
  /** True-peak ceiling in dBTP applied to every gain stage. */
  truePeakCeiling?: number;
  sampleRate?: number;
};

export class AudioGenerationError extends Error {}

/** fluidsynth's default render gain (kept for backward-compatible output). */
const BASE_GAIN = 0.7;
/** fluidsynth -g accepts 0..10; the synthesis stage never exceeds this. */
const MAX_FLUIDSYNTH_GAIN = 10;
/** EBU R128 target; override with the AUDIO_TARGET_LUFS env var. */
const DEFAULT_TARGET_LUFS = -23;
/** Leave headroom for lossy-codec overshoot (mp3/aac true peak). */
const DEFAULT_TRUE_PEAK_CEILING = -1.5;
/** Re-rendering only pays off when it buys at least this much gain. */
const MIN_SYNTH_RENDER_DB = 0.5;
/** Cascaded high-pass removing the synth's sub-40 Hz rumble. */
const RUMBLE_CUTOFF_HZ = 35;

const defaultTargetLufs = () => {
  const fromEnv = Number(process.env.AUDIO_TARGET_LUFS);
  return Number.isFinite(fromEnv) ? fromEnv : DEFAULT_TARGET_LUFS;
};

const requireTool = (tool: string) => {
  if (spawnSync(tool, ["--version"], { stdio: "ignore" }).error) {
    throw new AudioGenerationError(`Missing dependency: ${tool}. Install it first (e.g. sudo apt-get install fluidsynth ffmpeg)`);
  }
};

/** Renders midiPath to wavPath at the given fluidsynth gain. */
const renderWav = (midiPath: string, wavPath: string, soundfontPath: string, gain: number, sampleRate: number): void => {
  const synth = spawnSync(
    "fluidsynth",
    ["-ni", "-q", "-F", wavPath, "-r", String(sampleRate), "-g", String(gain), soundfontPath, midiPath],
    { stdio: "ignore" },
  );
  if (synth.status !== 0 || !existsSync(wavPath)) {
    throw new AudioGenerationError(`fluidsynth failed to render ${midiPath} (exit code ${synth.status})`);
  }
};

/** Measures EBU R128 integrated loudness (LUFS) and true peak (dBTP). */
const measureLoudness = (audioPath: string): { integrated: number; truePeak: number } => {
  const proc = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", audioPath, "-af", "loudnorm=print_format=json", "-f", "null", "-"], {
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new AudioGenerationError(`ffmpeg failed to measure loudness of ${audioPath}`);
  }
  const json = (proc.stderr ?? "").match(/\{[\s\S]*?\}/)?.[0];
  if (!json) throw new AudioGenerationError(`loudnorm produced no measurement for ${audioPath}`);
  const parsed = JSON.parse(json) as { input_i: string; input_tp: string };
  // loudnorm reports "-inf" for digital silence; clamp to its measurement floor.
  const integrated = parsed.input_i === "-inf" ? -70 : Number(parsed.input_i);
  const truePeak = parsed.input_tp === "-inf" ? -70 : Number(parsed.input_tp);
  if (!Number.isFinite(integrated) || !Number.isFinite(truePeak)) {
    throw new AudioGenerationError(`unexpected loudnorm output for ${audioPath}`);
  }
  return { integrated, truePeak };
};

export const generateAudio = ({
  midiPath,
  outputPath,
  soundfontPath,
  gain = BASE_GAIN,
  targetLufs = defaultTargetLufs(),
  truePeakCeiling = DEFAULT_TRUE_PEAK_CEILING,
  sampleRate = 48000,
}: GenerateAudioOptions): void => {
  requireTool("fluidsynth");
  requireTool("ffmpeg");
  if (!existsSync(midiPath)) throw new AudioGenerationError(`MIDI not found: ${midiPath}`);
  if (!existsSync(soundfontPath)) throw new AudioGenerationError(`SoundFont not found: ${soundfontPath}`);

  const wavPath = `${outputPath}.render.wav`;
  try {
    // 1. Base render + measurement.
    renderWav(midiPath, wavPath, soundfontPath, gain, sampleRate);
    const before = measureLoudness(wavPath);

    // 2. Lift loudness at the synthesis stage: music rises, the absolute
    //    noise floor does not, so the SNR improves. Bounded by fluidsynth's
    //    own gain cap and the true-peak headroom of the base render.
    const neededDb = targetLufs - before.integrated;
    const maxSynthUpDb = Math.min(20 * Math.log10(MAX_FLUIDSYNTH_GAIN / gain), truePeakCeiling - before.truePeak);
    const synthUpDb = Math.min(Math.max(neededDb, 0), maxSynthUpDb);

    let synthGain = gain;
    let measured = before;
    if (synthUpDb >= MIN_SYNTH_RENDER_DB) {
      synthGain = gain * 10 ** (synthUpDb / 20);
      renderWav(midiPath, wavPath, soundfontPath, synthGain, sampleRate);
      measured = measureLoudness(wavPath);
    }

    // 3. Residual trim in post (negative = attenuate an already-loud render),
    //    never above the true-peak ceiling.
    const residualDb = Math.min(targetLufs - measured.integrated, truePeakCeiling - measured.truePeak);

    // 4. Encode once: optional trim + rumble removal (the sub-40 Hz noise is
    //    a synth artifact, not musical content, so this always applies).
    const filters = [];
    if (Math.abs(residualDb) >= 0.05) filters.push(`volume=${residualDb.toFixed(2)}dB`);
    filters.push(`highpass=f=${RUMBLE_CUTOFF_HZ}`, `highpass=f=${RUMBLE_CUTOFF_HZ}`);
    const encode = spawnSync(
      "ffmpeg",
      ["-y", "-hide_banner", "-loglevel", "error", "-i", wavPath, "-af", filters.join(","), "-codec:a", "libmp3lame", "-q:a", "2", "-ar", String(sampleRate), outputPath],
      { stdio: "ignore" },
    );
    if (encode.status !== 0 || !existsSync(outputPath)) {
      throw new AudioGenerationError(`ffmpeg failed to encode ${outputPath}`);
    }

    const afterLufs = measured.integrated + residualDb;
    const afterPeak = measured.truePeak + residualDb;
    console.log(
      `[audio] ${afterLufs.toFixed(1)} LUFS (was ${before.integrated.toFixed(1)}), ` +
        `synth gain ${gain} -> ${synthGain.toFixed(2)}, post trim ${residualDb >= 0 ? "+" : ""}${residualDb.toFixed(1)} dB, ` +
        `rumble filter ${RUMBLE_CUTOFF_HZ} Hz x2, peak ${afterPeak.toFixed(1)} dBTP`,
    );
  } finally {
    rmSync(wavPath, { force: true });
  }
};

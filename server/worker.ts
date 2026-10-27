import { rmSync } from "node:fs";
import { join } from "node:path";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { generateAudio } from "../shared/audio";
import { CONFIG, jobAssetBaseUrl } from "./config";
import { Db, JobRow, claimJob, failJob, finishJob, updateProgress } from "./db";
import { getServeUrl } from "./bundle";
import { soundfontPath } from "./soundfonts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const processJob = async (db: Db, job: JobRow) => {
  const startedAt = Date.now();
  const jobDir = join(CONFIG.dataDir, "jobs", job.id);
  const videoPath = join(jobDir, "video.mp4");
  console.log(`[worker] job ${job.id} started (${job.duration_seconds.toFixed(1)}s, ${job.width}x${job.height}@${job.fps}, soundfont=${job.soundfont})`);
  try {
    // 1. Audio: MIDI -> MP3 through the job's SoundFont.
    generateAudio({
      midiPath: join(jobDir, "input.mid"),
      outputPath: join(jobDir, "input.mp3"),
      soundfontPath: soundfontPath(job.soundfont),
    });

    // 2. Video: headless Chrome renders the composition, fetching the job's
    //    assets back from this server via /assets/<jobId>/*.
    const serveUrl = await getServeUrl();
    const inputProps = {
      assetBaseUrl: jobAssetBaseUrl(job.id),
      title: job.title ?? undefined,
      fps: job.fps,
      width: job.width,
      height: job.height,
    };
    const composition = await selectComposition({ serveUrl, id: "MusicDance3D", inputProps });
    let lastProgressWrite = 0;
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: videoPath,
      inputProps,
      // Per-operation stall timeout (no single fetch/frame step may hang longer).
      timeoutInMilliseconds: 60_000,
      onProgress: ({ progress }) => {
        const now = Date.now();
        if (now - lastProgressWrite > 500) {
          lastProgressWrite = now;
          updateProgress(db, job.id, progress);
        }
      },
    });

    const renderSeconds = (Date.now() - startedAt) / 1000;
    finishJob(db, job.id, renderSeconds);
    console.log(`[worker] job ${job.id} done in ${renderSeconds.toFixed(1)}s`);
  } catch (cause) {
    rmSync(videoPath, { force: true });
    const message = errorMessage(cause);
    failJob(db, job.id, message);
    console.error(`[worker] job ${job.id} failed: ${message}`);
  }
};

/** Claims queued jobs and processes up to WORKER_CONCURRENCY of them in parallel. */
export const startWorker = (db: Db) => {
  const running = new Set<Promise<void>>();
  void (async () => {
    for (;;) {
      try {
        while (running.size < CONFIG.workerConcurrency) {
          const job = claimJob(db);
          if (!job) break;
          const task = processJob(db, job).finally(() => running.delete(task));
          running.add(task);
        }
      } catch (cause) {
        console.error("[worker] claim failed:", errorMessage(cause));
      }
      if (running.size > 0) {
        await Promise.race([...running]);
      } else {
        await sleep(2000);
      }
    }
  })();
};

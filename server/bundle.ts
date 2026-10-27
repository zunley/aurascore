import { join } from "node:path";
import { bundle } from "@remotion/bundler";
import { CONFIG } from "./config";

let pending: Promise<string> | null = null;

/** Bundles the composition once per process; concurrent callers share the promise. */
export const getServeUrl = (): Promise<string> => {
  pending ??= bundle({
    entryPoint: join(CONFIG.root, "src", "index.ts"),
    onProgress: (progress) => {
      if (progress % 25 === 0) console.log(`[bundle] ${progress}%`);
    },
  });
  return pending;
};

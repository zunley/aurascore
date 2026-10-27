import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { CONFIG } from "./config";

const WEB_DIR = join(CONFIG.root, "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * Serves the operator web UI from web/. No auth of its own — only /api/*
 * requires the API key (the UI collects it client-side), so keep /api
 * prefixed routes registered before this catch-all.
 */
export const registerWebUi = (app: FastifyInstance) => {
  const send = (reply: import("fastify").FastifyReply, relPath: string) => {
    const target = resolve(join(WEB_DIR, normalize(relPath)));
    if (target !== WEB_DIR && !target.startsWith(WEB_DIR + sep)) return reply.code(404).send();
    const path = existsSync(target) && statSync(target).isFile() ? target : join(WEB_DIR, "index.html");
    reply
      .header("content-type", MIME[extname(path)] ?? "application/octet-stream")
      .header("cache-control", "no-cache");
    return reply.send(createReadStream(path));
  };

  app.get("/", async (req, reply) => send(reply, "index.html"));
  app.get("/index.html", async (req, reply) => send(reply, "index.html"));
  app.get("/style.css", async (req, reply) => send(reply, "style.css"));
  app.get("/app.js", async (req, reply) => send(reply, "app.js"));
};

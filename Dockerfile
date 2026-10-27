# Render service image: Fastify API + in-process Remotion render worker.
FROM node:22-bookworm-slim

# Runtime deps: audio pipeline (fluidsynth/ffmpeg), headless Chrome libs, CJK fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fluidsynth ffmpeg \
    libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libasound2 libpango-1.0-0 libcairo2 \
    fonts-noto-cjk fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --loglevel=error

COPY . .
# Pre-download the Remotion headless shell so first boot needs no network.
RUN npx remotion browser ensure

ENV PORT=9302 NODE_ENV=production
EXPOSE 9302
VOLUME ["/app/data"]

# Needs --host docker group access if API_KEY auth is enabled on a public port.
CMD ["node", "node_modules/.bin/tsx", "server/index.ts"]

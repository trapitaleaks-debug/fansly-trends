FROM node:22-slim

# ffmpeg + chromium deps for Hyperframes HTML-to-video rendering
# fonts-noto-color-emoji gives Chrome native emoji glyph support
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-liberation \
    fonts-noto-color-emoji \
    python3 \
    make \
    g++ \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

# Install chrome-headless-shell for Hyperframes BeginFrame mode
# (regular chromium falls back to slow screenshot mode; chrome-headless-shell enables
#  deterministic frame-by-frame capture that is ~100x faster and more reliable)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npx --yes @puppeteer/browsers install chrome-headless-shell@stable 2>&1 | tail -3

# Hyperframes: use software rendering (no GPU on Railway)
ENV PRODUCER_BROWSER_GPU_MODE=software
# Give video elements more time to decode (own footage can be large)
ENV PRODUCER_PLAYER_READY_TIMEOUT_MS=90000

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3001
CMD ["npm", "run", "pipeline:server"]

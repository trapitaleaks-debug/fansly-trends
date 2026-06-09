FROM node:22-slim

# ffmpeg + chromium deps for Hyperframes HTML-to-video rendering
# fonts-noto-color-emoji gives Chrome native emoji glyph support
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-liberation \
    fonts-noto-color-emoji \
    fontconfig \
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
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# Install chrome-headless-shell for Hyperframes BeginFrame mode.
# Regular chromium (from apt) doesn't support HeadlessExperimental.beginFrame,
# so Hyperframes falls back to screenshot mode (~2s/frame = 7+ min for a 7s clip).
# chrome-headless-shell enables frame-by-frame deterministic capture (~fast).
# Symlink to a fixed path and set HYPERFRAMES_BROWSER_PATH so Hyperframes finds it
# instead of falling back to system /usr/bin/chromium.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npx --yes @puppeteer/browsers install chrome-headless-shell@stable 2>&1 | tail -3 \
    && ln -sf "$(find /root/.cache/puppeteer -name 'chrome-headless-shell' -type f | head -1)" \
              /usr/local/bin/chrome-headless-shell
ENV HYPERFRAMES_BROWSER_PATH=/usr/local/bin/chrome-headless-shell

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

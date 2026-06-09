FROM node:22-slim

# ffmpeg + chromium for Hyperframes HTML-to-video rendering
# fonts-noto-color-emoji gives Chrome proper emoji glyph support
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

# Hyperframes: point to system chromium, use software rendering (no GPU on Railway)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PRODUCER_HEADLESS_SHELL_PATH=/usr/bin/chromium
ENV PRODUCER_BROWSER_GPU_MODE=software

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3001
CMD ["npm", "run", "pipeline:server"]

FROM node:22-slim

# ffmpeg for video overlay processing, fonts-liberation for text rendering
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-liberation \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3001
CMD ["npm", "run", "pipeline:server"]

FROM node:18-slim

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN ffmpeg -version

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /tmp/video-merges && chmod 777 /tmp/video-merges

EXPOSE ${PORT:-8080}

CMD ["node", "App.js"]

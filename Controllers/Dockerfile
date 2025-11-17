FROM node:18-slim

WORKDIR /app

# Install FFmpeg for audio merging
RUN apt-get update && apt-get install -y ffmpeg && apt-get clean

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 8080

CMD ["node", "App.js"]

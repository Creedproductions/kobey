FROM node:20-alpine

WORKDIR /app

# Install required OS deps
RUN apk add --no-cache \
    ffmpeg \
    curl \
    bash \
    python3 \
  && ln -sf /usr/bin/python3 /usr/bin/python

# (Optional) if you still want to bypass the check:
# ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=1

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /tmp/media-temp

RUN adduser -D -u 1001 appuser && \
    chown -R appuser:appuser /app /tmp/media-temp

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "App.js"]

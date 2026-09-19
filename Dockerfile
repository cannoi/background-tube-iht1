FROM node:18-alpine
WORKDIR /app

# Zero runtime dependencies. Copy the app as-is so the image
# builds without touching the npm registry.
COPY package.json package-lock.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# SoloHost / docker-compose probe this path
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "server.js"]

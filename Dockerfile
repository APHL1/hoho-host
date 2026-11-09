# HoHoHost — image Docker (Node 22, aucune dépendance npm)
FROM node:22-alpine

LABEL org.opencontainers.image.title="HoHoHost" \
      org.opencontainers.image.description="Self-hosted family wishlists: reserve gifts without duplicates, Secret Santa, anonymous questions." \
      org.opencontainers.image.source="https://github.com/APHL1/hoho-host" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

RUN apk add --no-cache su-exec tzdata

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=Europe/Paris \
    PUID=1000 \
    PGID=1000

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data

VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

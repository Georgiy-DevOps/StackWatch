# Образ закреплён по digest: тег можно перезаписать, digest — нет.
# Обновление: docker buildx imagetools inspect node:24-alpine
FROM node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
COPY --chown=node:node package.json server.mjs agent.mjs watchdog.mjs healthcheck.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node deploy ./deploy
RUN mkdir -p /app/data /app/watchdog-data && chown node:node /app/data /app/watchdog-data
USER node
ENV HOST=0.0.0.0 PORT=4310 DATA_DIR=/app/data
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 CMD ["node", "healthcheck.mjs"]
CMD ["node", "server.mjs"]

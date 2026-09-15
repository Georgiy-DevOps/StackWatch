FROM node:24-alpine
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

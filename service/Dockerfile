# cleaningplan sidecar: Node 24, no npm dependencies (node:http + node:sqlite).
FROM node:24-slim
# setpriv (util-linux) drops to the node user after fixing the volume's ownership.
RUN setpriv --version >/dev/null
WORKDIR /app
COPY server.mjs ./
COPY app ./app
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3100 DB_PATH=/data/cleaningplan.db
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3100) + '/api/extensions/cleaningplan/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.mjs"]

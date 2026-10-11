FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock \
    && mkdir -p /data \
    && chown -R node:node /app /data
COPY --chown=node:node . .
ENV NODE_ENV=production
ENV RELAY_DB=/data/relay.db
VOLUME /data
EXPOSE 3400
USER node
CMD ["node", "server.js"]

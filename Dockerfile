FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV RELAY_DB=/data/relay.db
VOLUME /data
EXPOSE 3400
CMD ["node", "server.js"]

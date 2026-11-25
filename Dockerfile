FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node src ./src
COPY --chown=node:node schema.sql ./schema.sql
USER node
EXPOSE 3000
CMD ["npm","start"]

FROM node:20

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --omit=dev

COPY backend/ ./
COPY frontend/ ./public/

EXPOSE 3000

CMD ["node", "server.js"]

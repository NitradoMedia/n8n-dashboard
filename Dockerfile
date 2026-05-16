FROM node:20-alpine

WORKDIR /app

# Install backend deps
COPY backend/package.json ./backend/
RUN cd backend && npm install --production

# Copy source
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Data volume
VOLUME ["/data"]

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/dashboard.db

CMD ["node", "backend/server.js"]

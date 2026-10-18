FROM node:20-alpine

# Installa ffmpeg per la generazione dei timelapse
RUN apk add --no-cache ffmpeg

WORKDIR /usr/src/app

# Copia dipendenze e installa
COPY package*.json ./
RUN npm install --omit=dev

# Copia il codice applicazione
COPY server.js .
COPY public/ ./public/

# Porta esposta
EXPOSE 3000

# Avvio
CMD ["node", "server.js"]

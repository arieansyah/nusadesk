# NusaDesk signaling server — production image
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    NUSADESK_DB=/data/devices.json

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY index.js ./

# Device-ID ownership survives restarts in this volume
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]

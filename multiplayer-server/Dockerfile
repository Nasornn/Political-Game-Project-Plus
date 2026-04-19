FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=8787
EXPOSE 8787

CMD ["npm", "start"]

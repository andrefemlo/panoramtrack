FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

RUN npm install
RUN npx prisma generate
RUN npm run build

EXPOSE 3000

CMD sh -c "npx prisma db push && if [ \"$RUN_SEED\" = \"true\" ]; then npx prisma db seed; fi && node dist/main.js"
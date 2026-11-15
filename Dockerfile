FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --chown=node:node package.json ./
COPY --chown=node:node backend ./backend
COPY --chown=node:node public ./public

RUN mkdir -p /app/.data && chown node:node /app/.data

USER node
EXPOSE 3000

CMD ["npm", "start"]

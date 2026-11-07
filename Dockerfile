FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production DB_PATH=/data/clonereport.db TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]

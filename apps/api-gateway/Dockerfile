FROM node:22-alpine
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/api-gateway/package.json apps/api-gateway/package.json
COPY apps/auth-service/package.json apps/auth-service/package.json
COPY apps/group-service/package.json apps/group-service/package.json
COPY apps/message-service/package.json apps/message-service/package.json
COPY apps/notification-service/package.json apps/notification-service/package.json
COPY apps/user-service/package.json apps/user-service/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci

COPY . .
WORKDIR /workspace/apps/api-gateway
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

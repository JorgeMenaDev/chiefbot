# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
# HOSTNAME: Docker sets it to the container id, and Next would listen on that
# address alone. "::" listens on IPv4 and IPv6, since localhost can be either.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=::
COPY --from=build /src/.next/standalone ./
COPY --from=build /src/.next/static ./.next/static
COPY start.mjs ./
EXPOSE 3000
CMD ["node", "start.mjs"]

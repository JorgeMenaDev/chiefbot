# syntax=docker/dockerfile:1
# Behind a company network, Chiefbot passes CHIEFBOT_IMAGE_PREFIX, a registry
# mirror for the base images (docs/templates.md). Unset, they come from Docker Hub.
ARG CHIEFBOT_IMAGE_PREFIX=
FROM ${CHIEFBOT_IMAGE_PREFIX}node:24-alpine AS build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# npm uses the proxy's variables, which Chiefbot passes, and trusts the network's
# CA certificate, the build secret chiefbot-ca, on top of Node's own roots.
RUN --mount=type=secret,id=chiefbot-ca --mount=type=cache,target=/root/.npm \
  if [ -f /run/secrets/chiefbot-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/chiefbot-ca; fi \
  && npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM ${CHIEFBOT_IMAGE_PREFIX}node:24-alpine
WORKDIR /app
# HOSTNAME: Docker sets it to the container id, and Next would listen on that
# address alone. "::" listens on IPv4 and IPv6, since localhost can be either.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=::
COPY --from=build /src/.next/standalone ./
COPY --from=build /src/.next/static ./.next/static
COPY start.mjs ./
EXPOSE 3000
CMD ["node", "start.mjs"]

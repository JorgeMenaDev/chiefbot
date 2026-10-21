# The browser for check.sh: Playwright with Chromium's headless shell and its
# system libraries, nothing else.
# Behind a company network, Chiefbot passes CHIEFBOT_IMAGE_PREFIX, a registry
# mirror for the base images (docs/templates.md). Unset, they come from Docker Hub.
ARG CHIEFBOT_IMAGE_PREFIX=
FROM ${CHIEFBOT_IMAGE_PREFIX}node:24-bookworm-slim
WORKDIR /probe
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
  && npx playwright install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm
COPY probe.mjs ./
ENTRYPOINT ["node", "probe.mjs"]

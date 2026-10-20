# The browser for check.sh: Playwright with Chromium's headless shell and its
# system libraries, nothing else.
FROM node:24-bookworm-slim
WORKDIR /probe
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
  && npx playwright install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm
COPY probe.mjs ./
ENTRYPOINT ["node", "probe.mjs"]

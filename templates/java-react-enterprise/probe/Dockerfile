# The browser for check.sh. Its version matches the Playwright image's browsers.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /probe
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY probe.mjs ./
ENTRYPOINT ["node", "probe.mjs"]

# Behind a company network, Chiefbot passes CHIEFBOT_IMAGE_PREFIX, a registry
# mirror for the base images (docs/templates.md). Unset, they come from Docker Hub.
ARG CHIEFBOT_IMAGE_PREFIX=
FROM ${CHIEFBOT_IMAGE_PREFIX}node:24-alpine
WORKDIR /seed
COPY seed.mjs ./
COPY data ./data
CMD ["node", "seed.mjs"]

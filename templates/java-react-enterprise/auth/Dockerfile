# syntax=docker/dockerfile:1
# `gradle build` runs the tests too, so a failing test fails the image.
# Behind a company network, Chiefbot passes CHIEFBOT_IMAGE_PREFIX, a registry
# mirror for the base images (docs/templates.md). Unset, they come from Docker Hub.
ARG CHIEFBOT_IMAGE_PREFIX=
FROM ${CHIEFBOT_IMAGE_PREFIX}gradle:8.14.6-jdk17 AS build
WORKDIR /src
COPY . .
# Gradle trusts the network's CA certificate, the build secret chiefbot-ca (its
# first certificate), on top of the JDK's roots. Java reads no proxy variables.
RUN --mount=type=secret,id=chiefbot-ca --mount=type=cache,target=/home/gradle/.gradle \
  if [ -f /run/secrets/chiefbot-ca ]; then keytool -importcert -noprompt -cacerts -storepass changeit -alias chiefbot-ca -file /run/secrets/chiefbot-ca; fi \
  && gradle build --no-daemon --quiet

FROM ${CHIEFBOT_IMAGE_PREFIX}eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /src/build/libs/app.jar app.jar
COPY users.yaml users.yaml
EXPOSE 8081
ENTRYPOINT ["java", "-jar", "app.jar"]

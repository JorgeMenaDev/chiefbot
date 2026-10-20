# syntax=docker/dockerfile:1
# `gradle build` runs the tests too, so a failing test fails the image.
FROM gradle:8.14.6-jdk17 AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/home/gradle/.gradle gradle build --no-daemon --quiet

FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /src/build/libs/app.jar app.jar
COPY users.yaml users.yaml
EXPOSE 8081
ENTRYPOINT ["java", "-jar", "app.jar"]

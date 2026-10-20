# syntax=docker/dockerfile:1
FROM gradle:8.14.6-jdk17 AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/home/gradle/.gradle gradle build --no-daemon --quiet

FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /src/build/libs/app.jar app.jar
EXPOSE 8082
ENTRYPOINT ["java", "-jar", "app.jar"]

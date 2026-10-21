# syntax=docker/dockerfile:1
# `gradle build` runs the tests too, so a failing test fails the image.
# Behind a company network, Chiefbot passes CHIEFBOT_IMAGE_PREFIX, a registry
# mirror for the base images (docs/templates.md). Unset, they come from Docker Hub.
ARG CHIEFBOT_IMAGE_PREFIX=
FROM ${CHIEFBOT_IMAGE_PREFIX}gradle:8.14.6-jdk17 AS build
WORKDIR /src
COPY . .
# Gradle trusts the network's CA certificate, the build secret chiefbot-ca (its
# first certificate), on top of the JDK's roots. Java reads no proxy variables,
# so the proxy Docker passes to this step (HTTPS_PROXY, HTTP_PROXY and NO_PROXY,
# or lower-case: never declare them as an ARG or ENV) becomes Gradle's JVM proxy
# properties. With no proxy set, Gradle gets none.
RUN --mount=type=secret,id=chiefbot-ca --mount=type=cache,target=/home/gradle/.gradle <<'EOF'
set -euf
if [ -f /run/secrets/chiefbot-ca ]; then keytool -importcert -noprompt -cacerts -storepass changeit -alias chiefbot-ca -file /run/secrets/chiefbot-ca; fi
proxy=""
for scheme in http https; do
  if [ "$scheme" = http ]; then url=${HTTP_PROXY:-${http_proxy:-}}; else url=${HTTPS_PROXY:-${https_proxy:-}}; fi
  [ -n "$url" ] || continue
  # http://proxy.example.com:3128/ gives proxy.example.com and 3128 (with no port, the URL scheme's).
  address=${url#*://}; address=${address%%/*}; host=${address%:*}; port=${address##*:}
  if [ "$host" = "$address" ]; then case $url in https://*) port=443 ;; *) port=80 ;; esac; fi
  proxy="$proxy -D$scheme.proxyHost=$host -D$scheme.proxyPort=$port"
done
# NO_PROXY's hosts, |-separated, with a leading-dot domain as *.domain.
skip=${NO_PROXY:-${no_proxy:-}}
if [ -n "$proxy" ] && [ -n "$skip" ]; then proxy="$proxy -Dhttp.nonProxyHosts=$(printf %s "$skip" | sed -e 's/ //g' -e 's/^\./*./' -e 's/,\./,*./g' -e 's/,/|/g')"; fi
# One word per property (set -f keeps a * as it is).
gradle $proxy build --no-daemon --quiet
EOF

FROM ${CHIEFBOT_IMAGE_PREFIX}eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /src/build/libs/app.jar app.jar
COPY users.yaml users.yaml
EXPOSE 8081
ENTRYPOINT ["java", "-jar", "app.jar"]

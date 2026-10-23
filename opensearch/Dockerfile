# OpenSearch built locally from the official no-JDK distribution (Maven Central, checksum + PGP verified by
# `npm run up`) and this computer's OpenJDK 17, because the office web gateway cuts downloads of the bundled
# JDK inside opensearchproject/opensearch. Same OpenSearch engine; bundled plugins are not needed here.
FROM debian:bookworm-slim
ARG OPENSEARCH_VERSION=2.19.6
ARG CONFIG_HASH=
LABEL astra.config_hash=$CONFIG_HASH
RUN groupadd -g 1000 opensearch && useradd -u 1000 -g 1000 -M -d /usr/share/opensearch -s /bin/bash opensearch
COPY --chown=1000:1000 build/opensearch-${OPENSEARCH_VERSION} /usr/share/opensearch
COPY --chown=1000:1000 build/jdk /usr/share/opensearch/jdk
COPY --chown=1000:1000 opensearch.yml /usr/share/opensearch/config/opensearch.yml
RUN mkdir -p /usr/share/opensearch/data /usr/share/opensearch/logs \
 && chown -R 1000:1000 /usr/share/opensearch/data /usr/share/opensearch/logs
ENV OPENSEARCH_JAVA_HOME=/usr/share/opensearch/jdk \
    PATH=/usr/share/opensearch/bin:$PATH
WORKDIR /usr/share/opensearch
USER 1000
EXPOSE 9200
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=30 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/9200 && printf "GET /_cluster/health HTTP/1.0\r\n\r\n" >&3 && grep -qE "\"status\":\"(green|yellow)\"" <&3'
CMD ["opensearch"]

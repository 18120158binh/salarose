FROM docker.io/library/flink:2.2.0-java21

# The job jar bundles the Kafka, JDBC, and Postgres CDC connectors. Don't add them here: Flink loads
# org.apache.flink.* from lib first, so a copy in lib would replace the bundled one.
# The Postgres driver stays here, at the version in pom.xml: Flink's class loading guide keeps JDBC drivers in lib.
USER root
RUN apt-get update && \
    apt-get install -y wget && \
    wget -P /opt/flink/lib/ https://repo1.maven.org/maven2/org/postgresql/postgresql/42.7.3/postgresql-42.7.3.jar && \
    wget -P /opt/flink/lib/ https://repo1.maven.org/maven2/org/apache/flink/flink-sql-parquet/2.2.0/flink-sql-parquet-2.2.0.jar && \
    wget -P /opt/flink/lib/ https://repo1.maven.org/maven2/org/apache/hadoop/hadoop-client-api/3.3.6/hadoop-client-api-3.3.6.jar && \
    wget -P /opt/flink/lib/ https://repo1.maven.org/maven2/org/apache/hadoop/hadoop-client-runtime/3.3.6/hadoop-client-runtime-3.3.6.jar && \
    wget -P /opt/flink/lib/ https://repo1.maven.org/maven2/commons-logging/commons-logging/1.2/commons-logging-1.2.jar && \
    wget -P /opt/flink/lib/ https://repo1.maven.org/maven2/com/github/oshi/oshi-core/6.1.5/oshi-core-6.1.5.jar && \
    wget -P /opt/flink/lib/ https://repo1.maven.org/maven2/net/java/dev/jna/jna/5.12.1/jna-5.12.1.jar && \
    wget -P /opt/flink/lib/ https://repo1.maven.org/maven2/net/java/dev/jna/jna-platform/5.12.1/jna-platform-5.12.1.jar && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

USER flink

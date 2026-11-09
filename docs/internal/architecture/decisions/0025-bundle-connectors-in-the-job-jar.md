---
title: Bundle the connectors in the job JAR and keep the JDBC driver in the image
id: "0025"
status: proposed
date: 2026-10-20
tags: [flink, build, deployment]
supersedes: []
superseded_by: []
---

# 0025. Bundle the connectors in the job JAR and keep the JDBC driver in the image

## Context

The Flink jobs use three connectors: Kafka, JDBC, and Postgres CDC. Each one shipped twice. The job JAR bundled Kafka 5.0.0-2.2, JDBC 4.0.0-2.0, CDC 3.6.0-2.2, and the Postgres driver. The Flink image added the Kafka SQL connector 4.0.1-2.0, JDBC 4.0.0-2.0, the CDC SQL connector, the driver, and `zstd-jni` to `/opt/flink/lib`.

Flink resolves every class that matches `classloader.parent-first-patterns.default` from `lib` before the job JAR. In Flink 2.2 the default list starts with `java.`, `scala.`, and `org.apache.flink.`. So the connector classes in `lib` ran, not the ones the jobs compiled against. The Kafka client classes (`org.apache.kafka.*`) match no pattern, so they loaded from the job JAR. To log in with SASL/SCRAM, the jobs rewrote the JAAS login module to the name relocated inside the Kafka SQL connector JAR. That class existed only in the image. That was PLT-KI-02.

The system has never run, so no image, JAR, or savepoint depends on the old layout.

## Decision

The job JAR is the only source of the connectors. The image adds no connector JAR. Every connector is a release built for the Flink version in the image, 2.2. The jobs pass the JAAS config to the Kafka client unchanged.

The Postgres driver is the exception. It ships only in the image's `lib`. The JAR declares it `provided`, at the version the Dockerfile downloads. `flink-connector-base` is `provided` too, because `flink-dist` already carries it.

A unit test fails when a connector on the job's classpath is built for another Flink version, when the configured login module cannot be loaded, when the Dockerfile adds a connector, or when the driver versions differ.

This was chosen during the fix of PLT-KI-02. It is pending owner review.

## Why

- Flink's connector guide lists three ways to add a connector: shade the thin JAR into the job JAR, shade the uber JAR into the job JAR, or copy the uber JAR to `lib`. It says the uber JARs are "supported mostly for being used in conjunction with the SQL client". These jobs are DataStream and Table API programs, not SQL client sessions. [Source](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/dev/configuration/connector/)
- In application mode on Kubernetes, Flink loads the job JAR and `usrlib` through its user code class loader, child-first. A class that matches a parent-first pattern still loads from the job JAR when `lib` lacks it, because the loader asks the parent first and falls back to its own JARs. So the bundled `org.apache.flink.connector.*` and `org.apache.flink.cdc.*` classes run once the image stops shipping a copy. [Source](https://nightlies.apache.org/flink/flink-docs-release-2.2/docs/ops/debugging/debugging_classloading/)
- One place to change: a connector upgrade is a `pom.xml` edit and needs no new image. The job's tests run against the same classes the cluster runs.
- The same class loading guide says JDBC drivers "leak references outside the user code classloader" and should go in `lib/` instead of the user JAR. That is why the driver stays in the image.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Mark the connectors `provided` and pin the image's JARs to Flink 2.2 builds | Two files to keep in step for four artifacts. The job's tests would run against thin JARs while the cluster ran uber JARs with other contents, such as relocated Kafka clients. The SCRAM module name would still depend on the image. |
| Bundle the driver in the job JAR too | Fewer parts, but against Flink's class loading guide. The driver registers itself with `DriverManager`, which can hold the user code class loader after the job restarts. |
| Keep JDBC 4.0.0-2.0, built for Flink 2.0 | It avoids the OpenLineage SQL parser that 4.1.0-2.2 pulls in, but it compiles against Flink 2.0 APIs. |

## Consequences

- The image is a plain Flink 2.2 image plus the driver, Parquet, Hadoop, and metrics JARs. It no longer changes when a connector changes.
- The JAR grew from about 52 MB to about 67 MB. Most of the growth is `openlineage-sql-java`, a dependency of JDBC 4.1.0-2.2 with native parsers for Linux x86_64 and aarch64. Flink calls it when it builds the job graph, to report lineage for the JDBC sink.
- `zstd-jni` now loads from the job JAR, as a dependency of the Kafka client. It extracts its native library to a new temporary file for each class loader. This is inferred from its code, not run on a cluster.
- A JAAS config that names the relocated `org.apache.flink.kafka.shaded...` module fails to log in.
- Two classes in `flink-cdc-flink2-compat` duplicate Flink's own (`org.apache.flink.api.connector.sink2.Sink` and `org.apache.flink.table.api.ValidationException`). They match a parent-first pattern, so Flink's copies run.

## Related

- [Deployment](../../operations/deployment.md#images)
- [Configuration](../../operations/configuration.md)

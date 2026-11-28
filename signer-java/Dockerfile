# Multi-stage image: dependencies are bundled into the shaded JAR.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY signer-java/pom.xml signer-java/pom.xml
COPY signer-java/src signer-java/src
RUN mvn --batch-mode -f signer-java/pom.xml -DskipTests package

FROM eclipse-temurin:21-jre-jammy
RUN groupadd --system --gid 10001 signer \
    && useradd --system --uid 10001 --gid signer --home-dir /app --create-home signer
WORKDIR /app
COPY --from=build --chown=10001:10001 /workspace/signer-java/target/rep-p-cades-signer-0.1.0-SNAPSHOT.jar /app/signer.jar
USER 10001:10001
ENV PORT=8787
ENV REP_CADES_BIND_HOST=0.0.0.0
EXPOSE 8787
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=70.0", "-jar", "/app/signer.jar"]

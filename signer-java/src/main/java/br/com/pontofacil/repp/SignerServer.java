package br.com.pontofacil.repp;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public final class SignerServer {
    private static final int MAX_REQUEST_BYTES = 34_000_000;
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build());
    private static final Set<String> REQUEST_FIELDS = Set.of("operationId", "content", "contentSha256", "format", "contentType");
    private final byte[] serviceToken;
    private final CadesSigner signer;
    private HttpServer server;
    private ExecutorService executor;

    SignerServer(String serviceToken, CadesSigner signer) {
        if (serviceToken == null || serviceToken.length() < 32) {
            throw new IllegalArgumentException("REP_CADES_SERVICE_TOKEN must contain at least 32 characters");
        }
        if (signer == null || !signer.ready()) throw new IllegalArgumentException("CAdES signer is not ready");
        this.serviceToken = serviceToken.getBytes(StandardCharsets.UTF_8);
        this.signer = signer;
    }

    boolean authorized(String authorization) {
        return matchesBearer(serviceToken, authorization);
    }

    static boolean matchesBearer(byte[] expectedToken, String authorization) {
        if (authorization == null || !authorization.startsWith("Bearer ")) return false;
        byte[] supplied = authorization.substring(7).getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(expectedToken, supplied);
    }

    synchronized void start(String bindHost, int port) throws IOException {
        if (server != null) throw new IllegalStateException("Signer HTTP server is already started");
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Signer port must be between 1 and 65535");
        InetAddress bindAddress = InetAddress.getByName(bindHost);
        server = HttpServer.create(new InetSocketAddress(bindAddress, port), 32);
        server.createContext("/healthz", exchange -> respond(exchange, 200, "{\"status\":\"alive\"}"));
        server.createContext("/readyz", exchange -> {
            if (signer.ready()) respond(exchange, 200, "{\"status\":\"ready\",\"signingEnabled\":true}");
            else respond(exchange, 503, "{\"status\":\"not_ready\",\"signingEnabled\":false}");
        });
        server.createContext("/v1/sign-detached", this::signDetached);
        executor = Executors.newFixedThreadPool(4, task -> {
            Thread thread = new Thread(task, "rep-p-cades-http");
            thread.setDaemon(false);
            return thread;
        });
        server.setExecutor(executor);
        server.start();
    }

    synchronized void stop() {
        if (server != null) {
            server.stop(1);
            server = null;
        }
        if (executor != null) {
            executor.shutdown();
            try {
                if (!executor.awaitTermination(5, TimeUnit.SECONDS)) executor.shutdownNow();
            } catch (InterruptedException interrupted) {
                executor.shutdownNow();
                Thread.currentThread().interrupt();
            }
            executor = null;
        }
    }

    static JsonNode parseRequest(byte[] body) throws IOException {
        try (JsonParser parser = JSON.getFactory().createParser(body)) {
            JsonNode request = JSON.readTree(parser);
            if (request == null || !request.isObject() || parser.nextToken() != null) {
                throw new IOException("Request must contain exactly one JSON object");
            }
            Set<String> fields = new java.util.HashSet<>();
            request.fieldNames().forEachRemaining(fields::add);
            if (!REQUEST_FIELDS.equals(fields)) throw new IOException("Unexpected or missing request fields");
            return request;
        }
    }

    private void signDetached(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"method_not_allowed\"}");
            return;
        }
        if (!authorized(exchange.getRequestHeaders().getFirst("Authorization"))) {
            respond(exchange, 401, "{\"error\":\"unauthorized\"}");
            return;
        }
        String requestContentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (requestContentType == null
                || !requestContentType.toLowerCase(Locale.ROOT).matches("^application/json(?:\\s*;.*)?$")) {
            respond(exchange, 415, "{\"error\":\"content_type_must_be_json\"}");
            return;
        }
        String contentLength = exchange.getRequestHeaders().getFirst("Content-Length");
        if (contentLength != null) {
            try {
                if (Long.parseLong(contentLength) > MAX_REQUEST_BYTES) {
                    respond(exchange, 413, "{\"error\":\"request_too_large\"}");
                    return;
                }
            } catch (NumberFormatException invalidLength) {
                respond(exchange, 400, "{\"error\":\"invalid_content_length\"}");
                return;
            }
        }
        byte[] body;
        try (InputStream input = exchange.getRequestBody()) {
            body = input.readNBytes(MAX_REQUEST_BYTES + 1);
        }
        if (body.length > MAX_REQUEST_BYTES) {
            respond(exchange, 413, "{\"error\":\"request_too_large\"}");
            return;
        }
        try {
            JsonNode request = parseRequest(body);
            String operationId = requiredText(request, "operationId");
            String contentBase64 = requiredText(request, "content");
            String contentSha256 = requiredText(request, "contentSha256");
            if (!"CAdES-detached".equals(requiredText(request, "format"))
                    || !"application/octet-stream".equals(requiredText(request, "contentType"))
                    || !contentSha256.matches("(?i)[a-f0-9]{64}")
                    || !contentBase64.matches("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")) {
                respond(exchange, 400, "{\"error\":\"invalid_request\"}");
                return;
            }
            byte[] content = Base64.getDecoder().decode(contentBase64);
            if (content.length == 0 || content.length > 25_000_000
                    || !Base64.getEncoder().encodeToString(content).equals(contentBase64)) {
                respond(exchange, 400, "{\"error\":\"invalid_content\"}");
                return;
            }
            var result = signer.sign(operationId, content, contentSha256);
            respond(exchange, 200, JSON.writeValueAsString(result));
        } catch (Exception rejected) {
            // Do not disclose certificate, key-store, policy, or validation details to callers.
            respond(exchange, 503, "{\"error\":\"cryptographic_validation_failed\",\"signingEnabled\":false}");
        }
    }

    private static String requiredText(JsonNode node, String field) {
        JsonNode value = node == null ? null : node.get(field);
        if (value == null || !value.isTextual() || value.asText().isBlank()) {
            throw new IllegalArgumentException("Missing request field");
        }
        return value.asText();
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) { output.write(bytes); }
    }

    public static void main(String[] args) throws Exception {
        String token = System.getenv("REP_CADES_SERVICE_TOKEN");
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8787"));
        String bindHost = System.getenv().getOrDefault("REP_CADES_BIND_HOST", "127.0.0.1");
        CadesSigner signer = CadesSigner.fromEnvironment();
        SignerServer application = new SignerServer(token, signer);
        application.start(bindHost, port);
        Runtime.getRuntime().addShutdownHook(new Thread(application::stop, "rep-p-cades-shutdown"));
    }
}

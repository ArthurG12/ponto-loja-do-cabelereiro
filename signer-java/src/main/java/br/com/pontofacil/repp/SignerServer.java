package br.com.pontofacil.repp;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

public final class SignerServer {
    private static final int MAX_REQUEST_BYTES = 26_000_000;
    private final byte[] serviceToken;

    SignerServer(String serviceToken) {
        if (serviceToken == null || serviceToken.length() < 32) {
            throw new IllegalArgumentException("REP_CADES_SERVICE_TOKEN must contain at least 32 characters");
        }
        this.serviceToken = serviceToken.getBytes(StandardCharsets.UTF_8);
    }

    boolean authorized(String authorization) {
        if (authorization == null || !authorization.startsWith("Bearer ")) return false;
        byte[] supplied = authorization.substring(7).getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(serviceToken, supplied);
    }

    void start(int port) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 32);
        server.createContext("/healthz", exchange -> respond(exchange, 200, "{\"status\":\"alive\"}"));
        server.createContext("/readyz", exchange -> respond(exchange, 503,
            "{\"status\":\"not_ready\",\"signingEnabled\":false}"));
        server.createContext("/v1/sign-detached", this::rejectUntilCryptographicVerifierExists);
        server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(4));
        server.start();
    }

    private void rejectUntilCryptographicVerifierExists(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"method_not_allowed\"}");
            return;
        }
        if (!authorized(exchange.getRequestHeaders().getFirst("Authorization"))) {
            respond(exchange, 401, "{\"error\":\"unauthorized\"}");
            return;
        }
        byte[] body = exchange.getRequestBody().readNBytes(MAX_REQUEST_BYTES + 1);
        if (body.length > MAX_REQUEST_BYTES) {
            respond(exchange, 413, "{\"error\":\"request_too_large\"}");
            return;
        }
        // Deliberately no signing path exists until LPA/CMS, trust-chain,
        // revocation, policy and CAdES attribute validation are implemented.
        respond(exchange, 503, "{\"error\":\"cryptographic_validation_not_implemented\",\"signingEnabled\":false}");
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) { output.write(bytes); }
    }

    public static void main(String[] args) throws Exception {
        String token = System.getenv("REP_CADES_SERVICE_TOKEN");
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8787"));
        new SignerServer(token).start(port);
    }
}

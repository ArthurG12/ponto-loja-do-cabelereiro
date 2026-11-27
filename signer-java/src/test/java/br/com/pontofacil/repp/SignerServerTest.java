package br.com.pontofacil.repp;

import static org.junit.jupiter.api.Assertions.*;
import java.nio.charset.StandardCharsets;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import org.junit.jupiter.api.Test;

class SignerServerTest {
    @Test void rejectsMissingOrShortServiceToken() {
        assertThrows(IllegalArgumentException.class, () -> new SignerServer(null, null));
        assertThrows(IllegalArgumentException.class, () -> new SignerServer("short", null));
    }

    @Test void rejectsSignerThatHasNotPassedCryptographicBootstrap() {
        assertThrows(IllegalArgumentException.class,
            () -> new SignerServer("01234567890123456789012345678901", null));
    }

    @Test void comparesBearerTokenExactlyInConstantTimeHelper() {
        byte[] expected = "01234567890123456789012345678901".getBytes(StandardCharsets.UTF_8);
        assertTrue(SignerServer.matchesBearer(expected, "Bearer 01234567890123456789012345678901"));
        assertFalse(SignerServer.matchesBearer(expected, null));
        assertFalse(SignerServer.matchesBearer(expected, "Basic 01234567890123456789012345678901"));
        assertFalse(SignerServer.matchesBearer(expected, "Bearer 01234567890123456789012345678902"));
        assertFalse(SignerServer.matchesBearer(expected, "Bearer 01234567890123456789012345678901 "));
    }
    @Test void acceptsOnlyTheExactSignerRequestShape() throws Exception {
        String valid = "{\"operationId\":\"123e4567-e89b-12d3-a456-426614174000\","
                + "\"content\":\"YQ==\",\"contentSha256\":\"" + "a".repeat(64) + "\","
                + "\"format\":\"CAdES-detached\",\"contentType\":\"application/octet-stream\"}";
        assertEquals(5, SignerServer.parseRequest(valid.getBytes(StandardCharsets.UTF_8)).size());
        assertThrows(IOException.class, () -> SignerServer.parseRequest(
                (valid.substring(0, valid.length() - 1) + ",\"extra\":true}").getBytes(StandardCharsets.UTF_8)));
    }

    @Test void rejectsDuplicateJsonFieldsAndTrailingJsonValues() {
        String duplicate = "{\"operationId\":\"a\",\"operationId\":\"b\",\"content\":\"YQ==\","
                + "\"contentSha256\":\"" + "a".repeat(64) + "\",\"format\":\"CAdES-detached\","
                + "\"contentType\":\"application/octet-stream\"}";
        assertThrows(IOException.class, () -> SignerServer.parseRequest(duplicate.getBytes(StandardCharsets.UTF_8)));
        String trailing = "{\"operationId\":\"a\",\"content\":\"YQ==\",\"contentSha256\":\""
                + "a".repeat(64) + "\",\"format\":\"CAdES-detached\","
                + "\"contentType\":\"application/octet-stream\"} {}";
        assertThrows(IOException.class, () -> SignerServer.parseRequest(trailing.getBytes(StandardCharsets.UTF_8)));
    }

    @Test void rejectsArrayAndEmptySignerRequests() {
        assertThrows(IOException.class, () -> SignerServer.parseRequest("[]".getBytes(StandardCharsets.UTF_8)));
        assertThrows(IOException.class, () -> SignerServer.parseRequest("{}".getBytes(StandardCharsets.UTF_8)));
    }

    @Test void jsonStringLimitCanCarryTheMaximumBase64AfdPayload() {
        int maximumBase64Length = 4 * ((25_000_000 + 2) / 3);
        assertTrue(SignerServer.MAX_JSON_STRING_LENGTH >= maximumBase64Length);
    }

    @Test void rejectsExcessivelyNestedJson() {
        String nested = "[".repeat(17) + "null" + "]".repeat(17);
        String request = "{\"operationId\":\"123e4567-e89b-12d3-a456-426614174000\","
                + "\"content\":" + nested + ",\"contentSha256\":\"" + "a".repeat(64)
                + "\",\"format\":\"CAdES-detached\",\"contentType\":\"application/octet-stream\"}";
        assertThrows(IOException.class, () -> SignerServer.parseRequest(request.getBytes(StandardCharsets.UTF_8)));
    }

    @Test void exercisesPrivateHttpApiAuthenticationAndStrictRequestValidation() throws Exception {
        String token = "01234567890123456789012345678901";
        CadesSigningService fakeSigner = new CadesSigningService() {
            @Override public boolean ready() { return true; }
            @Override public Map<String, Object> sign(String operationId, byte[] content, String claimedDigest)
                    throws Exception {
                assertArrayEquals("a".getBytes(StandardCharsets.UTF_8), content);
                String actual = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
                assertEquals(actual, claimedDigest);
                return Map.of("operationId", operationId, "contentSha256", actual);
            }
        };
        SignerServer server = new SignerServer(token, fakeSigner);
        server.start("127.0.0.1", 0);
        try {
            HttpClient client = HttpClient.newHttpClient();
            URI endpoint = URI.create("http://127.0.0.1:" + server.port() + "/v1/sign-detached");
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest("a".getBytes(StandardCharsets.UTF_8)));
            String body = "{\"operationId\":\"123e4567-e89b-12d3-a456-426614174000\","
                    + "\"content\":\"YQ==\",\"contentSha256\":\"" + digest + "\","
                    + "\"format\":\"CAdES-detached\",\"contentType\":\"application/octet-stream\"}";

            HttpResponse<String> unauthorized = client.send(HttpRequest.newBuilder(endpoint)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(401, unauthorized.statusCode());

            HttpResponse<String> unsupportedType = client.send(HttpRequest.newBuilder(endpoint)
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "text/plain")
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(415, unsupportedType.statusCode());

            String duplicate = body.replace("\"content\":", "\"operationId\":\"123e4567-e89b-12d3-a456-426614174001\",\"content\":");
            HttpResponse<String> ambiguous = client.send(HttpRequest.newBuilder(endpoint)
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(duplicate)).build(),
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(400, ambiguous.statusCode());

            HttpResponse<String> accepted = client.send(HttpRequest.newBuilder(endpoint)
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/json; charset=utf-8")
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(200, accepted.statusCode());
            assertTrue(accepted.body().contains("123e4567-e89b-12d3-a456-426614174000"));
        } finally {
            server.stop();
        }
    }

}

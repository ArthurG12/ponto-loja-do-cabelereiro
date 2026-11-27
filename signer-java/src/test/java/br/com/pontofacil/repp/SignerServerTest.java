package br.com.pontofacil.repp;

import static org.junit.jupiter.api.Assertions.*;
import java.nio.charset.StandardCharsets;
import java.io.IOException;
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

}

package br.com.pontofacil.repp;

import static org.junit.jupiter.api.Assertions.*;
import java.nio.charset.StandardCharsets;
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
}

package br.com.pontofacil.repp;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;

class SignerServerTest {
    @Test void rejectsMissingOrShortServiceToken() {
        assertThrows(IllegalArgumentException.class, () -> new SignerServer(null));
        assertThrows(IllegalArgumentException.class, () -> new SignerServer("short"));
    }

    @Test void comparesBearerTokenExactly() {
        SignerServer server = new SignerServer("01234567890123456789012345678901");
        assertTrue(server.authorized("Bearer 01234567890123456789012345678901"));
        assertFalse(server.authorized(null));
        assertFalse(server.authorized("Basic 01234567890123456789012345678901"));
        assertFalse(server.authorized("Bearer 01234567890123456789012345678902"));
        assertFalse(server.authorized("Bearer 01234567890123456789012345678901 "));
    }
}

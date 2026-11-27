package br.com.pontofacil.repp;

import static org.junit.jupiter.api.Assertions.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.Duration;
import java.util.Date;
import java.util.HexFormat;
import org.bouncycastle.asn1.*;
import org.bouncycastle.asn1.nist.NISTObjectIdentifiers;
import org.bouncycastle.asn1.x509.AlgorithmIdentifier;
import org.junit.jupiter.api.Test;

class CadesSignerPolicyTest {
    private static final String OID = "2.16.76.1.7.1.1.2.4";
    private static final String URI = "https://example.invalid/PA_AD_RB_CAdES_2_4.der";

    private byte[][] fixture() throws Exception {
        byte[] internalHash = MessageDigest.getInstance("SHA-256").digest("internal-policy-hash".getBytes());
        ASN1EncodableVector paHashFields = new ASN1EncodableVector();
        paHashFields.add(new AlgorithmIdentifier(NISTObjectIdentifiers.id_sha256));
        paHashFields.add(new DEROctetString(internalHash));
        ASN1EncodableVector paFields = new ASN1EncodableVector();
        paFields.add(new DERSequence());
        paFields.add(new DERSequence(paHashFields));
        byte[] policyDer = new DERSequence(paFields).getEncoded("DER");
        byte[] publishedHash = MessageDigest.getInstance("SHA-256").digest(policyDer);

        Instant now = Instant.now();
        ASN1EncodableVector period = new ASN1EncodableVector();
        period.add(new ASN1GeneralizedTime(Date.from(now.minus(Duration.ofDays(1)))));
        period.add(new ASN1GeneralizedTime(Date.from(now.plus(Duration.ofDays(60)))));
        ASN1EncodableVector lpaHash = new ASN1EncodableVector();
        lpaHash.add(new AlgorithmIdentifier(NISTObjectIdentifiers.id_sha256));
        lpaHash.add(new DEROctetString(publishedHash));
        ASN1EncodableVector info = new ASN1EncodableVector();
        info.add(new DERSequence(period));
        info.add(new ASN1ObjectIdentifier(OID));
        info.add(new DERIA5String(URI));
        info.add(new DERSequence(lpaHash));
        ASN1EncodableVector infos = new ASN1EncodableVector();
        infos.add(new DERSequence(info));
        ASN1EncodableVector root = new ASN1EncodableVector();
        root.add(new ASN1Integer(0));
        root.add(new DERSequence(infos));
        root.add(new ASN1GeneralizedTime(Date.from(now.plus(Duration.ofDays(30)))));
        return new byte[][] { new DERSequence(paFields).getEncoded("DER"), new DERSequence(root).getEncoded("DER"), internalHash };
    }

    @Test void acceptsPolicyOnlyWhenLpaUriOidAndBothHashesMatch() throws Exception {
        byte[][] fixture = fixture();
        CadesSigner.Policy parsed = CadesSigner.parsePolicy(fixture[1], fixture[0], OID, URI,
                "2.4", HexFormat.of().formatHex(fixture[2]));
        assertEquals(OID, parsed.oid());
        assertEquals("2.4", parsed.version());
        assertTrue(parsed.nextUpdate().isAfter(Instant.now()));
        assertNull(parsed.revocationDate());
        assertTrue(CadesSigner.isPolicyCurrent(parsed, Instant.now()));
    }

    @Test void rejectsWrongPolicyUri() throws Exception {
        byte[][] fixture = fixture();
        assertThrows(SecurityException.class, () -> CadesSigner.parsePolicy(fixture[1], fixture[0],
                OID, "https://example.invalid/wrong.der", "2.4",
                HexFormat.of().formatHex(fixture[2])));
    }

    @Test void rejectsWrongInternalPolicyHash() throws Exception {
        byte[][] fixture = fixture();
        assertThrows(SecurityException.class, () -> CadesSigner.parsePolicy(fixture[1], fixture[0],
                OID, URI, "2.4", "00".repeat(32)));
    }
    @Test void rejectsExpiredFutureRevokedAndOverdueLpaPolicies() throws Exception {
        byte[][] fixture = fixture();
        CadesSigner.Policy valid = CadesSigner.parsePolicy(fixture[1], fixture[0], OID, URI,
                "2.4", HexFormat.of().formatHex(fixture[2]));
        Instant now = Instant.now();
        assertFalse(CadesSigner.isPolicyCurrent(new CadesSigner.Policy(OID, "2.4",
                now.minusSeconds(3600), now.minusSeconds(1), now.plusSeconds(60), null,
                fixture[2], "a".repeat(64)), now));
        assertFalse(CadesSigner.isPolicyCurrent(new CadesSigner.Policy(OID, "2.4",
                now.plusSeconds(60), now.plusSeconds(3600), now.plusSeconds(120), null,
                fixture[2], "a".repeat(64)), now));
        assertFalse(CadesSigner.isPolicyCurrent(new CadesSigner.Policy(OID, "2.4",
                now.minusSeconds(60), now.plusSeconds(3600), now.plusSeconds(120), now.minusSeconds(1),
                fixture[2], "a".repeat(64)), now));
        assertFalse(CadesSigner.isPolicyCurrent(new CadesSigner.Policy(OID, "2.4",
                now.minusSeconds(60), now.plusSeconds(3600), now.plus(Duration.ofDays(91)), null,
                fixture[2], "a".repeat(64)), now));
        assertTrue(CadesSigner.isPolicyCurrent(valid, now));
    }

}

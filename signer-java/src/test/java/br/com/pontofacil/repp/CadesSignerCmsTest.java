package br.com.pontofacil.repp;

import static org.junit.jupiter.api.Assertions.*;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.*;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.*;
import org.bouncycastle.cert.X509v3CertificateBuilder;
import org.bouncycastle.cert.jcajce.*;
import org.bouncycastle.cms.*;
import org.bouncycastle.asn1.cms.CMSAttributes;
import org.bouncycastle.cms.jcajce.JcaSimpleSignerInfoVerifierBuilder;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.junit.jupiter.api.Test;

class CadesSignerCmsTest {
    @Test void createsDetachedCmsWithAllMandatoryIcpBrasilSignedAttributes() throws Exception {
        if (Security.getProvider("BC") == null) Security.addProvider(new BouncyCastleProvider());
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        KeyPair pair = generator.generateKeyPair();
        Instant now = Instant.now();
        X500Name subject = new X500Name("C=BR,O=Teste,CN=Desenvolvedor CPF 12345678901");
        X509v3CertificateBuilder builder = new JcaX509v3CertificateBuilder(
                subject, BigInteger.valueOf(1001), Date.from(now.minusSeconds(60)),
                Date.from(now.plusSeconds(86400)), subject, pair.getPublic());
        builder.addExtension(Extension.keyUsage, true, new KeyUsage(KeyUsage.digitalSignature));
        var holder = builder.build(new JcaContentSignerBuilder("SHA256withRSA")
                .setProvider("BC").build(pair.getPrivate()));
        X509Certificate certificate = new JcaX509CertificateConverter()
                .setProvider("BC").getCertificate(holder);

        byte[] policyHash = MessageDigest.getInstance("SHA-256")
                .digest("policy".getBytes(StandardCharsets.UTF_8));
        CadesSigner.Policy policy = new CadesSigner.Policy(
                "2.16.76.1.7.1.1.2.4", "2.4", now.minusSeconds(60),
                now.plusSeconds(3600), now.plusSeconds(7200), false,
                policyHash, "a".repeat(64));
        CadesSigner signer = new CadesSigner(pair.getPrivate(), certificate,
                List.of(certificate), Set.of(), "SHA256withRSA", policy,
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                        .digest(certificate.getEncoded())).toUpperCase(Locale.ROOT),
                "12345678901", "production", "2.4");

        byte[] content = "AFD test fixture\r\n".getBytes(StandardCharsets.ISO_8859_1);
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
        Map<String, Object> response = signer.sign("123e4567-e89b-12d3-a456-426614174000", content, digest);
        byte[] signature = Base64.getDecoder().decode((String) response.get("signature"));
        CMSSignedData cms = new CMSSignedData(new CMSProcessableByteArray(content), signature);
        assertNotNull(cms.getSignedContent());
        assertEquals(1, cms.getSignerInfos().size());
        SignerInformation info = cms.getSignerInfos().getSigners().iterator().next();
        assertTrue(info.verify(new JcaSimpleSignerInfoVerifierBuilder().setProvider("BC").build(certificate)));
        assertNotNull(info.getSignedAttributes().get(CMSAttributes.contentType));
        assertNotNull(info.getSignedAttributes().get(CMSAttributes.messageDigest));
        assertNotNull(info.getSignedAttributes().get(new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.2.840.113549.1.9.16.2.47")));
        assertNotNull(info.getSignedAttributes().get(new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.2.840.113549.1.9.16.2.15")));
        assertEquals("2.16.76.1.7.1.1.2.4", response.get("policyIdentifier"));
        assertEquals("2.4", response.get("policyVersion"));
    }

    @Test void refusesContentDigestMismatchBeforeSigning() throws Exception {
        if (Security.getProvider("BC") == null) Security.addProvider(new BouncyCastleProvider());
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        KeyPair pair = generator.generateKeyPair();
        Instant now = Instant.now();
        X500Name subject = new X500Name("C=BR,O=Teste,CN=Desenvolvedor CPF 12345678901");
        var holder = new JcaX509v3CertificateBuilder(subject, BigInteger.valueOf(1002),
                Date.from(now.minusSeconds(60)), Date.from(now.plusSeconds(3600)),
                subject, pair.getPublic()).build(new JcaContentSignerBuilder("SHA256withRSA")
                .setProvider("BC").build(pair.getPrivate()));
        X509Certificate certificate = new JcaX509CertificateConverter()
                .setProvider("BC").getCertificate(holder);
        CadesSigner.Policy policy = new CadesSigner.Policy("2.16.76.1.7.1.1.2.4", "2.4",
                now.minusSeconds(60), now.plusSeconds(3600), now.plusSeconds(7200),
                false, new byte[32], "b".repeat(64));
        CadesSigner signer = new CadesSigner(pair.getPrivate(), certificate,
                List.of(certificate), Set.of(), "SHA256withRSA", policy,
                "c".repeat(64), "12345678901", "production", "2.4");
        assertThrows(SecurityException.class, () -> signer.sign(
                "123e4567-e89b-12d3-a456-426614174001",
                "content".getBytes(StandardCharsets.UTF_8), "0".repeat(64)));
    }
}

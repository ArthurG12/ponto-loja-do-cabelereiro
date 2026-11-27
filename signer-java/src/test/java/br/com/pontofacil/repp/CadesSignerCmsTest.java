package br.com.pontofacil.repp;

import static org.junit.jupiter.api.Assertions.*;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
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
import org.junit.jupiter.api.io.TempDir;

class CadesSignerCmsTest {
    @TempDir Path tempDir;
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
        assertDoesNotThrow(() -> CadesSigner.verifyKeyPair(pair.getPrivate(), certificate, "SHA256withRSA"));
        KeyPair wrongPair = generator.generateKeyPair();
        assertThrows(SecurityException.class,
                () -> CadesSigner.verifyKeyPair(wrongPair.getPrivate(), certificate, "SHA256withRSA"));

        byte[] policyHash = MessageDigest.getInstance("SHA-256")
                .digest("policy".getBytes(StandardCharsets.UTF_8));
        CadesSigner.Policy policy = new CadesSigner.Policy(
                "2.16.76.1.7.1.1.2.4", "2.4", now.minusSeconds(60),
                now.plusSeconds(3600), now.plusSeconds(7200), null,
                policyHash, "a".repeat(64));
        CadesSigner signer = new CadesSigner(pair.getPrivate(), certificate,
                List.of(certificate), Set.of(), "SHA256withRSA", policy,
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                        .digest(certificate.getEncoded())).toUpperCase(Locale.ROOT),
                "12345678901", "production", "2.4", new byte[0], new byte[0]);

        byte[] content = "AFD test fixture\r\n".getBytes(StandardCharsets.ISO_8859_1);
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
        assertThrows(SecurityException.class, () -> signer.sign(
                "123e4567-e89b-12d3-a456-426614174000", content, digest));
        Map<String, Object> response = signer.signInternal("123e4567-e89b-12d3-a456-426614174000", content, digest);
        byte[] signature = Base64.getDecoder().decode((String) response.get("signature"));
        CMSSignedData cms = new CMSSignedData(new CMSProcessableByteArray(content), signature);
        assertNull(new CMSSignedData(signature).getSignedContent());
        assertNotNull(cms.getSignedContent());
        assertEquals(1, cms.getSignerInfos().size());
        SignerInformation info = cms.getSignerInfos().getSigners().iterator().next();
        assertTrue(info.verify(new JcaSimpleSignerInfoVerifierBuilder().setProvider("BC").build(certificate)));
        assertNotNull(info.getSignedAttributes().get(CMSAttributes.contentType));
        assertNotNull(info.getSignedAttributes().get(CMSAttributes.messageDigest));
        var signingCertAttribute = info.getSignedAttributes().get(new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.2.840.113549.1.9.16.2.47"));
        assertNotNull(signingCertAttribute);
        var signingCertV2 = org.bouncycastle.asn1.ess.SigningCertificateV2.getInstance(
                signingCertAttribute.getAttrValues().getObjectAt(0));
        assertEquals(org.bouncycastle.asn1.nist.NISTObjectIdentifiers.id_sha256,
                signingCertV2.getCerts()[0].getHashAlgorithm().getAlgorithm());
        assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded()),
                signingCertV2.getCerts()[0].getCertHash());
        assertNotNull(info.getSignedAttributes().get(new org.bouncycastle.asn1.ASN1ObjectIdentifier("1.2.840.113549.1.9.16.2.15")));
        assertEquals("2.16.76.1.7.1.1.2.4", response.get("policyIdentifier"));
        assertEquals("2.4", response.get("policyVersion"));

        if (Boolean.getBoolean("rep.cades.opensslTest")) {
            Path signatureFile = tempDir.resolve("detached.p7s");
            Path contentFile = tempDir.resolve("content.afd");
            Path verifiedFile = tempDir.resolve("verified.afd");
            Files.write(signatureFile, signature);
            Files.write(contentFile, content);
            Process process = new ProcessBuilder("openssl", "cms", "-verify", "-binary",
                    "-inform", "DER", "-in", signatureFile.toString(),
                    "-content", contentFile.toString(), "-noverify",
                    "-out", verifiedFile.toString()).redirectErrorStream(true).start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            int exitCode = process.waitFor();
            assertEquals(0, exitCode, "OpenSSL CMS verification failed: " + output);
            assertArrayEquals(content, Files.readAllBytes(verifiedFile));
        }
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
                null, new byte[32], "b".repeat(64));
        CadesSigner signer = new CadesSigner(pair.getPrivate(), certificate,
                List.of(certificate), Set.of(), "SHA256withRSA", policy,
                "c".repeat(64), "12345678901", "production", "2.4", new byte[0], new byte[0]);
        assertThrows(SecurityException.class, () -> signer.signInternal(
                "123e4567-e89b-12d3-a456-426614174001",
                "content".getBytes(StandardCharsets.UTF_8), "0".repeat(64)));
    }
    @Test void enforcesAdRb24RsaAlgorithmAndMinimumKeySize() throws Exception {
        KeyPairGenerator rsa2048 = KeyPairGenerator.getInstance("RSA");
        rsa2048.initialize(2048);
        assertEquals("SHA256withRSA", CadesSigner.signatureAlgorithmFor(rsa2048.generateKeyPair().getPrivate()));

        KeyPairGenerator rsa1024 = KeyPairGenerator.getInstance("RSA");
        rsa1024.initialize(1024);
        assertThrows(SecurityException.class,
                () -> CadesSigner.signatureAlgorithmFor(rsa1024.generateKeyPair().getPrivate()));

        KeyPairGenerator ec = KeyPairGenerator.getInstance("EC");
        ec.initialize(256);
        assertEquals("SHA256withECDSA", CadesSigner.signatureAlgorithmFor(ec.generateKeyPair().getPrivate()));

        KeyPairGenerator ed25519 = KeyPairGenerator.getInstance("Ed25519");
        assertThrows(SecurityException.class,
                () -> CadesSigner.signatureAlgorithmFor(ed25519.generateKeyPair().getPrivate()));
    }

}

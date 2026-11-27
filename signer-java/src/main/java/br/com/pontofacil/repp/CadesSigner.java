package br.com.pontofacil.repp;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.*;
import java.security.cert.*;
import java.security.interfaces.ECKey;
import java.security.interfaces.RSAKey;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;
import org.bouncycastle.asn1.*;
import org.bouncycastle.asn1.cms.CMSAttributes;
import org.bouncycastle.asn1.cms.AttributeTable;
import org.bouncycastle.asn1.cms.CMSObjectIdentifiers;
import org.bouncycastle.asn1.cms.Attribute;
import org.bouncycastle.asn1.ess.ESSCertID;
import org.bouncycastle.asn1.ess.ESSCertIDv2;
import org.bouncycastle.asn1.ess.SigningCertificate;
import org.bouncycastle.asn1.ess.SigningCertificateV2;
import org.bouncycastle.asn1.nist.NISTObjectIdentifiers;
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers;
import org.bouncycastle.asn1.x509.AlgorithmIdentifier;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter;
import org.bouncycastle.cms.*;
import org.bouncycastle.cms.jcajce.*;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.operator.ContentSigner;
import org.bouncycastle.operator.jcajce.JcaDigestCalculatorProviderBuilder;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.bouncycastle.util.Store;
import org.bouncycastle.cert.jcajce.JcaCertStore;

/**
 * Strict CAdES detached signer. Every external trust input is mounted outside
 * the repository. Any missing, stale, unverifiable or revoked input aborts.
 */
final class CadesSigner implements CadesSigningService {
    private static final String SHA256_OID = "2.16.840.1.101.3.4.2.1";
    private static final String ICP_CADES_AD_RB_24_OID = "2.16.76.1.7.1.1.2.4";
    private static final ASN1ObjectIdentifier SIGNING_CERT_V2 =
        new ASN1ObjectIdentifier("1.2.840.113549.1.9.16.2.47");
    private static final ASN1ObjectIdentifier SIG_POLICY_ID =
        new ASN1ObjectIdentifier("1.2.840.113549.1.9.16.2.15");
    private static final ObjectMapper JSON = new ObjectMapper();

    private final PrivateKey privateKey;
    private final X509Certificate signerCertificate;
    private final List<X509Certificate> signerChain;
    private final Set<TrustAnchor> trustAnchors;
    private final String signatureAlgorithm;
    private final Policy policy;
    private final String fingerprint;
    private final String developerCpf;
    private final String environment;
    private final String policyVersion;
    private final byte[] lpaDer;
    private final byte[] lpaSignature;

    CadesSigner(PrivateKey privateKey, X509Certificate signerCertificate,
            List<X509Certificate> signerChain, Set<TrustAnchor> trustAnchors,
            String signatureAlgorithm, Policy policy, String fingerprint,
            String developerCpf, String environment, String policyVersion,
            byte[] lpaDer, byte[] lpaSignature) {
        this.privateKey = privateKey;
        this.signerCertificate = signerCertificate;
        this.signerChain = signerChain;
        this.trustAnchors = trustAnchors;
        this.signatureAlgorithm = signatureAlgorithm;
        this.policy = policy;
        this.fingerprint = fingerprint;
        this.developerCpf = developerCpf;
        this.environment = environment;
        this.policyVersion = policyVersion;
        this.lpaDer = lpaDer.clone();
        this.lpaSignature = lpaSignature.clone();
    }

    static CadesSigner fromEnvironment() throws Exception {
        if (Security.getProvider("BC") == null) Security.addProvider(new BouncyCastleProvider());
        Map<String, String> e = System.getenv();
        Security.setProperty("ocsp.enable", "true");
        System.setProperty("com.sun.security.enableCRLDP", "true");
        System.setProperty("com.sun.security.ocsp.timeout", "10s");
        System.setProperty("com.sun.security.ocsp.readtimeout", "10s");
        System.setProperty("com.sun.security.crl.timeout", "10s");
        System.setProperty("com.sun.security.crl.readtimeout", "10s");
        System.setProperty("com.sun.security.cert.timeout", "10s");
        System.setProperty("com.sun.security.cert.readtimeout", "10s");
        Path trustPath = requiredPath(e, "REP_CADES_TRUST_ANCHORS");
        Path lpaPath = requiredPath(e, "REP_CADES_LPA_DER");
        Path lpaSignaturePath = requiredPath(e, "REP_CADES_LPA_P7S");
        Path policyPath = requiredPath(e, "REP_CADES_POLICY_DER");
        Path keyStorePath = requiredPath(e, "REP_CADES_KEYSTORE");
        String keyPassword = required(e, "REP_CADES_KEYSTORE_PASSWORD");
        String expectedTrustAnchorsHash = hex(required(e, "REP_CADES_TRUST_ANCHORS_SHA256"));
        String expectedLpaHash = hex(required(e, "REP_CADES_LPA_SHA256"));
        String expectedLpaSignatureHash = hex(required(e, "REP_CADES_LPA_SIGNATURE_SHA256"));
        String expectedFingerprint = hex(required(e, "REP_CADES_CERT_SHA256"));
        String policyOid = required(e, "REP_CADES_POLICY_OID");
        String policyUri = required(e, "REP_CADES_POLICY_URI");
        String policyVersion = required(e, "REP_CADES_POLICY_VERSION");
        String policyAttributeHash = hex(required(e, "REP_CADES_POLICY_ATTRIBUTE_SHA256"));
        String cpf = digits(required(e, "REP_CADES_DEVELOPER_CPF"));
        String environment = required(e, "REP_CADES_ENVIRONMENT");
        if (!environment.equals("production") || cpf.length() != 11 || !policyVersion.equals("2.4")
                || !ICP_CADES_AD_RB_24_OID.equals(policyOid) || !(policyUri.startsWith("http://") || policyUri.startsWith("https://"))) {
            throw new IllegalStateException("Signer production identity or policy configuration is invalid");
        }

        if (!sha256(Files.readAllBytes(trustPath)).equals(expectedTrustAnchorsHash)) {
            throw new SecurityException("Trust-anchor bundle does not match the independently provisioned SHA-256 pin");
        }
        Set<TrustAnchor> anchors = loadTrustAnchors(trustPath);
        byte[] lpa = Files.readAllBytes(lpaPath);
        byte[] lpaSignature = Files.readAllBytes(lpaSignaturePath);
        byte[] policyDer = Files.readAllBytes(policyPath);
        if (!sha256(lpa).equals(expectedLpaHash)
                || !sha256(lpaSignature).equals(expectedLpaSignatureHash)) {
            throw new SecurityException("LPA artifacts do not match the independently provisioned SHA-256 pins");
        }
        verifyDetachedCms(lpa, lpaSignature, anchors, true);
        Policy policy = parsePolicy(lpa, policyDer, policyOid, policyUri, policyVersion, policyAttributeHash);
        if (!isPolicyCurrent(policy, Instant.now())) {
            throw new SecurityException("CAdES policy is expired, not yet valid, revoked, or LPA is stale");
        }

        char[] password = keyPassword.toCharArray();
        KeyStore keyStore = KeyStore.getInstance("PKCS12");
        try (InputStream in = Files.newInputStream(keyStorePath)) {
            keyStore.load(in, password);
        } finally {
            Arrays.fill(password, '\0');
        }
        String alias = null;
        Enumeration<String> aliases = keyStore.aliases();
        while (aliases.hasMoreElements()) {
            String candidate = aliases.nextElement();
            if (keyStore.isKeyEntry(candidate)) {
                if (alias != null) throw new SecurityException("PKCS#12 must contain exactly one signing key");
                alias = candidate;
            }
        }
        if (alias == null) throw new SecurityException("No private signing key found in PKCS#12");
        char[] keyPass = keyPassword.toCharArray();
        PrivateKey key;
        X509Certificate leaf;
        List<X509Certificate> chain = new ArrayList<>();
        try {
            key = (PrivateKey) keyStore.getKey(alias, keyPass);
            leaf = (X509Certificate) keyStore.getCertificate(alias);
            java.security.cert.Certificate[] certs = keyStore.getCertificateChain(alias);
            if (certs != null) for (java.security.cert.Certificate cert : certs) chain.add((X509Certificate) cert);
        } finally {
            Arrays.fill(keyPass, '\0');
        }
        if (leaf == null || key == null || chain.isEmpty()) throw new SecurityException("PKCS#12 signing identity is incomplete");
        leaf.checkValidity();
        if (leaf.getBasicConstraints() >= 0) throw new SecurityException("Signing certificate must be an end-entity certificate");
        boolean[] usage = leaf.getKeyUsage();
        if (usage == null || usage.length == 0 || !usage[0]) throw new SecurityException("Signing certificate lacks digitalSignature key usage");
        String actualFingerprint = sha256(leaf.getEncoded()).toUpperCase(Locale.ROOT);
        if (!actualFingerprint.equals(expectedFingerprint)) throw new SecurityException("Signing certificate fingerprint is not authorized");
        String subjectDigits = digits(leaf.getSubjectX500Principal().getName());
        if (!subjectDigits.contains(cpf)) throw new SecurityException("Developer CPF does not match signing certificate subject");
        validatePath(leaf, chain, anchors);
        String algorithm = signatureAlgorithmFor(key);
        verifyKeyPair(key, leaf, algorithm);
        return new CadesSigner(key, leaf, chain, anchors, algorithm, policy,
                actualFingerprint, cpf, environment, policyVersion, lpa, lpaSignature);
    }

    static boolean isPolicyCurrent(Policy policy, Instant now) {
        return !policy.notBefore.isAfter(now)
                && policy.notAfter.isAfter(now)
                && policy.nextUpdate.isAfter(now)
                && !policy.nextUpdate.isAfter(now.plus(Duration.ofDays(90)))
                && (policy.revocationDate == null || policy.revocationDate.isAfter(now));
    }

    @Override public boolean ready() {
        if (!isPolicyCurrent(policy, Instant.now())) return false;
        try {
            signerCertificate.checkValidity();
            verifyDetachedCms(lpaDer, lpaSignature, trustAnchors, true);
            validatePath(signerCertificate, signerChain, trustAnchors);
            return true;
        } catch (Exception invalidOrUnavailableTrustEvidence) {
            return false;
        }
    }

    @Override public Map<String, Object> sign(String operationId, byte[] content, String claimedDigest) throws Exception {
        validateSigningInput(operationId, content, claimedDigest);
        if (!ready()) throw new SecurityException("CAdES policy, LPA, certificate chain, or revocation status is not valid");
        return signInternal(operationId, content, sha256(content));
    }


    static String signatureAlgorithmFor(PrivateKey key) {
        if (key instanceof RSAKey rsa) {
            if (rsa.getModulus().bitLength() < 2048) {
                throw new SecurityException("ICP-Brasil CAdES AD-RB 2.4 requires RSA keys of at least 2048 bits");
            }
            return "SHA256withRSA";
        }
        if (key instanceof ECKey ec) {
            if (ec.getParams() == null || ec.getParams().getCurve().getField().getFieldSize() < 256) {
                throw new SecurityException("ICP-Brasil CAdES AD-RB 2.4 requires ECDSA keys of at least 256 bits");
            }
            return "SHA256withECDSA";
        }
        throw new SecurityException("Unsupported CAdES AD-RB 2.4 key algorithm; RSA and ECDSA are supported");
    }

    static void verifyKeyPair(PrivateKey privateKey, X509Certificate certificate, String algorithm) throws Exception {
        byte[] challenge = new byte[32];
        new SecureRandom().nextBytes(challenge);
        try {
            Signature signer = Signature.getInstance(algorithm);
            signer.initSign(privateKey);
            signer.update(challenge);
            byte[] proof = signer.sign();
            Signature verifier = Signature.getInstance(algorithm);
            verifier.initVerify(certificate.getPublicKey());
            verifier.update(challenge);
            if (!verifier.verify(proof)) {
                throw new SecurityException("PKCS#12 private key does not match the signing certificate");
            }
        } finally {
            Arrays.fill(challenge, (byte) 0);
        }
    }

    private static void validateSigningInput(String operationId, byte[] content, String claimedDigest) throws Exception {
        if (content == null || content.length == 0 || content.length > 25_000_000
                || operationId == null
                || !operationId.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) {
            throw new IllegalArgumentException("Invalid signing request");
        }
        if (!sha256(content).equalsIgnoreCase(claimedDigest)) throw new SecurityException("Content digest mismatch");
    }

    // Package-scoped primitive test seam. The HTTP service only calls sign(), which
    // performs LPA, trust-chain and revocation checks before reaching this method.
    Map<String, Object> signInternal(String operationId, byte[] content, String digest) throws Exception {
        if (content == null || content.length == 0 || content.length > 25_000_000
                || !sha256(content).equalsIgnoreCase(digest)) {
            throw new SecurityException("Content digest mismatch");
        }
        byte[] certHash = MessageDigest.getInstance("SHA-256").digest(signerCertificate.getEncoded());
        ESSCertIDv2 essCert = new ESSCertIDv2(certHash);
        SigningCertificateV2 signingCertificate = new SigningCertificateV2(new ESSCertIDv2[]{essCert});
        ASN1EncodableVector policyHashFields = new ASN1EncodableVector();
        policyHashFields.add(new AlgorithmIdentifier(NISTObjectIdentifiers.id_sha256));
        policyHashFields.add(new DEROctetString(policy.attributeHash));
        ASN1EncodableVector policyFields = new ASN1EncodableVector();
        policyFields.add(new ASN1ObjectIdentifier(policy.oid));
        policyFields.add(new DERSequence(policyHashFields));
        ASN1EncodableVector attrs = new ASN1EncodableVector();
        attrs.add(new Attribute(SIGNING_CERT_V2, new DERSet(signingCertificate)));
        attrs.add(new Attribute(SIG_POLICY_ID, new DERSet(new DERSequence(policyFields))));
        AttributeTable signedAttributes = new AttributeTable(attrs);

        var digestProvider = new JcaDigestCalculatorProviderBuilder().setProvider("BC").build();
        ContentSigner contentSigner = new JcaContentSignerBuilder(signatureAlgorithm).setProvider("BC").build(privateKey);
        SignerInfoGenerator signerInfo = new JcaSignerInfoGeneratorBuilder(digestProvider)
                .setContentDigest(new AlgorithmIdentifier(NISTObjectIdentifiers.id_sha256))
                .setSignedAttributeGenerator(new DefaultSignedAttributeTableGenerator(signedAttributes))
                .build(contentSigner, signerCertificate);
        CMSSignedDataGenerator generator = new CMSSignedDataGenerator();
        generator.addSignerInfoGenerator(signerInfo);
        generator.addCertificates(new JcaCertStore(signerChain));
        byte[] signature = generator.generate(new CMSProcessableByteArray(content), false).getEncoded();
        verifyGeneratedSignature(content, signature);

        Map<String, Object> validation = new LinkedHashMap<>();
        for (String flag : List.of("detached", "signatureValid", "contentMatches", "certificateValid",
                "chainValid", "revocationChecked", "policyValid", "policyNotRevoked",
                "signingCertificateAttributeValid", "messageDigestValid", "contentTypeValid",
                "lpaSignatureValid", "lpaIntegrityValid", "lpaFreshnessChecked",
                "developerIdentityValid")) validation.put(flag, true);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("operationId", operationId);
        result.put("contentSha256", digest);
        result.put("signature", Base64.getEncoder().encodeToString(signature));
        result.put("signerCertificateFingerprint", fingerprint);
        result.put("policyIdentifier", policy.oid);
        result.put("policyVersion", policyVersion);
        result.put("policyValidFrom", iso(policy.notBefore));
        result.put("policyValidUntil", iso(policy.notAfter));
        result.put("lpaNextUpdate", iso(policy.nextUpdate));
        result.put("lpaSha256", policy.lpaSha256);
        result.put("environment", environment);
        result.put("validation", validation);
        return result;
    }

    private void verifyGeneratedSignature(byte[] content, byte[] signature) throws Exception {
        if (new CMSSignedData(signature).getSignedContent() != null) {
            throw new SecurityException("Generated CMS unexpectedly embeds the signed content");
        }
        CMSSignedData cms = new CMSSignedData(new CMSProcessableByteArray(content), signature);
        if (cms.getSignerInfos().size() != 1) throw new SecurityException("CMS must contain exactly one signer");
        SignerInformation signer = cms.getSignerInfos().getSigners().iterator().next();
        if (!signer.verify(new JcaSimpleSignerInfoVerifierBuilder().setProvider("BC").build(signerCertificate))) {
            throw new SecurityException("Generated CMS signature did not verify");
        }
        AttributeTable table = signer.getSignedAttributes();
        requireAttribute(table, CMSAttributes.contentType);
        requireAttribute(table, CMSAttributes.messageDigest);
        Attribute sc = requireAttribute(table, SIGNING_CERT_V2);
        Attribute sp = requireAttribute(table, SIG_POLICY_ID);
        byte[] actualDigest = ASN1OctetString.getInstance(table.get(CMSAttributes.messageDigest).getAttrValues().getObjectAt(0)).getOctets();
        if (!MessageDigest.isEqual(actualDigest, MessageDigest.getInstance("SHA-256").digest(content))) {
            throw new SecurityException("CAdES messageDigest does not match content");
        }
        ASN1ObjectIdentifier contentType = ASN1ObjectIdentifier.getInstance(
                table.get(CMSAttributes.contentType).getAttrValues().getObjectAt(0));
        if (!CMSObjectIdentifiers.data.equals(contentType)) throw new SecurityException("Unexpected CMS contentType");
        SigningCertificateV2 scv2 = SigningCertificateV2.getInstance(sc.getAttrValues().getObjectAt(0));
        if (scv2.getCerts().length != 1
                || !NISTObjectIdentifiers.id_sha256.equals(scv2.getCerts()[0].getHashAlgorithm().getAlgorithm())
                || !MessageDigest.isEqual(scv2.getCerts()[0].getCertHash(),
                    MessageDigest.getInstance("SHA-256").digest(signerCertificate.getEncoded()))) {
            throw new SecurityException("signingCertificateV2 does not identify the signer certificate");
        }
        ASN1Sequence policySequence = ASN1Sequence.getInstance(sp.getAttrValues().getObjectAt(0));
        if (policySequence.size() != 2
                || !policy.oid.equals(ASN1ObjectIdentifier.getInstance(policySequence.getObjectAt(0)).getId())) {
            throw new SecurityException("CAdES signature policy identifier mismatch");
        }
        ASN1Sequence hashSequence = ASN1Sequence.getInstance(policySequence.getObjectAt(1));
        String policyHashAlgorithm = ASN1ObjectIdentifier.getInstance(
                ASN1Sequence.getInstance(hashSequence.getObjectAt(0)).getObjectAt(0)).getId();
        if (!SHA256_OID.equals(policyHashAlgorithm)
                || !MessageDigest.isEqual(ASN1OctetString.getInstance(hashSequence.getObjectAt(1)).getOctets(), policy.attributeHash)) {
            throw new SecurityException("CAdES signature policy hash mismatch");
        }
    }

    private static boolean singleAttribute(AttributeTable table, ASN1ObjectIdentifier oid) {
        Attribute attribute = table.get(oid);
        return attribute != null && attribute.getAttrValues().size() == 1;
    }

    private static void verifySigningCertificateAttribute(AttributeTable table, X509Certificate certificate)
            throws Exception {
        Attribute v2 = table.get(SIGNING_CERT_V2);
        byte[] expected;
        byte[] actual;
        if (v2 != null) {
            if (v2.getAttrValues().size() != 1) throw new SecurityException("Ambiguous signingCertificateV2");
            SigningCertificateV2 signing = SigningCertificateV2.getInstance(v2.getAttrValues().getObjectAt(0));
            if (signing.getCerts().length != 1) throw new SecurityException("LPA signingCertificateV2 must reference only its signer");
            String oid = signing.getCerts()[0].getHashAlgorithm().getAlgorithm().getId();
            String digest = switch (oid) {
                case "1.3.14.3.2.26" -> "SHA-1";
                case "2.16.840.1.101.3.4.2.1" -> "SHA-256";
                case "2.16.840.1.101.3.4.2.2" -> "SHA-384";
                case "2.16.840.1.101.3.4.2.3" -> "SHA-512";
                default -> throw new SecurityException("Unsupported LPA signingCertificateV2 digest");
            };
            expected = signing.getCerts()[0].getCertHash();
            actual = MessageDigest.getInstance(digest).digest(certificate.getEncoded());
        } else {
            Attribute v1 = table.get(PKCSObjectIdentifiers.id_aa_signingCertificate);
            if (v1 == null || v1.getAttrValues().size() != 1) throw new SecurityException("Missing signingCertificate");
            SigningCertificate signing = SigningCertificate.getInstance(v1.getAttrValues().getObjectAt(0));
            ESSCertID[] certs = signing.getCerts();
            if (certs.length != 1) throw new SecurityException("LPA signingCertificate must reference only its signer");
            expected = certs[0].getCertHash();
            actual = MessageDigest.getInstance("SHA-1").digest(certificate.getEncoded());
        }
        if (!MessageDigest.isEqual(expected, actual)) {
            throw new SecurityException("LPA signingCertificate attribute does not identify the signer");
        }
    }

    private static Attribute requireAttribute(AttributeTable table, ASN1ObjectIdentifier oid) {
        Attribute attribute = table.get(oid);
        if (attribute == null || attribute.getAttrValues().size() != 1) {
            throw new SecurityException("Missing or ambiguous mandatory CAdES signed attribute: " + oid);
        }
        return attribute;
    }

    private static void verifyDetachedCms(byte[] content, byte[] signature,
            Set<TrustAnchor> anchors, boolean validateChain) throws Exception {
        if (new CMSSignedData(signature).getSignedContent() != null) {
            throw new SecurityException("LPA signature must be detached");
        }
        CMSSignedData cms = new CMSSignedData(new CMSProcessableByteArray(content), signature);
        if (cms.getSignerInfos().size() != 1) {
            throw new SecurityException("LPA signature must have exactly one signer");
        }
        Store<X509CertificateHolder> store = cms.getCertificates();
        SignerInformation signer = cms.getSignerInfos().getSigners().iterator().next();
        Collection<X509CertificateHolder> matches = store.getMatches(signer.getSID());
        if (matches.size() != 1) throw new SecurityException("LPA signer certificate is missing or ambiguous");
        X509Certificate cert = new JcaX509CertificateConverter().setProvider("BC").getCertificate(matches.iterator().next());
        AttributeTable signed = signer.getSignedAttributes();
        if (signed == null || !singleAttribute(signed, CMSAttributes.contentType)
                || !singleAttribute(signed, CMSAttributes.messageDigest)
                || (!singleAttribute(signed, SIGNING_CERT_V2)
                    && !singleAttribute(signed, PKCSObjectIdentifiers.id_aa_signingCertificate))
                || !singleAttribute(signed, SIG_POLICY_ID)) {
            throw new SecurityException("LPA CMS signer lacks mandatory ICP-Brasil CAdES attributes");
        }
        verifySigningCertificateAttribute(signed, cert);
        ASN1ObjectIdentifier lpaContentType = ASN1ObjectIdentifier.getInstance(
                signed.get(CMSAttributes.contentType).getAttrValues().getObjectAt(0));
        if (!CMSObjectIdentifiers.data.equals(lpaContentType)) {
            throw new SecurityException("LPA CMS contentType is not data");
        }
        if (!signer.verify(new JcaSimpleSignerInfoVerifierBuilder().setProvider("BC").build(cert))) {
            throw new SecurityException("LPA CMS signature is invalid");
        }
        if (validateChain) {
            List<X509Certificate> included = new ArrayList<>();
            for (X509CertificateHolder holder : store.getMatches(null)) {
                included.add(new JcaX509CertificateConverter().setProvider("BC").getCertificate(holder));
            }
            validatePath(cert, included, anchors);
        }
    }

    private static void validatePath(X509Certificate leaf, Collection<X509Certificate> available,
            Set<TrustAnchor> anchors) throws Exception {
        leaf.checkValidity();
        X509CertSelector selector = new X509CertSelector();
        selector.setCertificate(leaf);
        PKIXBuilderParameters params = new PKIXBuilderParameters(anchors, selector);
        params.setDate(Date.from(Instant.now()));
        params.setRevocationEnabled(false);
        Collection<X509Certificate> all = new ArrayList<>(available);
        all.add(leaf);
        params.addCertStore(CertStore.getInstance("Collection",
                new CollectionCertStoreParameters(all)));
        PKIXRevocationChecker checker = (PKIXRevocationChecker)
                CertPathValidator.getInstance("PKIX").getRevocationChecker();
        checker.setOptions(EnumSet.noneOf(PKIXRevocationChecker.Option.class));
        params.addCertPathChecker(checker);
        CertPathBuilder.getInstance("PKIX").build(params);
    }

    private static Set<TrustAnchor> loadTrustAnchors(Path path) throws Exception {
        Collection<? extends java.security.cert.Certificate> certs;
        try (InputStream in = Files.newInputStream(path)) {
            certs = CertificateFactory.getInstance("X.509").generateCertificates(in);
        }
        if (certs.isEmpty()) throw new SecurityException("No ICP-Brasil trust anchors provisioned");
        Set<TrustAnchor> anchors = new HashSet<>();
        Set<String> rootVersions = new HashSet<>();
        for (java.security.cert.Certificate cert : certs) {
            if (!(cert instanceof X509Certificate x509) || x509.getBasicConstraints() < 0) {
                throw new SecurityException("Trust-anchor bundle contains a non-CA certificate");
            }
            x509.checkValidity();
            if (!x509.getSubjectX500Principal().equals(x509.getIssuerX500Principal())) {
                throw new SecurityException("Only self-issued ICP-Brasil root certificates may be trust anchors");
            }
            x509.verify(x509.getPublicKey());
            boolean[] usage = x509.getKeyUsage();
            if (usage != null && (usage.length <= 5 || !usage[5])) {
                throw new SecurityException("Trust anchor lacks keyCertSign usage");
            }
            String subject = x509.getSubjectX500Principal().getName();
            if (subject.matches("(?i).*\\bv5\\b.*")) rootVersions.add("v5");
            else if (subject.matches("(?i).*\\bv12\\b.*")) rootVersions.add("v12");
            else throw new SecurityException("AD-RB 2.4 trust anchor must be ICP-Brasil root v5 or v12");
            anchors.add(new TrustAnchor(x509, null));
        }
        if (anchors.size() != 2 || !rootVersions.equals(Set.of("v5", "v12"))) {
            throw new SecurityException("AD-RB 2.4 trust bundle must contain exactly the ICP-Brasil v5 and v12 root anchors");
        }
        return Set.copyOf(anchors);
    }

    static Policy parsePolicy(byte[] lpaDer, byte[] policyDer,
            String expectedOid, String expectedUri, String version, String attributeHashHex) throws Exception {
        ASN1Sequence root = ASN1Sequence.getInstance(ASN1Primitive.fromByteArray(lpaDer));
        int offset = root.size() == 3 ? 1 : 0;
        if (offset == 1 && !ASN1Integer.getInstance(root.getObjectAt(0)).getValue().equals(BigInteger.ZERO)) {
            throw new SecurityException("Unsupported LPA version");
        }
        if (root.size() - offset != 2) throw new SecurityException("Unsupported LPA ASN.1 structure");
        ASN1Sequence policyInfos = ASN1Sequence.getInstance(root.getObjectAt(offset));
        Instant nextUpdate = asInstant(root.getObjectAt(offset + 1));
        byte[] policyHash = MessageDigest.getInstance("SHA-256").digest(policyDer);
        ASN1Sequence paRoot = ASN1Sequence.getInstance(ASN1Primitive.fromByteArray(policyDer));
        if (paRoot.size() != 2 || !(paRoot.getObjectAt(0).toASN1Primitive() instanceof ASN1Sequence)) {
            throw new SecurityException("CAdES policy DER structure is incomplete or ambiguous");
        }
        ASN1Sequence internalHash = ASN1Sequence.getInstance(paRoot.getObjectAt(1));
        if (internalHash.size() != 2) throw new SecurityException("CAdES policy hash structure is invalid");
        String internalHashAlgorithm = ASN1ObjectIdentifier.getInstance(
                ASN1Sequence.getInstance(internalHash.getObjectAt(0)).getObjectAt(0)).getId();
        byte[] internalPolicyHash = ASN1OctetString.getInstance(internalHash.getObjectAt(1)).getOctets();
        byte[] configuredAttributeHash = HexFormat.of().parseHex(attributeHashHex);
        if (!SHA256_OID.equals(internalHashAlgorithm)
                || !MessageDigest.isEqual(internalPolicyHash, configuredAttributeHash)) {
            throw new SecurityException("Configured CAdES signature-policy hash differs from the hash embedded in the PA");
        }
        boolean found = false;
        Instant notBefore = null;
        Instant notAfter = null;
        Instant revocationDate = null;
        String matchedUri = null;
        for (ASN1Encodable item : policyInfos) {
            ASN1Sequence info = ASN1Sequence.getInstance(item);
            int i = 0;
            ASN1Sequence period = ASN1Sequence.getInstance(info.getObjectAt(i++));
            if (period.size() != 2) throw new SecurityException("CAdES policy period must have start and end");
            Instant candidateStart = asInstant(period.getObjectAt(0));
            Instant candidateEnd = asInstant(period.getObjectAt(1));
            if (!candidateStart.isBefore(candidateEnd)) throw new SecurityException("CAdES policy period is inverted");
            boolean hasRevocation = info.getObjectAt(i) instanceof ASN1UTCTime
                    || info.getObjectAt(i) instanceof ASN1GeneralizedTime;
            Instant revocation = hasRevocation ? asInstant(info.getObjectAt(i++)) : null;
            String oid = ASN1ObjectIdentifier.getInstance(info.getObjectAt(i++)).getId();
            String uri = ASN1IA5String.getInstance(info.getObjectAt(i++)).getString();
            if (info.size() != i + 1) throw new SecurityException("Unexpected fields in LPA policy entry");
            ASN1Sequence hashInfo = ASN1Sequence.getInstance(info.getObjectAt(i));
            if (hashInfo.size() != 2) throw new SecurityException("LPA policy hash structure is invalid");
            ASN1Sequence hashAlgorithmIdentifier = ASN1Sequence.getInstance(hashInfo.getObjectAt(0));
            if (hashAlgorithmIdentifier.size() < 1 || hashAlgorithmIdentifier.size() > 2) {
                throw new SecurityException("LPA policy hash AlgorithmIdentifier is invalid");
            }
            String hashAlgorithm = ASN1ObjectIdentifier.getInstance(hashAlgorithmIdentifier.getObjectAt(0)).getId();
            byte[] publishedPolicyHash = ASN1OctetString.getInstance(hashInfo.getObjectAt(1)).getOctets();
            if (oid.equals(expectedOid)) {
                if (found) throw new SecurityException("LPA contains duplicate entries for the configured policy OID");
                if (!SHA256_OID.equals(hashAlgorithm)
                        || !MessageDigest.isEqual(policyHash, publishedPolicyHash)) {
                    throw new SecurityException("LPA policy DER hash or algorithm mismatch");
                }
                found = true;
                matchedUri = uri;
                notBefore = candidateStart;
                notAfter = candidateEnd;
                revocationDate = revocation;
            }
        }
        if (!found || notBefore == null || notAfter == null || !expectedUri.equals(matchedUri)) {
            throw new SecurityException("Configured policy OID/URI is absent from signed LPA");
        }
        return new Policy(expectedOid, version, notBefore, notAfter, nextUpdate, revocationDate,
                configuredAttributeHash, sha256(lpaDer));
    }

    private static Instant asInstant(ASN1Encodable value) throws Exception {
        if (value instanceof ASN1GeneralizedTime time) return time.getDate().toInstant();
        if (value instanceof ASN1UTCTime time) return time.getDate().toInstant();
        throw new SecurityException("Unexpected LPA time encoding");
    }

    private static Path requiredPath(Map<String, String> env, String key) {
        return Path.of(required(env, key)).toAbsolutePath().normalize();
    }
    private static String required(Map<String, String> env, String key) {
        String value = env.get(key);
        if (value == null || value.isBlank()) throw new IllegalStateException("Missing signer configuration: " + key);
        return value.trim();
    }
    private static String hex(String value) {
        if (!value.matches("(?i)[a-f0-9]{64}")) throw new IllegalStateException("Expected SHA-256 hex configuration");
        return value.toLowerCase(Locale.ROOT);
    }
    private static String digits(String value) { return value.replaceAll("\\D", ""); }
    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }
    private static String iso(Instant value) {
        return DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'")
                .withZone(ZoneOffset.UTC).format(value);
    }
    record Policy(String oid, String version, Instant notBefore, Instant notAfter,
            Instant nextUpdate, Instant revocationDate, byte[] attributeHash, String lpaSha256) {
        Policy {
            attributeHash = attributeHash.clone();
        }
        @Override public byte[] attributeHash() { return attributeHash.clone(); }
    }
}

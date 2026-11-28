import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { requestCadesDetachedSignature } from './cades-signer-client.js';

const content = Buffer.from('AFD v004 bytes\\r\\n', 'latin1');
const fingerprint = 'A'.repeat(64);
const policyValidFrom = '2025-06-12T00:00:00Z';
const policyValidUntil = '2037-10-22T00:00:00Z';
const lpaNextUpdate = '2027-01-01T00:00:00Z';
const policyIdentifier = '2.16.76.1.7.1.1.2.4';

function validResponse(request) {
  return {
    operationId: request.operationId,
    contentSha256: createHash('sha256').update(content).digest('hex'),
    signature: Buffer.from('detached-cms-test').toString('base64'),
    signerCertificateFingerprint: fingerprint,
    policyIdentifier,
    policyVersion: '2.4',
    policyValidFrom,
    policyValidUntil,
    lpaNextUpdate,
    lpaSha256: 'C'.repeat(64),
    environment: 'production',
    validation: {
      detached: true,
      signatureValid: true,
      contentMatches: true,
      certificateValid: true,
      chainValid: true,
      revocationChecked: true,
      policyValid: true,
      policyNotRevoked: true,
      signingCertificateAttributeValid: true,
      messageDigestValid: true,
      contentTypeValid: true,
      lpaSignatureValid: true,
      lpaIntegrityValid: true,
      lpaFreshnessChecked: true,
      developerIdentityValid: true,
    },
  };
}

function config(fetchImpl) {
  return {
    endpoint: 'https://cades.internal.example',
    serviceToken: 'private-service-token',
    expectedFingerprint: fingerprint,
    expectedPolicyIdentifier: policyIdentifier,
    fetchImpl,
    now: new Date('2026-11-27T12:00:00Z'),
  };
}

test('fails closed when private signer configuration is missing or insecure', async () => {
  await assert.rejects(
    requestCadesDetachedSignature(content, { ...config(async () => {}), endpoint: 'http://cades.internal' }),
    /configuração privada/i,
  );
  await assert.rejects(
    requestCadesDetachedSignature(content, { ...config(async () => {}), expectedFingerprint: '' }),
    /configuração privada/i,
  );
});

test('sends exact AFD bytes and accepts only a complete detached CAdES attestation', async () => {
  let requestBody;
  let requestOptions;
  const result = await requestCadesDetachedSignature(content, config(async (url, options) => {
    assert.equal(String(url), 'https://cades.internal.example/v1/sign-detached');
    requestOptions = options;
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify(validResponse(requestBody)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));

  assert.equal(requestBody.format, 'CAdES-detached');
  assert.equal(requestBody.content, content.toString('base64'));
  assert.equal(requestBody.contentSha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(requestOptions.headers.authorization, 'Bearer private-service-token');
  assert.equal(result.signature.toString(), 'detached-cms-test');
  assert.equal(result.signerCertificateFingerprint, fingerprint);
});

test('rejects signer response bound to different content', async () => {
  await assert.rejects(requestCadesDetachedSignature(content, config(async (_url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ ...validResponse(body), contentSha256: '0'.repeat(64) }), { status: 200 });
  })), /não corresponde ao conteúdo/i);
});

test('rejects a different signing certificate', async () => {
  await assert.rejects(requestCadesDetachedSignature(content, config(async (_url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ ...validResponse(body), signerCertificateFingerprint: 'B'.repeat(64) }), { status: 200 });
  })), /certificado utilizado/i);
});

test('rejects incomplete cryptographic, chain or revocation validation', async () => {
  await assert.rejects(requestCadesDetachedSignature(content, config(async (_url, options) => {
    const body = JSON.parse(options.body);
    const result = validResponse(body);
    result.validation.chainValid = false;
    return new Response(JSON.stringify(result), { status: 200 });
  })), /não foi validada integralmente/i);
});

test('rejects expired or malformed policy/LPA metadata', async () => {
  await assert.rejects(requestCadesDetachedSignature(content, config(async (_url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ ...validResponse(body), lpaNextUpdate: '2026-01-01T00:00:00Z' }), { status: 200 });
  })), /fora da vigência/i);
});

test('rejects homologation environment and malformed CMS data', async () => {
  await assert.rejects(requestCadesDetachedSignature(content, config(async (_url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ ...validResponse(body), environment: 'homologation' }), { status: 200 });
  })), /não foi validada integralmente/i);
  await assert.rejects(requestCadesDetachedSignature(content, config(async (_url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ ...validResponse(body), signature: 'not base64!' }), { status: 200 });
  })), /CMS.*PKCS#7 inválido/i);
});


test('rejects an unapproved policy identifier', async () => {
  await assert.rejects(requestCadesDetachedSignature(content, config(async (_url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ ...validResponse(body), policyIdentifier: '2.16.76.1.7.1.1.2.3' }), { status: 200 });
  })), /política CAdES\/LPA/i);
});

test('rejects an LPA without independently verified signature and integrity', async () => {
  await assert.rejects(requestCadesDetachedSignature(content, config(async (_url, options) => {
    const body = JSON.parse(options.body);
    const result = validResponse(body);
    result.validation.lpaSignatureValid = false;
    return new Response(JSON.stringify(result), { status: 200 });
  })), /não foi validada integralmente/i);
});

test('rejects oversized content and unavailable signer', async () => {
  await assert.rejects(
    requestCadesDetachedSignature(Buffer.alloc(25_000_001), config(async () => {})),
    /acima do limite/i,
  );
  await assert.rejects(
    requestCadesDetachedSignature(content, config(async () => { throw new Error('network'); })),
    /indisponível/i,
  );
});

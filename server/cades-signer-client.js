import { createHash, randomUUID } from 'node:crypto';

const REQUIRED_VALIDATION_FLAGS = [
  'detached',
  'signatureValid',
  'contentMatches',
  'certificateValid',
  'chainValid',
  'revocationChecked',
  'policyValid',
  'policyNotRevoked',
  'signingCertificateAttributeValid',
  'messageDigestValid',
  'contentTypeValid',
  'lpaSignatureValid',
  'lpaIntegrityValid',
  'lpaFreshnessChecked',
  'developerIdentityValid',
];

function fail(message) {
  const error = new Error(message);
  error.code = 'CADES_SIGNER_REJECTED';
  return error;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeFingerprint(value) {
  return String(value || '').replaceAll(':', '').replaceAll(' ', '').toUpperCase();
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function decodeSignature(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 2_800_000
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw fail('O assinador retornou CMS/PKCS#7 inválido.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.toString('base64') !== value) {
    throw fail('A assinatura CMS não está em Base64 canônico.');
  }
  return decoded;
}

/**
 * Calls the private Java CAdES service. This client validates the service
 * response contract; the signer MUST perform cryptographic verification
 * against the exact content and validate the ICP-Brasil chain/LPA itself.
 * It is deliberately not connected to the public AFD route yet.
 */
export async function requestCadesDetachedSignature(content, {
  endpoint = process.env.REP_CADES_SIGNER_URL || '',
  serviceToken = process.env.REP_CADES_SIGNER_TOKEN || '',
  expectedFingerprint = process.env.REP_CADES_CERT_SHA256 || '',
  expectedPolicyIdentifier = process.env.REP_CADES_POLICY_OID || '',
  fetchImpl = fetch,
  timeoutMs = 20_000,
  now = new Date(),
} = {}) {
  if (!Buffer.isBuffer(content) || content.length === 0 || content.length > 25_000_000) {
    throw fail('Conteúdo AFD inválido ou acima do limite de assinatura.');
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw fail('Serviço privado CAdES não configurado.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !serviceToken
    || !/^[A-Fa-f0-9]{64}$/.test(normalizeFingerprint(expectedFingerprint))
    || !/^\\d+(?:\\.\\d+){2,}$/.test(expectedPolicyIdentifier)) {
    throw fail('Configuração privada do assinador CAdES inválida.');
  }

  const contentSha256 = sha256(content);
  const operationId = randomUUID();
  let response;
  try {
    response = await fetchImpl(new URL('/v1/sign-detached', url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        operationId,
        content: content.toString('base64'),
        contentSha256,
        format: 'CAdES-detached',
        contentType: 'application/octet-stream',
      }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch {
    throw fail('Serviço privado CAdES indisponível ou expirou o tempo de resposta.');
  }
  if (!response.ok) throw fail('O assinador CAdES recusou a operação.');
  const result = await response.json().catch(() => null);
  if (!result || result.operationId !== operationId || result.contentSha256 !== contentSha256) {
    throw fail('O assinador retornou uma resposta que não corresponde ao conteúdo enviado.');
  }

  const fingerprint = normalizeFingerprint(result.signerCertificateFingerprint);
  if (result.policyIdentifier !== expectedPolicyIdentifier
    || result.policyVersion !== '2.4'
    || !isIsoDate(result.policyValidFrom) || !isIsoDate(result.policyValidUntil)
    || !isIsoDate(result.lpaNextUpdate)
    || Date.parse(result.policyValidFrom) > now.getTime()
    || Date.parse(result.policyValidUntil) < now.getTime()
    || Date.parse(result.lpaNextUpdate) < now.getTime()
    || !/^[A-Fa-f0-9]{64}$/.test(String(result.lpaSha256 || ''))) {
    throw fail('A política CAdES/LPA informada pelo assinador está ausente, não é a política autorizada ou está fora da vigência.');
  }
  if (result.environment !== 'production'
    || !REQUIRED_VALIDATION_FLAGS.every((flag) => result.validation?.[flag] === true)) {
    throw fail('A assinatura, cadeia ICP-Brasil ou política não foi validada integralmente.');
  }

  const signature = decodeSignature(result.signature);
  return {
    signature,
    operationId,
    contentSha256,
    signerCertificateFingerprint: fingerprint,
    policyIdentifier: result.policyIdentifier,
    policyVersion: result.policyVersion,
    policyValidFrom: result.policyValidFrom,
    policyValidUntil: result.policyValidUntil,
    lpaNextUpdate: result.lpaNextUpdate,
    lpaSha256: result.lpaSha256,
  };
}

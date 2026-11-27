package br.com.pontofacil.repp;

import java.util.Map;

interface CadesSigningService {
    boolean ready();
    Map<String, Object> sign(String operationId, byte[] content, String claimedDigest) throws Exception;
}

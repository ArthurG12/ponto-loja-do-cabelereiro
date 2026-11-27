# Arquitetura de assinatura CAdES ICP-Brasil do AFD REP-P

## Estado

Documento de arquitetura. **Não implementa assinatura, não habilita exportação e não substitui validação jurídica/técnica.** O endpoint AFD deve continuar bloqueando a entrega até que todas as verificações abaixo estejam implementadas e aprovadas.

## Base normativa e biblioteca

- O MTE exige assinatura CAdES destacada ICP-Brasil do AFD, entregue como arquivo .p7s separado do AFD.
- O ITI publica a Lista de Políticas de Assinatura (LPA) CAdES vigente. Na consulta de 27/11/2026, o ciclo publicado é de 03/10/2026 a 01/01/2027. O serviço deve consultar a LPA oficial e validar sua assinatura, integridade, vigência e política aplicável em cada operação; não fixar indefinidamente um OID ou DER embutido no código.
- A política AD-RB CAdES 2.4 está publicada como vigente pelo ITI e seu OID é `2.16.76.1.7.1.1.2.4`. A versão deve ser confirmada contra a LPA vigente antes de cada assinatura; o serviço não aceita política enviada pelo cliente nem mantém OID/DER desatualizado.
- O SERPRO Demoiselle Signer é a opção inicial de implementação: versão 4.6.2, módulos policy-impl-cades, chain-icp-brasil e policy-engine. O projeto documenta geração e validação CAdES, cadeias ICP-Brasil e carregamento de LPA.
- A interface `PKCS7Signer` da biblioteca expõe `doDetachedSign(content, previewSigned)`, que produz assinatura destacada sem incorporar o conteúdo. `CAdESChecker.checkDetachedSignature(content, signature)` permite verificar o CMS contra os bytes originais; `SignatureInformations` expõe invalidSignature, validatorErrors e validatorWarnings. A implementação deve rejeitar qualquer erro, aviso ou resultado inconclusivo.
- **Limite identificado na revisão do código 4.6.2:** `PolicyValidator` carrega e interpreta a LPA, verifica `nextUpdate`, período e revogação da política, mas não demonstra por si só a verificação criptográfica da assinatura CMS da própria LPA nem a conferência independente do hash do DER contra a LPA assinada. Isso precisa ser feito por um verificador separado antes de confiar nos dados da LPA.

## Arquitetura proposta

1. **API REP-P (Node)** autentica o administrador, limita o período, consulta o ledger e gera os bytes AFD v004.
2. Antes de assinar, a API valida o AFD localmente: ISO-8859-1, CRLF, larguras, CRC, trailer, sequência NSR e cadeia de hashes. Enquanto a regra de hash tipo 7 permanecer candidata, a exportação legal continua bloqueada.
3. A API envia os bytes exatos do AFD a um **serviço privado de assinatura Java**, em rede privada, com autenticação serviço-a-serviço (mTLS preferencialmente). O navegador nunca acessa o assinador.
4. O serviço Java baixa a LPA CAdES e o respectivo arquivo de assinatura do repositório oficial do ITI, valida a assinatura da LPA contra uma cadeia confiável do ITI, confere o hash do DER e o `nextUpdate`, e confirma que a política AD-RB CAdES 2.4/OID `2.16.76.1.7.1.1.2.4` está vigente e não revogada. Só então usa Demoiselle Signer 4.6.2 para criar CAdES detached. Não aceitar OID/política arbitrária enviada pelo cliente.
5. O assinador verifica o certificado e a cadeia ICP-Brasil em produção, validade temporal, revogação/CRL ou OCSP conforme a política e identidade do titular. A identidade do certificado deve corresponder aos dados oficiais do desenvolvedor/fabricante configurados no REP-P.
6. A API recebe o CMS/PKCS#7 DER, valida a assinatura contra os mesmos bytes AFD e confirma que é detached, que o conteúdo assinado corresponde byte a byte ao AFD, que a cadeia e política são aceitas e que o certificado é o esperado.
7. Somente após todas as verificações a API entrega o AFD e o .p7s juntos, com nomes coerentes e sem cache. Qualquer erro, indisponibilidade, política vencida ou certificado não validado resulta em bloqueio, nunca em fallback para arquivo sem assinatura.

## Proteção da chave

- A chave privada e o PIN/senha do certificado não entram no Git, frontend, Supabase, logs, mensagens ou variáveis VITE_*.
- Preferir chave não exportável em HSM ou token/serviço criptográfico com interface PKCS#11. Se o certificado disponível exigir arquivo A1/PKCS#12, ele deve permanecer em secret store/volume criptografado e restrito ao processo de assinatura, com acesso operacional mínimo, rotação e auditoria.
- Não enviar certificado, arquivo PFX/P12, PIN ou senha pelo chat.
- Desabilitar cadeias de homologação no ambiente de produção; a documentação do Demoiselle 4.6.2 alerta que cadeias de homologação podem aceitar certificados de teste.
- O serviço não deve registrar bytes do AFD, assinatura completa, senha, PIN ou chave em logs. Registrar apenas identificador de operação, hash do conteúdo, fingerprint do certificado, política/versionamento e resultado.

## Contrato interno sugerido

Solicitação privada:
- content: bytes do AFD em Base64;
- contentSha256: SHA-256 calculado pela API sobre os bytes exatos;
- operationId: UUID gerado no backend;
- nenhum campo de certificado, OID ou política escolhido pelo usuário.

Resposta privada:
- signature: bytes DER do CMS detached em Base64;
- contentSha256: digest dos bytes efetivamente assinados;
- signerCertificateFingerprint: fingerprint do certificado utilizado;
- `policyIdentifier`, `policyVersion`, período de validade da política, `lpaNextUpdate` e SHA-256 do DER da LPA;
- validation: resultado estruturado das verificações de assinatura, atributos CAdES, cadeia ICP-Brasil, revogação, identidade do desenvolvedor, assinatura/integridade/atualidade da LPA e ausência de revogação da política.

A API deve rejeitar resposta sem todos os campos, OID diferente do autorizado, versão diferente da política configurada, digest divergente, CMS malformado, assinatura attached, certificado diferente do esperado, LPA sem assinatura/integridade/atualidade comprovadas ou validação não conclusiva. O contrato não deve ser exposto publicamente.

## Testes obrigatórios antes de liberar o endpoint

- Vetores de teste com certificado ICP-Brasil de homologação em ambiente isolado e certificado de produção em teste controlado.
- Assinatura detached válida e verificação com ferramenta independente compatível com a política aplicada.
- Alteração de um único byte do AFD deve invalidar a assinatura.
- Rejeitar assinatura attached, assinatura sem signingCertificate/v2, sem sigPolicyId, com messageDigest ou contentType ausente/incorreto.
- Rejeitar certificado expirado, revogado, cadeia incompleta, certificado de homologação em produção e titular divergente do desenvolvedor cadastrado.
- Rejeitar LPA vencida, não assinada, adulterada, indisponível ou fora da vigência. Validar assinatura CMS e hash do DER independentemente do `PolicyValidator` do Demoiselle. Manter cache somente com validação de integridade e vigência.
- Testar concorrência, timeout, indisponibilidade do assinador, repetição de operação e integridade dos nomes/pares AFD + P7S.
- Conferência independente do leiaute AFD v004 e do algoritmo de hash tipo 7 antes de qualquer exportação legal.

## Critério de conclusão

A assinatura só poderá ser ativada após implementação e testes automatizados de geração e verificação, certificado ICP-Brasil válido do desenvolvedor, identidade/registro INPI reais, validação independente do AFD/hash e revisão especializada. Até lá, o endpoint deve continuar retornando indisponibilidade para exportação e jamais disponibilizar o AFD sem assinatura.


## Controles adicionais identificados na versão 4.6.2

A revisão das notas de versão 4.6.2 (03/09/2026) identificou uma ressalva relevante: a validação do hash da política no \`CAdESChecker\` foi desabilitada por padrão para preservar compatibilidade com assinaturas já aceitas por validadores do SERPRO e do ITI. A mesma release introduziu detecção de inconsistência entre o OID do algoritmo declarado e o tamanho do \`hashValue\` do \`SignaturePolicyIdentifier\`. Consequentemente:

- Não tratar \`CAdESChecker\` como prova suficiente de que o hash da PA/LPA foi validado. O serviço deve recomputar SHA-256 do DER da LPA e compará-lo com o valor publicado no canal oficial, além de validar criptograficamente o arquivo de assinatura da LPA.
- O verificador independente deve conferir o algoritmo declarado, o OID, o tamanho do digest e o digest efetivo do DER. Qualquer inconsistência deve bloquear a assinatura.
- A cadeia de produção \`chain-icp-brasil\` deve ser a única cadeia ICP-Brasil habilitada no processo de produção. A documentação da 4.6.2 informa que providers presentes no classpath são carregados automaticamente, inclusive módulos de homologação; portanto, não incluir \`chain-icp-brasil-homolog\` nem \`chain-iti-homolog\` no artefato de produção. Não basta configurar um sinalizador se a dependência de homologação continuar empacotada.
- O trust anchor usado para validar a assinatura da LPA deve ser provisionado fora do repositório, com fingerprint SHA-256 verificado por procedimento operacional independente. Não confiar em certificado raiz recebido no mesmo download que a LPA.
- O resultado de validação deve distinguir assinatura matemática válida, cadeia confiável, revogação verificada e política vigente. Uma verificação positiva de CMS não equivale, isoladamente, a todas essas condições.

A LPA CAdES publicada pelo ITI é atualizada em ciclos e contém \`nextUpdate\`; o ITI informa que a própria LPA é assinada com PKCS#7 por certificado de pessoa jurídica do ITI. O serviço deve falhar fechado quando não conseguir baixar ou validar os artefatos, sem reaproveitar indefinidamente um cache expirado.

## Critérios de teste adicionais

- Teste negativo com hash DER alterado, hash publicado adulterado, OID de algoritmo incorreto e \`hashValue\` com tamanho incompatível.
- Teste de empacotamento que falha se qualquer artefato de cadeia de homologação estiver no classpath/runtime de produção.
- Teste com certificado da LPA fora da cadeia confiável configurada, certificado expirado ou revogado.
- Teste de indisponibilidade do ITI e de \`nextUpdate\` vencido: nenhuma assinatura pode ser produzida usando LPA vencida.

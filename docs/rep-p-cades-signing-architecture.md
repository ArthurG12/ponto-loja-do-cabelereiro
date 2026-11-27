# Arquitetura de assinatura CAdES ICP-Brasil do AFD REP-P

## Estado real da implementação

O serviço Java 21 está implementado na pasta `signer-java/`, com geração CMS/CAdES detached, validação da LPA, cadeia PKIX e revogação, API HTTP privada, imagem Docker não-root e testes automatizados. O CI também verifica a matemática CMS gerada com OpenSSL.

**Isso ainda não habilita a exportação AFD nem comprova conformidade REP-P.** Os artefatos oficiais da LPA/PA, as raízes ICP-Brasil v5/v12 aprovadas e o certificado real do desenvolvedor ainda precisam ser provisionados e ensaiados. A integração ponta a ponta com a rota Node/AFD permanece bloqueada em HTTP 503. Não há assinatura real de produção neste repositório.

## Base normativa

- O MTE exige assinatura CAdES destacada ICP-Brasil do AFD, entregue como arquivo `.p7s` separado do AFD.
- Política selecionada: **AD-RB baseada em CAdES, versão 2.4**, OID `2.16.76.1.7.1.1.2.4`.
- O DOC-ICP-15.03 v9.1, Anexo 2, seção 1, define para AD-RB CAdES 2.4 os atributos assinados `contentType`, `messageDigest`, `signingCertificateV2` e `sigPolicyId`.
- Para AD-RB CAdES 2.4, o conjunto de raízes confiáveis é **ICP-Brasil v5 e v12** (não v2/v5). A versão 2.4 também exige revogação por LCR ou OCSP para certificados finais e de ACs.
- A política 2.4 permite RSA/SHA-256, RSA/SHA-512, ECDSA/SHA-256, ECDSA/SHA-512, Ed25519 e Ed448. O tamanho mínimo é 2048 bits para RSA, 256 bits para ECDSA/Ed25519 e 456 bits para Ed448.
- A implementação atual suporta o subconjunto RSA/SHA-256 (mínimo 2048 bits) e ECDSA/SHA-256 (mínimo 256 bits). SHA-512, Ed25519 e Ed448 ainda não foram implementados e são rejeitados; isso é uma limitação explícita de suporte, não uma proibição da política.
- A versão 2.4 da PA tem período de assinatura de 12/06/2025 a 22/10/2037. A LPA CAdES publicada pelo ITI tem ciclo próprio e `nextUpdate`; na consulta de 27/11/2026, o ciclo divulgado era 03/10/2026 a 01/01/2027. A LPA deve ser atualizada antes do seu `nextUpdate`, sem fixar datas no código.

Fontes:
- [DOC-ICP-15.03 v9.1, Anexo 2 — AD-RB CAdES](https://www.gov.br/iti/pt-br/assuntos/legislacao/documentos-principais/v9.1_IN2021_03_DOCICP15.03_compilada.pdf)
- [LPA CAdES e situação das políticas](https://www.gov.br/iti/pt-br/assuntos/repositorio/lista-de-politicas-de-assinatura)
- [Repositório de certificados ICP-Brasil](https://www.gov.br/iti/pt-br/assuntos/repositorio/certificados-das-acs-da-icp-brasil-arquivo-unico-compactado)

## Implementação atual

### Fluxo

1. O backend Node autentica o administrador, limita o período, consulta o ledger e prepara os bytes exatos do AFD v004.
2. O cliente Node `server/cades-signer-client.js` envia o conteúdo em Base64 por HTTPS, com Bearer de serviço, SHA-256 e UUID de operação. O timeout padrão é 150 segundos.
3. Um proxy TLS privado (modelo em `signer-java/nginx.conf.example`) termina HTTPS e encaminha apenas `/v1/sign-detached` para o serviço Java na rede privada. O exemplo usa TLS e Bearer; **mTLS de cliente ainda não está configurado**.
4. O serviço Java recebe LPA DER, assinatura PKCS#7 da LPA, PA DER, bundle de raízes e PKCS#12 como arquivos externos provisionados em runtime. Ele não baixa artefatos automaticamente nem confia em certificados recebidos junto com a LPA.
5. Na inicialização, compara os hashes independentes do bundle e dos arquivos LPA, exige exatamente duas raízes autoassinadas ICP-Brasil v5/v12, valida a assinatura CMS detached da LPA, constrói a cadeia até as raízes pinadas e confere validade/revogação.
6. Interpreta a LPA e a PA em ASN.1, confere OID, URI, período, hash DER da PA, hash interno usado no `sigPolicyId`, revogação e `nextUpdate`. Rejeita LPA vencida ou com `nextUpdate` superior a 90 dias.
7. Carrega um PKCS#12 com exatamente uma chave de assinatura, confere fingerprint SHA-256, CPF no Subject, certificado final não-CA, KeyUsage `digitalSignature` e prova criptográfica de correspondência entre chave privada e certificado.
8. Gera CMS detached com `contentType`, `messageDigest`, `signingCertificateV2` (SHA-256 default) e `sigPolicyId`; reabre e verifica a assinatura antes de devolver o `.p7s`.
9. Cada readiness e cada assinatura revalidam LPA, cadeia e revogação. Falha, indisponibilidade ou resultado inconclusivo bloqueia. A API HTTP usa JSON estrito, limite de corpo compatível com AFD de até 25 MB, fila limitada e uma assinatura pesada simultânea.
10. A rota AFD ainda **não chama** o cliente CAdES para liberar arquivos. Ela permanece bloqueada até verificação independente e integração completa.

### Arquivos

- `signer-java/src/main/java/br/com/pontofacil/repp/CadesSigner.java`: bootstrap, validação e geração CMS/CAdES.
- `signer-java/src/main/java/br/com/pontofacil/repp/SignerServer.java`: HTTP privado, Bearer, parsing estrito e backpressure.
- `signer-java/src/main/java/br/com/pontofacil/repp/CadesSigningService.java`: contrato interno para testes de integração HTTP.
- `signer-java/Dockerfile`: imagem multi-stage, JAR sombreado e usuário não-root.
- `signer-java/nginx.conf.example`: terminação TLS privada para o cliente Node.
- `server/cades-signer-client.js`: cliente HTTPS Node; valida contrato e atestados, mas não implementa CMS.

### Provisionamento externo

Variáveis obrigatórias do serviço Java:

- `REP_CADES_SERVICE_TOKEN`, `REP_CADES_BIND_HOST`, `PORT`.
- `REP_CADES_TRUST_ANCHORS` e `REP_CADES_TRUST_ANCHORS_SHA256`: bundle PEM somente com as raízes oficiais v5/v12 e pin SHA-256 aprovado por canal independente.
- `REP_CADES_LPA_DER`, `REP_CADES_LPA_P7S`, `REP_CADES_LPA_SHA256`, `REP_CADES_LPA_SIGNATURE_SHA256`.
- `REP_CADES_POLICY_DER`, `REP_CADES_POLICY_OID`, `REP_CADES_POLICY_URI`, `REP_CADES_POLICY_VERSION=2.4`, `REP_CADES_POLICY_ATTRIBUTE_SHA256`.
- `REP_CADES_KEYSTORE`, `REP_CADES_KEYSTORE_PASSWORD`, `REP_CADES_CERT_SHA256`, `REP_CADES_DEVELOPER_CPF`, `REP_CADES_ENVIRONMENT=production`.

O SHA-256 de `REP_CADES_POLICY_ATTRIBUTE_SHA256` corresponde ao hash interno `SignPolicyHash` da PA, usado no atributo `sigPolicyId`; **não** é o SHA-256 do arquivo DER inteiro. O hash do DER completo é comparado com o hash publicado na LPA. Os sidecars HTTP do ITI servem como conferência de consistência, não como raiz de confiança independente.

Não inserir certificado, PFX/P12, senha, PIN, chave privada, tokens ou hashes não aprovados no Git, frontend, Supabase ou logs. Preferir HSM/PKCS#11 ou chave não exportável. A implementação atual lê PKCS#12 externo; HSM/PKCS#11 ainda não foi integrado.

### Revogação e transporte

O serviço habilita OCSP e CRL Distribution Points, não habilita `SOFT_FAIL` e limita conexão/leitura a 10 segundos para OCSP, LCR e recuperação de certificados. A indisponibilidade resulta em bloqueio. A rede precisa permitir egress controlado aos respondedores ICP-Brasil.

O Java escuta HTTP dentro da rede privada do container. O cliente Node exige HTTPS; use o proxy TLS privado. O exemplo Nginx não habilita mTLS de cliente. Para exigir mTLS, provisionar certificado de cliente no backend Node, configurar o transporte HTTPS para apresentá-lo e validar a identidade no proxy.

## Testes já automatizados

O CI atual executa testes Java/JUnit, verifica CMS detached com OpenSSL 3 como segunda implementação, confere dependências no JAR sombreado e constrói a imagem Docker. A suíte inclui:
- atributos CAdES obrigatórios e verificação de assinatura detached;
- assinatura RSA/SHA-256 e ECDSA/SHA-256 com chaves efêmeras;
- vinculação chave privada/certificado;
- períodos, revogação e nextUpdate da PA/LPA;
- seleção das raízes v5/v12;
- parsing JSON estrito, autenticação Bearer, API HTTP, backpressure e payload Base64 até o tamanho máximo do AFD.

Esses testes provam funcionamento do código com vetores sintéticos e a matemática CMS, não conformidade da cadeia real. Ainda faltam LPA/PA oficiais provisionadas, raízes aprovadas, certificado real do desenvolvedor, ensaio OCSP/CRL real e validação independente da cadeia/atributos em ambiente controlado.

## Lacunas antes de ativar o AFD

1. Provisionar LPA/PA e raízes v5/v12 atuais do ITI, com hashes e fingerprints aprovados por procedimento independente.
2. Provisionar o certificado ICP-Brasil real do desenvolvedor e confirmar CPF, cadeia, validade e revogação com OCSP/LCR reais.
3. Avaliar HSM/PKCS#11 ou proteção equivalente para a chave privada.
4. Implantar proxy HTTPS privado, segredos externos, regras de rede, auditoria operacional e, se exigido, mTLS de cliente.
5. Integrar o cliente Node ao Java e implementar uma segunda validação CMS independente antes de liberar o arquivo.
6. Validar independentemente o leiaute AFD v004 e o algoritmo SHA-256 do tipo 7.
7. Fazer ensaio ponta a ponta com AFD real de teste, assinatura `.p7s`, alteração de byte, certificado expirado/revogado e falha de rede.
8. Concluir documentação legal, dados reais do empregador/desenvolvedor, registro INPI, HLB, PTRP/AEJ, comprovante e revisão especializada.

Até cumprir esses itens, a rota AFD deve continuar retornando 503 e jamais liberar arquivo sem assinatura. Este documento não é laudo jurídico, atestado de conformidade nem autorização de uso legal.

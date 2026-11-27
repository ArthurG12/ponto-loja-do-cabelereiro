# REP-P CAdES signer (Java)

**Estado: implementação criptográfica em validação automatizada; ainda não autorizada para produção ou emissão de AFD legal.** A habilitação operacional depende de provisionamento de artefatos oficiais, certificado ICP-Brasil real do desenvolvedor, revisão independente e ensaios positivos/negativos com certificados de produção controlados.

## Componentes implementados

- Serviço HTTP isolado com autenticação Bearer serviço-a-serviço, limite de corpo, JSON estrito (sem campos duplicados, extras ou valores JSON concatenados), validação de Content-Type/Content-Length, respostas sem cache, erros 400/413/415 apropriados, fila de workers limitada e encerramento gracioso do executor.
- Verificação de LPA CAdES detached: CMS/PKCS#7 sobre os bytes DER exatos, certificado do signatário, caminho até trust anchors provisionados, validade e revogação com PKIX/OCSP/CRL em modo fail-closed.
- Integridade por SHA-256 pinado independentemente para LPA DER e assinatura .p7s.
- Leitura ASN.1 da LPA: nextUpdate, OID, URI, período e revogação da política.
- Conferência do hash SHA-256 da política DER publicado na LPA e do hash interno da PA usado no atributo CAdES.
- Restrição explícita à política ICP-Brasil CAdES AD-RB versão 2.4 (OID 2.16.76.1.7.1.1.2.4).
- Carregamento de identidade PKCS#12 externa ao repositório; pin SHA-256 do certificado, CPF do desenvolvedor no Subject, certificado final não-CA, digitalSignature KeyUsage e prova criptográfica de correspondência entre chave privada e certificado na inicialização.
- Construção CMS detached com contentType, messageDigest, signingCertificateV2 e sigPolicyId; assinatura RSA/SHA-256 conforme AD-RB 2.4, rejeitando ECDSA e chaves RSA abaixo de 2048 bits.
- Reabertura e verificação criptográfica independente do CMS recém-gerado antes de retornar a assinatura.
- A rota só responde ready depois de validar configuração, LPA, política, cadeia e identidade. Cada consulta de readiness e cada assinatura revalidam a LPA e o caminho/revogação; falha ou indisponibilidade bloqueia a operação.

## Configuração obrigatória

Os arquivos devem ser montados por secret manager/volume protegido, fora do Git e sem expor o conteúdo em logs:

| Variável | Conteúdo |
|---|---|
| REP_CADES_SERVICE_TOKEN | segredo serviço-a-serviço com pelo menos 32 caracteres |
| REP_CADES_BIND_HOST | padrão 127.0.0.1; usar IP privado explícito se necessário |
| PORT | porta HTTP, padrão 8787 |
| REP_CADES_TRUST_ANCHORS | bundle PEM de âncoras ICP-Brasil aprovadas, provisionado fora do repositório |
| REP_CADES_TRUST_ANCHORS_SHA256 | SHA-256 aprovado do bundle PEM exato de âncoras |
| REP_CADES_LPA_DER | caminho da LPA CAdES DER oficial |
| REP_CADES_LPA_P7S | caminho da assinatura PKCS#7 detached da LPA |
| REP_CADES_POLICY_DER | caminho da PA CAdES DER correspondente |
| REP_CADES_LPA_SHA256 | SHA-256 aprovado da LPA DER |
| REP_CADES_LPA_SIGNATURE_SHA256 | SHA-256 aprovado do arquivo .p7s da LPA |
| REP_CADES_POLICY_OID | deve ser 2.16.76.1.7.1.1.2.4 |
| REP_CADES_POLICY_URI | URI textual exata da PA conforme a LPA (HTTP/HTTPS conforme publicação oficial) |
| REP_CADES_POLICY_VERSION | deve ser 2.4 |
| REP_CADES_POLICY_ATTRIBUTE_SHA256 | hash interno SHA-256 da PA para o atributo sigPolicyId |
| REP_CADES_KEYSTORE | caminho externo para PKCS#12 do desenvolvedor |
| REP_CADES_KEYSTORE_PASSWORD | senha do PKCS#12, fornecida por secret manager |
| REP_CADES_CERT_SHA256 | fingerprint SHA-256 autorizado do certificado do desenvolvedor |
| REP_CADES_DEVELOPER_CPF | CPF do desenvolvedor para correspondência com o Subject do certificado |
| REP_CADES_ENVIRONMENT | deve ser production; qualquer outro valor bloqueia o serviço |

Não adicione certificados, chaves, senhas, hashes de produção não conferidos ou dados pessoais ao repositório. A âncora de confiança e os pins devem ser aprovados por procedimento independente, não copiados cegamente da própria LPA.

Para conferir o pin do bundle de âncoras, calcule o SHA-256 dos bytes exatos do arquivo provisionado (por exemplo, sha256sum trust-anchors.pem). Os hashes da LPA DER e do arquivo .p7s devem ser confrontados com os sidecars oficiais do ITI e aprovados por canal independente. Já REP_CADES_POLICY_ATTRIBUTE_SHA256 **não** é o SHA-256 do arquivo DER inteiro: é o hash interno SignPolicyHash extraído da própria PA, que o serviço compara com o atributo sigPolicyId. Não use um valor inferido ou copiado sem validar a estrutura ASN.1 da PA.


## Endpoints

- GET /healthz: processo vivo.
- GET /readyz: HTTP 200 apenas após validação criptográfica completa na inicialização; caso contrário, o serviço não inicia.
- POST /v1/sign-detached: recebe JSON com operationId, content Base64, contentSha256, format=CAdES-detached e contentType=application/octet-stream; devolve CMS .p7s Base64 e atestação das verificações realizadas. Qualquer falha resulta em HTTP 503 genérico.

A porta não deve ser publicada na Internet. Use rede privada e TLS/mTLS na fronteira de serviço, com autenticação Bearer rotacionável. O bind local é o padrão deliberado.

## Testes e limites ainda abertos

- CI Maven/JDK 21 cobre compilação, pacote, controles de token, parsing ASN.1 da LPA/PA, limites de vigência de 90 dias, rejeição de JSON ambíguo, algoritmo AD-RB 2.4 (RSA mínimo 2048; EC rejeitado) e geração/verificação CMS detached com chave RSA efêmera de teste.
- Vetores sintéticos não demonstram que os artefatos oficiais atuais, a cadeia ICP-Brasil ou o certificado real do desenvolvedor serão aceitos.
- Ainda são necessários testes de integração com LPA CAdES oficial assinada pelo ITI, trust anchors oficiais pinados, respostas OCSP/CRL reais, certificado ICP-Brasil válido do desenvolvedor e verificação por uma segunda implementação independente.
- A validação da revogação depende de conectividade aos respondedores OCSP/CRL; indisponibilidade ou resultado inconclusivo bloqueia.
- Não foi implementado HSM/PKCS#11. O PKCS#12 externo é uma etapa de integração; para produção, preferir chave não exportável em HSM/token e revisar a proteção do processo/segredos.
- O servidor ainda não possui TLS/mTLS próprio, rotação automática de segredos, auditoria externa imutável, timestamping ou monitoramento operacional.
- A API Node cliente ainda exige integração/testes ponta a ponta com este serviço; a rota pública de AFD permanece bloqueada até revisão independente do resultado e da cadeia completa.
- A conformidade REP-P depende também da validação do AFD v004, hash tipo 7, demais documentos e requisitos operacionais; assinatura correta isoladamente não torna o sistema REP-P pronto.

## Container privado

A imagem é multi-stage, inclui as dependências no JAR sombreado e executa como usuário não-root (UID 10001). A porta 8787 é apenas exposta como metadado Docker; o Dockerfile não publica a porta no host.

~~~sh
docker build -f signer-java/Dockerfile -t rep-p-cades-signer:local .
docker network create rep-p-private
~~~

Execute o container na mesma rede bridge privada do backend, monte os arquivos de confiança e PKCS#12 como volume somente leitura e injete as variáveis por um secret manager/arquivo de ambiente fora do repositório. Dentro do container, os caminhos configurados devem apontar para os arquivos montados. **Não use `-p 8787:8787` nem publique a porta em proxy público.** A rede precisa permitir saída controlada aos respondedores OCSP/LCR oficiais; bloqueie entrada externa e limite egress conforme a infraestrutura ICP-Brasil.

O serviço escuta em `0.0.0.0` dentro do container para aceitar conexões do backend na rede Docker privada. Fora de container, o padrão continua sendo `127.0.0.1`. A fronteira entre backend e assinador deve usar TLS/mTLS e regras de rede, mesmo que ambos estejam na mesma rede privada.

O CI verifica o CMS detached gerado por uma segunda implementação (OpenSSL), confere a presença de Bouncy Castle/Jackson no JAR sombreado e constrói a imagem Docker. Isso verifica a matemática CMS e o empacotamento; não substitui a validação oficial da cadeia, da LPA/PA, do certificado ICP-Brasil real nem uma revisão independente de conformidade.

## Execução local de desenvolvimento

Requer JDK 21 e Maven 3.9+.

~~~sh
cd signer-java
mvn --batch-mode test package
~~~

Não use certificado de produção em ambiente de desenvolvimento. Não exponha o serviço à rede pública.


Referências oficiais para atualização dos artefatos: [LPA CAdES do ITI](https://www.gov.br/iti/pt-br/assuntos/repositorio/lista-de-politicas-de-assinatura), [DOC-ICP-15.01](https://repositorio.iti.gov.br/instrucoes-normativas/IN2021_01_DOC-ICP-15.01.htm) e [DOC-ICP-15.03 v9.1](https://www.gov.br/iti/pt-br/assuntos/legislacao/documentos-principais/v9.1_IN2021_03_DOCICP15.03_compilada.pdf). O ciclo da LPA CAdES vigente deve ser reconfirmado a cada provisionamento; não reutilize indefinidamente os artefatos locais.

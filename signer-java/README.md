# REP-P CAdES signer (Java)

**Estado: bootstrap de segurança; assinatura desabilitada. Não é um assinador REP-P pronto para produção.**

## Execução local

Requer JDK 21 e Maven 3.9+.

```sh
cd signer-java
mvn test
REP_CADES_SERVICE_TOKEN='use-a-local-secret-of-at-least-32-characters' mvn package
REP_CADES_SERVICE_TOKEN='use-a-local-secret-of-at-least-32-characters' java -jar target/rep-p-cades-signer-0.1.0-SNAPSHOT.jar
```

O JAR possui classe principal configurada. A execução local serve apenas para validar o comportamento fail-closed; não o exponha à rede pública.

## Endpoints atuais

- `GET /healthz`: processo vivo.
- `GET /readyz`: sempre HTTP 503 enquanto a implementação criptográfica não estiver concluída.
- `POST /v1/sign-detached`: exige Bearer de serviço e limita o corpo; sempre retorna HTTP 503. Não produz CMS, não declara validação e não simula sucesso.

## Bloqueios antes de habilitar assinatura

1. Verificar CMS detached da LPA sobre os bytes DER exatos.
2. Validar certificado signatário, trust anchor explicitamente provisionado, validade e revogação ICP-Brasil; revogação inconclusiva bloqueia.
3. Validar hashes publicados, estrutura ASN.1, nextUpdate e política aplicável.
4. Conferir independentemente os atributos CAdES obrigatórios, digest, OID e hash da política.
5. Integrar mecanismo de assinatura com chave protegida (preferencialmente HSM/PKCS#11), sem incluir material secreto no repositório.
6. Validar a assinatura produzida contra os bytes exatos do AFD com verificador independente e certificado de produção autorizado.
7. Adicionar testes positivos com vetores reais controlados e testes negativos para cada condição acima.

Nenhuma dependência Demoiselle ou cadeia de homologação foi adicionada. A seleção da biblioteca e a validação da API devem ocorrer após fixar versões e revisar suas limitações. O serviço não deve ser exposto publicamente; use rede privada e TLS/mTLS no ambiente de implantação.

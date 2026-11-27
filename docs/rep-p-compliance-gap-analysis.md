# REP-P — análise de lacunas normativas e técnicas

**Base normativa consultada:** Portaria MTP nº 671/2021, Anexo IX, e página oficial do Ministério do Trabalho e Emprego sobre REP, cujos leiautes AFD e AEJ foram atualizados em 31/07/2026.

Este documento é uma análise de engenharia. Não é laudo jurídico, atestado de conformidade ou autorização para uso em produção.

## 1. Requisitos confirmados

- O REP-P precisa de registro do programa de computador no INPI; não depende de homologação de modelo pelo MTE.
- O relógio acessado pelo REP-P deve manter sincronismo com a Hora Legal Brasileira disseminada pelo Observatório Nacional, com variação máxima de 30 segundos.
- O coletor conectado deve exibir relógio digital com horas, minutos e segundos no momento da marcação.
- A marcação on-line é o fluxo normal. O modo off-line é excepcional e não é obrigatório; se implementado, deve transmitir as marcações no primeiro retorno à conexão.
- O REP-P deve manter ARP com redundância, alta disponibilidade e confiabilidade; os dados não podem ser apagados ou alterados direta ou indiretamente no prazo legal.
- Cada estabelecimento possui sua própria sequência NSR, iniciando em 1 na primeira operação do REP em relação ao estabelecimento.
- O REP-P gera o AFD. O PTRP gera o AEJ e o Espelho de Ponto Eletrônico.
- O trabalhador deve conseguir acessar o comprovante após cada marcação, sem solicitação prévia, e extrair comprovantes das últimas 48 horas, no mínimo.

## 2. Leiautes oficiais vigentes consultados

A página do MTE disponibiliza versões atualizadas em 31/07/2026:

- **AFD — versão 004**: texto ISO-8859-1, linhas terminadas em CRLF, registros ordenados por NSR, sem linhas em branco. Registros 1 a 5 usam CRC-16/KERMIT. O registro 7 usa SHA-256. A assinatura é destacada em arquivo .p7s.
- **AEJ — versão 002**: texto ISO-8859-1, campos separados por pipe, linhas CRLF, sem linhas em branco. Deve conter cabeçalho, REP(s), vínculos, horários contratuais, marcações, ausências/banco de horas, identificação do PTRP, trailer e assinatura destacada .p7s.

### AFD — pontos essenciais

- Registro 1: identificação do empregador, documento, nome, registro INPI, intervalo do arquivo, data/hora de geração, versão 004 e identificação do desenvolvedor do REP.
- Registro 2: inclusão/alteração dos dados do empregador, com NSR e responsável.
- Registro 4: ajuste do relógio, com data/hora anterior e posterior e responsável.
- Registro 5: inclusão/alteração/exclusão de empregado, CPF, nome, demais dados e responsável.
- Registro 6: eventos sensíveis do REP-P, incluindo disponibilidade (07) e indisponibilidade (08) do serviço e retorno de energia (02).
- Registro 7: NSR, tipo 7, data/hora da marcação, CPF do empregado, data/hora de gravação, identificador do coletor (01 a 05), indicador on-line/off-line e hash SHA-256.
- Registro 9: trailer com contagens por tipo.
- A assinatura final informa literalmente ASSINATURA_DIGITAL_EM_ARQUIVO_P7S, completando o campo de 100 caracteres com espaços; o arquivo destacado tem extensão .p7s.

### AEJ — pontos essenciais

- Versão do leiaute 002.
- O registro 04 contém duração diária da jornada em minutos e os pares de entrada/saída previstos.
- O registro 05 distingue marcação original (O), incluída manualmente (I), pré-assinalada (P), ponto por exceção (X) e outras fontes (T); também identifica entrada/saída, sequência do par e motivo quando aplicável.
- O registro 08 identifica o PTRP e seu desenvolvedor. Para desenvolvedor pessoa física, a identificação deve usar CPF.
- O AEJ é assinado pelo desenvolvedor do PTRP em CAdES destacado .p7s.

## 3. Lacunas identificadas na implementação atual

| Área | Situação atual | Providência necessária |
|---|---|---|
| NSR | allocate_rep_nsr() é usado pelas marcações; eventos ainda não têm NSR | Unificar a sequência por estabelecimento para todas as operações que geram registros AFD (tipos 2, 4, 5, 6 e 7) |
| Hash do AFD | record_hash atual é SHA-256 de JSON canônico interno | Implementar o hash do registro 7 a partir dos campos normativos e hash anterior; não reutilizar o JSON atual sem validação |
| CPF do trabalhador | employees.cpf é opcional | Exigir CPF válido antes de liberar o uso REP-P e preservar snapshot do CPF na marcação |
| Coletor | collector_id atual é identificador livre do tablet | Separar identificador interno do coletor e código normativo 01–05 |
| Horários | recorded_at existe; created_at é gerado pelo banco | Formalizar e preservar horário da marcação e horário da gravação, ambos com fuso |
| Eventos da ARP | rep_events registra evento genérico sem NSR | Modelar alterações de empregador, ajustes de relógio, alterações de empregados e eventos sensíveis, com responsável, data/hora e NSR |
| Dados do empregador | establishments tem nome e documento genérico | Completar tipo/documento, nome legal, local de prestação, CAEPF/CNO quando aplicável |
| Identidade do software | Não há número INPI nem metadados completos do desenvolvedor | Criar configuração versionada com registro INPI, versão, CPF/nome/e-mail do desenvolvedor |
| AFD | Ainda não implementado | Gerar AFD por intervalo temporal, leiaute 004, CRLF, ISO-8859-1, registros ordenados, trailer e assinatura CAdES |
| AEJ/PTRP | Tratamento formal e AEJ ainda não implementados | Criar trilha de tratamento sem alterar originais, geração AEJ 002 e Espelho |
| Comprovante | Não há comprovante REP-P assinado | Gerar PDF PAdES por marcação e disponibilizar histórico mínimo de 48 horas |
| HLB | clock_timestamp() do PostgreSQL, sem prova de sincronismo | Hospedar o serviço de tempo em infraestrutura controlada, sincronizar com ON/HLB, monitorar desvio e guardar evidências operacionais |
| Disponibilidade | Não há registro de início/fim do serviço | Registrar eventos 07/08 e monitorar disponibilidade, backup e recuperação |
| Assinatura | Não implementada | Certificado ICP-Brasil do desenvolvedor, assinatura CAdES destacada de AFD/AEJ e PAdES do comprovante |

## 4. Cuidados de implementação

1. Não converter o hash JSON atual em hash AFD por aproximação. A serialização dos campos que alimentam o SHA-256 precisa ser implementada literalmente conforme o leiaute e coberta por testes independentes.
2. Não reutilizar NSR de time_marks isoladamente depois que os registros de eventos forem introduzidos. O NSR é uma sequência única por estabelecimento e deve cobrir as operações normativas.
3. Não permitir que edição de cadastro de funcionário, alteração de empregador, manutenção do relógio ou eventos de disponibilidade alterem ou apaguem registros anteriores.
4. O AFD deve ser gerado pelo módulo REP-P a partir da ARP; o AEJ deve ser gerado pelo PTRP a partir do AFD e dos dados de tratamento. Não misturar as responsabilidades.
5. As marcações originais devem permanecer intactas. O tratamento pode acrescentar informações ou indicar marcações indevidas, com motivo e trilha de auditoria.
6. Não ativar a integração para uso real antes de CPF/documentos, registro INPI, HLB, assinaturas, comprovante, AFD, AEJ, backup/restore e testes de aceitação estarem concluídos.

## 5. Próxima sequência de trabalho

1. Criar migration aditiva para metadados do empregador, desenvolvedor, coletor e snapshot de CPF/horários.
2. Redesenhar NSR e eventos da ARP para cobrir todos os registros normativos.
3. Corrigir o hash do registro tipo 7 e criar vetores de teste e verificador de cadeia.
4. Implementar gerador AFD 004 e validador estrutural/CRC/hash.
5. Implementar PTRP, AEJ 002 e Espelho de Ponto.
6. Implementar assinatura ICP-Brasil e comprovante PDF PAdES.
7. Configurar sincronismo HLB, monitoramento, redundância, backup e recuperação.
8. Executar homologação interna com dados fictícios e revisão jurídica/documental antes do uso real.

## 6. Fontes oficiais

- MTE — Registro Eletrônico de Ponto: https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/fiscalizacao-do-trabalho/rep
- MTE — Perguntas e Respostas da Portaria nº 671/2021: https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/fiscalizacao-do-trabalho/Perguntas%20e%20Respostas%20REP
- Observatório Nacional — sincronismo público à HLB: https://www.gov.br/observatorio/pt-br/assuntos/areas-de-atuacao/tempo-e-frequencia/acerte-seu-computador-via-internet
- Observatório Nacional — sincronismo certificado à HLB: https://www.gov.br/pt-br/servicos/sincronismo-certificado-a-hora-legal-brasileira-on
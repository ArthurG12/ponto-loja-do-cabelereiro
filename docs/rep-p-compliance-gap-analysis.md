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
| NSR | Migration 008 cria rep_ledger, espelha marcações tipo 7 e fornece append_rep_afd_event() para tipos 2, 4, 5 e 6 | Validar payloads tipados de cada registro, cobrir eventos administrativos reais e impedir qualquer caminho de gravação fora do livro |
| Hash do AFD | Migration 010 implementa SHA-256 por concatenação dos campos fixos 1–7 e hash anterior, com versão `afd-v004-fixed-concat-candidate-v1` e vetores independentes | Confirmar formalmente a serialização com segunda implementação/revisão especializada antes de tratar como hash normativo e liberar AFD |
| CPF do trabalhador | Migration 009 adiciona validação matemática no cadastro, exige CPF válido na RPC de marcação e preserva snapshot de 11 dígitos; registros antigos podem continuar sem CPF | Completar integração de alterações cadastrais com registro AFD tipo 5 e revisar tratamento de dados pessoais |
| Coletor | Backend exige identificador estável e código normativo 01–05; configuração inicial do tablet via navegador é 02 | Inventariar cada coletor físico e controlar seu ciclo de vida e alterações |
| Horários | recorded_at existe; created_at é gerado pelo banco | Formalizar e preservar horário da marcação e horário da gravação, ambos com fuso |
| Eventos da ARP | Migrations 012 e 017 registram eventos AFD tipo 5 com CPF do empregado e do responsável; migration 013 registra tipo 2; migration 015 registra disponibilidade tipo 6 (07/08) | Integrar monitor externo para quedas abruptas e retorno de energia (02), completar demais dados de identificação do tipo 5 e validar serialização/CRC na geração AFD |
| Dados do empregador | Migration 013 adiciona fluxo administrativo protegido para CPF do responsável e dados do empregador; alteração gera AFD tipo 2 transacional | Integrar formulário administrativo, preencher dados reais da Loja do Cabeleireiro e validar CNPJ/CPF, CAEPF/CNO e local de prestação antes da operação real |
| Identidade do software | Não há número INPI nem metadados completos do desenvolvedor | Criar configuração versionada com registro INPI, versão, CPF/nome/e-mail do desenvolvedor |
| AFD | Ainda não implementado | Gerar AFD por intervalo temporal, leiaute 004, CRLF, ISO-8859-1, registros ordenados, trailer e assinatura CAdES |
| AEJ/PTRP | Tratamento formal e AEJ ainda não implementados | Criar trilha de tratamento sem alterar originais, geração AEJ 002 e Espelho |
| Comprovante | Não há comprovante REP-P assinado | Gerar PDF PAdES por marcação e disponibilizar histórico mínimo de 48 horas |
| HLB | clock_timestamp() do PostgreSQL, sem prova de sincronismo | Hospedar o serviço de tempo em infraestrutura controlada, sincronizar com ON/HLB, monitorar desvio e guardar evidências operacionais |
| Disponibilidade | Migration 015 registra eventos 07/08 no início e no encerramento gracioso do backend, com NSR e timestamp DH | Monitor externo para quedas abruptas, eventos de retorno de energia (02), alertas, backup e recuperação |
| RPCs legadas e acesso | Migration 011 revoga do navegador as RPCs legadas de listagem, PIN e marcação; histórico legado é consultado somente pelo backend | Validar rate limiting e sessões reais Auth; revisar periodicamente grants e advisors do Supabase |
| Assinatura | Não implementada | Certificado ICP-Brasil do desenvolvedor, assinatura CAdES destacada de AFD/AEJ e PAdES do comprovante |





### Responsável nos eventos cadastrais de empregados (migration 017)

A migration 017 completa o AFD tipo 5 com o CPF do responsável administrativo. O trigger agora exige sessão autenticada de administrador, CPF válido do responsável e CPF válido do empregado antes de registrar inclusão, alteração ou desativação. O CPF do responsável é incluído no payload e a operação cadastral é revertida se faltar qualquer requisito. A criação/alteração de empregados deve passar pelo fluxo administrativo autenticado; operações de manutenção sem responsável identificado não geram eventos normativos.

### Eventos de disponibilidade do serviço (migration 015)

A RPC backend-only `record_rep_service_event` registra apenas transições reais 07 (disponibilidade) e 08 (indisponibilidade) do ciclo de vida do servidor REP-P, com timestamp DH de 24 caracteres, origem do evento e NSR compartilhado. O backend tenta gravar 07 após iniciar a escuta e 08 em encerramento gracioso (`SIGTERM`/`SIGINT`); a prontidão da API só é liberada depois da confirmação do evento 07. Uma queda abrupta pode impedir o registro 08, por isso ainda é necessário monitor externo para detectar indisponibilidade não graciosa. O código 02 (retorno de energia) não é gerado sem sensor ou evidência real de energia. A variável privada `REP_ESTABLISHMENT_ID` vincula o processo ao estabelecimento.

### Ajuste do relógio (migration 014)

A RPC `admin_adjust_rep_clock` exige administrador autenticado e CPF válido no perfil. Recebe os instantes explícitos anterior e posterior ao ajuste físico, serializa os campos DH com segundos fixos em `00` e offset, conforme o leiaute oficial; preserva a diferença real em segundos apenas como metadado auxiliar, registra o instante de gravação e o responsável, e chama a API interna de eventos para alocar NSR compartilhado e gravar tipo 4 em `rep_events` e `rep_ledger` na mesma transação. Instantes ausentes, infinitos ou iguais são rejeitados. A função não altera o relógio do servidor nem comprova sincronismo HLB; ainda é necessário um controlador confiável integrado ao Observatório Nacional, com evidência de leitura imediatamente antes/depois do ajuste.

### Identificação do empregador (migration 013)

A migration 013 adiciona o CPF do responsável ao perfil administrativo, sem expor essa coluna por grants de leitura do cliente. O administrador informa seu CPF por `admin_set_responsible_cpf`; a alteração dos dados do estabelecimento é feita por `admin_save_establishment`. Um trigger valida a sessão administrativa, o CPF do responsável e os campos do empregador, e gera o AFD tipo 2 com NSR na mesma transação. Se faltar CPF ou algum campo obrigatório, a alteração é revertida. A integração do formulário administrativo ainda está pendente; os dados reais da empresa não foram preenchidos no staging.

### Eventos cadastrais de empregados (migration 012)

Um trigger `AFTER INSERT OR UPDATE` na tabela `employees` gera o registro AFD tipo 5 na mesma transação da operação cadastral. São registrados inclusão (`I`), alteração (`A`) e desativação (`E`), com CPF, nome, admissão, jornada, situação, e-mail e telefone, além do identificador do empregado e responsável autenticado. Atualizações técnicas de PIN, tentativas inválidas e bloqueios não geram eventos cadastrais, pois não alteram os campos de identificação acompanhados pelo trigger. Se o estabelecimento ou a alocação de NSR estiverem indisponíveis, a operação cadastral falha integralmente.

### Segurança do fluxo remoto (migration 011)

O frontend remoto não chama mais diretamente as RPCs legadas `list_active_employees`, `verify_employee_pin`, `list_employee_punches` ou `register_punch`. A equipe e o histórico legado passam pelo backend confiável; `list_employee_punches` permanece executável apenas por `service_role`. Sem `VITE_REP_API_URL`, a marcação remota falha de forma fechada em vez de gravar em `punches`. Isso reduz a superfície exposta, mas não substitui rate limiting no backend nem a validação de sessões Auth e RLS.

## 4. Cuidados de implementação

1. Não converter o hash JSON atual em hash AFD por aproximação. A serialização dos campos que alimentam o SHA-256 precisa ser implementada literalmente conforme o leiaute e coberta por testes independentes.
2. Não reutilizar NSR de time_marks isoladamente depois que os registros de eventos forem introduzidos. O NSR é uma sequência única por estabelecimento e deve cobrir as operações normativas.
3. Não permitir que edição de cadastro de funcionário, alteração de empregador, manutenção do relógio ou eventos de disponibilidade alterem ou apaguem registros anteriores.
4. O AFD deve ser gerado pelo módulo REP-P a partir da ARP; o AEJ deve ser gerado pelo PTRP a partir do AFD e dos dados de tratamento. Não misturar as responsabilidades.
5. As marcações originais devem permanecer intactas. O tratamento pode acrescentar informações ou indicar marcações indevidas, com motivo e trilha de auditoria.
6. Não ativar a integração para uso real antes de CPF/documentos, registro INPI, HLB, assinaturas, comprovante, AFD, AEJ, backup/restore e testes de aceitação estarem concluídos.

## 5. Próxima sequência de trabalho

1. Migration 008 cria a primeira versão do livro imutável rep_ledger, metadados iniciais do empregador e a API de inclusão de eventos AFD com NSR compartilhado.
2. Completar os metadados do desenvolvedor e do coletor, além de integrar alterações de empregados como registros AFD tipo 5 e preservar snapshots de identificação e horário.
3. Validar a serialização candidata do hash tipo 7 com segunda implementação independente; depois criar o verificador completo de cadeia.
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
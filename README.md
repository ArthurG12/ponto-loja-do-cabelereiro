# Ponto Fácil — Loja do Cabeleireiro

Aplicação inicial para tablet, com interface responsiva e base para conexão ao Supabase. A logomarca fornecida foi copiada sem alteração para `public/logo-loja.png`.

## Estado atual

O tablet já registra ponto de verdade. Sem Supabase, os dados ficam no SQLite deste computador, em `data/ponto.sqlite`. Limpar o navegador não apaga as batidas. Há cinco colaboradoras de teste para a tela inicial.

Implementado:
- Cartões da equipe, senha numérica e confirmação da marcação.
- Sequência de segunda a sexta: entrada, almoço, retorno e saída. Sábado: entrada e saída.
- Painel com quem está atrasada, em expediente, no almoço ou além do horário de saída.
- Cadastro, troca de senha, ativar e desativar colaboradora.
- Apuração da jornada A/B: previsto, trabalhado, saldo, hora extra e atraso.
- Abono de atestado ou folga, correção de horário e inclusão de marcação esquecida.
- CSV de batidas e de apuração, no formato que o Excel abre.
- Banco SQLite local e cópia de segurança em JSON.
- Trava depois de 5 senhas erradas.
- Esquema Supabase com PIN só no servidor, para quando o ponto precisar sair deste aparelho.

Ainda fora deste pacote:
- Publicar num endereço da internet e configurar o domínio.
- Exportação nativa `.xlsx` (o CSV já abre no Excel).
- Arquivo do atestado dentro do sistema: a observação fica no ponto e o documento continua guardado na loja.
- Homologação legal de registrador eletrônico de ponto. Isto é controle interno.

## Pré-requisitos

- Node.js LTS instalado.
- Projeto Supabase.
- Terminal/linha de comando.

## Rodar localmente

1. Abra um terminal na pasta `ponto-facil-loja`.
2. Execute `npm install`.
3. Execute `npm run dev` e abra o endereço local. Esse comando sobe a página e o banco.
4. No tablet, entre em **Acesso do administrador**, crie a senha e cadastre a equipe.
5. O arquivo do banco é `data/ponto.sqlite`. Em Ajustes dá para baixar uma cópia JSON.

O Supabase é opcional e serve para o mesmo ponto em mais de um aparelho. Copie `.env.example` para `.env`, preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`, execute `supabase/schema.sql` no SQL Editor e crie o usuário em Authentication. O primeiro usuário vira administrador. Não coloque a chave `service_role` no navegador nem em variável `VITE_*`.

## Configuração do banco

O SQL é a base do modo online. O primeiro usuário criado em Authentication recebe `role = 'admin'`. Se o gatilho não for criado, insira a linha em `profiles` na mão, como está comentado no final do arquivo. As colaboradoras e as senhas são cadastradas pelo painel: o PIN só existe como hash no banco.

O login administrativo usa Supabase Auth. O fluxo de colaboradora utiliza RPC para validar o PIN e registrar a marcação com horário do servidor. Antes de abrir o sistema à equipe, teste as políticas RLS, a limitação de tentativas, a sequência de marcações e os acessos cruzados.

## Publicar online

O site público é o GitHub Pages: https://arthurg12.github.io/ponto-loja-do-cabelereiro/

Cada push na branch `main` gera o build e publica. O endereço do Supabase e a chave pública ficam em `.env.production`, porque essa chave é feita para ir no navegador. A chave `service_role` não entra no repositório.

## Integração REP-P em desenvolvimento

A branch `feat/rep-p-arp` contém migrations aditivas para a ARP e uma API REP-P isolada do servidor legado SQLite. O processo dedicado é iniciado com `npm run start:rep-p` e executa apenas os endpoints REP-P; ele não importa, inicializa nem semeia o banco SQLite local. O frontend remoto exige `VITE_REP_API_URL` para listar colaboradores (`GET /api/rep-p/employees`), consultar marcações (`POST /api/rep-p/today`) e registrar novas marcações (`POST /api/rep-p/register`). **Se a URL do backend não estiver configurada ou o serviço estiver indisponível, a operação remota falha de forma fechada: não há fallback para as RPCs legadas de marcação.** O modo SQLite local continua separado e não deve ser tratado como REP-P.

Configure no ambiente privado do processo backend:

- `SUPABASE_URL`: URL do projeto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: chave privilegiada, exclusivamente no servidor.
- `REP_COLLECTOR_ID`: identificador estável do coletor/tablet.
- `REP_COLLECTOR_TYPE`: código normativo do coletor: `01` mobile, `02` navegador, `03` desktop, `04` dispositivo eletrônico ou `05` outro. Para o tablet acessado pelo navegador, use `02`.
- `REP_ESTABLISHMENT_ID`: UUID do estabelecimento ativo ao qual este processo REP-P está vinculado.
- `REP_ALLOWED_ORIGIN` ou `REP_ALLOWED_ORIGINS`: origem(ens) exata(s) do frontend. Para várias origens, separe por vírgula.

O endpoint de equipe retorna somente identificador, nome e jornada de colaboradores ativos. As RPCs legadas de listagem, validação de PIN e gravação de marcação não ficam mais acessíveis pelo navegador; a consulta do histórico legado é feita pelo backend com `service_role`.
- `HOST=0.0.0.0` e `PORT`: endereço e porta de escuta do serviço.

O processo oferece `GET /healthz` para verificação de vida e `GET /readyz` para verificar se as variáveis obrigatórias estão configuradas. A API aceita somente JSON, limita o corpo a 16 KiB, aplica CORS por allowlist e não habilita cookies ou sessão administrativa. O processo deve ser executado como serviço Node persistente, atrás de HTTPS, com reinício automático e logs protegidos.

No build do frontend, configure `VITE_REP_API_URL` com a URL pública do backend. A chave privilegiada jamais pode ser colocada em `.env.production`, variável `VITE_*`, código do navegador ou repositório. Não compartilhe essa chave no chat.

O cadastro administrativo coleta CPF e valida os dígitos verificadores. A função de registro valida PIN e CPF, preserva o snapshot do CPF, o código normativo do coletor e o indicador on-line/off-line, controla a sequência prevista e aloca NSR por estabelecimento em transação. CPFs antigos podem continuar vazios, mas a marcação REP-P fica bloqueada até o cadastro válido. O hash do registro tipo 7 usa a concatenação dos campos fixos 1–7 formatados e o hash anterior tipo 7, identificado como `afd-v004-fixed-concat-candidate-v1`. A Portaria enumera os campos, mas não explicita literalmente a serialização dos bytes; por isso, a versão permanece candidata e não libera ainda a exportação legal do AFD. A migration `202611260004_read_employee_time_marks.sql` adiciona a leitura do próprio dia por PIN exclusivamente via backend. A gravação original é feita em `time_marks`; a tabela legada `punches` permanece separada nesta fase. A migration `202611260003_assign_employee_establishment.sql` também vincula automaticamente novos funcionários ao único estabelecimento ativo; se houver mais de um, a inclusão falha de forma segura.


**Leitura integrada nesta etapa:** a tela de conferência consulta também as marcações REP-P por um endpoint backend que valida novamente o PIN. Os relatórios administrativos combinam `punches` legados e `time_marks` (com leitura protegida por RLS para administradores). A tela de ajustes identifica os registros REP-P pelo NSR e não oferece alteração/anulação direta, pois as marcações originais são imutáveis. As migrations `202611270012_employee_afd_events.sql` e `202611270013_employer_afd_type2.sql` registram eventos AFD tipo 5 (empregados) e tipo 2 (identificação do empregador), com NSR compartilhado e trilha imutável na mesma transação. O tipo 2 exige CPF válido do administrador responsável e possui RPCs protegidas; a integração do formulário administrativo ainda está pendente. A migration `202611270014_afd_clock_adjustments.sql` adiciona a RPC administrativa `admin_adjust_rep_clock`, que registra o tipo 4 com instantes anterior/posterior, formato DH normativo (segundos fixos `00`), fuso, CPF do responsável e NSR compartilhado. Ela não altera o relógio físico nem comprova sincronismo HLB: a integração com um controlador confiável e a fonte do Observatório Nacional ainda estão pendentes. A migration `202611270015_rep_service_availability_events.sql` registra eventos AFD tipo 6: o backend grava 07 ao iniciar e 08 no encerramento gracioso, com NSR compartilhado. A prontidão fica bloqueada até confirmar o evento 07. Quedas abruptas ainda exigem monitor externo, e o evento 02 depende de sensor real de retorno de energia. Também permanece pendente o fluxo formal de tratamento/AEJ.

**Limitação importante:** usar `clock_timestamp()` não comprova, por si só, sincronização nem rastreabilidade da Hora Legal Brasileira (HLB). Antes de qualquer uso como REP-P, o servidor e o banco precisam estar em infraestrutura com sincronização HLB documentada e monitorada, variação dentro do limite normativo, controles operacionais e testes. Ainda não foram implementados assinatura digital ICP-Brasil, comprovante legal, AFD/AEJ ou PTRP. Portanto, esta integração é uma etapa técnica de desenvolvimento, não uma declaração de conformidade legal.

As migrations em `supabase/migrations/` devem ser aplicadas em ordem, primeiro em um projeto de teste e após backup. Não execute em produção sem validar o schema, os usuários/estabelecimento e os registros existentes.

A análise detalhada dos requisitos e das lacunas identificadas nos leiautes oficiais de 31/07/2026 está em [docs/rep-p-compliance-gap-analysis.md](docs/rep-p-compliance-gap-analysis.md). Ela deve ser tratada como checklist de engenharia, não como declaração de conformidade.

## Jornadas previstas

- Jornada A: segunda a sexta 08:00–12:00 e 13:00–17:00; sábado 08:00–12:00.
- Jornada B: segunda a sexta 09:00–13:00 e 14:00–18:00; sábado 09:00–13:00.

A apuração de horas não deve ser usada para folha de pagamento até ser implementada e validada de acordo com a jornada real, feriados, convenção coletiva e regras trabalhistas aplicáveis.

## Aviso importante

Esta versão é para controle interno e desenvolvimento. Não é apresentada como sistema legalmente homologado/certificado de registro eletrônico de ponto. Proteja dados pessoais, especialmente documentos médicos. A foto de perfil não é reconhecimento facial. Não use biometria nesta versão.

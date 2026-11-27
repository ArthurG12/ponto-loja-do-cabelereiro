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

A branch `feat/rep-p-arp` contém migrations aditivas para a ARP e um endpoint de registro protegido no backend. Quando `VITE_REP_API_URL` estiver configurada no build do frontend, as novas marcações online são enviadas para `POST /api/rep-p/register`; sem essa variável, o sistema mantém o fluxo Supabase legado. **O fluxo legado não deve ser tratado como REP-P.**

O backend precisa receber, em variáveis privadas do ambiente de execução:

- `SUPABASE_URL`: URL do projeto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: chave service_role, exclusivamente no servidor.
- `REP_COLLECTOR_ID`: identificador estável do coletor/tablet.
- `REP_ALLOWED_ORIGIN`: origem exata do frontend, por exemplo `https://arthurg12.github.io`.
- `HOST` e `PORT`: endereço e porta de escuta do serviço.

No build do frontend, configure `VITE_REP_API_URL` com a URL pública do backend. A chave `service_role` jamais pode ser colocada em `.env.production`, variável `VITE_*`, código do navegador ou repositório.

A função de registro valida o PIN no banco, controla a sequência prevista, aloca NSR por estabelecimento em transação, registra horário do PostgreSQL e encadeia os hashes SHA-256. A gravação original é feita em `time_marks`; a tabela legada `punches` permanece separada nesta fase. A migration `202611260003_assign_employee_establishment.sql` também vincula automaticamente novos funcionários ao único estabelecimento ativo; se houver mais de um, a inclusão falha de forma segura.


**Integração ainda incompleta na interface:** nesta etapa, a tela de conferência do funcionário e os relatórios administrativos ainda consultam o fluxo legado `punches`. Portanto, embora o endpoint novo grave em `time_marks`, a visualização completa dessas marcações na interface ainda precisa ser integrada antes de habilitar `VITE_REP_API_URL` para uso diário.

**Limitação importante:** usar `clock_timestamp()` não comprova, por si só, sincronização nem rastreabilidade da Hora Legal Brasileira (HLB). Antes de qualquer uso como REP-P, o servidor e o banco precisam estar em infraestrutura com sincronização HLB documentada e monitorada, variação dentro do limite normativo, controles operacionais e testes. Ainda não foram implementados assinatura digital ICP-Brasil, comprovante legal, AFD/AEJ ou PTRP. Portanto, esta integração é uma etapa técnica de desenvolvimento, não uma declaração de conformidade legal.

As migrations em `supabase/migrations/` devem ser aplicadas em ordem, primeiro em um projeto de teste e após backup. Não execute em produção sem validar o schema, os usuários/estabelecimento e os registros existentes.

## Jornadas previstas

- Jornada A: segunda a sexta 08:00–12:00 e 13:00–17:00; sábado 08:00–12:00.
- Jornada B: segunda a sexta 09:00–13:00 e 14:00–18:00; sábado 09:00–13:00.

A apuração de horas não deve ser usada para folha de pagamento até ser implementada e validada de acordo com a jornada real, feriados, convenção coletiva e regras trabalhistas aplicáveis.

## Aviso importante

Esta versão é para controle interno e desenvolvimento. Não é apresentada como sistema legalmente homologado/certificado de registro eletrônico de ponto. Proteja dados pessoais, especialmente documentos médicos. A foto de perfil não é reconhecimento facial. Não use biometria nesta versão.

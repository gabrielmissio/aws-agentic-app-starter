# Assessment Técnico — `aws-agentic-app-starter`

**Escopo:** avaliação independente da engenharia do template, desconsiderando o domínio da aplicação.
**Data:** 2026-08-28 · **Commit avaliado:** `6ca67f3` (branch `feat/assessment`, árvore limpa)
**Objetivo:** determinar se o template está pronto para acelerar (1) demos, (2) pilotos fechados
inclusive com dados sensíveis, e (3) aplicações públicas em produção.

---

## 1. Resumo executivo

Este é um template acima da média da categoria. A engenharia é deliberada: as decisões de segurança
não estão apenas documentadas — estão **asseguradas por testes contra o template sintetizado**, o que
é raro. O *deployment profile gate* (`infra/src/config.ts:173`) é uma ideia genuinamente boa e bem
executada: transforma comentários de README em uma build que se recusa a sintetizar.

O que o template **não** tem é a camada operacional que separa "um sistema que funciona" de "um
sistema que se opera": não há tracing, não há métricas de negócio ou de custo por usuário, não há
pipeline de deploy, não há guardrails de conteúdo do Bedrock, e o estado conversacional vive na
memória do contêiner.

### Veredito por nível

| Nível | Prontidão | Nota | Síntese |
|---|---|---|---|
| **1. Demos** | ✅ **Pronto** | 5/5 | Um comando de deploy, defaults de sandbox coerentes, zero bloqueadores. |
| **2. Pilotos fechados (dados sensíveis)** | ⚠️ **Condicionalmente pronto** | 3/5 | O gate de perfil cobre a postura de acesso; falta a camada de *evidência* (tracing, auditoria de conteúdo), isolamento de rede e guardrails de IA. |
| **3. Produção pública** | ❌ **Não pronto** | 2/5 | Bloqueadores estruturais: sem CD, sem domínio/TLS próprio, WAF opcional, estado em memória, teto de 50 e-mails/dia do Cognito. |

### Notas por dimensão

| Dimensão | Nota | Comentário de uma linha |
|---|---|---|
| Arquitetura | 4,5/5 | Fronteira de confiança clara, coerente e (quase toda) testada. |
| Qualidade de código | 4,5/5 | TS estrito, módulos puros separados de I/O, comentários que explicam o *porquê*. |
| Testes e quality gates | 3,5/5 | 249 testes de altíssima qualidade — com buracos nomeáveis e nenhuma medição de cobertura. |
| Segurança | 4,0/5 | IAM de menor privilégio real; falta criptografia com CMK, WAF obrigatório e isolamento de rede. |
| Infraestrutura AWS | 4,0/5 | 100% IaC, dependências explícitas; sem VPC e sem estratégia multi-conta. |
| Observabilidade | 2,0/5 | 3 alarmes e logs de acesso. Sem tracing, sem métricas, sem dashboard, sem correlação. |
| Resiliência | 2,0/5 | Degradação elegante em dois pontos; sem retry, DLQ, concorrência reservada ou DR. |
| Escalabilidade | 2,5/5 | Camada serverless escala; o agente não (estado em memória, evicção O(n)). |
| Desempenho | 3,5/5 | Streaming fim a fim e decisões de pooling corretas; nada é medido. |
| CI/CD | 2,5/5 | CI exemplar em higiene de supply chain; CD inexistente; sem governança de repositório. |
| Governança de IA | 2,0/5 | Excelente no controle de identidade; ausente em conteúdo, avaliação e auditoria. |
| Otimização de custos | 3,0/5 | Bons tetos preventivos; nenhuma instrumentação de consumo real. |

---

## 2. Metodologia e evidências coletadas

Este assessment é baseado em leitura integral do código-fonte (~9.680 LOC em TS/TSX/MJS, dos quais
~2.668 em testes), da documentação (5 READMEs, 4 arquivos `.env.example`) e da IaC, complementada por
execução real:

| Verificação executada | Resultado |
|---|---|
| `npm run verify` (lint + typecheck + test) | ✅ **Exit 0** — 249 testes em 20 arquivos, todos passando |
| `npm run audit` (`--audit-level=high`) | ✅ **Exit 0** — 1 vulnerabilidade *low* (esbuild, dev-only, Windows) |
| Síntese CloudFormation de `auth`, `bff`, `frontend` | ✅ 58 recursos gerados, inspecionados propriedade a propriedade |
| Inventário de propriedades de hardening no template sintetizado | Ver §6.6 |

Distribuição dos testes: `infra` 79 · `chatbot-frontend` 79 · `chatbot-bff` 63 · `agent` 28.

> **Nota metodológica:** o `AgentStack` não é sintetizável sem um `docker build` real, portanto suas
> propriedades foram avaliadas por leitura de código, não por inspeção de template. Isso é uma
> limitação deste assessment **e** uma lacuna do template (§6.3).

---

## 3. Veredito nível 1 — Demos

### Prontidão: ✅ **Pronto** (5/5)

O template atinge exatamente o objetivo declarado. Um desenvolvedor com credenciais AWS e Docker sai
de zero a uma aplicação agêntica autenticada, com streaming e painel administrativo, em três comandos
(`README.md:38-42`).

### Evidências positivas

- **Defaults de sandbox coerentes e conscientes.** Sign-up aberto, CORS `*`, sem MFA — cada um
  documentado como sandbox-only em `infra/.env.example`, com a razão de ser default explicada.
- **`demo` é deliberadamente não verificado** (`infra/src/config.ts:174`). A justificativa no código —
  "um sandbox que reclama ensina que esses erros são ruído" — é um raciocínio de produto maduro.
- **Garantia de não-regressão de custo.** O teste `costs nothing and changes nothing when no profile
  is set` (`infra/src/__tests__/stacks.test.ts:504`) assegura que nenhum recurso faturado aparece
  sem escolha explícita: `UserPoolTier`, `UserPoolAddOns` e `MfaConfiguration` são todos ausentes por
  padrão.
- **Testes rodam sem AWS, sem Docker e sem browser** (`environment: 'node'` nos quatro pacotes).
- **Recuperação de erro documentada** para a falha mais provável na primeira execução
  (`exec format error` no build ARM64 → `npm run docker:setup-arm64`).
- **Throttle default de 10 rps / 20 burst** e cota de 20 req/60s por usuário impedem que uma demo
  esquecida rodando gere fatura de Bedrock.

### Riscos e lacunas (não bloqueadores)

| Item | Severidade | Evidência |
|---|---|---|
| Não há `LICENSE` no repositório | **Média** — para um template destinado a ser copiado, a ausência de licença cria ambiguidade jurídica sobre reuso | `ls` na raiz: sem LICENSE, CONTRIBUTING, SECURITY.md, CODEOWNERS |
| E-mails do Cognito caem em spam (mailer default `no-reply@verificationemail.com`) | Baixa | Documentado honestamente em `infra/README.md`, seção "Emails" |
| Deploy assume Docker + Buildx + emulação ARM64 | Baixa | `README.md:36` |

### Ações recomendadas (prioridade)

1. **P2 —** Adicionar `LICENSE` (ex.: MIT ou Apache-2.0) e `SECURITY.md`. Um template sem licença é
   um template que a área jurídica de um cliente bloqueia.
2. **P3 —** Adicionar um `docker compose` ou script único que suba agente + BFF + frontend local, para
   reduzir o caminho de três terminais descrito em `README.md` ("Local development").

---

## 4. Veredito nível 2 — Pilotos fechados, inclusive com dados sensíveis

### Prontidão: ⚠️ **Condicionalmente pronto** (3/5)

O template **entende** o problema de piloto melhor que a maioria — o gate de perfil é a prova. O que
falta não é postura de acesso, é **capacidade de evidenciar e conter**: um piloto com dados sensíveis
precisa responder "quem viu o quê, quando, e o que o agente respondeu", e o template deliberadamente
não guarda essa informação.

### Evidências positivas

**O gate de perfil faz trabalho real** (`infra/src/config.ts:173-223`). Com `DEPLOY_PROFILE=pilot`,
`cdk synth` falha antes de qualquer recurso ser descrito, listando **todas** as violações de uma vez:

- `PUBLIC_SIGNUP_ENABLED` deve ser `false`
- `ALLOWED_ORIGIN` não pode ser `*`
- `ALERT_EMAIL` é obrigatório
- `COGNITO_MFA` deve ser `required`
- `COGNITO_THREAT_PROTECTION` não pode ser `off`
- `RETAIN_DATA` deve ser `true`

E `assertDeploymentTarget` (`infra/src/config.ts:119`) exige `DEPLOY_ACCOUNT`/`DEPLOY_REGION` sob
`pilot`/`prod`, falhando se as credenciais ambientes resolverem para outra conta. Ambos têm cobertura
de teste dedicada (`infra/src/__tests__/config.test.ts:181-336`).

**Isolamento de identidade — o ponto mais forte do template.** A cadeia é coerente do IaC ao runtime:

| Camada | Controle | Evidência |
|---|---|---|
| Browser | Nenhuma credencial AWS — user pool sem identity pool | `chatbot-frontend/src/lib/auth.ts:19-27` |
| Teste | Ausência do identity pool **asserida** | `stacks.test.ts:64`, `:71`, `:106` — inclusive `sts:AssumeRoleWithWebIdentity` ausente do template inteiro |
| Transporte | Runtime AgentCore sem `authorizerConfiguration` → só SigV4 | `agent-stack.ts:197` |
| IAM | Só a role do BFF de chat tem `InvokeAgentRuntime` | `bff-stack.ts:95-101`; asserido em `stacks.test.ts:91` e `:399` |
| Sessão | `sessionId` prefixado com `sha256(sub)[:16]` — impede replay de conversa alheia | `chatbot-bff/src/session.ts:14-39` |
| Ferramentas | **Nenhuma tool aceita `userId`**; identidade vem de `AsyncLocalStorage` | `agent/src/tools.ts`, `agent/src/caller.ts:20-30`; asserido sobre todo o toolset |

**Separação de privilégios entre funções.** O chat e o admin são Lambdas distintas, e o teste
`keeps every privileged grant off the function that relays model output`
(`stacks.test.ts:399`) assere **exaustivamente** que a role do chat pode fazer exatamente duas coisas:
`bedrock-agentcore:InvokeAgentRuntime` e `dynamodb:UpdateItem`. Nada de `cognito-idp:`,
`secretsmanager`, `kms:`, `sns:Publish`.

**IAM de menor privilégio com raciocínio.** `bedrockModelResources` (`agent-stack.ts:242`) escopa o
Bedrock a **um** modelo, emitindo os dois formatos de ARN necessários (foundation-model e
inference-profile) — um detalhe correto e não óbvio, com três testes cobrindo os casos.
ECR escopado ao repositório do próprio asset; DynamoDB só `UpdateItem`; Cognito com as quatro ações
enumeradas e escopadas ao pool.

**Autorização servidor-side em rota administrativa.** `admin-handler.ts:71` reconfere
`cognito:groups` contra o grupo `admins` em toda chamada. O badge no frontend é explicitamente
cosmético (`session-roles.ts:27-32`). `parseGroupsClaim` (`admin.ts:53`) trata as três formas em que o
authorizer serializa a claim — um ponto onde errar falha aberto.

**Trilha de auditoria para ações privilegiadas.** `auditRecord` (`admin.ts:202`) emite uma linha JSON
por ação — inclusive **negadas** — nomeando o humano (`actorSub`, `actorEmail`), o que o CloudTrail
não faz (ele atribui à role da Lambda).

**Higiene de dados nos logs.** `dataTraceEnabled` explicitamente `false` (`bff-stack.ts:113`); o
formato de access log carrega identidade e resultado, nunca corpo (`bff-stack.ts:131-142`); o registro
de auditoria carrega apenas ator/ação/alvo, com comentário explicando a decisão (`admin.ts:197-201`).

**Renderização segura de saída do modelo.** `AgentMarkdown` usa `react-markdown@10.1.0` sem
`rehype-raw` e sem `dangerouslySetInnerHTML`; o `defaultUrlTransform` da lib sanitiza URIs
`javascript:`. Mensagens do usuário são renderizadas como texto puro, por decisão documentada. Isso
fecha o vetor XSS mais comum em apps agênticos.

### 🔴 Riscos e bloqueadores

| # | Risco | Sev. | Evidência |
|---|---|---|---|
| **B1** | **Nenhum Bedrock Guardrail configurado.** Não há filtro de conteúdo, detecção/redação de PII, tópicos negados nem detecção de prompt-attack em lugar algum do repositório. A palavra "guardrails" no `README.md:21` refere-se a controles *operacionais* (retenção, alarmes, budget, throttling, WAF) — a enumeração é honesta, mas convida à leitura errada. | **Crítica** | `grep -ri guardrail` retorna apenas `infra/app.ts:67` (comentário de seção) e prosa do README |
| **B2** | **Runtime AgentCore em `networkMode: 'PUBLIC'`** — sem VPC, sem subnets privadas, sem VPC endpoints, sem controle de egresso. Um contêiner comprometido tem saída irrestrita para a internet. | **Alta** | `agent-stack.ts:180-182` |
| **B3** | **Nenhum registro do que o agente respondeu.** O histórico vive na memória do contêiner e é perdido no restart (`agent/src/index.ts:9-22`). Não há log, tabela ou stream do conteúdo. Para um piloto regulado, "não guardamos nada" costuma ser inaceitável tanto quanto "guardamos tudo sem controle". | **Alta** | `agent/src/index.ts:13-15` |
| **B4** | **Zero tracing distribuído.** `TracingConfig` ausente em todas as Lambdas no template sintetizado; a role do runtime **tem** permissões X-Ray (`agent-stack.ts:113-122`) mas nada as usa. Não há correlation ID propagado browser → BFF → agente. Diagnosticar uma resposta errada em piloto é impossível. | **Alta** | Síntese: `grep -c TracingConfig` = 0 |
| **B5** | **Nenhuma criptografia com chave gerenciada pelo cliente (CMK).** Log groups, tabela DynamoDB e tópico SNS usam chaves AWS-owned/managed. O tópico SNS de alarmes está sem criptografia em repouso. | **Média** | Síntese: `KmsKeyId`, `KmsMasterKeyId`, `SSESpecification` = 0 ocorrências |
| **B6** | **WAF opcional mesmo em `prod`.** É a única camada que filtra **antes** da autenticação; o throttle de stage não diz *quem* gastou e a cota por usuário só age depois do login. A decisão de deixá-lo opcional é justificada por custo (`config.ts:86-91`) e é defensável — mas o gate não força sequer uma escolha explícita. | **Média** | `config.ts:92`, `stacks.test.ts:586` |
| **B7** | **Deploy manual, da máquina do desenvolvedor, com credenciais ambientes.** Não há pipeline, aprovação, ou segregação de funções. `npm run deploy:no-approval` existe e ignora o gate de aprovação de IAM. | **Média** | `infra/package.json:19-20` |
| **B8** | **Refresh token de 30 dias sem processo de revogação documentado.** Combinado com a nota do `infra/README.md` de que uma mudança de grupo só chega no próximo token, o janelamento de revogação efetiva é longo para dados sensíveis. | **Média** | `auth-stack.ts:236-238` |
| **B9** | **Sem versionamento nem access logging no bucket S3, e sem access logs do CloudFront.** Não há trilha de quem acessou o frontend. | **Baixa** | Síntese: `VersioningConfiguration`, `Logging` = 0 |

### Lacunas de teste relevantes para este nível

- **`AgentStack` é testado apenas por leitura de fonte.** A ausência de `authorizerConfiguration`
  está asserida (`stacks.test.ts:592`), assim como o escopo de ECR e de log groups — mas o stack
  nunca é sintetizado, então as variáveis de ambiente do runtime, a trust policy da execution role e
  o `lifecycleConfiguration` continuam sem cobertura.
- **Nenhum teste dos handlers.** `handler.ts` e `admin-handler.ts` não têm teste algum — apenas seus
  auxiliares puros. Não é testado: o *fail-closed* quando `claims.sub` é ausente
  (`handler.ts:73-78`), nem o **bypass silencioso do rate limit** quando `RATE_LIMIT_TABLE_NAME` é
  vazio (`handler.ts:84`).
- **`infra/lambdas/custom-message/` sem teste**, apesar de estar no caminho crítico de `SignUp` e
  `AdminCreateUser`. O módulo até exporta `resetAppUrlCache` como "test seam" — que nenhum teste usa.
- **Nenhuma medição de cobertura** em nenhum dos quatro `vitest.config.ts`, e nenhum gate de
  cobertura no CI.

### Ações recomendadas — nível 2, por criticidade

| Prio | Ação | Esforço |
|---|---|---|
| **P0** | Adicionar um **Bedrock Guardrail** (filtros de conteúdo + detecção de PII + prompt-attack) como recurso CDK opcional, e torná-lo **obrigatório sob `pilot`/`prod`** no `assertDeploymentPosture`. | M |
| **P0** | Habilitar **X-Ray** (`tracing: lambda.Tracing.ACTIVE`) nas três Lambdas e no stage do API Gateway; instrumentar o contêiner do agente com ADOT/OTel para que as permissões já concedidas passem a ser usadas. Propagar um correlation ID do browser ao agente. | M |
| **P1** | Definir a política de retenção de conteúdo conversacional: ou persistir com criptografia CMK + retenção declarada, ou documentar formalmente a ausência como decisão de privacidade. Hoje é um vazio, não uma escolha. | M |
| **P1** | Mover o runtime AgentCore para VPC com subnets privadas, NAT controlado e VPC endpoints para Bedrock/DynamoDB/Cognito. | M |
| **P1** | Testar os handlers: fail-closed sem claims, bypass do rate limit com tabela ausente, caminho OPTIONS/405, e o `custom-message` completo. | M |
| **P1** | Adicionar CMK para log groups, DynamoDB e SNS; habilitar criptografia do tópico de alarmes. | S |
| **P1** | Exigir `WAF_ENABLED=true` sob `pilot`/`prod` — ou, no mínimo, transformá-lo numa escolha explícita que o gate cobra (aceitar `false` apenas se declarado). | S |
| **P1** | Substituir o deploy manual por pipeline com OIDC (sem chaves de longa duração), `cdk diff` obrigatório em PR e aprovação para `pilot`/`prod`. Ver §6. | M |
| **P2** | Habilitar versionamento e access logging no bucket S3, e access logs no CloudFront. | S |
| **P2** | Medir cobertura (`vitest --coverage`) e definir um piso no CI. | S |
| **P2** | Reduzir a validade do refresh token sob `pilot`/`prod` e documentar o procedimento de revogação (`admin-user-global-sign-out`). | XS |

---

## 5. Veredito nível 3 — Aplicações públicas em produção

### Prontidão: ❌ **Não pronto** (2/5)

O template não afirma estar pronto para isso — o `README.md` é explícito ("é andaime, não um produto
acabado") e nomeia duas decisões deixadas em aberto. A avaliação abaixo confirma essa autoavaliação e
a estende: as lacunas são mais amplas do que as duas declaradas.

### 🔴 Bloqueadores estruturais

| # | Bloqueador | Por que bloqueia | Evidência |
|---|---|---|---|
| **P1** | **Estado conversacional na memória do contêiner.** Perdido em restart, não compartilhado entre réplicas. Com múltiplas réplicas, a continuidade da conversa depende de afinidade de sessão do AgentCore. | Um usuário público perde o contexto sem aviso a cada reciclagem de contêiner | `agent/src/index.ts:9-22` (declarado no README) |
| **P2** | **Sem CD.** Não há workflow de deploy, role OIDC, ambientes protegidos, promoção entre contas, `cdk diff` em PR, detecção de drift ou procedimento de rollback. | Produção pública exige deploy auditável e reversível | `.github/workflows/` contém apenas `ci.yml` |
| **P3** | **Sem domínio próprio nem certificado ACM.** A app serve de `*.cloudfront.net` com o certificado default do CloudFront — cujo piso de protocolo é TLSv1. | Problema de marca, de phishing e de conformidade TLS | Síntese: `ViewerCertificate` e `MinimumProtocolVersion` ausentes |
| **P4** | **Teto de 50 e-mails/dia do mailer default do Cognito.** SES não está conectado (exige domínio verificado + saída do sandbox). | Onboarding público trava no primeiro dia | Documentado em `infra/README.md`, seção "Emails" |
| **P5** | **Sem WAF no CloudFront.** O ACL opcional é `REGIONAL`, associado ao stage do API Gateway; a distribuição do SPA fica descoberta. | Superfície pública sem filtragem de borda | `bff-stack.ts:352` |
| **P6** | **Região única, sem DR.** Não há réplica, backup declarado, RTO/RPO ou runbook. | Sem objetivo de recuperação, não há SLA | Ausência em toda a IaC |
| **P7** | **Sem concorrência reservada nem DLQ em nenhuma Lambda.** Um pico de tráfego pode consumir a concorrência da conta inteira; falhas assíncronas não têm destino. | Falha em cascata e perda silenciosa | Síntese: `ReservedConcurrentExecutions`, `DeadLetterConfig` = 0 |
| **P8** | **Sem retry/backoff nem circuit breaker na chamada ao Bedrock/AgentCore.** Um throttle do Bedrock vira erro 500 direto para o usuário. | `agent-client.ts:57-72` — `client.send()` sem tratamento de throttling |
| **P9** | **Sem SLO, dashboard ou alarme de latência.** Existem 3 alarmes, todos de erro (`threshold: 1`), nenhum de latência, throttle, erro de Bedrock ou rejeição de cota. | Não é possível operar contra um objetivo | `bff-stack.ts:261-286` |
| **P10** | **Sem teste de carga ou de desempenho.** Nenhuma linha de base de latência de primeiro token, throughput ou custo por conversa. | Capacidade e custo em escala são desconhecidos | Ausência em todo o repositório |
| **P11** | **Sem moderação de saída nem avaliação de qualidade.** Nenhum eval suite, nenhum teste de regressão de comportamento do modelo, nenhum versionamento do prompt do sistema. | Uma app pública responde a desconhecidos sem rede de proteção | `agent/src/agent.ts:22-50` |

### Riscos adicionais de escala e custo

- **Contexto cresce sem limite dentro de uma sessão.** Não há teto de turnos nem de tokens por
  conversa. Com TTL de 30 minutos e cota de 20 req/min, uma sessão pode acumular contexto muito
  grande — e cada turno reenvia o contexto inteiro, tornando o custo **superlinear por sessão**.
  Não há métrica que revele isso acontecendo.
- **`evictStaleSessions()` é O(n) sobre todo o mapa a cada requisição** (`agent/src/index.ts:17-22`).
  Com muitas sessões ativas por contêiner, isso vira trabalho por requisição proporcional ao número de
  sessões.
- **Sem telemetria de tokens ou atribuição de custo.** `cloudwatch:PutMetricData` é concedido ao
  runtime (`agent-stack.ts:123-133`) e nunca chamado. Não é possível responder "qual usuário gastou o
  orçamento" nem "quanto custa uma conversa".
- **O budget mede a conta inteira, não o projeto** — apesar de se chamar `${projectName}-monthly`.
  Não há `costFilters` no `CfnBudget` (`bff-stack.ts`). Em conta dedicada — que é para onde
  `DEPLOY_ACCOUNT` empurra um piloto — dá no mesmo; em conta compartilhada, um teto abaixo do que a
  conta já gasta alerta em 100% todo dia até alguém silenciar. A tag `Project` agora existe em todo
  recurso taggável (`app.ts`), o que torna o escopo *possível*, mas filtrar por uma tag ainda não
  ativada no Billing faz o budget medir zero e nunca disparar — troca de um modo de falha barulhento
  por um silencioso. Decisão pendente, não defeito.
- **O budget é *account-wide***, não escopado por tag ou serviço, e só alerta — não contém gasto.
  O escopo agora está dito em `.env.example`, no `infra/README.md` e no próprio stack; antes só o
  comentário do `bff-stack.ts` mencionava, enquanto o nome do recurso sugeria o contrário.
- **Sem tratamento de idempotência** em requisições de chat retentadas: um retry do cliente gera nova
  invocação (e novo custo de tokens).
- **Sem graceful shutdown no contêiner do agente.** Não há handler de `SIGTERM`, nem `HEALTHCHECK` no
  Dockerfile — requisições em voo são cortadas na reciclagem.
- **Erros do chat não são localizáveis.** O contrato de `ErrorCode` (`chatbot-bff/src/errors.ts`)
  existe e é usado nas rotas admin, mas o handler de chat emite prosa em inglês crua
  (`handler.ts:89`, `:154`). O `retryAfterSeconds` é **enviado pelo BFF e ignorado pelo frontend**.

### Ações recomendadas — nível 3, por criticidade

| Prio | Ação | Esforço |
|---|---|---|
| **P0** | Substituir o armazenamento de sessão em memória pelo `SessionManager` do Strands SDK sobre store persistente (DynamoDB), com criptografia e retenção declaradas. | M |
| **P0** | Construir o pipeline de CD: OIDC, `cdk diff` em PR, ambientes protegidos, promoção dev→stage→prod, rollback documentado. Considerar CDK Pipelines. | L |
| **P0** | Domínio próprio + certificado ACM + `MinimumProtocolVersion: TLSv1.2_2021`; WAF também no CloudFront. | M |
| **P0** | Conectar SES (identidade de domínio verificada, DKIM, saída do sandbox) — o caminho já está documentado em `infra/README.md`. | M |
| **P0** | Guardrails do Bedrock **obrigatórios** + moderação de saída (herda de B1, §4). | M |
| **P1** | Retry com backoff exponencial e jitter na chamada ao AgentCore; tratar `ThrottlingException` do Bedrock distintamente de erro genérico. | S |
| **P1** | Concorrência reservada nas Lambdas; DLQ onde aplicável. | S |
| **P1** | Dashboard CloudWatch + SLOs + alarmes de latência (p99), throttles, erros do Bedrock e taxa de rejeição de cota. | M |
| **P1** | Métricas de negócio via EMF: tokens de entrada/saída por invocação, custo estimado por `sub`, invocações por ferramenta, duração de turno. | M |
| **P1** | Teto de turnos/tokens por sessão e truncamento/sumarização de contexto. | M |
| **P1** | Eval suite para o agente (casos de regressão de comportamento) + versionamento do prompt do sistema. | L |
| **P2** | Decidir o escopo do budget (conta vs. tag `Project`, com a ativação no Billing como pré-requisito); AWS Cost Anomaly Detection. | S |
| **P2** | Estratégia de DR: backup do user pool, RTO/RPO declarados, runbook de incidente. | M |
| **P2** | Teste de carga com linha de base de latência de primeiro token e custo por conversa. | M |
| **P2** | Unificar o contrato de erro: fazer `/chat` emitir `{ code, error }` como as rotas admin, e o frontend consumir `retryAfterSeconds`. | S |
| **P2** | `SIGTERM` handler + `HEALTHCHECK` no contêiner do agente. | XS |
| **P3** | Trocar as Lambdas para `arm64` (Graviton) — ~20% mais barato pelo mesmo perfil de carga. | XS |

---

## 6. Avaliação por dimensão — detalhamento

### 6.1 Arquitetura — 4,5/5

**Forças.** Quatro stacks com fronteiras nítidas e dependências unidirecionais e justificadas
(`infra/README.md`, seção "Stacks"): `agent` antes de `bff` porque a role do BFF é escopada ao ARN do
runtime; `bff` antes de `frontend` porque o `config.js` carrega a URL da API. O ciclo
`auth ↔ frontend` (o trigger de e-mail precisa da URL do app, que só existe depois do frontend) é
quebrado por um parâmetro SSM lido em *runtime*, não em síntese (`frontend-stack.ts:213`,
`auth-stack.ts:176-211`) — solução limpa e corretamente documentada.

A decisão central — BFF como único transporte — é coerente do IaC ao frontend, e a justificativa
(`README.md`, "Why the BFF is the only transport") é o melhor texto do repositório: identifica que o
bloco de identidade é *texto puro* e portanto só é confiável na medida do transporte que o carregou.

O padrão de duas Lambdas (chat sem privilégios, admin com privilégios) é explicitamente apresentado
como o modelo a copiar (`bff-stack.ts:193-196`) — um template que ensina, não só que funciona.

**Fraquezas.**
- `AgentStack` sem cobertura de teste (§4).
- Sem VPC em lugar algum — o template *espera* que ferramentas alcancem backends
  (`agent-stack.ts:167-169`) mas não mostra o padrão de rede para isso.
- Sem estratégia multi-conta/multi-ambiente além de `PROJECT_NAME` + perfil.
- O bloco de identidade não tem integridade em banda (assinatura/HMAC). O código reconhece isso
  (`agent/src/caller.ts:6-9`) e mitiga por transporte — defensável, mas significa que a fronteira de
  confiança depende de o IAM permanecer correto para sempre, sem detecção in-band.

### 6.2 Qualidade de código — 4,5/5

TypeScript `strict` em toda parte (`tsconfig.base.json`), ESLint com `tseslint.configs.strict`.
Separação consistente entre lógica pura e I/O — `admin.ts` vs `admin-handler.ts`, `config.ts` vs
`app.ts`, `caller.ts` vs `index.ts` — que é precisamente o que torna a suíte de testes possível sem
mocks pesados.

Os comentários explicam o *porquê* num nível muito acima da média, e **verifiquei diversos deles
contra o código**: são precisos. Exemplos de raciocínio genuinamente não óbvio, corretamente
registrado:
- Por que o `BedrockModel` é compartilhado mas o `Agent` não é (`agent/src/agent.ts:4-8`, `:52-59`).
- Por que o stream inteiro é consumido *dentro* do escopo do `AsyncLocalStorage`
  (`agent/src/index.ts:58-60`).
- Por que o atributo não pode se chamar `locale` (`auth-stack.ts:104-107`) — colisão com atributo
  padrão reservado, e porta de mão única.
- Por que dois `BucketDeployment` com `cache-control` opostos (`frontend-stack.ts:161-167`).

Riscos de duplicação são tratados explicitamente: o formato de fio do bloco de identidade é asserido
literalmente nos dois lados (`chatbot-bff/src/session-context.ts:5-7`), porque os pacotes não podem se
importar.

**Defeitos encontrados** (todos menores, nenhum de segurança):

| Defeito | Local |
|---|---|
| `resetAppUrlCache` exportado como "test seam" sem nenhum teste que o use | `infra/lambdas/custom-message/index.mjs:35` |
| Caminho de chat não usa o contrato `ErrorCode` que as rotas admin usam | `handler.ts:89`, `:154` vs `errors.ts` |
| `retryAfterSeconds` enviado e ignorado | `handler.ts:90` vs `ChatExperience.tsx:147` |
| Sem limite de caracteres no cliente correspondente ao servidor | `http.ts:80` |
| `local.ts` duplica o laço de streaming do `handler.ts` em vez de compartilhá-lo | `local.ts:83-113` |

### 6.3 Testes e quality gates — 3,5/5

**249 testes, todos passando**, ~28% do LOC total. A qualidade é excepcional: os testes asseguram
*invariantes com o modo de falha declarado*, não implementação. Destaques:

- `gates every method on the API behind the Cognito authorizer` (`stacks.test.ts:382`) **enumera**
  todos os métodos do template em vez de listar rotas conhecidas — uma rota nova nasce coberta.
- `keeps every privileged grant off the function that relays model output` (`:399`) faz assertiva
  **exaustiva** do conjunto de ações, não uma checagem de ausência.
- `never puts a phone number in the schema, in any configuration` (`:528`) protege contra um modo de
  falha real e específico do Cognito (adicionar atributo padrão a um pool vivo quebra o deploy).

**Lacunas** (repetidas de §4, consolidadas):

| Lacuna | Impacto |
|---|---|
| `AgentStack` nunca sintetizado — env vars do runtime, trust policy e lifecycle sem cobertura (a ausência de `authorizerConfiguration` **está** asserida por leitura de fonte) | Médio |
| Nenhum teste de handler (`handler.ts`, `admin-handler.ts`) | Alto |
| `infra/lambdas/custom-message/` sem teste, no caminho crítico de sign-up | Médio |
| Sem testes de componentes React (declarado como deliberado em `chatbot-frontend/vitest.config.ts`) | Médio |
| Nenhum teste de integração ou E2E | Médio |
| Sem medição nem gate de cobertura | Médio |
| Sem teste de carga | Médio (nível 3) |

### 6.4 Segurança — 4,0/5

Coberta em detalhe em §4. Resumo dos controles **presentes e verificados**: ausência de identity pool
(asserida), IAM de menor privilégio com escopo por recurso, separação de privilégios entre funções
(asserida exaustivamente), namespacing de sessão por hash do `sub`, recheck de grupo server-side, CSP
sem `unsafe-inline` em `script-src`, HSTS com preload, `frame-ancestors 'none'`, OAC (não OAI) no S3,
bucket privado, auditoria estruturada incluindo negativas, e supply chain de CI acima da média
(actions fixadas por SHA, `persist-credentials: false`, `permissions: contents: read`, timeout,
audit gate em `high` — com a justificativa correta de por que `critical` seria insuficiente).

**Ausentes**: guardrails de conteúdo, CMK, isolamento de rede, WAF obrigatório, TLS mínimo, scanning
de imagem (ECR scan-on-push não habilitado), SBOM, scanning de IaC (cdk-nag),
`PublicAccessBlockConfiguration` fixado no bucket (ausência deliberada e documentada em
`frontend-stack.ts:58-59` por conta de SCPs — mas o controle não fica no template).

Nota: `NODE_TLS_REJECT_UNAUTHORIZED=0` aparece comentado em dois `.env.example`, com avisos fortes e
corretos sobre o escopo de processo inteiro. Aceitável, mas presente.

### 6.5 Infraestrutura AWS — 4,0/5

Tudo em CDK, sem passos de console. Nomeação a partir de uma variável. Políticas de remoção
raciocinadas (`RETAIN` por default no user pool e no bucket; `DESTROY` na tabela de contadores, com a
justificativa correta de que são contadores descartáveis). O split de `cache-control` entre os dois
`BucketDeployment` — com teste — é um detalhe que a maioria dos templates erra.

Faltam: VPC, endpoints e uma estratégia multi-conta.

### 6.6 Observabilidade — 2,0/5

**Presente:** 3 alarmes CloudWatch com tópico SNS; access logs do API Gateway com `requestId`,
`sub`, status, latência e IP, sem corpo; retenção de 30 dias em todos os log groups (com a
justificativa de que 7 dias não sobrevive a um incidente descoberto depois de um fim de semana);
auditoria JSON estruturada nas rotas admin.

**Ausente** — confirmado por inspeção do template sintetizado:

| Propriedade | Ocorrências na síntese |
|---|---|
| `TracingConfig` (X-Ray nas Lambdas) | 0 |
| `TracingEnabled` (X-Ray no stage) | 0 |
| `ContributorInsights` | 0 |
| Dashboard CloudWatch | 0 recursos |
| Métricas customizadas / EMF | 0 chamadas no código |

Somando: sem tracing, sem dashboard, sem métricas de negócio, sem correlation ID, sem log
estruturado no caminho de chat (apenas `console.error` cru — `handler.ts:151`), sem métricas de
tokens ou de invocação de ferramenta, sem alarmes de latência/throttle/Bedrock. **Esta é a dimensão
mais fraca junto com governança de IA, e é a que mais separa o nível 2 do nível 1.**

### 6.7 Resiliência — 2,0/5

**Presente:** o trigger `CustomMessage` nunca lança, degradando para o template plain-text em vez de
bloquear o sign-up (`index.mjs:90-94`) — decisão correta e bem justificada; o convite admin cai para
o caminho sem atributo de locale se o pool não o tiver (`admin-handler.ts:143-158`); o parser de
stream ignora eventos desconhecidos em vez de falhar; `complete()` é idempotente
(`stream-parser.ts:114-123`); evicção por TTL das sessões.

**Ausente:** retry/backoff, circuit breaker, DLQ, concorrência reservada, `SIGTERM`, `HEALTHCHECK`,
DR, idempotência de retry, e — o item de maior impacto — persistência do estado conversacional.

### 6.8 Escalabilidade — 2,5/5

A camada Lambda/DynamoDB/CloudFront escala naturalmente; `PAY_PER_REQUEST` é a escolha certa para
contadores. Os tetos (10 rps de stage, 20/60s por usuário) são deliberados, documentados e fáceis de
elevar.

Os limitantes reais são o agente (estado por contêiner, evicção O(n), afinidade de sessão do
AgentCore) e o mailer do Cognito (50/dia).

### 6.9 Desempenho — 3,5/5

**Bom:** `BedrockModel` no escopo de módulo (pool de conexões compartilhado) pareado com `Agent`
por requisição (evita vazamento de estado entre chamadores) — o par correto, e não óbvio, com o
raciocínio registrado; streaming fim a fim (Lambda response streaming → SSE → markdown incremental);
`AgentMarkdown` carregado sob demanda; assets com hash de conteúdo e `immutable`; compressão no
CloudFront; imagem ARM64.

Bundle de produção: 403,8 KB JS (123,5 KB gzip) + 158,3 KB do chunk de markdown (48,0 KB gzip) +
22,1 KB CSS. Aceitável.

**Não medido:** nada. Sem orçamento de performance, sem linha de base de latência de primeiro token,
sem mitigação de cold start. As Lambdas são `x86_64` com 512/256 MB — sem justificativa registrada e
sem medição que a suporte.

### 6.10 CI/CD — 2,5/5

O CI é genuinamente bom **no escopo que cobre**, e a higiene de supply chain é superior à média:
actions fixadas por SHA de commit (com o comentário explicando que uma tag é um ponteiro mutável),
`persist-credentials: false`, `permissions: contents: read` no topo, `timeout-minutes: 20`, e gate de
audit em `high` com justificativa explícita.

Mas: **não há CD**, a governança de repositório é incompleta (sem LICENSE, CODEOWNERS,
SECURITY.md, CONTRIBUTING, template de PR — o Dependabot está configurado), e o CI
**nunca roda `cdk synth`** — de modo que
uma alteração que quebre a síntese no `app.ts`, onde vive o gate de perfil, passa no CI. O comentário
do workflow justifica isso como fronteira de credenciais; a justificativa vale para o `AgentStack`
(build Docker real), mas os outros três stacks sintetizariam sem credenciais.

### 6.11 Governança de IA — 2,0/5

**Presente, e forte:** a regra "nenhuma tool aceita user id" asserida sobre todo o toolset; identidade
apenas de claims verificadas; prompt do sistema instruindo o modelo a nunca aceitar afirmação de
identidade vinda da conversa (`agent.ts:26-30`); `<thinking>` removido da saída visível
(`stream-parser.ts:17-95`); modelo fixado por ID em um único lugar compartilhado entre configuração e
IAM (`config.ts:358-367`); tetos de entrada em duas camadas (`http.ts:80` = 8.000 chars no BFF,
`limits.ts:7` = 20.000 chars no runtime, com a justificativa de defesa em profundidade).

**Ausente:** guardrails de conteúdo/PII/prompt-attack, moderação de saída, eval suite, testes de
regressão de comportamento, versionamento de prompt, procedimento de troca de modelo, registro
auditável de prompts e respostas, human-in-the-loop para ações consequentes, política de retenção de
conteúdo, model card / política de uso aceitável, teto de turnos por conversa.

### 6.12 Otimização de custos — 3,0/5

**Presente:** Bedrock escopado a um modelo (fronteira de custo tanto quanto de segurança); throttle de
stage; cota por usuário; tetos de entrada; budget opcional com alertas em 80% e 100%; ARM64 no agente;
`PAY_PER_REQUEST`; `PriceClass_100`; o aviso de que threat protection move o pool para o plano Plus
faturado por MAU — exatamente o tipo de alerta que templates omitem; e o teste
`costs nothing and changes nothing when no profile is set` como garantia de que um upgrade do
template não aparece como custo novo.

**Ausente:** telemetria de tokens, atribuição de custo por usuário/sessão, teto de turnos (custo
superlinear por sessão), tags de alocação de custo (apenas o runtime tem tag), budget escopado,
anomaly detection, concorrência reservada como teto de gasto de pior caso, e `arm64` nas Lambdas.

---

## 7. Backlog consolidado priorizado

Ordenado por criticidade absoluta, atravessando os três níveis.

| # | Ação | Bloqueia nível | Dimensão | Esforço |
|---|---|---|---|---|
| 1 | Bedrock Guardrails (conteúdo + PII + prompt-attack), obrigatórios sob `pilot`/`prod` | 2, 3 | Governança de IA | M |
| 2 | Tracing distribuído (X-Ray/OTel) + correlation ID fim a fim | 2, 3 | Observabilidade | M |
| 3 | Persistir estado conversacional (`SessionManager` sobre DynamoDB) | 3 | Resiliência | M |
| 4 | Pipeline de CD com OIDC, `cdk diff` em PR, ambientes protegidos, rollback | 2, 3 | CI/CD | L |
| 5 | Testes dos handlers (fail-closed, bypass de rate limit, `custom-message`) | 2 | Testes | M |
| 6 | Política de retenção de conteúdo conversacional (persistir com controle, ou declarar formalmente) | 2 | Governança de IA | M |
| 7 | VPC + endpoints + controle de egresso para o runtime | 2 | Infra / Segurança | M |
| 8 | Domínio próprio + ACM + `TLSv1.2_2021` + WAF no CloudFront | 3 | Segurança | M |
| 9 | SES conectado (domínio verificado, DKIM, saída do sandbox) | 3 | Infra | M |
| 10 | Métricas de negócio via EMF: tokens, custo por `sub`, invocações por ferramenta | 2, 3 | Observabilidade / Custos | M |
| 11 | CMK para logs, DynamoDB e SNS | 2 | Segurança | S |
| 12 | WAF obrigatório (ou escolha explícita cobrada) sob `pilot`/`prod` | 2 | Segurança | S |
| 13 | Retry/backoff + tratamento de throttling do Bedrock | 3 | Resiliência | S |
| 14 | Concorrência reservada + DLQ | 3 | Resiliência | S |
| 15 | Dashboard + SLOs + alarmes de latência/throttle/Bedrock | 3 | Observabilidade | M |
| 16 | Teto de turnos/tokens por sessão + truncamento de contexto | 3 | Custos | M |
| 17 | Eval suite + versionamento do prompt do sistema | 3 | Governança de IA | L |
| 18 | `LICENSE`, `SECURITY.md`, `CODEOWNERS`, template de PR | 1, 2 | Governança | S |
| 19 | Cobertura medida com piso no CI; `cdk synth` no CI | 2 | Quality gates | S |
| 20 | Decidir o escopo do budget: conta inteira (hoje) vs. tag `Project` ativada no Billing | 3 | Custos | S |
| 21 | Versionamento e access logging no S3; access logs no CloudFront | 2 | Segurança | S |
| 22 | Unificar contrato de erro em `/chat`; consumir `retryAfterSeconds` | 3 | Qualidade / UX | S |
| 23 | `SIGTERM` + `HEALTHCHECK` no contêiner; Lambdas em `arm64` | 3 | Resiliência / Custos | XS |

---

## 8. O que este template faz melhor que a média da categoria

Registrado por justiça de avaliação — estes são pontos que raramente aparecem em templates
comparáveis:

1. **Propriedades de segurança asseridas contra o template sintetizado**, não apenas documentadas.
   A ausência do identity pool, o conjunto exaustivo de ações da role de chat, e a autenticação de
   *todos* os métodos enumerados são testes que impedem regressão por hábito.
2. **O gate de perfil de deployment.** A observação de que "quem copia o repositório para rodar um
   piloto não é quem leu o comentário" (`config.ts:29-31`) é uma tese correta sobre por que
   documentação falha como controle — e o gate é a implementação certa dessa tese.
3. **O ARN duplo do Bedrock** (`agent-stack.ts:242`) — inference profile *e* foundation model. É um
   detalhe que quase todo mundo erra, e está testado nos dois sentidos.
4. **A regra "nenhuma tool aceita user id"**, asserida sobre todo o toolset, com o ataque concreto
   nomeado. É o controle certo para o risco real de aplicações agênticas.
5. **Higiene de supply chain no CI** acima da média, com o raciocínio registrado em cada decisão.
6. **Honestidade sobre limitações.** A seção "What this template leaves open" nomeia exatamente as
   duas maiores lacunas funcionais. Este assessment as confirma e as estende — mas o template não
   tenta escondê-las.

---

## 9. Limitações deste assessment

- **`AgentStack` não foi sintetizado.** Requer `docker build` real. Suas propriedades foram avaliadas
  por leitura de código, não por inspeção de template — a mesma limitação que a suíte de testes tem.
- **Nenhum deploy foi executado.** Comportamento em runtime (latência real, comportamento do
  AgentCore sob concorrência, entrega de e-mail, eficácia do CSP contra a app real) não foi observado.
- **Nenhum teste de penetração** foi conduzido. As conclusões de segurança derivam de leitura de
  código e IaC.
- **Nenhuma medição de desempenho ou custo** foi feita — as observações dessas dimensões são
  estruturais, não empíricas.
- Este assessment reflete o commit `6ca67f3`, com a revisão registrada abaixo. As referências
  `arquivo:linha` são válidas para esse estado da árvore.

### Revisão — 2026-08-28

Dois apontamentos foram corrigidos no repositório após a primeira emissão e, por isso, não constam
mais das seções acima:

| Apontamento original | Correção aplicada |
|---|---|
| Comentário obsoleto em `infra/.env.example` afirmando que a tela de sign-in não trata o desafio de enrollment TOTP (o que desencorajava a única postura de MFA que o gate de piloto aceita) | Comentário reescrito para descrever o comportamento real: contas sem fator recebem o desafio de setup no próximo sign-in, tratado por `chatbot-frontend/src/lib/auth-steps.ts` |
| Ausência de `authorizerConfiguration` no `AgentStack` não asserida em teste algum | Teste `declares no authorizer configuration on the runtime` adicionado em `infra/src/__tests__/stacks.test.ts:592`, por leitura de fonte — verificado que falha quando a propriedade é introduzida |
| Sem limite de caracteres no cliente correspondente ao `MAX_MESSAGE_LENGTH = 8000` do servidor | `maxLength={8000}` no input do chat (`chatbot-frontend/src/components/ChatExperience.tsx`), com comentário apontando a constante espelhada |
| Tags de alocação de custo ausentes em todo recurso exceto o runtime | `cdk.Tags.of(app)` aplica `Project` (`infra/src/app.ts`); verificado na síntese que alcança todo recurso taggável, incluindo o user pool via `UserPoolTags` |
| Sem Dependabot/Renovate — o gate de `npm audit` reportava sem nada mover as dependências | `.github/dependabot.yml` cobrindo os cinco `package.json` e as GitHub Actions, com minor/patch agrupados |
| Escopo do budget não documentado: o recurso se chama `${projectName}-monthly` mas mede a conta inteira, e nem `.env.example` nem `infra/README.md` diziam isso | Escopo e sua consequência em conta compartilhada documentados nos dois arquivos e no `bff-stack.ts`, junto do porquê de não filtrar por tag |

A contagem de testes nas seções acima (249) já reflete essa revisão.

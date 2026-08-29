# Assessment Técnico — `aws-agentic-app-starter`

**Escopo:** avaliação independente da engenharia do template, desconsiderando o domínio da aplicação.
**Data:** 2026-08-29 · **Commit avaliado:** `c2d05ae` (branch `feat/pilot-enabler`, árvore limpa)
**Emissão original:** 2026-08-28 sobre `6ca67f3` — ver §10 para o que mudou entre as duas.
**Objetivo:** determinar se o template está pronto para acelerar (1) demos, (2) pilotos fechados
inclusive com dados sensíveis, e (3) aplicações públicas em produção.

---

## 1. Resumo executivo

Este é um template acima da média da categoria. A engenharia é deliberada: as decisões de segurança
não estão apenas documentadas — estão **asseguradas por testes contra o template sintetizado**, o que
é raro. O *deployment profile gate* (`infra/src/config.ts`) é uma ideia genuinamente boa e bem
executada: transforma comentários de README em uma build que se recusa a sintetizar.

Desde a emissão original (§10), o template **fechou a maior parte da lacuna de nível 2**: agora há
guardrail de conteúdo do Bedrock, tracing distribuído com correlation ID fim a fim, criptografia com
CMK própria em todos os stores, e estado conversacional durável em AgentCore Memory com retenção e
isolamento por `actorId`. O gate de perfil passou de 6 para 9 regras, incorporando guardrail,
tracing e retenção como *evidence posture*.

O que **ainda** falta para separar "um sistema que funciona" de "um sistema que se opera com dados
sensíveis" é mais estreito: isolamento de rede do runtime (VPC), pipeline de deploy, métricas de
negócio/custo por usuário, e cobertura de teste dos handlers. Nenhum é o buraco largo que a primeira
emissão descreveu.

### Veredito por nível

| Nível | Prontidão | Nota | Síntese |
|---|---|---|---|
| **1. Demos** | ✅ **Pronto** | 5/5 | Um comando de deploy, defaults de sandbox coerentes, zero bloqueadores. |
| **2. Pilotos fechados (dados sensíveis)** | ✅ **Pronto com condições** | 4/5 | O gate cobre acesso *e* evidência (tracing, retenção, guardrail obrigatórios); conteúdo é registrado com CMK. Restam: isolamento de rede do runtime, pipeline de deploy e testes de handler — endereçáveis antes ou logo após o go. |
| **3. Produção pública** | ⚠️ **Parcialmente pronto** | 3/5 | Persistência resolvida. Restam: sem CD, sem domínio/TLS próprio, WAF opcional, sem SLO/dashboard, teto de 50 e-mails/dia do Cognito, sem DR. |

### Notas por dimensão

| Dimensão | Nota | Comentário de uma linha |
|---|---|---|
| Arquitetura | 4,5/5 | Fronteira de confiança clara, coerente e (quase toda) testada; três Lambdas com privilégios separados sobre a memória. |
| Qualidade de código | 4,5/5 | TS estrito, módulos puros separados de I/O, comentários que explicam o *porquê*. |
| Testes e quality gates | 4,0/5 | 319 testes de altíssima qualidade — restam handlers sem teste e nenhuma medição de cobertura. |
| Segurança | 4,5/5 | IAM de menor privilégio real, agora com CMK própria em todos os stores; falta WAF obrigatório e isolamento de rede. |
| Infraestrutura AWS | 4,0/5 | 100% IaC, dependências explícitas, KMS compartilhada entre stacks; sem VPC e sem estratégia multi-conta. |
| Observabilidade | 3,5/5 | X-Ray nas 3 Lambdas + stage, OTel no agente, correlation ID fim a fim, log estruturado. Falta dashboard, SLO e métricas de negócio. |
| Resiliência | 3,0/5 | Estado conversacional agora durável (AgentCore Memory); teto de contexto por sessão. Falta retry, DLQ, concorrência reservada, DR. |
| Escalabilidade | 3,0/5 | Camada serverless escala; o agente já não guarda estado em memória, mas mantém afinidade de sessão do AgentCore. |
| Desempenho | 3,5/5 | Streaming fim a fim e decisões de pooling corretas; nada é medido. |
| CI/CD | 2,5/5 | CI exemplar em higiene de supply chain; CD inexistente; sem governança de repositório. |
| Governança de IA | 3,5/5 | Controle de identidade forte + guardrail (conteúdo/PII/prompt-attack) + registro auditável de conteúdo. Falta eval suite e versionamento de prompt. |
| Otimização de custos | 3,5/5 | Bons tetos preventivos + teto de contexto por sessão; ainda sem instrumentação de consumo real (tokens/custo por `sub`). |

---

## 2. Metodologia e evidências coletadas

Este assessment é baseado em leitura integral do código-fonte (~9.680 LOC em TS/TSX/MJS, dos quais
~2.668 em testes), da documentação (5 READMEs, 4 arquivos `.env.example`) e da IaC, complementada por
execução real:

| Verificação executada | Resultado |
|---|---|
| `npm run verify` (lint + typecheck + test) | ✅ **Exit 0** — 319 testes, todos passando |
| `npm run audit` (`--audit-level=high`) | ✅ **Exit 0** — 1 vulnerabilidade *low* (esbuild, dev-only, Windows); moderadas abaixo do gate |
| Síntese CloudFormation de `auth`, `bff`, `frontend` | ✅ recursos gerados, inspecionados propriedade a propriedade |
| Inventário de propriedades de hardening no template sintetizado | Ver §6.6 |

Distribuição dos testes (HEAD `c2d05ae`): `infra` 97 · `chatbot-frontend` 79 · `chatbot-bff` 107 ·
`agent` 36.

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

### Prontidão: ✅ **Pronto com condições** (4/5)

O template **entende** o problema de piloto melhor que a maioria — o gate de perfil é a prova — e
desde a emissão original passou a **implementar** a camada que faltava. A postura de *evidência* que
a primeira versão apontava como ausente agora existe e é cobrada pelo gate: um piloto com dados
sensíveis consegue responder "o que o agente respondeu" (AgentCore Memory), "por quanto tempo isso é
guardado" (`CONVERSATION_RETENTION_DAYS`, obrigatório) e "qual turno o usuário está reclamando"
(correlation ID fim a fim que alcança o turno gravado).

O que resta para um "go" limpo não é mais uma lacuna de capacidade — é **isolamento de rede do
runtime** (VPC), **um caminho de deploy auditável** e **cobertura de teste dos handlers**. Os três
são endereçáveis; nenhum é o buraco largo da primeira emissão.

### Evidências positivas

**O gate de perfil faz trabalho real** (`infra/src/config.ts`, `assertDeploymentPosture`). Com
`DEPLOY_PROFILE=pilot`, `cdk synth` falha antes de qualquer recurso ser descrito, listando **todas**
as violações de uma vez. São **nove** regras agora — as seis originais de *access posture* mais três
de *evidence posture* acrescentadas desde a emissão original:

- `PUBLIC_SIGNUP_ENABLED` deve ser `false`
- `ALLOWED_ORIGIN` não pode ser `*`
- `ALERT_EMAIL` é obrigatório
- `COGNITO_MFA` deve ser `required`
- `COGNITO_THREAT_PROTECTION` não pode ser `off`
- `RETAIN_DATA` deve ser `true`
- `GUARDRAIL_ENABLED` deve ser `true` — nada mais no stack inspeciona conteúdo, redige PII ou
  reconhece prompt injection *(novo)*
- `TRACING_ENABLED` deve ser `true` — uma resposta errada tem de ser reconstruível pelos três
  runtimes *(novo)*
- `CONVERSATION_RETENTION_DAYS` deve estar setado — conversas são gravadas, então por quanto tempo é
  uma decisão que alguém tem de tomar *(novo)*

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

### ✅ Bloqueadores resolvidos desde a emissão original

Estes eram os bloqueadores da primeira versão. Foram fechados no commit `3ee31cb`
(*"make conversations durable, guarded and traceable"*) e verificados no HEAD:

| # | Risco original | Como foi resolvido | Evidência |
|---|---|---|---|
| **B1** | Nenhum Bedrock Guardrail | `createGuardrail` cria filtros de conteúdo (SEXUAL/VIOLENCE/HATE HIGH, INSULTS/MISCONDUCT MEDIUM), `PROMPT_ATTACK` input-only, e PII `ANONYMIZE` em 9 entidades — **obrigatório sob `pilot`/`prod`** pelo gate. Versão numerada e imutável, pinada pelo runtime. | `agent-stack.ts` `createGuardrail`; `config.ts` regra `GUARDRAIL_ENABLED` |
| **B3** | Nenhum registro do que o agente respondeu | Conversas gravadas em **AgentCore Memory** (`CfnMemory`), com `eventExpiryDuration = CONVERSATION_RETENTION_DAYS` e `encryptionKeyArn` na CMK. Isolamento por `actorId` derivado do namespace da sessão. Um evento por turno; PII já anonimizada é o que se grava. | `agent-stack.ts` `ConversationMemory`; `agent/src/memory.ts` |
| **B4** | Zero tracing distribuído | `TRACING_ENABLED` **obrigatório sob `pilot`/`prod`**: `lambda.Tracing.ACTIVE` nas três Lambdas e `tracingEnabled` no stage. `agent/src/telemetry.ts` registra o provider OTel do SDK. **Correlation ID fim a fim**: minted no browser (`X-Correlation-Id`), propagado como baggage W3C ao runtime e gravado no turno. | `bff-stack.ts` `tracing`; `config.ts` regra `TRACING_ENABLED`; `agent/src/telemetry.ts` |
| **B5** | Nenhuma criptografia com CMK | `kms.Key` própria (`DataKey`) criada no `AgentStack` e compartilhada com o `BffStack`: tabelas DynamoDB `CUSTOMER_MANAGED`, log groups com `encryptionKey`, tópico SNS com `masterKey`, memória e guardrail com a mesma chave. Políticas de chave escopadas por serviço e por conta. | `agent-stack.ts` `DataKey`; `bff-stack.ts` `encryptionKey` |

O bloqueador **P1 de nível 3** (estado conversacional na memória do contêiner) também foi resolvido
pela mesma mudança: o histórico agora é durável, sobrevive a restart, é isolado por `actorId` e tem
teto de contexto por sessão (`MAX_REPLAYED_MESSAGES = 40`), o que endereça parcialmente o custo
superlinear apontado em §5.

### 🔴 Riscos e bloqueadores remanescentes

| # | Risco | Sev. | Evidência |
|---|---|---|---|
| **B2** | **Runtime AgentCore em `networkMode: 'PUBLIC'`** — sem VPC, sem subnets privadas, sem VPC endpoints, sem controle de egresso. Um contêiner comprometido tem saída irrestrita para a internet. É o único bloqueador *estrutural* remanescente do nível 2. O `README.md` agora nomeia isso explicitamente ("The agent runtime has no VPC"). | **Alta** | `agent-stack.ts` `networkConfiguration: { networkMode: 'PUBLIC' }` |
| **B6** | **WAF opcional em todos os perfis, e fora do gate.** É a única camada que filtra **antes** da autenticação. A implementação melhorou (4 managed rule groups + rate limit por IP, todas em `block`), mas `resolveWafEnabled` continua com default `false` e o gate não cobra sequer uma escolha explícita. | **Média** | `config.ts` `resolveWafEnabled`; `bff-stack.ts` `attachWebAcl` |
| **B7** | **Deploy manual, da máquina do desenvolvedor, com credenciais ambientes.** Não há pipeline, aprovação ou segregação de funções. `npm run deploy:no-approval` existe. O CI **explicitamente não roda `cdk synth`** (mantém a fronteira de credenciais), então uma quebra do gate de perfil ainda passa no CI. | **Média** | `.github/workflows/ci.yml`; `infra/package.json` `deploy:no-approval` |
| **B8** | **Refresh token de 30 dias sem processo de revogação documentado.** Combinado com a nota de que uma mudança de grupo só chega no próximo token, o janelamento de revogação efetiva é longo para dados sensíveis. Inalterado. | **Média** | `auth-stack.ts:238` `refreshTokenValidity: Duration.days(30)` |
| **B9** | **Sem versionamento nem access logging no bucket S3, e sem access logs do CloudFront.** Não há trilha de quem acessou o frontend. Inalterado. | **Baixa** | `frontend-stack.ts` — sem `VersioningConfiguration` nem `serverAccessLogs` |

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

As ações P0 da emissão original (guardrail, tracing + correlation ID, política de retenção, CMK) já
foram executadas. O que resta:

| Prio | Ação | Esforço |
|---|---|---|
| **P0** | Mover o runtime AgentCore para VPC com subnets privadas, NAT controlado e VPC endpoints para Bedrock/DynamoDB/Cognito — o único bloqueador estrutural remanescente (B2). | M |
| **P1** | Testar os handlers: fail-closed sem claims, bypass do rate limit com tabela ausente, caminho OPTIONS/405, e o `custom-message` completo. `handler.ts`, `admin-handler.ts` e `conversations-handler.ts` continuam sem teste de handler — só seus auxiliares puros. | M |
| **P1** | Exigir `WAF_ENABLED=true` sob `pilot`/`prod` — ou, no mínimo, transformá-lo numa escolha explícita que o gate cobra (B6). | S |
| **P1** | Substituir o deploy manual por pipeline com OIDC (sem chaves de longa duração), `cdk diff` obrigatório em PR e aprovação para `pilot`/`prod` (B7). Ver §6. | M |
| **P2** | Habilitar versionamento e access logging no bucket S3, e access logs no CloudFront (B9). | S |
| **P2** | Medir cobertura (`vitest --coverage`) e definir um piso no CI. | S |
| **P2** | Reduzir a validade do refresh token sob `pilot`/`prod` e documentar o procedimento de revogação (`admin-user-global-sign-out`) (B8). | XS |
| **P2** | Rodar `cdk synth` (dos três stacks sintetizáveis) no CI, para que uma quebra do gate de perfil não passe. | S |

---

## 5. Veredito nível 3 — Aplicações públicas em produção

### Prontidão: ⚠️ **Parcialmente pronto** (3/5)

O template não afirma estar pronto para isso — o `README.md` é explícito ("é andaime, não um produto
acabado"). Desde a emissão original, o bloqueador de maior impacto (estado conversacional em memória)
foi resolvido, o que sobe a nota. As lacunas remanescentes são de operação em escala pública, não de
correção funcional.

### 🔴 Bloqueadores estruturais

O bloqueador **P1 original — estado conversacional na memória do contêiner — foi RESOLVIDO**: o
histórico vive agora em AgentCore Memory, durável entre restarts e réplicas, isolado por `actorId` e
com teto de contexto por sessão (`agent/src/memory.ts`). Os demais permanecem:

| # | Bloqueador | Por que bloqueia | Evidência |
|---|---|---|---|
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

- **Contexto por sessão agora tem teto — parcial.** `MAX_REPLAYED_MESSAGES = 40`
  (`agent/src/memory.ts`) limita quantas mensagens passadas são reenviadas a cada turno, o que bounda
  o custo superlinear que a emissão original apontava. É um teto, não um sumarizador: além dele os
  turnos mais antigos deixam de ser vistos pelo modelo (mas continuam na memória e no transcript). Um
  teto por *tokens* e sumarização de contexto ainda não existem, e nenhuma métrica revela quando o
  teto é atingido.
- **`evictStaleSessions()` O(n)** deixou de ser um problema no caminho quente: o estado por contêiner
  foi substituído por AgentCore Memory (`agent/src/index.ts` reescrito).
- **Sem telemetria de tokens ou atribuição de custo.** `cloudwatch:PutMetricData` continua concedido
  ao runtime; `agent/src/telemetry.ts` registra o provider OTel do SDK Strands, mas ele só exporta
  quando `OTEL_EXPORTER_OTLP_ENDPOINT` aponta para um collector — que o template não provê. Sem esse
  collector, ainda não é possível responder "qual usuário gastou o orçamento" nem "quanto custa uma
  conversa" a partir de métricas de negócio/EMF.
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
| **✅ feito** | ~~Substituir o armazenamento de sessão em memória por store persistente~~ — resolvido via AgentCore Memory (`agent/src/memory.ts`), com CMK e retenção declaradas. | — |
| **P0** | Construir o pipeline de CD: OIDC, `cdk diff` em PR, ambientes protegidos, promoção dev→stage→prod, rollback documentado. Considerar CDK Pipelines. | L |
| **P0** | Domínio próprio + certificado ACM + `MinimumProtocolVersion: TLSv1.2_2021`; WAF também no CloudFront. | M |
| **P0** | Conectar SES (identidade de domínio verificada, DKIM, saída do sandbox) — o caminho já está documentado em `infra/README.md`. | M |
| **✅ feito** | ~~Guardrails do Bedrock obrigatórios~~ — resolvido (B1). Falta ainda **moderação de saída** dedicada além do guardrail. | — |
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

### 6.3 Testes e quality gates — 4,0/5

**319 testes, todos passando** (infra 97 · frontend 79 · bff 107 · agent 36). A qualidade permanece
excepcional: os testes asseguram *invariantes com o modo de falha declarado*, não implementação. Os
novos cobrem a separação de privilégios entre as três Lambdas sobre a memória, o wire-format do
correlation id, a durabilidade condicional (`memory.test.ts`) e as regras de gate acrescentadas.
Destaques originais mantidos:

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

**Ausentes**: WAF obrigatório, isolamento de rede, TLS mínimo, scanning
de imagem (ECR scan-on-push não habilitado), SBOM, scanning de IaC (cdk-nag),
`PublicAccessBlockConfiguration` fixado no bucket (ausência deliberada e documentada em
`frontend-stack.ts` por conta de SCPs — mas o controle não fica no template). **Guardrails de
conteúdo e CMK deixaram de estar ausentes** (ver B1/B5): há guardrail obrigatório sob `pilot`/`prod`
e uma CMK própria criptografando conversas, tabelas, logs e o tópico de alarmes.

Nota: `NODE_TLS_REJECT_UNAUTHORIZED=0` aparece comentado em dois `.env.example`, com avisos fortes e
corretos sobre o escopo de processo inteiro. Aceitável, mas presente.

### 6.5 Infraestrutura AWS — 4,0/5

Tudo em CDK, sem passos de console. Nomeação a partir de uma variável. Políticas de remoção
raciocinadas (`RETAIN` por default no user pool e no bucket; `DESTROY` na tabela de contadores, com a
justificativa correta de que são contadores descartáveis). O split de `cache-control` entre os dois
`BucketDeployment` — com teste — é um detalhe que a maioria dos templates erra.

Faltam: VPC, endpoints e uma estratégia multi-conta.

### 6.6 Observabilidade — 3,5/5

**Presente:** X-Ray nas três Lambdas e no stage do API Gateway (sob `TRACING_ENABLED`, obrigatório em
`pilot`/`prod`); provider OTel registrado no contêiner do agente (`agent/src/telemetry.ts`);
**correlation ID fim a fim** — minted no browser (`X-Correlation-Id`), propagado como baggage W3C na
invocação do runtime, e gravado no turno em AgentCore Memory, de modo que o id que um usuário cita
localiza o exato exchange; log estruturado JSON no caminho de chat (`logEvent`, `handler.ts`); 3
alarmes CloudWatch com tópico SNS criptografado; access logs do API Gateway (identidade e resultado,
sem corpo); retenção de 30 dias em todos os log groups; auditoria JSON estruturada nas rotas admin.

**Ainda ausente:**

| Propriedade | Estado |
|---|---|
| Dashboard CloudWatch | 0 recursos |
| Métricas de negócio / EMF (tokens, custo por `sub`, invocações por ferramenta) | não emitidas — o provider OTel só exporta com `OTEL_EXPORTER_OTLP_ENDPOINT` + collector externo |
| Alarmes de latência / throttle / erro de Bedrock / rejeição de cota | ausentes (os 3 alarmes são todos de erro) |
| SLO declarado | ausente |

O tracing e o correlation ID fecham o que mais separava o nível 2 do nível 1 na emissão original. O
que resta é a camada de *operação contra um objetivo* (dashboard, SLO, métricas de negócio) — mais
relevante para produção pública que para um piloto fechado.

### 6.7 Resiliência — 3,0/5

**Presente:** **estado conversacional durável** em AgentCore Memory — o item de maior impacto da
emissão original, agora resolvido: o histórico sobrevive a restart e é compartilhado entre réplicas
por `actorId`, não mais preso a um `Map` de contêiner; o trigger `CustomMessage` nunca lança,
degradando para o template plain-text (`index.mjs`); o convite admin cai para o caminho sem atributo
de locale se o pool não o tiver; o parser de stream ignora eventos desconhecidos; `complete()` é
idempotente; a memória degrada para "sem histórico" (não falha) quando `AGENTCORE_MEMORY_ID` está
ausente.

**Ausente:** retry/backoff, circuit breaker, DLQ, concorrência reservada, `SIGTERM`, `HEALTHCHECK`,
DR, e idempotência de retry.

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

### 6.11 Governança de IA — 3,5/5

**Presente, e forte:** a regra "nenhuma tool aceita user id" asserida sobre todo o toolset; identidade
apenas de claims verificadas; prompt do sistema instruindo o modelo a nunca aceitar afirmação de
identidade vinda da conversa; `<thinking>` removido da saída visível; modelo fixado por ID em um
único lugar compartilhado entre configuração e IAM; tetos de entrada em duas camadas (8.000 chars no
BFF, 20.000 no runtime). **Novidades desde a emissão original:** guardrail de conteúdo/PII/prompt-attack
obrigatório sob `pilot`/`prod`, com PII anonimizada antes de gravar; **registro auditável do conteúdo
conversacional** em AgentCore Memory com retenção declarada; **teto de contexto por conversa**
(`MAX_REPLAYED_MESSAGES`).

**Ausente:** moderação de saída dedicada (além do guardrail), eval suite, testes de regressão de
comportamento, versionamento de prompt, procedimento de troca de modelo, human-in-the-loop para
ações consequentes, model card / política de uso aceitável.

### 6.12 Otimização de custos — 3,5/5

**Presente:** Bedrock escopado a um modelo (fronteira de custo tanto quanto de segurança); throttle de
stage; cota por usuário; tetos de entrada; **teto de contexto por sessão** (`MAX_REPLAYED_MESSAGES`,
que bounda o custo superlinear apontado antes); budget opcional com alertas em 80% e 100%; ARM64 no
agente; `PAY_PER_REQUEST`; `PriceClass_100`; tag `Project` em todo recurso taggável; o aviso de que
threat protection move o pool para o plano Plus faturado por MAU; e o teste
`costs nothing and changes nothing when no profile is set`.

**Ausente:** telemetria de tokens e atribuição de custo por usuário/sessão (o provider OTel existe
mas exige collector externo), teto por *tokens*, budget escopado por tag, anomaly detection,
concorrência reservada como teto de gasto de pior caso, e `arm64` nas Lambdas.

---

## 7. Backlog consolidado priorizado

Ordenado por criticidade absoluta, atravessando os três níveis. As linhas ✅ foram concluídas desde a
emissão original e ficam aqui como registro.

| # | Ação | Bloqueia nível | Dimensão | Esforço |
|---|---|---|---|---|
| ✅ | ~~Bedrock Guardrails (conteúdo + PII + prompt-attack), obrigatórios sob `pilot`/`prod`~~ | 2, 3 | Governança de IA | feito |
| ✅ | ~~Tracing distribuído (X-Ray/OTel) + correlation ID fim a fim~~ | 2, 3 | Observabilidade | feito |
| ✅ | ~~Persistir estado conversacional~~ — AgentCore Memory, isolado por `actorId`, CMK, retenção | 3 | Resiliência | feito |
| ✅ | ~~Política de retenção de conteúdo conversacional~~ — `CONVERSATION_RETENTION_DAYS` cobrado pelo gate | 2 | Governança de IA | feito |
| ✅ | ~~CMK para logs, DynamoDB e SNS~~ — uma chave própria compartilhada entre stacks | 2 | Segurança | feito |
| 1 | VPC + endpoints + controle de egresso para o runtime (B2) | 2 | Infra / Segurança | M |
| 2 | Pipeline de CD com OIDC, `cdk diff` em PR, ambientes protegidos, rollback (B7) | 2, 3 | CI/CD | L |
| 3 | Testes dos handlers (fail-closed, bypass de rate limit, `custom-message`, conversations) | 2 | Testes | M |
| 4 | WAF obrigatório (ou escolha explícita cobrada) sob `pilot`/`prod` (B6) | 2 | Segurança | S |
| 5 | Domínio próprio + ACM + `TLSv1.2_2021` + WAF no CloudFront | 3 | Segurança | M |
| 6 | SES conectado (domínio verificado, DKIM, saída do sandbox) | 3 | Infra | M |
| 7 | Métricas de negócio via EMF: tokens, custo por `sub`, invocações por ferramenta (requer collector OTLP) | 2, 3 | Observabilidade / Custos | M |
| 8 | Retry/backoff + tratamento de throttling do Bedrock | 3 | Resiliência | S |
| 9 | Concorrência reservada + DLQ | 3 | Resiliência | S |
| 10 | Dashboard + SLOs + alarmes de latência/throttle/Bedrock | 3 | Observabilidade | M |
| 11 | Teto de tokens por sessão + sumarização de contexto (o teto de mensagens já existe) | 3 | Custos | M |
| 12 | Eval suite + versionamento do prompt do sistema | 3 | Governança de IA | L |
| 13 | `LICENSE`, `SECURITY.md`, `CODEOWNERS`, template de PR | 1, 2 | Governança | S |
| 14 | Cobertura medida com piso no CI; `cdk synth` (dos 3 stacks sintetizáveis) no CI | 2 | Quality gates | S |
| 15 | Decidir o escopo do budget: conta inteira (hoje) vs. tag `Project` ativada no Billing | 3 | Custos | S |
| 16 | Versionamento e access logging no S3; access logs no CloudFront (B9) | 2 | Segurança | S |
| 17 | Unificar contrato de erro em `/chat`; consumir `retryAfterSeconds` no frontend | 3 | Qualidade / UX | S |
| 18 | Reduzir validade do refresh token sob `pilot`/`prod` + procedimento de revogação (B8) | 2 | Segurança | XS |
| 19 | `SIGTERM` + `HEALTHCHECK` no contêiner; Lambdas em `arm64` | 3 | Resiliência / Custos | XS |

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
- Este assessment reflete o commit `c2d05ae` (branch `feat/pilot-enabler`), atualizado a partir da
  emissão original sobre `6ca67f3`. O que mudou entre os dois está registrado em §10. As referências
  a arquivos apontam para símbolos (funções, constructs) em vez de linhas, porque a árvore mudou
  substancialmente entre as duas emissões.

### Verificação executada nesta revisão (HEAD `c2d05ae`)

- `npm run verify` → **exit 0**, 319 testes passando (infra 97 · frontend 79 · bff 107 · agent 36).
- `npm run audit` (`--audit-level=high`) → **exit 0**: 1 vulnerabilidade *low* (esbuild, dev-only,
  Windows) e moderadas abaixo do gate.
- Leitura de fonte confirmando o estado de cada bloqueador: `agent-stack.ts`, `bff-stack.ts`,
  `config.ts`, `app.ts`, `auth-stack.ts`, `frontend-stack.ts`, `agent/src/memory.ts`,
  `agent/src/telemetry.ts`, `chatbot-bff/src/handler.ts`.

### Revisão — 2026-08-28 (sobre `6ca67f3`, emissão original)

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

A contagem de testes nesta revisão de 2026-08-28 era 249. A revisão de 2026-08-29 (§10) reflete o
estado atual (319).

---

## 10. Revisão — 2026-08-29 (`6ca67f3` → `c2d05ae`)

Entre a emissão original e o HEAD atual, o commit `3ee31cb`
(*"make conversations durable, guarded and traceable"*) e os que o seguem fecharam a maior parte dos
bloqueadores de nível 2. Este é o delta, verificado por leitura de fonte e por `npm run verify`/`audit`
(ambos exit 0).

### O que foi resolvido

| Bloqueador original | Estado | Evidência |
|---|---|---|
| **B1** — sem Bedrock Guardrail | ✅ Resolvido | `createGuardrail` (conteúdo + PII `ANONYMIZE` + `PROMPT_ATTACK`), obrigatório sob `pilot`/`prod` |
| **B3** — sem registro do que o agente respondeu | ✅ Resolvido | AgentCore Memory com retenção e CMK; `agent/src/memory.ts` |
| **B4** — zero tracing distribuído | ✅ Resolvido | X-Ray nas 3 Lambdas + stage; OTel no agente; correlation ID fim a fim, obrigatório sob `pilot`/`prod` |
| **B5** — sem CMK | ✅ Resolvido | `DataKey` (KMS) própria compartilhada entre stacks, em conversas, tabelas, logs e tópico |
| **P1 (nível 3)** — estado conversacional em memória | ✅ Resolvido | AgentCore Memory, durável, isolado por `actorId`, teto de contexto por sessão |
| Gate de perfil com 6 regras | ✅ Ampliado para 9 | `GUARDRAIL_ENABLED`, `TRACING_ENABLED`, `CONVERSATION_RETENTION_DAYS` acrescentados |

### O que permanece aberto (nível 2)

| # | Item | Sev. | Necessário para o "go"? |
|---|---|---|---|
| **B2** | Runtime sem VPC (`networkMode: 'PUBLIC'`) | Alta | **Sim** — ver critério abaixo |
| **B7** | Sem pipeline de CD; CI não roda `cdk synth` | Média | Condicional |
| Testes | Handlers sem teste (`handler`, `admin-handler`, `conversations-handler`) | Média | Recomendado |
| **B6** | WAF opcional e fora do gate | Média | Recomendado (piloto fechado) |
| **B8** | Refresh token 30d sem revogação documentada | Média | Recomendado |
| **B9** | S3/CloudFront sem versionamento nem access logs | Baixa | Não |
| Gov. | `LICENSE`/`SECURITY.md`/`CODEOWNERS` ausentes | Baixa | Não (mas trava jurídico do cliente) |
| UX | `/chat` sem `ErrorCode`; `retryAfterSeconds` não consumido no frontend | Baixa | Não |

### Decisão de "go" — piloto fechado com dados sensíveis e usuários reais

O template passou de **condicionalmente pronto (3/5)** para **pronto com condições (4/5)** para este
cenário. Um "go" **claro** depende de três decisões, em ordem de peso:

1. **Isolamento de rede do runtime (B2) — o único bloqueador que não é uma escolha de processo.**
   Enquanto o runtime está em `networkMode: 'PUBLIC'`, um contêiner comprometido tem egresso
   irrestrito. Para um piloto cujo toolset **não faz chamadas de saída** (o caso do template hoje), o
   risco é contível e pode ser aceito *explicitamente e por escrito* como exceção com prazo. No
   momento em que uma tool alcançar qualquer backend, isso vira bloqueador rígido — mover para VPC
   com endpoints antes do go é o caminho seguro.

2. **Caminho de deploy auditável (B7).** Um piloto com dados reais precisa de deploy reversível e
   rastreável. Não exige o pipeline completo antes do go: o mínimo aceitável é **credenciais de
   deploy dedicadas (não pessoais), `cdk diff` revisado antes de cada deploy, e `npm run deploy` com
   aprovação (nunca `deploy:no-approval`)**. O pipeline OIDC completo pode vir logo após.

3. **Confiança no caminho crítico (testes de handler).** Os invariantes de segurança do IaC estão
   testados, mas o *fail-closed* do handler de chat sem `claims.sub` e o *bypass* do rate limit com
   tabela ausente não têm teste. Para dados sensíveis, recomenda-se **cobrir esses dois caminhos
   antes do go** — é esforço baixo e fecha o modo de falha mais consequente do runtime da aplicação.

**Pré-requisitos operacionais do go (independentes de código):** `DEPLOY_PROFILE=pilot` com as 9
regras satisfeitas (o gate garante), `DEPLOY_ACCOUNT`/`DEPLOY_REGION` pinados, `WAF_ENABLED=true`
(fortemente recomendado mesmo sendo opcional), `CONVERSATION_RETENTION_DAYS` acordado com a área de
privacidade, e o `OTEL_EXPORTER_OTLP_ENDPOINT` apontando para um collector se métricas de
tokens/custo forem exigidas no piloto.

**Resumo:** o go é viável. Com WAF ligado e a exceção de rede aceita por escrito (dado que o toolset
não faz egresso), os itens 2 e 3 são a diferença entre um go condicional e um go limpo — ambos de
esforço baixo. B9, governança de repositório e o contrato de erro do `/chat` não bloqueiam este
cenário.

# Assessment técnico independente

**Repositório:** `aws-agentic-payments-starter`  
**Data da avaliação:** 2026-08-27  
**Natureza:** análise independente de código, infraestrutura, configurações, testes e documentação operacional vigente  
**Resultado geral:** adequado somente como acelerador de demos internas e controladas; não adequado, no estado atual, para piloto com dados sensíveis nem para produção pública.

> **Nota de leitura — remediação em andamento.** O corpo deste documento é o registro da avaliação e **não foi reescrito**: cada achado descreve o que foi observado na data acima, e continua descrevendo. O que foi acrescentado é uma linha `Status da remediação` ao fim de cada achado já tratado, mais a [seção 12](#12-estado-da-remediação) com o quadro consolidado. O veredito das seções 5 e 11 **permanece válido**: quatro dos treze bloqueadores de piloto estão fechados, e um assessment não se torna favorável porque parte dele foi endereçada.

## 1. Declaração de independência, escopo e limitações

Este assessment foi construído diretamente a partir do código-fonte, stacks AWS CDK, políticas IAM, manifests e lockfiles, workflow de CI, Dockerfile, testes e documentação técnica atual. Arquivos de assessment anteriores — inclusive `assessment.md`, `ASSESSMENT.md` e variantes — não foram abertos, pesquisados nem usados. Seções documentais declaradas como derivadas de assessment anterior também foram excluídas como fonte de conclusão.

A análise cobriu:

- arquitetura, separação de componentes, trust boundaries e qualidade de software;
- APIs, autenticação, autorização, isolamento entre usuários e comportamento do agente;
- dados sensíveis, privacidade, criptografia, assinaturas, evidência e segredos;
- AWS CDK, IAM, KMS, DynamoDB, Cognito, API Gateway, Lambda, AgentCore, S3 e CloudFront;
- dependências, lockfiles, container, CI/CD e cadeia de suprimentos;
- escalabilidade, idempotência, resiliência, observabilidade, backup e recuperação;
- testes, operação, governança, documentação, onboarding e reutilização.

A avaliação é predominantemente estática. As tentativas de executar `lint`, `typecheck`, testes e `npm audit` nesta sessão não produziram resultados utilizáveis e as repetições não foram autorizadas. Portanto:

- a existência dos testes foi inspecionada, mas não se afirma que a branch atual passa neles;
- não se afirma que as dependências estejam livres de CVEs atuais;
- não foram validados recursos já implantados, configurações externas à árvore, SCPs, CloudTrail organizacional, AWS Config, GuardDuty, conteúdo de segredos, valores reais de `.env`, subscriptions SNS ou controles manuais da conta;
- não foram realizados pentest, DAST, load test, restore test ou teste de interoperabilidade com uma implementação AP2 independente.

Essas limitações reduzem a evidência operacional disponível; elas não invalidam os defeitos concretos identificados no código e no IaC.

## 2. Visão executiva

O repositório tem uma base técnica melhor que a de uma PoC comum. O domínio AP2 está separado de adapters AWS; o agente não recebe uma ferramenta capaz de autorizar pagamento; BFF de chat, administração e checkout são funções distintas; as entidades AP2 têm funções, tabelas, chaves e permissões separadas; há assinaturas ES256/KMS, verificação de audience, expiração e linkage, credential de uso único, rate limiting, redaction de logs, PITR em DynamoDB, CloudFront com OAC/CSP/HSTS e uma suíte relevante de testes negativos.

Esses controles são reais e úteis, mas **não compensam os bloqueadores**:

1. há uma condição de corrida crítica capaz de emitir dois pares de mandatos e executar duas autorizações PSP para uma única confirmação;
2. retry e recuperação do checkout não formam uma saga idempotente; uma operação pode produzir efeito financeiro e permanecer como falha para o usuário;
3. operações de leitura da superfície de consentimento não revalidam ownership;
4. autenticação, step-up e antiabuso têm defaults de demo: signup público, ausência de MFA, senha mínima simples e OTP revelado no exemplo de configuração;
5. o runtime do agente usa rede pública/egress aberto e permissões Bedrock/ECR mais amplas que o necessário;
6. o evidence store não é imutável: `PutItem` sem condição permite overwrite;
7. CI, supply chain, promotion e deploy não oferecem assurance suficiente para dados sensíveis ou produção;
8. não há PSP real, SCA/3DS de issuer, webhooks, captura/refund ou reconciliação;
9. não há estratégia de disaster recovery regional, lifecycle de dados e chaves, nem observabilidade/auditoria operacional completas.

A conclusão sem suavização é: **o repositório demonstra bem conceitos de agentes e pagamentos assinados, mas ainda não constitui uma plataforma de pagamentos operacionalmente segura**.

## 3. Arquitetura e trust boundaries observados

O fluxo principal implementado é:

1. uma SPA React é distribuída por CloudFront a partir de bucket S3 privado;
2. o usuário autentica no Cognito User Pool; não há Cognito Identity Pool nem credenciais AWS no browser;
3. a SPA envia ID token ao API Gateway REST, protegido por Cognito authorizer;
4. o API Gateway encaminha para três Lambdas BFF separadas: chat, administração e checkout;
5. o BFF de chat assina uma identidade curta do usuário em KMS e invoca o Bedrock AgentCore via SigV4;
6. o agente acessa somente Merchant, Consent Session e Credential Provider por Function URLs `AWS_IAM`;
7. o Mandate Authority é separado e só pode ser invocado pelo BFF de checkout;
8. Merchant chama MPP, e MPP chama o Credential Provider para redeem;
9. DynamoDB persiste carts, sessões, mandatos, métodos, credentials, tentativas, evidências e intents;
10. chaves KMS distintas assinam artefatos de Merchant, Consent, CP, MPP e identidade.

A separação reduz blast radius, mas todos os atores permanecem sob a mesma conta, aplicação CDK e domínio administrativo. Portanto, a independência entre Merchant, Consent, CP e MPP é uma separação IAM interna, não independência organizacional ou jurídica.

Evidências centrais: `infra/src/app.ts:31-163`, `infra/src/stacks/bff-stack.ts:78-489`, `infra/src/stacks/agent-stack.ts:63-216`, `infra/src/stacks/ap2-entities-stack.ts:44-283`, `infra/src/stacks/data-stack.ts:24-153` e `infra/src/stacks/security-stack.ts:22-100`.

## 4. Controles positivos comprovados

Os seguintes controles devem ser preservados durante a remediação:

- **Agente sem autoridade de pagamento:** o toolset é propositivo e não expõe assinatura, emissão de mandato ou settlement; o IAM do agente não permite invocar Mandate Authority ou MPP (`agent/src/tools/ap2/tools.ts:1-245`, `infra/src/stacks/ap2-entities-stack.ts:242-273`).
- **Identidade não controlada pelo prompt:** o BFF cria JWS curto com `sub`, assinado por chave KMS própria; entidades verificam essa identidade, e o token é removido antes do prompt chegar ao modelo (`ap2-core/src/domain/identity.ts:26-112`, `agent/src/tools/ap2/caller.ts:1-112`).
- **Autenticação server-side:** API Gateway aplica Cognito authorizer; os handlers falham fechados sem `sub`; administração revalida o grupo `admins` no servidor (`infra/src/stacks/bff-stack.ts:184-385`, `chatbot-bff/src/admin.ts:61-94`).
- **Separação de privilégios:** chat, admin e checkout são funções distintas; somente checkout lê HMAC, envia SMS e alcança a autoridade de consentimento (`infra/src/stacks/bff-stack.ts:78-420`).
- **Criptografia de artefatos:** ES256, KMS P-256, `typ`, `kid`, audience, expiração, canonicalização e hash linkage são verificados no domínio (`ap2-core/src/domain/jws.ts:1-165`, `ap2-core/src/domain/crypto.ts:1-85`, `ap2-core/src/domain/sdjwt.ts:36-351`).
- **Single-use sequencial:** redeem da credential usa atualização condicional `ISSUED → REDEEMED`, e JTIs são consumidos com `attribute_not_exists` (`ap2-core/src/adapters-aws/dynamo-repos.ts:173-248`).
- **Checkout server-authoritative:** valor e cart são obtidos do artefato assinado; o seal vincula sessão, cart hash, valor e usuário; tentativas de OTP são contabilizadas atomicamente (`chatbot-bff/src/ap2-handler.ts:185-424`, `chatbot-bff/src/ap2/intent.ts:1-160`).
- **Minimização de dados de cartão:** PAN/CVV não aparecem no fluxo; referências PSP permanecem no CP; o agente recebe referências opacas.
- **Hardening de frontend:** bucket privado/OAC, HTTPS, HSTS, CSP `script-src 'self'` e frame denial (`infra/src/stacks/frontend-stack.ts:53-148`).
- **Proteção operacional básica:** DynamoDB on-demand e PITR, throttling de API, quotas atômicas por usuário, X-Ray em entidades, logs estruturados com redaction e alarms básicos (`infra/src/stacks/data-stack.ts:24-153`, `chatbot-bff/src/rate-limit.ts:76-116`, `ap2-core/src/log.ts:34-147`).
- **Base de qualidade:** TypeScript strict, ESLint, seis lockfiles npm, `npm ci`, testes de domínio/segurança/IaC e container multi-stage executado como usuário não root (`tsconfig.base.json:2-10`, `package.json:5-17`, `agent/Dockerfile:4-41`).

## 5. Vereditos por cenário

| Cenário | Veredito | Uso seguro hoje | Condições e justificativa |
|---|---|---|---|
| Aceleração de novas demos | **Pronto com restrições** | Demos internas, sandbox, dados sintéticos, sem dinheiro real e com baixa concorrência | Modularidade, onboarding, separação do domínio, IaC e testes aceleram novas demos. A corrida crítica impede afirmar exactly-once; os defaults devem ser tratados como sandbox; distribuição externa é bloqueada pela ausência de licença. |
| Piloto fechado com dados sensíveis | **Não pronto** | Nenhum uso com dados sensíveis antes da remediação mínima | Ownership incompleto, MFA/step-up inadequados, egress do agente, lifecycle de dados, evidence mutável, observabilidade, recovery e release assurance são insuficientes. Se houver dinheiro real, idempotência e ausência de PSP/SCA real são bloqueadores adicionais absolutos. |
| Aplicação pública em produção | **Não pronto** | Não deve ser exposta como serviço público de pagamentos | Há risco crítico de dupla autorização, ausência de saga/reconciliação, autenticação e antiabuso insuficientes, nenhum DR regional, deploy sem gates, supply chain incompleta, ausência de PSP real e interoperabilidade externa não demonstrada. |

### Resposta direta às três perguntas

1. **Está pronto para acelerar a criação de novas demos?** **Pronto com restrições.** Sim para experimentação interna e descartável, desde que não use dados/valor reais nem faça alegações de robustez financeira ou imutabilidade ainda não sustentadas.
2. **Está pronto para pilotos fechados que utilizem dados sensíveis?** **Não pronto.** O fechamento do piloto não elimina riscos de exfiltração, acesso cruzado, retenção, recuperação, takeover, supply chain e auditoria.
3. **Está pronto para uma aplicação pública em produção?** **Não pronto.** O defeito crítico de concorrência, somado às lacunas de pagamento real, segurança operacional e resiliência, proíbe esse uso.

## 6. Sumário dos achados

| Severidade | Quantidade | Interpretação |
|---|---:|---|
| Crítica | 1 | Pode causar autorização/cobrança duplicada e quebra de integridade financeira. |
| Alta | 11 | Bloqueadores de piloto, produção ou reutilização externa; exigem remediação antes do cenário indicado. |
| Média | 9 | Lacunas relevantes de defesa em profundidade, privacidade, operação, capacidade e qualidade. Algumas tornam-se bloqueadoras conforme classificação dos dados ou SLO. |
| Baixa | 4 | Hardening e manutenção recomendados; não impedem isoladamente uma demo interna. |

Legenda de classificação de uso:

- **BD:** bloqueador para demo, sempre ou sob a condição descrita;
- **BP:** bloqueador para piloto com dados sensíveis;
- **BProd:** bloqueador para produção pública;
- **MR:** melhoria recomendada, não bloqueadora no cenário indicado.

## 7. Achados detalhados

### C-01 — Aprovação e pagamento não são atômicos sob concorrência

- **Severidade:** **Crítica**.
- **Problema:** `consent-decision` lê uma sessão `PENDING`, emite e persiste mandatos e só depois grava `APPROVED`. `putSession` e os writes de mandato são incondicionais. Duas confirmações concorrentes podem observar `PENDING` e emitir pares diferentes. No MPP, a idempotency key é consultada antes, mas reservada somente depois de redeem e de `psp.authorize`; dois requests concorrentes podem executar o side effect financeiro antes de um perder a disputa de persistência.
- **Evidência:** `ap2-core/src/handlers/consent-decision.ts:44-81`; `ap2-core/src/domain/entities/consent-mandates.ts:82-177`; `ap2-core/src/adapters-aws/dynamo-repos.ts:99-132,250-287`; `ap2-core/src/domain/entities/mpp.ts:88-105,221-281`; `chatbot-bff/src/ap2-handler.ts:337-451`.
- **Risco real:** dois mandatos, duas credentials e duas autorizações/cobranças para a mesma intenção; receipts divergentes; usuário recebe um resultado enquanto outro se torna canônico; nenhuma compensação automática.
- **Cenários e categoria:** **BD** para demos que aleguem integridade/exactly-once ou admitam cliques/retries concorrentes; **BP** absoluto se houver dinheiro real; **BProd** absoluto. Categoria: integridade financeira, concorrência e idempotência.
- **Correção recomendada:** adquirir lock com `UpdateItem` condicional `PENDING → PROCESSING` antes de assinar; usar operation ID, lease e transições versionadas; persistir resultado recuperável. No MPP, reservar a idempotency key antes de redeem/PSP com estados `IN_PROGRESS/SUCCEEDED/FAILED`, reutilizar a mesma chave no PSP e reconciliar por webhook. Adicionar teste concorrente que prove exatamente uma assinatura efetiva e uma chamada PSP.

- **Status da remediação (2026-08-27):** **Remediado** (ciclo 1). A decisão de consentimento adquire um claim condicional `PENDING → PROCESSING` com lease e `lockOwner` antes de assinar, e o MPP reserva a idempotency key antes do redeem e do PSP. Provado por suíte concorrente em `ap2-core/src/__tests__/concurrency.test.ts`, validada por mutação: sem o claim, dez confirmações simultâneas produzem dois pares de mandatos; sem a reserva, duas credenciais distintas na mesma jornada geram duas chamadas ao PSP.
### A-01 — Retry não é uma saga idempotente e pode ocultar um pagamento concluído

- **Severidade:** **Alta**.
- **Problema:** após timeout, o BFF pode recuperar mandatos já emitidos, mas solicita nova credential para o mesmo Payment Mandate. O CP consome o JTI na primeira emissão e não possui índice idempotente para devolver a credential existente. O BFF não persiste a etapa da saga nem consulta status/receipt antes de repetir. `markSettled` ocorre depois do pagamento e é best-effort.
- **Evidência:** `chatbot-bff/src/ap2/consent-adapter.ts:32-71`; `ap2-core/src/domain/entities/credential-provider.ts:123-180`; `ap2-core/src/adapters-aws/dynamo-repos.ts:135-201,226-248`; `chatbot-bff/src/ap2-handler.ts:387-451`.
- **Risco real:** a autorização pode ocorrer e a intent continuar `pending`; novo clique recebe `REPLAYED`/falha; suporte e usuário não sabem se devem tentar novamente, gerando duplicidade manual ou disputa.
- **Cenários e categoria:** **MR** para demo simples; **BP** se houver transação real; **BProd**. Categoria: recovery, reconciliação e consistência de estado.
- **Correção recomendada:** persistir saga de checkout antes de cada hop; tornar emissão de credential idempotente por hash estável do mandato/payer/journey/MPP; expor status por idempotency key; reconciliar receipts e webhooks antes de declarar falha; implementar compensações e runbook de operação.

- **Status da remediação (2026-08-27):** **Parcialmente remediado** (ciclo 1). Emissão de credencial idempotente pela requisição inteira, estado da saga persistido antes de cada hop, e `/confirm` sobre um intent liquidado responde com o resultado armazenado em vez de 409. Permanece aberto o restante — compensações, reconciliação por webhook — que só é exigível com dinheiro real.
### A-02 — Leituras da superfície de consentimento não aplicam ownership em todas as operações

- **Severidade:** **Alta**.
- **Problema:** somente a criação da sessão resolve obrigatoriamente a identidade do caller. `get_consent_session`, `poll_consent_status` e `get_mandate` aceitam referências e retornam dados sem comparar owner. O agente tem IAM para a função inteira. IDs de sessão são truncados, e o cache de carts no agente é global por `journeyId`, não por caller.
- **Evidência:** `ap2-core/src/handlers/consent-mandates.ts:20-94`; `agent/src/tools/ap2/tools.ts:32-52,196-238`; `infra/src/stacks/ap2-entities-stack.ts:165-176,246-265`; `ap2-core/src/domain/entities/merchant.ts:119-143`.
- **Risco real:** comprometimento do runtime, tool client ou futura exposição indevida pode permitir leitura cross-user de itens, valores, cart e mandatos; o cache pode misturar jornadas entre callers.
- **Cenários e categoria:** **BD** somente para demo compartilhada com dados reais; **BP**; **BProd**. Categoria: autorização por objeto e isolamento de tenant/ator.
- **Correção recomendada:** exigir identity token em toda operação; comparar `session.userId` com `sub` sem fallback; não buscar mandato por ID nu; usar UUID completo e referência vinculada ao owner; eliminar cache global ou chaveá-lo por `sub:journeyId`; adicionar testes negativos cross-user para cada operação.

- **Status da remediação (2026-08-27):** **Remediado** (ciclo 1). `get_consent_session`, `poll_consent_status` e `get_mandate` exigem identity token e comparam `session.userId` com o `sub`, sem fallback; mandato só é alcançável pela sessão que o contém; o cache de carrinhos do agente é keyado por `sub:journeyId` e o id de sessão voltou a UUID completo. Testes negativos cross-user por operação.
### A-03 — Autenticação e step-up têm postura de demonstração

- **Severidade:** **Alta**.
- **Problema:** signup público é default, Cognito não exige MFA, a senha mínima é 8 sem símbolo, e operações abaixo do threshold são confirmadas sem fator adicional. O User Pool não coleta telefone, mas o fluxo seguro de step-up depende de `phone_number`. O `.env.example` liga `OTP_REVEAL_IN_UI=true`, devolvendo o código no mesmo canal autenticado.
- **Evidência:** `infra/src/stacks/auth-stack.ts:56-120,171-190`; `infra/src/config.ts:39-47,103-171,209-282`; `infra/.env.example:15-98`; `chatbot-bff/src/ap2-handler.ts:126-133,218-325`.
- **Risco real:** account takeover permite aprovações e acesso ao histórico; signup em massa contorna quota por `sub` e gera custo; OTP revelado não comprova posse de segundo canal; com reveal desligado, compras acima do threshold ficam indisponíveis sem telefone.
- **Cenários e categoria:** **MR/restrição obrigatória** para demo sandbox; **BP**; **BProd**. Categoria: autenticação forte, fraude e antiabuso.
- **Correção recomendada:** profiles explícitos `demo|pilot|prod`; falhar synth de pilot/prod se signup estiver público, OTP reveal ativo ou MFA ausente; invite-only em piloto; MFA resistente a phishing para admins e step-up transacional para pagadores; Cognito threat protection; políticas de sessão e senha adequadas; limites por IP/device/account.

- **Status da remediação (2026-08-27):** **Parcialmente remediado** (ciclo 2). Perfis `demo|pilot|prod` fazem o `cdk synth` falhar em `pilot`/`prod` com signup público, OTP revelado, origem aberta, MFA fora de `required` ou threat protection desligada. MFA é por app autenticador (TOTP), com o fluxo de enrolamento implementado na tela de login e um painel de adesão voluntária para o modo `optional`. **Aberto:** o step-up transacional não tem canal — nada na aplicação coleta telefone, então checkouts acima do threshold são recusados com `stepUpUnavailable`.
### A-04 — AgentCore tem egress público e IAM mais amplo que o necessário

- **Severidade:** **Alta**.
- **Problema:** o runtime usa `networkMode: PUBLIC`; a role lê qualquer repositório ECR da conta, descreve logs amplamente e invoca qualquer foundation model em qualquer região, além de recursos Bedrock amplos. A entrada continua SigV4-only, o que é positivo, mas não limita egress ou abuso de credencial da role.
- **Evidência:** `infra/src/stacks/agent-stack.ts:63-113,141-148,174-215`.
- **Risco real:** comprometimento do container ou da tool chain permite exfiltração pela internet, enumeração de assets e consumo de modelos não aprovados, com impacto de confidencialidade e custo.
- **Cenários e categoria:** **MR** para demo sem dados reais; **BP**; **BProd**. Categoria: IAM least privilege, network boundary e contenção de workload não confiável.
- **Correção recomendada:** restringir ECR ao repository ARN do asset; restringir Bedrock ao model/inference-profile e região configurados; adotar VPC/private mode e endpoints quando suportado; controlar egress; substituir Function URLs internas por integração privada quando necessário; usar permission boundary/SCP, quotas e alarms de tokens/custo.

- **Status da remediação (2026-08-27):** **Parcialmente remediado** (ciclo 2). IAM restrito: ECR ao ARN do repositório do asset, Bedrock ao modelo configurado (profile e foundation model), `DescribeLogGroups` ao prefixo do runtime. **Aberto:** o egress. O runtime segue em `networkMode: PUBLIC` e a avaliação de modo privado com endpoints não foi feita.
### A-05 — Evidence store não é append-only nem prova independente

- **Severidade:** **Alta**.
- **Problema:** o IAM concede somente `PutItem`, mas o adapter não usa `ConditionExpression`. Em DynamoDB, `PutItem` sobrescreve uma chave existente. Eventos não são assinados individualmente, o sort key usa aleatoriedade fraca para finalidade probatória e o Explorer confia no booleano `verified` armazenado.
- **Evidência:** `ap2-core/src/adapters-aws/evidence-dynamo.ts:16-35`; `infra/src/stacks/ap2-entities-stack.ts:129-151,225-239`; `chatbot-bff/src/ap2-handler.ts:520-568`.
- **Risco real:** uma role writer comprometida pode sobrescrever ou forjar evidência; a trilha serve para diagnóstico, mas não sustenta alegação de WORM, não repúdio ou prova independente em disputa.
- **Cenários e categoria:** **BD** para demo cujo objetivo seja provar imutabilidade; **BP**; **BProd**. Categoria: auditoria, integridade e não repúdio.
- **Correção recomendada:** `attribute_not_exists` em cada append; único serviço de ingestão; eventos assinados e encadeados por hash/sequence; nonce CSPRNG; export contínuo cross-account para S3 Object Lock Compliance ou ledger equivalente; Explorer deve reexecutar verificações criptográficas.

- **Status da remediação (2026-08-27):** **Parcialmente remediado** (ciclo 0). O append passou a ser condicional (`attribute_not_exists(sk)`), então uma segunda escrita na mesma chave é recusada em vez de sobrescrever, e o sufixo do sort key vem de `randomBytes` em vez de `Math.random()`. **Aberto:** eventos assinados e encadeados por hash, export contínuo para armazenamento imutável cross-account, e reverificação criptográfica no Explorer.
### A-06 — CI e cadeia de suprimentos não fornecem assurance suficiente

- **Severidade:** **Alta**.
- **Problema:** o gate de SCA falha somente em severidade `critical`; actions usam tags mutáveis; workflow não declara `permissions`, timeout ou `persist-credentials: false`; installs dos subpacotes executam lifecycle scripts; não há SAST, secret scanning, dependency review, SBOM, scanner de container, assinatura ou proveniência.
- **Evidência:** `.github/workflows/ci.yml:1-39`; `package.json:5-17`; lockfiles dos seis pacotes; `agent/Dockerfile:4-41`. A ausência dos controles foi verificada no inventário da árvore.
- **Risco real:** vulnerabilidade High de runtime pode manter CI verde; action/tag ou install script comprometido executa código no runner; falhas e segredos podem alcançar release sem detecção. Este achado descreve insuficiência do controle, não afirma a existência atual de CVE específica, pois o audit não foi executado.
- **Cenários e categoria:** **MR** para demo local; **BP**; **BProd**. Categoria: supply chain e SDLC.
- **Correção recomendada:** pin de actions por SHA; `permissions: contents: read`; `persist-credentials: false`; SCA de produção em High com exceções expirantes; Dependabot/Renovate; CodeQL/Semgrep; Gitleaks; dependency review; SBOM CycloneDX/SPDX; scan e assinatura da imagem; provenance/attestation; política explícita para lifecycle scripts.

- **Status da remediação (2026-08-27):** **Parcialmente remediado** (ciclo 0). O workflow declara `permissions: contents: read`, `persist-credentials: false`, `timeout-minutes`, e as actions estão pinadas por SHA; o gate de auditoria subiu de `critical` para `high`. **Aberto:** SAST, secret scanning, dependency review, SBOM, scan e assinatura da imagem, e política para lifecycle scripts.
### A-07 — Deploy e segregação de ambientes não têm gates de segurança

- **Severidade:** **Alta**.
- **Problema:** deploys usam `--require-approval never`; não há pipeline de promoção, allowlist de account/region, environment obrigatório, `cdk diff` gateado, ambiente protegido, canary ou rollback coordenado. O stage da API é sempre `prod`, independentemente do ambiente. Deploys parciais podem deixar contratos incompatíveis.
- **Evidência:** `infra/package.json:14-21`; `infra/src/app.ts:31-38`; `infra/src/stacks/bff-stack.ts:175-184`; `.github/workflows/ci.yml:1-39`.
- **Risco real:** mudança de IAM ou recurso destrutivo pode ir para a conta errada sem confirmação; stacks podem ficar em versões distintas; Lambda/SPA são atualizadas sem canary; rollback de uma stack não reverte as anteriores.
- **Cenários e categoria:** **restrição forte** para demo em conta isolada; **BP**; **BProd**. Categoria: change management, segregação e release engineering.
- **Correção recomendada:** mapear `environment → account/region`; contas separadas; pipeline OIDC de menor privilégio; build/synth/diff completo; approval para broadening e GitHub Environment protegido; artefato imutável promovido; Lambda versions/aliases e canary; smoke pós-deploy e rollback coordenado.

- **Status da remediação (2026-08-27):** **Parcialmente remediado** (ciclo 0). `--require-approval never` foi trocado por `broadening` nos três scripts de deploy, e um guard de conta/região falha o synth quando as credenciais não correspondem ao alvo declarado — obrigatório em `pilot`/`prod`. **Aberto:** pipeline de promoção por OIDC, ambiente protegido, `cdk diff` gateado, artefato imutável e rollback coordenado.
### A-08 — Não existe processador real nem ciclo operacional de pagamento

- **Severidade:** **Alta**.
- **Problema:** o contexto instancia `SimulatedPsp`; métodos podem ser provisionados automaticamente com referências sandbox. Não existem issuer challenge/3DS/SCA, webhooks, capture, void, refund, dispute, chargeback, reconciliação ou antifraude real.
- **Evidência:** `ap2-core/src/context.ts:35-58`; `ap2-core/src/domain/entities/credential-provider.ts:303-314`; `infra/src/config.ts:197-241`.
- **Risco real:** o software não processa dinheiro real nem trata estados assíncronos e exceções comuns de pagamentos. Trocar somente o adapter não resolve idempotência, reconciliação ou compliance.
- **Cenários e categoria:** **não bloqueia** demo sandbox; **BP** para qualquer piloto financeiro; **BProd**. Categoria: completude funcional, risco financeiro e integração regulada.
- **Correção recomendada:** adapter PSP real com idempotency key, authorize/capture/void/refund, webhooks assinados e reconciliação; SCA de issuer/network; tokenização; tratamento de disputas; threat model e definição formal de escopo PCI.

### A-09 — Interoperabilidade AP2 externa não está demonstrada e há incompatibilidades

- **Severidade:** **Alta**.
- **Problema:** os SD-JWTs usam payload flat e modelo de disclosure próprio; audience/nonce são tratados no token de emissão, não em apresentação KB-SD-JWT; receipts de decline podem omitir campo de erro esperado. Os testes validam schemas locais e não cobrem interoperabilidade independente nem todas as receipts.
- **Evidência:** `ap2-core/src/domain/sdjwt.ts:86-111,171-223`; `ap2-core/src/domain/entities/mpp.ts:245-259`; `ap2-core/src/__tests__/ap2-conformance.test.ts:43-70,145-166`; schemas em `ap2-core/src/schemas/ap2/`.
- **Risco real:** um verifier externo pode rejeitar mandatos ou receipts; “conformidade” permanece válida somente dentro do ecossistema fechado do repositório.
- **Cenários e categoria:** **MR** para demo monolítica; **BP** se integrar organizações/implementações distintas; **BProd** para qualquer claim de interoperabilidade AP2. Categoria: protocolo e compatibilidade.
- **Correção recomendada:** adotar schemas e envelope oficiais versionados; presentations/KB-SD-JWT quando aplicável; validar todas as receipts; mapear decline para outcome canônico; testes de contrato contra implementação independente e suite oficial.

### A-10 — PITR não constitui estratégia de disaster recovery

- **Severidade:** **Alta**.
- **Problema:** recursos são regionais; não há Global Tables, cópia cross-region/cross-account, AWS Backup/Vault Lock, KMS multi-region, stack secundária, failover DNS, backup de identidade ou restore automatizado testado. `RETAIN` e PITR protegem cenários limitados, não indisponibilidade regional.
- **Evidência:** `infra/src/stacks/data-stack.ts:33-128`; `infra/src/stacks/security-stack.ts:22-100`; `infra/src/stacks/auth-stack.ts:56-120`; `infra/src/app.ts:31-38`.
- **Risco real:** indisponibilidade regional bloqueia autenticação, assinatura e pagamentos; recuperação pode exceder qualquer SLO; Cognito e chaves exigem estratégia própria; erro administrativo ou comprometimento de conta não é resolvido por `RETAIN`.
- **Cenários e categoria:** **MR** para demo; **BP** para dados sensíveis sem RPO/RTO formal e restore testado; **BProd**. Categoria: continuidade, backup e DR.
- **Correção recomendada:** definir RTO/RPO; backups cross-account/cross-region com vault lock; restore automatizado e exercitado; estratégia de identidade; avaliar Global Tables e KMS multi-region; preservar public keys/kids históricos; ambiente secundário e failover testados.

### A-11 — Ausência de licença bloqueia reutilização externa governada

- **Severidade:** **Alta** para o objetivo de starter/reuso; não é uma vulnerabilidade de runtime.
- **Problema:** não há arquivo `LICENSE`, campo `license` nos manifests, política de notices ou inventário de licenças de terceiros.
- **Evidência:** inventário completo da raiz e manifests `package.json`, `ap2-core/package.json`, `agent/package.json`, `chatbot-bff/package.json`, `chatbot-frontend/package.json` e `infra/package.json`.
- **Risco real:** terceiros não possuem concessão clara para copiar, modificar ou redistribuir; times jurídicos podem bloquear adoção, piloto ou publicação do template.
- **Cenários e categoria:** **BD** para demo externa ou reuso entre entidades sem relação jurídica; **BP/BProd** quando distribuição ou sublicenciamento forem necessários; **MR** para uso estritamente interno pelo titular. Categoria: governança e propriedade intelectual.
- **Correção recomendada:** decisão jurídica explícita; adicionar licença SPDX/copyright; campos `license`; THIRD_PARTY_NOTICES e policy/scanner de licenças; documentar se o artefato é template público, código proprietário ou pacote interno.

- **Status da remediação (2026-08-27):** **Aberto** — decisão adiada. A escolha de licença foi explicitamente adiada pelo titular. Bloqueia apenas distribuição ou reutilização externa, não o piloto.
### M-01 — Validação runtime é parcial e baseada em casts

- **Severidade:** **Média**.
- **Problema:** handlers usam casts de body e validam poucos campos; não há schemas runtime estritos e compartilhados para operações internas. IDs, strings, datas, currency, arrays e tamanho total nem sempre são limitados antes da persistência ou de chamadas KMS.
- **Evidência:** `ap2-core/src/http.ts:21-36,109-162`; `ap2-core/src/handlers/merchant.ts:17-78`; `ap2-core/src/handlers/consent-mandates.ts:20-94`; `ap2-core/src/handlers/credential-provider.ts:16-73`.
- **Risco real:** 500s, objetos DynamoDB acima do limite, custo/DoS, dados malformados persistidos e comportamento inesperado sob caller IAM comprometido.
- **Cenários e categoria:** **MR** para demo; pode tornar-se **BP/BProd** conforme exposição. Categoria: AppSec, robustez e API design.
- **Correção recomendada:** Zod/Ajv `.strict()`, limites de bytes/string/arrays, allowlists de formato/enum, validação antes de persistir, respostas 400/422 estáveis e testes de fuzz/property-based nos boundaries.

- **Status da remediação (2026-08-27):** **Remediado** (ciclo 2). Schemas estritos, sem dependências externas, nos seis handlers de entidade: envelope, identificadores, contagens e limites de bytes, com rejeição de campos desconhecidos e teto de corpo. Os mandatos são deliberadamente limitados e não redescritos — a assinatura sobre a forma canônica é a verificação mais forte, e uma segunda definição divergiria dela. `record_evidence`, que gravava o corpo inteiro no DynamoDB, passou a montar o registro a partir de campos nomeados.
### M-02 — Lifecycle, minimização e criptografia de dados não têm política completa

- **Severidade:** **Média**, podendo ser alta conforme classificação/regulação.
- **Problema:** mandates, attempts e evidence podem reter artefatos e histórico sem política diferenciada; não há delete/anonymize/DSAR/legal hold; logs guardam identificadores por um mês; tabelas e logs usam criptografia gerenciada padrão, sem CMKs de dados explicitamente segregadas.
- **Evidência:** `ap2-core/src/domain/entities/consent-mandates.ts:105-177`; `ap2-core/src/domain/ports.ts:25-48`; `infra/src/stacks/data-stack.ts:24-153`; `infra/src/stacks/bff-stack.ts:129-178`.
- **Risco real:** retenção excessiva de compras e consentimento, incapacidade de atender eliminação/minimização, blast radius administrativo maior e possível não conformidade.
- **Cenários e categoria:** **MR** para demo descartável e sintética; **BP** até existir política compatível; **BProd** quando exigido por privacidade/compliance. Categoria: privacy e data governance.
- **Correção recomendada:** classificação e data inventory; TTL/archive por finalidade; workflows de export/delete/anonymize/legal hold; CMKs onde requeridas; documentação de subprocessors; teste periódico de eliminação e restauração.

### M-03 — Observabilidade, auditoria operacional e resposta a incidentes são incompletas

- **Severidade:** **Média**.
- **Problema:** alarms cobrem essencialmente erros de Lambda e 5xx; destinatário e budget são opcionais; logs têm um mês e `DESTROY`; AgentCore não recebe log group com retenção controlada; faltam CloudTrail organizacional, archive central, dashboards e alarms de latency/throttle/concurrency/KMS/Dynamo/AgentCore/SNS.
- **Evidência:** `infra/src/stacks/bff-stack.ts:126-178,438-505`; `infra/src/stacks/ap2-entities-stack.ts:65-109`; `infra/src/stacks/agent-stack.ts:80-113`; `infra/.env.example:32-41`.
- **Risco real:** abuso bem-sucedido não dispara alarm; falha pode não chegar a ninguém; após 30 dias faltam dados forenses; custo e saturação são detectados tarde.
- **Cenários e categoria:** **MR** para demo; **BP/BProd** conforme requisitos de detecção e resposta. Categoria: observabilidade, forense e operação.
- **Correção recomendada:** contato on-call obrigatório em pilot/prod; métricas/SLO e dashboards; alarms de p95/p99, duration, throttles, concurrency, 4xx/429, spend e delivery; CloudTrail multi-region e archive imutável cross-account; retenção por classe; runbooks e exercícios.

### M-04 — API pública não tem WAF e os defaults favorecem abuso

- **Severidade:** **Média**.
- **Problema:** API Gateway é público; CORS default é `*`; não há WAF/WebACL, bot control, CAPTCHA ou resource policy. Throttle global e quota por usuário reduzem custo, mas signup público permite múltiplas contas e CORS não é controle de autorização.
- **Evidência:** `infra/src/stacks/bff-stack.ts:175-248`; `infra/src/config.ts:91-127`; `chatbot-bff/src/http.ts:14-33`.
- **Risco real:** automação de signup e requests aumenta custo Bedrock/SMS e pressão sobre Cognito/API; ataques L7 não são filtrados por managed rules.
- **Cenários e categoria:** **MR** para demo fechada; **BP** se internet-exposta; **BProd** como parte do hardening mínimo. Categoria: edge security e antiabuso.
- **Correção recomendada:** origem exata fora de demo; WAF managed e rate-based rules; proteção de signup; quotas por IP/device/account e custo; custom domain/TLS policy; monitoramento 4xx/429 e criação de usuários.

- **Status da remediação (2026-08-27):** **Parcialmente remediado** (ciclo 2). CORS com origem exata é exigido pelo portão em `pilot`/`prod`. O web ACL — managed rule groups mais regra de taxa por IP — está implementado e testado, porém **desligado por padrão em todos os perfis e fora do portão**, por decisão de custo do titular: um portão que força gasto recorrente é contornado. Ligar é uma variável de ambiente; a decisão permanece do operador.
### M-05 — O gate não valida todos os artefatos nem a experiência end-to-end

- **Severidade:** **Média**.
- **Problema:** `verify` não executa build/synth completo; CI exclui AgentStack/container; não há coverage threshold; frontend testa bibliotecas em ambiente Node, não componentes renderizados; não há browser E2E, smoke AWS ou teste real SigV4/AgentCore.
- **Evidência:** `package.json:9-17`; `.github/workflows/ci.yml:1-39`; `infra/src/__tests__/stacks.test.ts:1-13`; `chatbot-frontend/vitest.config.ts:3-9`; 32 arquivos de teste inspecionados nos cinco pacotes.
- **Risco real:** PR verde pode quebrar imagem, CDK asset, wiring de autenticação/checkout, acessibilidade ou contrato cloud; contagem de testes não prova cobertura dos caminhos críticos.
- **Cenários e categoria:** **MR** para demo; **BP/BProd** para release assurance. Categoria: testes e qualidade de entrega.
- **Correção recomendada:** build dos quatro artefatos e full synth; Docker build/smoke; coverage por pacote e branch crítica; Testing Library e Playwright; contract tests BFF↔Agent↔entidades; ambiente efêmero e canário pós-deploy.

### M-06 — Lifecycle de chaves e modelo de confiança não suportam operação multi-organização

- **Severidade:** **Média**, alta para ecossistema externo.
- **Problema:** `kid` é estático por papel; não há versão, JWKS/trust registry histórico, revogação ou runbook de comprometimento. Todos os atores e chaves estão na mesma conta e sob o mesmo operador.
- **Evidência:** `infra/src/stacks/security-stack.ts:22-100`; `infra/src/stacks/ap2-entities-stack.ts:44-239`; `ap2-core/src/domain/jws.ts:43-75`; `ap2-core/src/domain/identity.ts:36-67`.
- **Risco real:** rotação pode quebrar verificação histórica; comprometimento do plano administrativo afeta todos os papéis; assinaturas não provam independência organizacional.
- **Cenários e categoria:** **MR** para demo; **BP** dependendo do trust model; **BProd** para multi-organização. Categoria: crypto lifecycle e segregação de funções.
- **Correção recomendada:** `kid` versionado/URI, JWKS e trust list histórica; política de rotação/revogação; preservação de public keys; contas/organizações separadas, SCPs e aprovação independente para alterações de chave/grants.

### M-07 — Há outras transições e contexto conversacional suscetíveis a regressão/forja

- **Severidade:** **Média**.
- **Problema:** criação de intent usa write incondicional e pode substituir estado resolvido por `pending`; eventos de sistema são concatenados como texto no prompt e podem ser imitados pelo usuário.
- **Evidência:** `chatbot-bff/src/ap2-handler.ts:218-325`; `chatbot-bff/src/ap2/intent-store.ts:72-83`; `chatbot-frontend/src/components/ChatExperience.tsx:20-39,130-151`; `agent/src/agent.ts:67-74`.
- **Risco real:** histórico regressivo, checkout impossível de reconciliar e modelo declarando pagamento/decline com base em evento textual forjado. Os controles determinísticos ainda impedem settlement somente por prompt, limitando a severidade.
- **Cenários e categoria:** **MR** em todos; **BProd** se estado conversacional for apresentado como prova. Categoria: state machine e prompt/context integrity.
- **Correção recomendada:** put/transição condicional versionada; endpoint idempotente que retorna intent existente; eventos server-side estruturados e assinados em canal não imitável; modelo consulta status authoritative.

### M-08 — Capacidade, backpressure e acesso a dados não foram preparados para escala pública

- **Severidade:** **Média**.
- **Problema:** não há reserved concurrency, provisioned concurrency, aliases ou alarms de saturação; checkout síncrono percorre vários hops dentro de 29s; catálogo/cart usam scans em alguns caminhos; administração pagina apenas parte dos usuários.
- **Evidência:** `infra/src/stacks/bff-stack.ts:105-350,451-489`; `infra/src/stacks/ap2-entities-stack.ts:65-109`; `ap2-core/src/adapters-aws/dynamo-repos.ts:51-96`; `chatbot-bff/src/admin-handler.ts:43-45,91-111`.
- **Risco real:** rajadas consomem concorrência compartilhada, aumentam 504s e custo; scans degradam com volume; páginas administrativas ficam incompletas.
- **Cenários e categoria:** **MR** para demo/piloto pequeno; **BProd** até load/capacity test. Categoria: escalabilidade e resiliência.
- **Correção recomendada:** capacity model e load test; concurrency budgets; alarms de throttle/duration; retry budgets por hop; GSIs/search para consultas; paginação completa; considerar orquestração assíncrona quando o fluxo puder tolerá-la, preservando idempotência.

### M-09 — Governança e manutenção do starter são frágeis

- **Severidade:** **Média**.
- **Problema:** não há `SECURITY.md`, `CONTRIBUTING`, `CODEOWNERS`, changelog ou automação de atualização. Seis árvores npm exigem listas manuais em scripts e CI; um novo pacote pode ficar fora de install, teste e audit.
- **Evidência:** `package.json:5-17`; `.github/workflows/ci.yml:20-31`; ausência verificada desses arquivos no inventário do repositório.
- **Risco real:** ownership e triagem de vulnerabilidade ficam implícitos; drift entre pacotes; integração de novos componentes pode escapar dos gates; onboarding e reuso degradam à medida que o projeto cresce.
- **Cenários e categoria:** **MR** para equipe pequena/demo; **BP/BProd** como parte da governança mínima. Categoria: manutenção, governança e DX.
- **Correção recomendada:** políticas de segurança/contribuição/ownership/release; branch protection; bot de dependências; avaliar npm workspaces para descoberta de pacotes; templates e checks que detectem pacote não incluído no CI.

### B-01 — Respostas JSON sensíveis não padronizam headers de no-store/hardening

- **Severidade:** **Baixa**.
- **Problema e evidência:** respostas JSON de admin, journeys e evidence não definem consistentemente `Cache-Control: no-store` e `X-Content-Type-Options: nosniff` (`chatbot-bff/src/http.ts:35-60`).
- **Risco real:** cache intermediário/browser pode reter dados mais do que o esperado.
- **Cenários e categoria:** **MR** em todos; não bloqueia uso imediato isoladamente.
- **Correção recomendada:** headers uniformes para respostas autenticadas e testes de contrato HTTP.

- **Status da remediação (2026-08-27):** **Remediado** (ciclo 0). `Cache-Control: no-store` e `X-Content-Type-Options: nosniff` em toda resposta JSON, tanto no BFF quanto no envelope das entidades.
### B-02 — Hardening S3/CloudFront depende parcialmente de defaults

- **Severidade:** **Baixa**.
- **Problema e evidência:** bucket usa OAC/policy correta, mas não fixa explicitamente `BlockPublicAccess.BLOCK_ALL`, versioning ou access logging (`infra/src/stacks/frontend-stack.ts:53-72,123-136`).
- **Risco real:** alteração manual/account-level reduz a garantia declarativa; faltam trilhas de acesso e rollback simples de assets.
- **Cenários e categoria:** **MR**; produção deve corrigir como hardening.
- **Correção recomendada:** pin de Public Access Block/Object Ownership, deny de transporte inseguro, AWS Config/SCP e logging conforme necessidade.

### B-03 — Análise estática não é type-aware em profundidade

- **Severidade:** **Baixa**.
- **Problema e evidência:** ESLint strict não usa configuração type-aware; TypeScript define `skipLibCheck: true` (`eslint.config.mjs:5-17`, `tsconfig.base.json:2-10`).
- **Risco real:** algumas classes de erro dependentes de tipo e incompatibilidades de declarations podem escapar.
- **Cenários e categoria:** **MR** de qualidade.
- **Correção recomendada:** `strictTypeChecked` nas áreas críticas e job periódico com `skipLibCheck=false`, com exceções documentadas.

### B-04 — Comando de remediação de dependências mascara falhas

- **Severidade:** **Baixa**.
- **Problema e evidência:** `install:all:fix` executa `npm audit fix || true` em todas as árvores (`package.json:7-8`).
- **Risco real:** comando termina com sucesso mesmo com findings pendentes e altera vários lockfiles sem fluxo de revisão explícito.
- **Cenários e categoria:** **MR** de manutenção/supply chain.
- **Correção recomendada:** PRs automatizados por pacote, relatório não-zero fora da política e build/synth/test obrigatórios após mudança de lockfile.

## 8. Bloqueadores por cenário

- **Status da remediação (2026-08-27):** **Remediado** (ciclo 0). `install:all:fix` deixou de mascarar falhas com `|| true`.
### 8.1 Bloqueadores para demos

Não há bloqueador absoluto para **demo interna, sandbox, com dados sintéticos e sem dinheiro real**, mas há bloqueadores condicionais:

- C-01 bloqueia qualquer demo que pretenda provar exactly-once, robustez financeira ou operar com concorrência/retries reais;
- A-05 bloqueia alegação de evidence imutável/WORM;
- A-11 bloqueia distribuição ou reutilização externa sem base jurídica;
- dados reais, PAN/CVV, dinheiro real e credenciais reais não devem ser usados;
- `OTP_REVEAL_IN_UI=true` deve ser rotulado visualmente como sandbox;
- usar conta AWS isolada, budget/alerta configurados e, se internet-exposta, signup invite-only.

### 8.2 Bloqueadores para piloto com dados sensíveis

Antes de qualquer piloto sensível, devem ser tratados no mínimo:

- C-01, mesmo que o PSP permaneça simulado, para integridade de estado;
- A-02 ownership completo e isolamento de cache;
- A-03 MFA/step-up seguro, invite-only e anti-Sybil;
- A-04 egress/IAM do agente;
- A-05 evidence com integridade real;
- A-06 e A-07 assurance de supply chain, ambiente e promoção;
- A-10 restore/DR compatível com RPO/RTO do piloto;
- M-01 validação estrita;
- M-02 lifecycle/privacidade/criptografia conforme classificação;
- M-03 observabilidade, auditoria e resposta a incidentes;
- M-04 WAF/edge controls se o piloto for acessível pela internet;
- M-05 build/synth/E2E do artefato promovido;
- A-01 e A-08 se o piloto mover dinheiro real.

### 8.3 Bloqueadores para produção pública

Todos os achados críticos e altos são bloqueadores para produção pública, com exceção da licença somente se o titular mantiver uso estritamente proprietário e tiver direitos comprovados. Também são obrigatórios antes do go-live os médios M-01 a M-08, porque em escala pública eles afetam segurança, compliance, SLO, recuperação e operação.

## 9. Plano de remediação priorizado

### P0 — Interromper risco de integridade financeira

1. Implementar transição atômica `PENDING → PROCESSING` e finalização versionada no consentimento.
2. Reservar idempotency key antes de qualquer redeem/PSP; impedir side effects concorrentes.
3. Tornar credential issuance e checkout retry idempotentes e recuperáveis.
4. Persistir saga/reconciliation state e criar testes concorrentes determinísticos.
5. Não conectar PSP real antes da aprovação desses critérios.

**Critério de saída:** duas ou mais confirmações concorrentes produzem exatamente um conjunto de mandatos, uma credential efetiva e uma chamada PSP; timeout em qualquer hop pode ser retomado sem duplicidade.

### P1 — Base mínima para piloto sensível

1. Exigir ownership em toda leitura/ação de consentimento e eliminar cache cross-user.
2. Introduzir profiles de ambiente e defaults seguros: invite-only, OTP reveal proibido, MFA/admin step-up e origem fechada.
3. Restringir IAM/egress do agente e adotar network boundary compatível.
4. Aplicar schemas runtime estritos e limites de payload.
5. Definir inventário, retenção, eliminação, legal hold e CMKs conforme classificação.
6. Tornar evidence append-only com condição e export imutável independente.
7. Exigir alertas, logs/auditoria central e runbooks de incidente.
8. Implantar WAF/antiabuso quando houver exposição à internet.

**Critério de saída:** threat model aprovado, teste cross-tenant negativo, OTP/MFA sem canal compartilhado, data lifecycle testado, evidência não sobrescrevível e detecção operacional com responsável on-call.

### P2 — Release engineering, supply chain e recovery

1. Pin de actions/imagens; permissions mínimas; SAST/SCA/secret/container/license scans; SBOM e provenance.
2. Full build, Docker smoke, CDK synth e policy-as-code em PR.
3. Pipeline OIDC por ambiente/account, `cdk diff`, approval e artefato promovido imutável.
4. Canary/aliases, smoke pós-deploy e rollback coordenado.
5. RTO/RPO, backup cross-account/cross-region e restore testado.
6. Coverage por risco, UI tests, browser E2E, contracts e load test.
7. Adicionar licença e arquivos de governança.

**Critério de saída:** release reproduzível e rastreável, sem findings fora da política, restaurável em exercício e promovida entre contas sem rebuild.

### P3 — Prontidão de produção de pagamentos

1. PSP real com idempotência, webhooks, capture/void/refund e reconciliação.
2. SCA/3DS e antifraude; escopo PCI e privacidade formalizados.
3. Interoperabilidade AP2 validada externamente.
4. Key lifecycle, trust registry/JWKS histórico, rotação e revogação.
5. Segregação organizacional/contas dos atores conforme modelo de confiança.
6. SLOs, capacity model, on-call, disaster exercise e gestão de disputa/chargeback.

**Critério de saída:** pentest e revisão arquitetural independentes, load/chaos/restore tests, operação 24x7 compatível com SLO e aprovação de segurança/compliance/risco antes do go-live.

## 10. Capacidade de reutilização e experiência de desenvolvimento

Como acelerador interno de demo, o repositório é forte: há separação por packages, domain ports/adapters, scripts raiz, env example, CDK, seed, frontend configurável, testes negativos e documentação por componente. O fluxo pode ser clonado e adaptado sem reescrever a base criptográfica.

As restrições de reuso são relevantes: seis árvores npm e listas manuais aumentam drift; a toolchain não está totalmente pinada; não há licença nem processo de contribuição/ownership/release; o quick start copia defaults deliberadamente inseguros para além de sandbox; CI não valida o artefato completo. Assim, a reutilização segura hoje é **interna, supervisionada e limitada a prototipação**.

## 11. Conclusão objetiva

Hoje, o repositório pode ser usado com segurança razoável somente para:

- demos internas e controladas;
- dados exclusivamente sintéticos;
- PSP simulado e nenhum valor real;
- conta AWS isolada e orçamento baixo;
- baixa concorrência;
- comunicação explícita de que OTP revelado, evidence e fluxo financeiro são mecanismos de sandbox, não controles de produção.

Ele **não deve ser usado hoje** para:

- armazenar ou processar dados pessoais/financeiros sensíveis em piloto;
- movimentar dinheiro real;
- sustentar alegações de exactly-once, WORM ou interoperabilidade AP2 externa;
- operar uma aplicação pública de pagamentos.

O maior mérito do repositório é a arquitetura defensiva do fluxo agente→BFF→entidades e a base criptográfica/testável. O maior risco é que essa boa estrutura possa transmitir uma sensação de prontidão superior à realidade operacional. A condição de corrida crítica, a ausência de saga/reconciliação e os gaps de identidade, supply chain, DR e operação tornam o **go-live público um no-go inequívoco** até a conclusão das fases P0 a P3 e validação dinâmica independente.

## 12. Estado da remediação

Acrescentado após a avaliação. Registra o que mudou no repositório desde ela, sem alterar os achados.

### 12.1 Quadro dos treze bloqueadores de piloto (seção 8.2)

| Achado | Estado | Onde |
|---|---|---|
| C-01 | Fechado | Claim condicional no consentimento; reserva de idempotency key antes do PSP |
| A-02 | Fechado | Ownership em toda leitura de consentimento; cache do agente por caller |
| M-01 | Fechado | Schemas estritos nos seis handlers de entidade |
| A-03 | Parcial | Perfis, MFA/TOTP, invite-only, senha, threat protection · falta canal do step-up |
| A-04 | Parcial | IAM restrito ao modelo e ao repositório · `networkMode: PUBLIC` segue aberto |
| A-05 | Parcial | Append condicional e nonce CSPRNG · falta encadeamento assinado e export imutável |
| A-06 | Parcial | Permissões, pin por SHA, audit em `high` · falta SAST, SBOM, scan de imagem |
| A-07 | Parcial | Guard de conta/região e approval `broadening` · falta pipeline de promoção |
| M-04 | Parcial | Web ACL implementado, desligado por padrão por decisão de custo |
| A-10 | Aberto | — |
| M-02 | Aberto | — |
| M-03 | Aberto | — |
| M-05 | Aberto | — |

Fora do conjunto de piloto: **A-01** teve a parte mínima feita (idempotência de emissão e retomada de checkout); **B-01** e **B-04** foram fechados; **A-11** está aberto por decisão adiada do titular. **A-08**, **A-09**, **M-06**, **M-07**, **M-08**, **B-02** e **B-03** não foram tratados.

### 12.2 O que a remediação mudou nos pressupostos do assessment

Três observações do corpo do documento deixaram de descrever o repositório, e ficam registradas aqui porque o texto original foi preservado:

- **§4 (controles positivos)** listava "single-use sequencial" e "checkout server-authoritative" como controles que compensavam parcialmente C-01. Eles continuam existindo, mas a atomicidade da aprovação já não depende deles.
- **§7/A-03** afirma que o User Pool não coleta telefone e que o fluxo seguro de step-up depende de `phone_number`. Isso permanece verdadeiro e passou a ser uma decisão explícita: a coleta foi removida do template porque nada na aplicação escrevia o atributo, e Cognito não permite acrescentá-lo a um pool existente.
- **§7/M-04** trata o WAF como parte do hardening mínimo. O componente existe; a decisão de exigi-lo foi deliberadamente deixada com o operador, e o portão de perfis não o cobra.

### 12.3 O que ainda impede o GO

Nada mudou na resposta da seção 8.2 enquanto **A-10**, **M-02**, **M-03** e **M-05** não forem tratados: continuidade e restauração testada, política de ciclo de vida do dado, detecção com responsável designado, e validação do artefato promovido. São obrigações de privacidade e operação, não hardening opcional — e nenhuma delas é substituível por controle compensatório.

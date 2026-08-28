# Assessment técnico independente — AP2 v0.2 human-present com cartão

**Data:** 2026-08-27  
**Escopo:** AP2 v0.2, CDK/AWS, backend, frontend, agent e quality gates  
**Método:** análise estática independente  
**Baseline normativa:** AP2 `v0.2.0`, commit `b4587ac1d055888a73b4b21750973cffba961793`

## 1. Resumo executivo

O repositório é um **bom starter para uma demo controlada**, desde que use somente identidades, dados, instrumentos e processamento sintéticos, em conta isolada e com os defaults explicitamente restringidos. Ele contém uma implementação human-present substancial: separa o agent da Trusted Surface, assina artefatos com chaves por ator, emite Checkout e Payment Mandates fechados, encadeia-os por hashes, aplica expiração, owner binding, anti-replay por `jti`, credencial single-use, idempotência no MPP, receipts assinados e evidence trail append-only.

Isso não torna o template pronto para os outros dois objetivos. O veredito é:

| Perfil | Veredito | Justificativa curta |
|---|---|---|
| Demo controlada | **GO condicional** | Adequada com dados e PSP sintéticos, acesso limitado, operação sem concorrência deliberada e aceitação explícita das limitações. Os defaults entregues não constituem, por si, uma demo fechada. |
| Piloto fechado com dados sensíveis | **NO-GO** | Há blockers de consentimento confiável, corrida entre confirmar/recusar, canal de step-up não operacional quando o threshold o aciona, escopo incompleto no CP, receipts incompletos, autorização por operação, governança/recuperação de dados e release assurance. |
| Produção pública | **NO-GO** | Além dos blockers do piloto, há somente `SimulatedPsp`, ausência de reconciliação financeira, estado process-local no agent, caminho síncrono, scans sem paginação, WAF opcional, ausência de HA/DR e supply chain/deploy gates insuficientes. |

### Conclusão sobre AP2 v0.2

A implementação está **materialmente alinhada ao caminho nominal** human-present/direct, mas **não deve ser declarada estritamente conforme à v0.2** enquanto permanecerem, no mínimo:

1. Payment Receipts que não satisfazem integralmente o schema canônico;
2. ausência de distribuição/preservação verificável dos receipts para todos os papéis previstos;
3. verificação incompleta do escopo semântico do Payment Mandate pelo CP;
4. consentimento final exibindo apenas um resumo, e não os termos completos derivados do checkout assinado;
5. pacote de disputa incompleto e evidence com hashes semanticamente incorretos em alguns eventos.

Também é importante registrar o que **não** é uma não conformidade do fluxo direto v0.2: ausência de `IntentMandate`, ausência de holder binding `cnf`/KB-JWT, não consumo de `nonce`, ausência de TTL normativo específico e ausência de formato AP2 para PAN/DPAN/3DS. Esses itens pertencem a samples, ao modo open/autonomous, a perfis adicionais ou a controles locais de robustez.

## 2. Independência, método e limitações

### 2.1 Independência

Este assessment foi produzido sem abrir ou usar o conteúdo de:

- `docs/assessments/**`;
- `docs/assessments/assessment.md`;
- `docs/ap2-conformance.md`;
- `ap2-core/src/__tests__/ap2-conformance.test.ts`;
- documentos ou testes equivalentes de assessment/conformance.

Foram usados código executável, configuração, manifests, workflow de CI, testes normais quando necessários para mapear a cobertura declarada e fontes oficiais do AP2 no commit fixado.

### 2.2 Baseline oficial fixada e disciplina de versão

A baseline é exclusivamente a release oficial [`v0.2.0`](https://github.com/google-agentic-commerce/AP2/releases/tag/v0.2.0), publicada em 2026-04-28, apontando para o commit assinado/verificado [`b4587ac1d055888a73b4b21750973cffba961793`](https://github.com/google-agentic-commerce/AP2/commit/b4587ac1d055888a73b4b21750973cffba961793), `feat: Release Ap2 v0.2 (#233)`. A tag é lightweight. Toda conclusão de conformidade AP2 neste assessment deriva do conteúdo desse commit; não foram combinados requisitos de `main`, documentação `latest`, v0.1, versões posteriores, drafts ou outros protocolos.

Fontes oficiais examinadas, todas fixadas no mesmo commit v0.2:

- [`specification.md`](https://github.com/google-agentic-commerce/AP2/blob/b4587ac1d055888a73b4b21750973cffba961793/docs/ap2/specification.md)
- [`flows.md`](https://github.com/google-agentic-commerce/AP2/blob/b4587ac1d055888a73b4b21750973cffba961793/docs/ap2/flows.md)
- [`agent_authorization.md`](https://github.com/google-agentic-commerce/AP2/blob/b4587ac1d055888a73b4b21750973cffba961793/docs/ap2/agent_authorization.md)
- [`checkout_mandate.md`](https://github.com/google-agentic-commerce/AP2/blob/b4587ac1d055888a73b4b21750973cffba961793/docs/ap2/checkout_mandate.md)
- [`payment_mandate.md`](https://github.com/google-agentic-commerce/AP2/blob/b4587ac1d055888a73b4b21750973cffba961793/docs/ap2/payment_mandate.md)
- [`security_and_privacy_considerations.md`](https://github.com/google-agentic-commerce/AP2/blob/b4587ac1d055888a73b4b21750973cffba961793/docs/ap2/security_and_privacy_considerations.md)
- [`implementation_considerations.md`](https://github.com/google-agentic-commerce/AP2/blob/b4587ac1d055888a73b4b21750973cffba961793/docs/ap2/implementation_considerations.md)
- [schemas canônicos `code/sdk/schemas/ap2/**`](https://github.com/google-agentic-commerce/AP2/tree/b4587ac1d055888a73b4b21750973cffba961793/code/sdk/schemas/ap2), incluindo [`payment_receipt.json`](https://github.com/google-agentic-commerce/AP2/blob/b4587ac1d055888a73b4b21750973cffba961793/code/sdk/schemas/ap2/payment_receipt.json)

A inclusão de uma fonte nessa lista não muda sua classe normativa. `flows.md` declara seus fluxos como exemplos não normativos, e `implementation_considerations.md` foi usado como orientação de implementação. Termos `MUST`/`SHOULD`/`MAY` só foram atribuídos quando constam das fontes fixadas com essa força; requisitos estruturais foram extraídos de `required`, `const` e `oneOf` dos schemas canônicos do mesmo commit.

O [sample human-present/cards fixado na v0.2](https://github.com/google-agentic-commerce/AP2/blob/b4587ac1d055888a73b4b21750973cffba961793/code/samples/python/scenarios/a2a/human-present/cards/README.md) foi tratado apenas como referência não normativa. Os schemas em `ap2-core/src/schemas/ap2/**` foram tratados como derivados locais, nunca como fonte da norma.

Como verificação complementar, foram lidas integralmente em 2026-08-27 as páginas públicas [`Flows`](https://ap2-protocol.org/ap2/flows/), [`Specification`](https://ap2-protocol.org/ap2/specification/), [`Checkout Mandate`](https://ap2-protocol.org/ap2/checkout_mandate/), [`Payment Mandate`](https://ap2-protocol.org/ap2/payment_mandate/) e [`Implementation Considerations`](https://ap2-protocol.org/ap2/implementation_considerations). A página `Specification` se identifica como AP2 v0.2; cada página complementar foi comparada ao documento correspondente no commit `b4587ac…`. Essas URLs mutáveis foram usadas somente como *cross-check*: nenhum requisito do assessment depende exclusivamente delas e nenhum conteúdo divergente foi importado para a baseline.

Em caso de diferença, o snapshot v0.2 fixado prevalece. Duas tensões da renderização pública foram preservadas, não resolvidas por mistura de versões: (1) a tabela de Payment Receipt marca `psp_confirmation_id` e `network_confirmation_id` como `Required: No`, enquanto o `payment_receipt.json` fixado exige ambos no branch `Success`; e (2) descrições tabulares de `vct` omitem em pontos o sufixo `.1`, enquanto as seções `Type` e os schemas fixados exigem `mandate.checkout.1` e `mandate.payment.1`. Essas tensões são qualificadas na seção 4.3 e na linha AP2-19; o contrato aplicado continua sendo o commit v0.2 reproduzível.

### 2.3 Limitações da avaliação

Por solicitação do responsável pelo repositório, não foram executados testes, builds, audit, `cdk synth`, Docker build, deploy nem smoke tests. Portanto:

- “presente no CI” significa **declarado estaticamente**, não executado neste assessment;
- nenhuma conclusão afirma que dependências estão livres de vulnerabilidades atuais;
- não foram validados recursos realmente implantados, credenciais, alarmes assinados, quotas AWS, métricas, restauração ou comportamento de um ambiente live;
- uma tentativa inicial de `bootstrap` produziu saída incompleta e inconclusiva antes da mudança de escopo; ela não é usada como evidência de aprovação ou falha.

Conteúdo externo foi resumido e parafraseado para conformidade com restrições de licenciamento.

## 3. Arquitetura e trust boundaries observadas

O fluxo local é:

1. o agent pesquisa produtos, solicita ao Merchant um checkout assinado, lista referências opacas de pagamento e abre uma ConsentSession;
2. o browser chama `POST /intent` no BFF;
3. o BFF recupera o checkout server-side, deriva valor/itens, sela a intenção e decide step-up;
4. em `POST /confirm`, o BFF valida owner, expiração, selo e OTP quando aplicável;
5. a Mandate Authority verifica o artefato do Merchant e emite Checkout e Payment Mandates fechados;
6. o Credential Provider verifica a cadeia e emite uma credencial single-use;
7. o Merchant verifica o Checkout Mandate e aciona o MPP;
8. o MPP resgata a credencial no CP, verifica o Payment Mandate, chama o PSP simulado e assina o Payment Receipt;
9. o Merchant assina o Checkout Receipt;
10. o BFF persiste um resultado reduzido e expõe metadados do evidence trail.

Evidências principais: `agent/src/tools/ap2/tools.ts:7-17,115-283`, `chatbot-bff/src/ap2-handler.ts:139-190,205-557`, `ap2-core/src/domain/entities/consent-mandates.ts:90-198`, `ap2-core/src/domain/entities/credential-provider.ts:55-414`, `ap2-core/src/domain/entities/merchant.ts:128-398` e `ap2-core/src/domain/entities/mpp.ts:74-373`.

### Controles arquiteturais positivos

- O modelo possui quatro tools propose-only e não recebe uma tool para confirmar, emitir mandates ou liquidar: `agent/src/tools/ap2/tools.ts:7-17,115-283`.
- O prompt proíbe pedir OTP ou alegar que pagou: `agent/src/agent.ts:41-87`.
- A Mandate Authority é uma função separada e somente o BFF recebe o grant direto para a decisão: `infra/src/stacks/ap2-entities-stack.ts:139-299`, `infra/src/stacks/bff-stack.ts:374-390`.
- Chaves de assinatura são separadas por ator; o segredo HMAC fica em Secrets Manager: `infra/src/stacks/security-stack.ts:49-100`.
- Owner binding é reiterado no BFF, cart, sessão, credential e redeem.
- PAN/CVV não entram no agent; ele vê somente `paymentMethodRef` e nome mascarado: `ap2-core/src/domain/entities/credential-provider.ts:24-49`.
- A credencial passa atomicamente de `ISSUED` para `REDEEMED`: `ap2-core/src/adapters-aws/dynamo-repos.ts:359-379`.
- O MPP reserva a idempotency key antes do PSP: `ap2-core/src/domain/entities/mpp.ts:98-143`.
- Evidence de entidades é append-only na perspectiva IAM da aplicação: `ap2-core/src/adapters-aws/evidence-dynamo.ts:8-57`, `infra/src/stacks/ap2-entities-stack.ts:123-294`.

## 4. Interpretação normativa do AP2 v0.2

### 4.1 Requisitos efetivos do fluxo direct/human-present

Para o escopo avaliado, a v0.2 exige ou estrutura canonicamente:

- Trusted Surface não-agentic e verificações determinísticas;
- Checkout JWT assinado pelo Merchant;
- Checkout e Payment Mandates fechados, aprovados diretamente pelo usuário;
- `vct` versionado e campos obrigatórios dos schemas;
- vínculo de Checkout Mandate com `checkout_jwt` por `checkout_hash`;
- vínculo do Payment Mandate ao checkout por `transaction_id`;
- assinatura não determinística do Checkout JWT, com ECDSA como exemplo;
- verificação do checkout mais recente pelo Merchant;
- verificação do Payment Mandate por CP/Network/MPP antes da credencial/processamento;
- credencial limitada à transação e liberada ao Merchant;
- receipts assinados na aceitação e rejeição, referenciando o mandate correspondente;
- preservação dos artefatos/hashes necessária à verificação de disputa;
- minimização de dados e salts com entropia adequada em SD-JWT.

### 4.2 Itens que não são MUST do direct/human-present

| Item | Classificação correta na v0.2 |
|---|---|
| `IntentMandate` | Terminologia/comportamento de sample; não faz parte do núcleo normativo direct auditado. |
| `CartMandate` | Extensão/nome local e de sample. No código, ele funciona como envelope do Checkout JWT assinado pelo Merchant. |
| `cnf`, holder key e KB-JWT | Requisito do mandate aberto enquanto aberto; não é requisito do closed mandate direto puro. |
| Consumo de `nonce` | Não há MUST de nonce/challenge no direct; `nonce` aparece em exemplos. |
| Anti-replay/idempotency key direta | Importante controle de produção, mas não é especificado como MUST no direct. |
| `iat` e `exp` | Opcionais nos schemas de mandates fechados; o código local é mais restritivo. |
| DPAN, PAN, criptograma, 3DS/SCA e PCI | Fora do formato central AP2; precisam de perfil de cartão, CP/Network e arquitetura PCI. |
| OTP `123` e DPAN preferencial | Comportamentos do sample, não norma. |
| Open mandates, constraints, `sd_hash` open→closed | Não aplicáveis ao fluxo direct puro. |

### 4.3 Tensões internas e de renderização da baseline oficial

A baseline fixada e sua renderização pública contêm ambiguidades que uma implementação interoperável precisa perfilar explicitamente, sem combinar versões:

1. o receipt genérico de `agent_authorization.md` usa `result: success|error`, enquanto os schemas concretos fixados usam `status: Success|Error`;
2. no `payment_receipt.json` do commit v0.2, o branch `Success` exige `psp_confirmation_id` e `network_confirmation_id`; a tabela da página pública mutável marca ambos como `Required: No`. Este assessment aplica o schema fixado e registra a tabela apenas como ambiguidade documental;
3. as seções `Type` e os schemas v0.2 exigem `mandate.checkout.1` e `mandate.payment.1`, embora descrições tabulares publicadas omitam o sufixo `.1` em alguns pontos; os valores versionados completos prevalecem;
4. o texto direto permite que o SA encaminhe a credencial, enquanto a regra de segurança diz que ela só deve ser liberada ao Merchant;
5. `specification.md` exige assinatura não determinística para o Checkout JWT, enquanto a seção de segurança discute salt como mitigação para assinatura determinística;
6. os schemas não conseguem, sozinhos, validar algoritmo, base64url ou igualdade entre hashes; esses controles dependem de código determinístico.

Este assessment usa a leitura estrutural estrita dos JSON Schemas canônicos do commit `b4587ac…`, preserva a força normativa de cada fonte e registra as tensões em vez de resolvê-las silenciosamente ou recorrer a outra versão.

## 5. Matriz requisito → status → evidência → gap

Legenda: **Conforme**, **Parcial**, **Não conforme**, **Extensão**, **N/A** ou **Não demonstrado**.

| ID | Classe oficial | Requisito/base oficial | Status | Evidência local | Gap e impacto |
|---|---|---|---|---|---|
| AP2-01 | Norma descritiva | Papéis SA, CP, Merchant, MPP e TS com responsabilidades acumuláveis | Conforme | Entidades separadas em `ap2-core/src/domain/entities/**`; stacks em `infra/src/stacks/ap2-entities-stack.ts:27-48,139-299` | Acúmulo de papéis está explícito no deployment; não é gap por si. |
| AP2-02 | MUST | Trusted Surface e verificações atribuídas aos papéis devem ser não-agentic | Conforme com hardening parcial | BFF e Mandate Authority determinísticos; tools propose-only em `agent/src/tools/ap2/tools.ts:7-17` | IAM do agent alcança funções Merchant/CP multiplexadas; é risco de least privilege, não prova de que o LLM assina mandates. |
| AP2-03 | MUST | LLMs/agentes devem ser tratados como potenciais atacantes | Parcial | Omissão de tools críticas, identity JWS e separação de signer; `infra/src/stacks/agent-stack.ts:175-234` | `networkMode: PUBLIC` não é endpoint anônimo, mas não há política VPC/egress declarada; eventos de sistema são texto imitável. |
| AP2-04 | Norma descritiva | Direct: usuário aprova closed Checkout e Payment Mandates na TS | Parcial | Emissão em `ap2-core/src/domain/entities/consent-mandates.ts:90-198`; aprovação em `chatbot-bff/src/ap2-handler.ts:337-452` | O card final recebe apenas `summary`. Itens/total são derivados do cart assinado, mas `paymentMethodRef` vem separadamente da sessão e não está explicitamente no selo; a representação final confiável e itemizada não chega à UI. |
| AP2-05 | Schema (`required`/`const`) | Checkout Mandate requer `vct=mandate.checkout.1`, `checkout_jwt`, `checkout_hash` | Conforme | `ap2-core/src/domain/sdjwt.ts:154-178,268-310` | O nome local `CartMandate` é extensão; o `merchant_authorization` cumpre o papel de Checkout JWT. |
| AP2-06 | Schema (`required`/`const`) | Payment Mandate requer vct, transaction, payee, amount e instrument | Conforme na emissão | `ap2-core/src/domain/entities/consent-mandates.ts:143-180`; `ap2-core/src/domain/sdjwt.ts:188-216` | A emissão contém os campos; a verificação de todos os significados pelo CP é incompleta, ver AP2-12/AP2-13. |
| AP2-07 | MUST | Comparar a string `vct` inteira, incluindo `.1` | Conforme | `ap2-core/src/domain/sdjwt.ts:268-349` | Sem gap identificado. |
| AP2-08 | MUST | Merchant fornece Checkout JWT assinado; assinatura não determinística | Conforme | Cart JWS ES256 em `ap2-core/src/domain/mandates.ts:55-114` | Adequado ao requisito de ECDSA. Interoperabilidade externa ainda exige política de trust/key lifecycle. |
| AP2-09 | MUST | `checkout_hash` deve hashear o Checkout JWT e ser comparado ao checkout mais recente | **Parcial** | Emissão/verificação em `ap2-core/src/domain/sdjwt.ts:154-178,268-310`; freshness em `ap2-core/src/domain/entities/merchant.ts:274-333`; repositório em `ap2-core/src/adapters-aws/dynamo-repos.ts:73-103` | O hash é comparado, mas `getCartByJourney` usa `Scan` não paginado, sem ordenação, e escolhe `Items[0]`; criação por `cartId` não impõe unicidade. “Mais recente” não é garantido. |
| AP2-10 | MUST | Payment Mandate deve referenciar o checkout associado | Conforme | `transaction_id=checkoutJwtHash`; comparações em `ap2-core/src/domain/entities/credential-provider.ts:163-225` e `ap2-core/src/domain/entities/mpp.ts:146-259` | Sem gap criptográfico principal. |
| AP2-11 | MUST | Merchant verifica Checkout Mandate e retorna Checkout Receipt | Conforme no core | `ap2-core/src/domain/entities/merchant.ts:236-398` | O receipt é descartado no BFF e não fica disponível ao usuário/verificador externo. |
| AP2-12 | MUST | CP/Network verificam Payment Mandate antes de emitir credencial e retornam Payment Receipt JWT apropriado se a verificação falhar | **Parcial; não conforme no erro** | Assinatura, audience, amount, owner e MPP em `ap2-core/src/domain/entities/credential-provider.ts:163-246` | CP não compara `payment_instrument.id` com o método solicitado, currency com o cart nem payee com o Merchant. Além disso, seus branches de falha lançam `BlockedError` sem emitir o Payment Receipt JWT exigido pela specification. |
| AP2-13 | MUST | Credencial deve ser vinculada à transação específica | Parcial | Credencial inclui hashes, amount, method, merchant, MPP e `single_use`: `ap2-core/src/domain/entities/credential-provider.ts:247-297` | O conteúdo é forte, mas herda a verificação semântica incompleta do CP. |
| AP2-14 | MUST de segurança, com tensão textual | Credencial só é liberada ao Merchant | Parcial/perfil local | Agent e browser não a recebem; BFF a recebe e encaminha no pipeline | É defensável apenas se o BFF for perfilado como relay opaco da TS. A tensão oficial deve ser documentada e o relay minimizado. |
| AP2-15 | MUST | MPP recebe a credencial do Merchant e verifica limitação ao checkout | Conforme com lacunas herdadas | `ap2-core/src/domain/entities/merchant.ts:334-398`; `ap2-core/src/domain/entities/mpp.ts:146-265` | MPP não corrige payee/currency/instrument não comparados pelo CP. |
| AP2-16 | Extensão local | Credencial precede o processamento e é single-use | Extensão robusta | `ISSUED → REDEEMED` condicional em `ap2-core/src/adapters-aws/dynamo-repos.ts:359-379` | Bom controle adicional; consumir antes do PSP exige reconciler para falhas ambíguas. |
| AP2-17 | MUST | Aceitação/rejeição de mandate deve produzir receipt assinado | Parcial | Outcomes do PSP e blocks capturados dentro do `try` recebem receipt em `ap2-core/src/domain/entities/mpp.ts:282-373`; Merchant assina em `ap2-core/src/domain/entities/merchant.ts:306-398` | Falhas de verificação no CP não emitem Payment Receipt JWT; `BLOCKED_IN_PROGRESS` ocorre antes do `try` do MPP; error receipts capturados são achatados/perdidos pelo entity client/BFF; browser recebe só resultado reduzido. |
| AP2-18 | Schema (`required`/`oneOf`) | Checkout Receipt deve satisfazer schema canônico | Conforme no caminho observado | `ap2-core/src/domain/entities/merchant.ts:246-398` inclui status, iss, iat, reference e campos condicionais | Falta validação canônica no gate e persistência/exposição do JWS. |
| AP2-19 | Schema (`required`/`oneOf`) | Payment Receipt deve satisfazer o schema canônico fixado | **Não conforme sob o schema fixado; documentação publicada ambígua** | `ap2-core/src/domain/entities/mpp.ts:74-333` | No branch `Success`, `payment_receipt.json` da v0.2 exige `psp_confirmation_id` e `network_confirmation_id`; o código inclui o primeiro e omite o segundo. A tabela pública mutável marca ambos como opcionais, portanto a omissão do Network ID é falha contra a baseline fixada, mas não consenso documental sem ressalva. No branch `Error`, `error` e `error_description` são exigidos; o decline do PSP omite `error`, gap inequívoco. |
| AP2-20 | MUST | Payment Receipt deve voltar ao SA, CP e Network quando aplicável | **Não conforme/parcial** | Retorna ao Merchant/BFF; redução em `chatbot-bff/src/ap2-handler.ts:454-508` | CP não recebe o receipt; Checkout Receipt é descartado; JWS não chega à web. |
| AP2-21 | MUST | Receipt `reference` deve vincular o mandate correspondente | Parcial | Payment reference passa a hash do Payment Mandate após redeem; Checkout reference usa hash do Checkout Mandate | Rejeições anteriores ao redeem usam checkout hash porque o MPP ainda não recebeu o Payment Mandate; perfil/semântica de erro precisa ser definida. |
| AP2-22 | MUST de verificação de disputa + orientação v0.2 de preservação | Verificação de disputa deve reconstruir mandates, hashes e receipts; para isso, preservar SD-JWTs, disclosures e sua serialização compacta | Parcial | Mandates são guardados; evidence registra IDs/hashes | `/evidence` não entrega artifacts nem disclosures/serialização compacta; receipts não formam bundle verificável; `PAYMENT_MANDATE` registra `cartHash`, e Checkout Receipt evidence registra checkout hash em vez do hash do receipt. |
| AP2-23 | Norma de privacidade | Minimização de dados entre participantes | Parcialmente conforme | Agent vê refs opacas; Merchant não recebe Payment Mandate; payer refs ficam CP→MPP | BFF vê a credencial; `pspReference` é exposto na resposta e em `note` de evidence. Política de minimização/retenção não é demonstrada no repositório. |
| AP2-24 | MUST | Salt com entropia suficiente nos digests SD-JWT | Não demonstrado diretamente | Emissão delegada à biblioteca `@sd-jwt/*` em `ap2-core/src/domain/sdjwt.ts` | Não há gate/test vector independente declarado no pipeline para provar parâmetros e interoperabilidade. Não é evidência de falha criptográfica, mas falta assurance. |
| AP2-25 | Schema opcional + extensão local | Expiração de mandates fechados | Extensão robusta | `iat/exp` de 15 min, cart/sessão/intent/credential com janelas menores | A v0.2 torna `iat/exp` opcionais; o controle local é positivo. `/intent` ainda pode sobrescrever/reabrir estado de aplicação. |
| AP2-26 | Não especificado no direct + extensão local | Anti-replay direto por nonce/idempotency | Extensão robusta/parcial E2E | `jti` consumido separadamente no CP/MPP; credential single-use; key no MPP | `nonce` não é consumido, mas isso não é MUST. No retry do orquestrador, o CP pode responder `REPLAYED` antes que a chamada alcance o branch `DONE` do MPP, embora o MPP reproduza o receipt se for alcançado com a mesma key. |
| AP2-27 | Sample/open; N/A ao direct | `IntentMandate`, open mandates e holder binding | N/A | `IntentMandate` existe apenas como tipo; closed flow não usa `cnf` | Não deve ser reportado como não conformidade do direct v0.2. Pode ser roadmap de extensão futura. |
| AP2-28 | Fora do núcleo AP2 | Perfil de cartão real | Ausente no produto | `SimulatedPsp` em `ap2-core/src/context.ts:42-62` e `ap2-core/src/domain/adapters/memory.ts:356-370` | AP2 não define o token de cartão, mas produção exige tokenização, adquirência, PCI, 3DS/SCA quando aplicável, webhooks e reconciliação. |

### Resultado consolidado de conformidade

- **Conformes no caminho nominal:** trust boundary principal, Checkout JWT ES256, closed mandates, vct, hashes, transaction link, owner binding, expiração local, verificação Merchant/MPP, credencial single-use e receipts assinados no core.
- **Parciais:** consentimento informado, threat model operacional, verificação semântica CP, entrega da credencial, error receipts, dispute bundle, minimização e assurance do SD-JWT.
- **Não conformes na leitura estrita:** Payment Receipt canônico, ausência de Payment Receipt JWT nas falhas do CP e distribuição dos receipts.
- **Extensões úteis:** Cart Mandate local, `presence=HUMAN_PRESENT`, ConsentProof, `jti`, credential single-use, idempotência e evidence trail.

## 6. Findings priorizados

### Critério de prioridade

- **P0:** blocker para pelo menos um objetivo declarado; pode causar pagamento contra decisão do usuário, resultado financeiro desconhecido, violação estrutural AP2 ou exposição séria de dados.
- **P1:** obrigatório antes de produção pública e, salvo mitigação formal, antes de piloto sensível.
- **P2:** hardening, interoperabilidade e manutenção necessários para um starter reutilizável.
- **P3:** otimização e polish sem bloquear o caminho seguro imediato.

### Como usar os findings em fixes futuros

A seção 6 é a lista acionável de trabalho; os “Gaps” das seções por domínio são resumos e não criam findings independentes. Cada fix deve manter o ID no task/PR e cobrir três elementos: **problema e impacto**, **como resolver** e **aceite mínimo observável**. Os P0 detalham esses elementos em blocos; P1–P3 usam formato compacto. A recomendação indica uma direção técnica, não uma obrigação de copiar exatamente a solução proposta: alternativa equivalente é aceitável se preservar as invariantes e satisfizer integralmente o aceite mínimo.

### 6.1 P0 — blockers

#### P0-01 — Confirm, decline e supersede não compartilham uma state machine atômica

**Cenário:** `/confirm` lê `pending` e inicia assinatura/liquidação sem fazer claim atômico do intent. Durante o hop, `/decline` ou a abertura de outro intent pode gravar `declined/superseded`. Se o pagamento terminar, `markSettled` perde a condição e o erro é engolido. O resultado pode ser cobrança/receipt real com estado local “declined”.

**Evidência:** `chatbot-bff/src/ap2-handler.ts:304-320,337-478,533-557`; `chatbot-bff/src/ap2/intent-store.ts:102-110,190-260`.

**Como resolver:** introduzir estado `PENDING → PROCESSING → SETTLED|DECLINED|FAILED|UNKNOWN`; claim condicional com versão/fencing token antes de assinar; decline somente sobre `PENDING`; propagar reject à ConsentSession; outbox durável; reconciler para `PROCESSING/UNKNOWN`.

**Critério de aceite:** em testes concorrentes confirm×confirm, confirm×decline e confirm×supersede, existe exatamente um outcome terminal; após decline confirmado nenhuma chamada ao PSP ocorre; todo side effect financeiro converge para o mesmo receipt/status no intent e na sessão.

#### P0-02 — Payment Receipts não satisfazem integralmente o schema v0.2 fixado nem são distribuídos

**Cenário:** no branch `Success`, o MPP omite `network_confirmation_id`, exigido pelo `payment_receipt.json` do commit v0.2, embora a tabela pública mutável marque os IDs de confirmação como opcionais. Essa é uma falha sob a baseline canônica fixada com ambiguidade documental explícita, não um consenso sem ressalva. No branch `Error`, o decline do PSP omite `error`, gap inequívoco. Além disso, falhas de verificação no CP lançam `BlockedError` sem Payment Receipt JWT; o BFF descarta o Checkout Receipt e devolve apenas campos achatados; e o CP não recebe nem armazena o Payment Receipt terminal do MPP. Isso impede alegação estrita de conformidade e reduz auditabilidade/disputa.

**Evidência:** `ap2-core/src/domain/entities/credential-provider.ts:163-246`; `ap2-core/src/domain/entities/mpp.ts:74-373`; `ap2-core/src/domain/entities/merchant.ts:306-398`; `chatbot-bff/src/ap2-handler.ts:454-508`.

**Como resolver:** para alegar conformidade estrita à baseline escolhida, produzir receipts MPP que validem no schema canônico do commit `b4587ac…`, incluindo ambos os confirmation IDs em `Success` e `error`/`error_description` em `Error`. Se `network_confirmation_id` não for aplicável ao perfil, não relaxar o schema silenciosamente: fixar e publicar um perfil ou errata v0.2 formal, ajustar o claim de conformidade e registrar a precedência. Fazer o CP emitir Payment Receipt JWT assinado em toda falha de verificação; preservar Checkout/Payment Receipt JWS e, para disputa, os SD-JWTs, disclosures e serializações compactas; entregar o Payment Receipt ao SA/BFF, ao CP e à Network quando aplicável; disponibilizar bundle verificável e owner-scoped; preservar error receipts entre entity client e BFF.

**Critério de aceite:** sob claim estrito v0.2, todo `Success`/`Error` do MPP e toda falha normativa do CP produzem receipt que passa os schemas oficiais do commit fixado; qualquer exceção depende de perfil/errata v0.2 explicitamente versionado, nunca de uma página `latest` ou de outra release. Os hashes `reference` são reproduzíveis; SA/BFF, CP e Network aplicável recebem o mesmo Payment Receipt terminal; Merchant/usuário recebem Checkout Receipt; e o bundle com receipts, SD-JWTs, disclosures e serializações compactas verifica offline.

#### P0-03 — O CP não valida todo o escopo assinado do Payment Mandate

**Cenário:** o CP usa `paymentMethodRef` do request sem compará-lo com `pmV.payment_instrument.id`; compara amount numérico, mas não currency; não compara payee com o Merchant do checkout. Um caller interno privilegiado pode trocar método por outro do mesmo payer ou aceitar semântica divergente.

**Evidência:** `ap2-core/src/domain/entities/credential-provider.ts:163-246`.

**Como resolver:** comparar instrument id/type, amount e currency, payee id/name, transaction id, payer/owner e target MPP antes de consumir `jti`; rejeitar campos desconhecidos ou divergentes com receipt assinado.

**Critério de aceite:** qualquer mutação isolada desses campos é recusada antes da emissão; nenhuma credential é persistida; o error receipt referencia o Payment Mandate apresentado.

#### P0-04 — Consentimento final não é itemizado nem independente do modelo

**Cenário:** o BFF deriva itens e total do checkout assinado e mantém `paymentMethodRef` na ConsentSession, mas `/intent` retorna somente `summary`. O card mostra essa frase. O método vem de `session.paymentMethodRef`, separadamente do cart, e não está explicitamente coberto pelo selo HMAC. A visão itemizada pode ficar apenas na narrativa/Markdown produzida pelo agent, que está fora da Trusted Surface.

**Evidência:** `chatbot-bff/src/ap2-handler.ts:239-334`; `chatbot-frontend/src/components/ap2/CheckoutCard.tsx:171-180`; `agent/src/tools/ap2/tools.ts:158-212,228-282`; `agent/src/agent.ts:72-100`.

**Como resolver:** devolver e renderizar diretamente da TS merchant, itens, quantidades, preços, frete, total/moeda, método mascarado, validade, step-up e hash curto; incluir o método/representação final no binding confirmado; não usar texto do modelo como fonte de termos.

**Critério de aceite:** desligar/alterar a mensagem do agent não muda os termos exibidos; qualquer divergência de item, total, moeda, merchant ou método entre a representação exibida e o estado confirmado bloqueia a aprovação.

#### P0-05 — Quando a política exige step-up, o perfil regulado não oferece canal operacional

**Cenário:** pilot/prod proíbem revelar OTP na UI. O User Pool não coleta telefone; sem `phone_number`, `/intent` retorna 503 para compras acima do threshold configurado. MFA TOTP de login não é o desafio transacional do checkout. Elevar o threshold pode evitar esse caminho, mas equivale a desabilitar o controle, não a implementar step-up.

**Evidência:** `infra/.env.example`; `infra/src/stacks/auth-stack.ts:97-129`; `infra/src/config.ts:198-264`; `chatbot-bff/src/ap2-handler.ts:258-273`.

**Como resolver:** a política de risco deve definir quando step-up é obrigatório. Nesses casos, implementar passkey/WebAuthn transacional, TOTP transacional claramente vinculado, ou canal verificado com enrollment/delivery observável; registrar método e challenge binding no ConsentProof; fazer perfil regulado recusar synth quando exigir step-up sem canal funcional.

**Critério de aceite:** para os cenários que a política classifica como step-up, o usuário conclui o desafio sem receber o segredo no mesmo canal; replay e challenge de outra sessão falham; falha de entrega é visível e monitorada; o profile gate valida configuração compatível com a política.

#### P0-06 — PSP real e reconciliação financeira não estão implementados

**Cenário:** a credencial é consumida no redeem antes de `psp.authorize`. Se ocorrer timeout/falha depois de uma autorização, não há webhook, polling ou worker no repositório para descobrir o outcome. No retry do orquestrador, a chamada volta primeiro ao CP; uma credential já `REDEEMED` não é reproduzida e o Payment Mandate já consumido pode resultar em `REPLAYED` antes de o fluxo alcançar o branch `DONE` do MPP. Se o MPP for alcançado diretamente com a mesma key, ele reproduz o receipt antes do novo redeem. O adapter selecionado continua sendo somente `SimulatedPsp`.

**Evidência:** `ap2-core/src/context.ts:42-62`; `ap2-core/src/domain/adapters/memory.ts:356-370`; `ap2-core/src/adapters-aws/entity-client.ts:165-190`; `ap2-core/src/domain/entities/credential-provider.ts:128-154,239-252,300-414`; `ap2-core/src/domain/entities/mpp.ts:109-124,244-333`.

**Como resolver:** adapter PSP real com tokenização e idempotency key nativa, deadlines, webhooks assinados, status query, void/refund, estados `PENDING/UNKNOWN`, inbox/outbox e reconciler periódico. Definir e comprovar o boundary PCI.

**Critério de aceite:** falha injetada antes/durante/depois da autorização converge sem segunda cobrança; webhook duplicado/reordenado é idempotente; `UNKNOWN` gera alerta/reconciliação; nenhum PAN/CVV entra em agent, BFF, logs ou DynamoDB.

#### P0-07 — Autorização por principal/operação não sustenta least privilege para dados sensíveis

**Cenário:** o role do agent pode invocar funções inteiras de Merchant e CP, embora as tools exponham só operações propose-only. O CP multiplexa list/issue/redeem, e `redeem` recebe `callingMpp` no payload sem demonstrar binding criptográfico desse valor ao principal SigV4 chamador. A segurança pretendida nas tools não está integralmente refletida na autorização do runtime.

**Evidência:** `infra/src/stacks/agent-stack.ts:175-193`; `ap2-core/src/handlers/credential-provider.ts:58-78`.

**Como resolver:** separar funções/URLs por operação ou autenticar caller/operation por principal SigV4 verificável; permitir redeem apenas ao MPP; remover grants de issue/redeem/initiate payment do agent. WAF, network mode e egress permanecem hardening P1, tratados em P1-09/P1-10.

**Critério de aceite:** policy simulator e testes de autorização mostram que o principal do agent não consegue issue/redeem/initiate payment/decision; CP rejeita `callingMpp` não vinculado ao principal autorizado; cada operação sensível possui allowlist de principals independente dos campos do request.

#### P0-08 — Governança, retenção, key lifecycle e recuperação mínima não são demonstradas para dados sensíveis

**Cenário:** PITR regional e `RETAIN` são positivos, mas os stacks examinados não declaram política por classe de dado, DSAR/deleção, backup imutável/cross-account, restore drill, RTO/RPO, rotação do HMAC ou rollover/revogação de signing keys. Os Log Groups explicitamente criados pelo BFF usam retenção de um mês e podem ser destruídos, enquanto mandates/evidence podem ficar indefinidamente. HA/failover multi-região é requisito adicional de produção, tratado na fase P0-C, não baseline universal de um piloto.

**Evidência:** `infra/src/stacks/data-stack.ts:40-139`; `infra/src/stacks/security-stack.ts:49-100`; `infra/src/stacks/bff-stack.ts:102-180,355-359`; `infra/src/stacks/agent-stack.ts:88-145`.

**Como resolver:** para o piloto, definir classificação/minimização, tabela de retenção, legal hold e deleção verificável; CMK conforme classificação; backup isolado/cross-account quando requerido pelo threat model; restore drill e RTO/RPO; key versioning, trust list, rotação/revogação e retenção das chaves necessárias à disputa. Para produção, adicionar DR regional conforme objetivos aprovados.

**Critério de aceite:** cada dado tem owner/base legal/TTL/deletion path; restore é ensaiado e atende o RTO/RPO do piloto; chave comprometida é revogada sem invalidar evidência histórica legítima; logs/audit trail têm retenção coerente. Produção comprova separadamente seu failover/DR.

### 6.2 P1 — alta prioridade

| ID | Problema e impacto | Evidência | Como resolver e aceite mínimo |
|---|---|---|---|
| P1-01 | Emissão dos dois mandates, evidence e finalização da sessão não formam transação; falha intermediária pode deixar pares incompletos ou duplicados. | `ap2-core/src/handlers/consent-decision.ts:102-185`; `ap2-core/src/adapters-aws/dynamo-repos.ts:143-204`; `ap2-core/src/domain/entities/consent-mandates.ts:90-198` | **Como resolver:** persistir um aggregate versionado por ConsentSession, com IDs determinísticos, estado de emissão e outbox gravados em transação (`TransactWriteItems` ou equivalente); retry deve retomar o passo pendente, não criar outro par. **Aceite mínimo:** falha injetada após cada write retoma para exatamente um Checkout Mandate, um Payment Mandate, um conjunto coerente de evidence e uma única finalização da sessão. |
| P1-02 | Evidence tem hashes incorretos/incompletos, não preserva o bundle AP2 v0.2 verificável e expõe referência PSP em `note`; disputas não podem ser recompostas com segurança. | `ap2-core/src/domain/entities/consent-mandates.ts:183-198`; `ap2-core/src/domain/entities/merchant.ts:260-273`; `ap2-core/src/domain/entities/mpp.ts:323-333`; `chatbot-bff/src/ap2-handler.ts:602-613` | **Como resolver:** registrar o hash do próprio artefato/receipt; armazenar cifrados e owner-scoped receipts, SD-JWTs, disclosures e serializações compactas; remover/redigir referências PSP de campos livres; fornecer verificador offline. **Aceite mínimo:** o bundle exportado recompõe e verifica assinaturas, `sd_hash`, `checkout_hash` e `reference`; alteração de um byte ou ausência de disclosure falha fechada; usuário não autorizado e resposta pública não veem a referência PSP. |
| P1-03 | `/intent` sobrescreve registros sem condição e pode reabrir estado terminal ou resetar o orçamento de OTP. | `chatbot-bff/src/ap2/intent-store.ts:102-110`; `chatbot-bff/src/ap2-handler.ts:304-320` | **Como resolver:** usar chave canônica por owner+session, versão e conditional write que permita criar quando ausente ou atualizar apenas o estado esperado; rotação/supersede deve ser operação explícita e atômica. **Aceite mínimo:** requests duplicados ou concorrentes convergem para uma versão canônica; intent terminal não volta a `PENDING`; contador/limite de OTP não diminui por retry. |
| P1-04 | Cart idempotente usa `Scan` + `Put` com `cartId` aleatório; concorrência pode criar mais de um checkout para a mesma journey e a seleção do “mais recente” fica indeterminada. | `ap2-core/src/adapters-aws/dynamo-repos.ts:51-103`; `ap2-core/src/domain/entities/merchant.ts:128-226` | **Como resolver:** modelar PK ou GSI por owner+journey/idempotency key, criar com condição de unicidade e retornar o registro vencedor em conflito; definir ordenação/versionamento explícito se múltiplas versões forem permitidas. **Aceite mínimo:** criações concorrentes com a mesma chave retornam o mesmo `cartId` e hash; a leitura não usa `Scan` nem depende de `Items[0]`. |
| P1-05 | Scans/queries sem paginação podem truncar em 1 MiB, omitir registros e degradar custo/latência. | `ap2-core/src/adapters-aws/dynamo-repos.ts:51-103,275-295`; `chatbot-bff/src/ap2/intent-store.ts:106-151`; `chatbot-bff/src/ap2/evidence-store.ts:34-56` | **Como resolver:** definir access patterns, criar GSIs adequados e substituir `Scan` por `Query`; implementar cursor opaco baseado em `LastEvaluatedKey`, page size limitado e backfill/migração dos índices. **Aceite mínimo:** dataset acima de 1 MiB é percorrido sem perda ou duplicação entre páginas, com ordem documentada; caminhos críticos não executam `Scan`. |
| P1-06 | Conversa e cache de cart do agent são process-local; restart perde estado e réplicas podem divergir ou misturar writes concorrentes. | `agent/src/index.ts:9-79`; `agent/src/tools/ap2/tools.ts:30-59,158-282` | **Como resolver:** mover estado para store durável cifrado, chaveado por tenant/owner/session, com TTL, optimistic version ou lease e operações idempotentes; manter artefatos de pagamento opacos ao modelo e apagar estado após handoff/expiração. **Aceite mínimo:** restart ou troca de réplica preserva a sessão correta; writers obsoletos são rejeitados; sessões de owners distintos permanecem isoladas e expiram no prazo definido. |
| P1-07 | `/confirm` mantém toda a cadeia de pagamento dentro do timeout síncrono da API; timeout do cliente pode ocultar um processamento ainda ativo. | `infra/src/stacks/bff-stack.ts:314-360`; `chatbot-bff/src/ap2-handler.ts:407-470` | **Como resolver:** após claim atômico, iniciar workflow durável (por exemplo Step Functions/SQS), retornar `202` com operation ID owner-scoped e expor polling/SSE; aplicar deadline, retry idempotente e reconciliação por hop. **Aceite mínimo:** a API responde antes do timeout, retry do cliente retorna a mesma operação, restart de worker não perde progresso e todo processamento termina em estado consultável `SETTLED`, `FAILED` ou `UNKNOWN`. |
| P1-08 | Alarmes cobrem falhas técnicas básicas, mas não outcomes de negócio; pagamentos presos ou divergência de receipt podem não gerar resposta operacional. | `infra/src/stacks/bff-stack.ts:447-496`; `chatbot-bff/src/handler.ts:51-146` | **Como resolver:** emitir métricas estruturadas nas transições, sem PII, para latency, throttles, intents presos, `UNKNOWN`, receipt mismatch, OTP delivery e dependências Dynamo/KMS/Bedrock/WAF; criar dashboards, alarmes e runbooks com owner. **Aceite mínimo:** sinais sintéticos de cada condição crítica acionam o alarme dentro do SLO, apontam para runbook e permitem localizar a operação por correlation ID sem expor segredo. |
| P1-09 | O profile `prod` permite WAF desabilitado e Cognito threat protection em `audit`; uma configuração insegura ainda sintetiza/deploya. | `infra/src/config.ts:105-117,198-264` | **Como resolver:** transformar WAF associado às bordas e threat protection `enforced` em invariantes fail-closed de produção; para piloto, exigir decisão explícita versionada; adicionar assertions CDK/profile gate sem escape silencioso. **Aceite mínimo:** configuração `prod` com WAF off ou proteção abaixo de `enforced` falha antes do deploy, e o template sintetizado demonstra as associações esperadas. |
| P1-10 | Não há gate demonstrado de residência/DLP nem política de egress do agent; prompts podem usar região/modelo ou destinos incompatíveis com o perfil de dados. | `infra/src/stacks/agent-stack.ts:149-164,195-286` | **Como resolver:** versionar política de regiões/modelos permitidos, classificar e redigir dados antes do prompt, aplicar Guardrail quando adequado e restringir egress por endpoint/proxy/allowlist conforme threat model; configuração deve falhar fechada. **Aceite mínimo:** região, modelo e destino não autorizados são recusados; fixtures classificadas pela política como proibidas para IA/log não chegam ao modelo nem ao log; a decisão de residência e os fluxos permitidos ficam verificáveis no profile. |
| P1-11 | API pública usa validação ad hoc e contratos majoritariamente TypeScript-only; clientes e runtime podem discordar sobre payloads e erros. | `chatbot-bff/src/ap2-handler.ts:195-221,354-361`; `ap2-core/src/validate.ts:181-252` | **Como resolver:** definir OpenAPI/JSON Schema versionado como fonte única, validar body/query/headers e limite de bytes no runtime, padronizar error envelope e gerar tipos/clients; estabelecer política de compatibilidade. **Aceite mínimo:** campos desconhecidos, payload malformado ou oversized falham com código estável; client gerado e handler passam os mesmos contract cases; breaking change exige nova versão. |
| P1-12 | Merchant/BFF confiam no receipt retornado pelo MPP sem revalidá-lo; receipt trocado, adulterado ou referenciando outro mandate pode contaminar estado/evidence. | `ap2-core/src/domain/entities/merchant.ts:334-398`; `chatbot-bff/src/ap2-handler.ts:454-508` | **Como resolver:** centralizar um verifier na fronteira de confiança que valide schema v0.2 fixado, assinatura e signer confiável, tipo/audience quando presentes, tempo quando aplicável, `reference`, status e cadeia antes de persistir ou expor. **Aceite mínimo:** mutações isoladas de assinatura, signer, status ou `reference` são recusadas sem marcar settlement; receipt válido é preservado integralmente e vinculado ao mandate esperado. |

### 6.3 P2/P3 — hardening do starter

| ID | Problema e impacto | Evidência | Como resolver e aceite mínimo |
|---|---|---|---|
| P2-01 | Eventos `[SYSTEM EVENT]` são texto criado pelo cliente e imitável; conteúdo do usuário pode parecer uma instrução confiável. | `chatbot-frontend/src/components/ChatExperience.tsx:20-39,122-145` | **Como resolver:** transportar eventos em envelope tipado criado/autenticado pelo servidor, fora do campo de texto e com allowlist de tipos; o agent nunca deve inferir privilégio por prefixo textual. **Aceite mínimo:** mensagem do usuário contendo literalmente `[SYSTEM EVENT]` continua com role `user` e não altera estado, prompt de sistema ou disponibilidade de tools. |
| P2-02 | Falha ao abrir o gate vira `console.warn`/card ausente e decline é fire-and-forget; o usuário pode perder recuperação ou acreditar que recusou antes do servidor confirmar. | `chatbot-frontend/src/lib/ap2/api.ts:71-85`; `chatbot-frontend/src/components/ap2/CheckoutCard.tsx:106-113` | **Como resolver:** modelar estados `opening`, `open`, `declining`, `error` e `closed`; exibir erro recuperável com retry e manter o card até receber ack idempotente do decline. **Aceite mínimo:** falha de rede preserva contexto e oferece retry; UI só mostra “recusado” após ack; retries/duplo clique convergem para o mesmo estado terminal. |
| P2-03 | CSP permite qualquer `execute-api` da região e tokens Amplify usam o storage padrão; uma origem comprometida aumenta o alcance de exfiltração. | `infra/src/stacks/frontend-stack.ts:78-110` | **Como resolver:** gerar `connect-src` com os hosts exatos do deployment, remover wildcard regional e documentar a decisão de armazenamento de sessão; conforme o threat model, usar memória ou cookie `HttpOnly`, `Secure` e `SameSite` mediado por BFF, com defesa XSS/CSRF correspondente. **Aceite mínimo:** browser bloqueia API não allowlisted; somente as origens necessárias funcionam; testes de segurança demonstram que o mecanismo escolhido não expõe token a um vetor que a ADR declarou fora da tolerância. |
| P2-04 | Dialog MFA não demonstra focus trap/restauração e loading pode renderizar `null`; teclado/leitor de tela pode perder contexto. | `chatbot-frontend/src/components/TwoFactorDialog.tsx:24-35,115-137`; `chatbot-frontend/src/App.tsx:18-28,70-113` | **Como resolver:** usar primitive de dialog acessível ou implementar trap, foco inicial, restauração, rótulo/descrição e política de Escape; renderizar fallback com `aria-busy`/status durante loading. **Aceite mínimo:** fluxo completo funciona somente por teclado, foco não escapa nem se perde ao fechar, axe/component test não reporta violação crítica e loading nunca deixa tela silenciosa indefinidamente. |
| P2-05 | Erros de tools podem enviar `err.message` ao modelo; detalhes internos, identificadores ou segredos podem entrar no contexto. | `agent/src/tools/ap2/tools.ts:59-68` | **Como resolver:** criar taxonomia de erros públicos com código, retryability e mensagem segura; mapear exceções internas no boundary da tool, registrar detalhes apenas server-side com correlation ID e redaction. **Aceite mínimo:** exceção contendo segredo/stack/URL interna resulta em código público estável para o modelo e nenhum dado sensível no prompt ou resposta; logs mantêm diagnóstico redigido e correlacionável. |
| P2-06 | Além do lifecycle operacional de P0-08, discovery/trust list interoperável de issuers não é demonstrada; rotação externa pode quebrar verificação ou aceitar issuer indevido. | `infra/src/stacks/security-stack.ts:49-100`; `ap2-core/src/domain/sdjwt.ts:268-349` | **Como resolver:** definir registry/JWKS versionado que mapeie issuer a `kid`, algoritmo e papéis permitidos; implementar cache/refresh, janela de sobreposição, revogação e test vectors de rollover. **Aceite mínimo:** rotação válida ocorre sem downtime, chave revogada/desconhecida ou algoritmo não permitido falha fechado, e artefatos históricos continuam verificáveis pela política de retenção. |
| P2-07 | Contrato de compatibilidade/migração de tabelas e artefatos não é demonstrado; deploy pode tornar registros existentes ilegíveis ou impedir rollback. | `infra/src/stacks/data-stack.ts:40-139` | **Como resolver:** adicionar `schemaVersion`, leitores backward-compatible, ordem de deploy expand/migrate/contract, backfill idempotente com checkpoint e plano de rollback. **Aceite mínimo:** versões antiga e nova coexistem durante rollout, migração interrompida retoma sem duplicação/perda, rollback lê os dados ainda suportados e versão desconhecida falha de forma explícita. |
| P3-01 | Seis installs/locks independentes aumentam custo e risco de drift, embora também preservem isolamento entre packages. | `package.json:7-16` | **Como resolver:** avaliar npm workspaces ou ferramenta equivalente, centralizando scripts e política de dependências sem acoplar artefatos implantáveis; registrar ADR caso locks separados sejam mantidos. **Aceite mínimo:** existe um bootstrap reproduzível documentado, CI detecta drift e cada package continua construível/publicável de forma independente; a decisão escolhida tem owner e rationale. |
| P3-02 | Node, package manager e versões de TypeScript/toolchain não são formalizados de modo uniforme; local e CI podem compilar com runtimes diferentes. | `package.json`; `infra/package.json`; `.github/workflows/ci.yml:31-40` | **Como resolver:** declarar `engines`, `packageManager` com versão exata e arquivo de runtime (`.nvmrc`/`.node-version` ou equivalente); alinhar TypeScript/tooling ou documentar matriz de compatibilidade. **Aceite mínimo:** runtime incompatível falha cedo, bootstrap local e CI usam as mesmas versões e divergência intencional entre packages fica explicitamente testada/documentada. |
| P3-03 | O perfil AP2 local e suas extensões não estão reunidos em um contrato de interoperabilidade; nova equipe pode confundir extensão com requisito v0.2. | `ap2-core/src/domain/mandates.ts:55-114`; `ap2-core/src/domain/entities/consent-mandates.ts:90-198`; `ap2-core/src/domain/entities/credential-provider.ts:247-297` | **Como resolver:** publicar documento/ADR versionado com o commit AP2 baseline, mapeamento CartMandate→Checkout JWT, papéis e relay da credencial, receipt profile, trust assumptions e extensões `presence`, ConsentProof e evidence; ligar schemas e vectors fixados. **Aceite mínimo:** cada campo/etapa é classificável como v0.2, perfil local ou extensão, e uma equipe nova consegue gerar e verificar o happy path sem depender de conhecimento oral. |

## 7. Avaliação por domínio

### 7.1 CDK e infraestrutura

**Pontos fortes**

- Perfis `demo|pilot|prod` e pin obrigatório de account/region nos perfis regulados: `infra/src/config.ts:34-61,123-177`.
- Pilot/prod recusam signup público, OTP revelado, CORS `*`, ausência de email de alerta, MFA não required, threat protection off e `RETAIN_DATA=false`: `infra/src/config.ts:198-264`.
- Cognito authorizer em endpoints externos, SRP, ocultação de existência e sem Identity Pool: `infra/src/stacks/auth-stack.ts:55-76,263-282`; `infra/src/stacks/bff-stack.ts:217-255,300-310,430-446`.
- Funções/roles distintas para chat, admin, checkout e entidades; keys por ator; evidence write-only para atores.
- API throttling, quotas por `sub`, access logs sem payload e headers CSP/HSTS na borda.
- DynamoDB PITR e retain por default constituem baseline útil para demo/piloto.

**Gaps demonstrados ou não cobertos pelos stacks examinados**

- Ausência de `DEPLOY_PROFILE` cai silenciosamente em demo: `infra/src/config.ts:48-60`.
- WAF permanece opt-in em todos os perfis; proteção equivalente em todas as bordas não é demonstrada.
- AgentCore usa `networkMode: PUBLIC`; o stack não declara política VPC/egress allowlist. Isso não significa endpoint anônimo, pois a invocação continua protegida por SigV4.
- Tabelas usam criptografia gerenciada pelo serviço e o frontend usa SSE-S3; decisão CMK por classificação não é demonstrada.
- Os stacks não declaram backup cross-account/region, restore drill, deletion protection explícita, global tables ou failover.
- Retenção é inconsistente: várias tabelas não têm TTL de negócio e os Log Groups explicitamente criados pelo BFF usam um mês.
- Estratégia operacional de rotação/versionamento/revogação de signing keys e HMAC não é demonstrada.
- Os alarmes versionados não cobrem a cadeia completa de pagamento, AgentCore/Bedrock, WAF, Dynamo/KMS e reconciliação.
- O workflow versionado não demonstra promoção de artefato imutável por ambiente.

**Nota:** CDK bem estruturado não substitui controles de conta AWS, Organizations/SCP, CloudTrail organizacional, Config/Security Hub/GuardDuty, gestão de domínios/certificados e runbooks, que não podem ser inferidos deste repositório.

### 7.2 Backend e domínio AP2

**Pontos fortes**

- Limites/shape validation nas fronteiras do core: `ap2-core/src/validate.ts:1-35,181-252`.
- Selo HMAC, OTP aleatório, hash-only storage e comparação constant-time: `chatbot-bff/src/ap2/intent.ts:24-152`.
- Owner derivado de Cognito e reafirmado por identity JWS KMS.
- Lease no ConsentSession, credential single-use, `jti` por verifier e idempotency reservation antes do PSP.
- Erros externos estáveis e logging com redaction de OTP/token/secret/PAN/CVV.
- Separação clara de ports/adapters facilita substituir memory/Dynamo/KMS/PSP.

**Gaps**

- State machine distribuída e reconciliação insuficientes.
- Validação pública do BFF é inferior à validação do core.
- Contratos não são publicados/versionados para consumidores.
- Scans, falta de paginação e ausência de unicidade por journey limitam escala/correção.
- Error receipts e status AP2 são achatados em HTTP 422/200 de forma pouco expressiva.
- PSP decline vira `settled` com `status=Error`; faltam estados operacionais explícitos.
- Falha de SMS pode ser engolida e não há delivery telemetry.
- Evidence não é transacional com mudança de estado nem side effect financeiro.

### 7.3 Frontend

**Pontos fortes**

- Aprovação/OTP vão direto ao BFF, nunca ao agent.
- Step-up é recalculado server-side; cliente não decide o threshold.
- Campo OTP possui label/describedby e estados usam live regions/alerts.
- Markdown usa `react-markdown`, sem `dangerouslySetInnerHTML`, e links externos usam `noopener noreferrer`.
- CloudFront aplica CSP/HSTS/frame protections.

**Gaps**

- Termos finais não são itemizados pela Trusted Surface.
- Erro ao abrir gate pode simplesmente remover o card.
- Decline fecha a UI antes do ack.
- Receipt JWS e Checkout Receipt não são exibidos/downloadable/verificáveis.
- CSP de API é mais ampla que o endpoint do app.
- Não foram localizados testes de componentes/DOM/accessibility; a configuração Vitest frontend usa ambiente Node e escopo de lib: `chatbot-frontend/vitest.config.ts:1-10`.

### 7.4 Agent

**Pontos fortes**

- Toolset propose-only e sem parâmetros `userId` controláveis pelo modelo.
- Identity do caller é vinculada por contexto assíncrono e JWS emitido pelo BFF.
- Cart cache é namespaced por usuário e evita devolver o artefato inteiro ao LLM.
- Requests/entity calls possuem limites e timeouts básicos.
- Agent novo por request reduz interleaving de estado mutável entre callers.

**Gaps**

- Conversa e carts intermediários ficam em `Map`, perdem-se em restart e não são compartilhados.
- Não há lock/versionamento de sessão entre invocações concorrentes.
- Prompt é a principal camada para comportamento de conteúdo; os arquivos examinados não demonstram guardrail/DLP/política de egress equivalente.
- O modelo default global pode atravessar regiões; não há decisão/gate de residência demonstrado no stack.
- Evento “system” é conteúdo textual forjável pelo usuário.
- Role do agent mantém grants mais amplos que as quatro tools.

## 8. Quality gates — avaliação estática

### 8.1 O que está declarado

| Gate | Implementação declarada | Avaliação |
|---|---|---|
| Instalação reproduzível | `npm run bootstrap` usa `npm ci` na raiz e em cinco packages | Positivo: lock por package. Custo: seis instalações e risco de drift sem workspace governance. |
| Lint | `eslint .` na raiz | Abrange o repo conforme ignore/config; configuração central é positiva. |
| Typecheck | Sequencial em core, agent, BFF, infra e frontend | Boa cobertura estática dos cinco packages. |
| Test | `vitest run` nos cinco packages | A orquestração dos cinco packages está declarada; sem execução e sem inferir breadth/coverage apenas pelo script. |
| Verify | lint + typecheck + test | Coerente entre local e CI. |
| Audit | `npm audit --audit-level=high` em raiz e cinco packages | Melhor que gate somente critical, mas não cobre imagem, licença, malware/proveniência ou risco transitivo contextual. |
| CI | Node 22, actions fixadas por SHA, token read-only, timeout de 20 min | Boas práticas claras em `.github/workflows/ci.yml:13-58`. |
| Builds | `infra` pretest constrói core, BFF e frontend | Build do agent não faz parte do gate; não há build root explícito de todos os artefatos. |

### 8.2 Gaps do quality gate

Nos manifests, workflow e configurações examinados, não foram demonstrados gates específicos para:

- threshold de coverage ou mutation testing para state machines/criptografia;
- component tests frontend, browser e2e ou accessibility automation;
- contract tests contra schemas oficiais AP2 fixados;
- corrida/concorrência, fault injection, retry e reconciliation;
- full `cdk synth` incluindo AgentStack/Docker asset, `cdk diff` e assertions de todos os stacks;
- Docker build do agent e smoke da imagem;
- secret scan, SAST/CodeQL, dependency review, IaC scan/CDK Nag e container scan;
- SBOM, licença policy, provenance/attestation e assinatura de imagem;
- base image fixada por digest;
- deploy OIDC por ambiente, approvals, promotion, canary/rollback e smoke pós-deploy;
- restore drill, load/performance ou chaos/failure testing.

O comentário do workflow exclui deliberadamente o full synth que materializa o AgentStack/Docker asset, Docker build e deploy do PR gate: `.github/workflows/ci.yml:1-10`. Testes de infraestrutura podem usar synth de stacks base; portanto, a conclusão não é que “nenhum synth ocorre”, mas que o artefato completo implantável não é um gate. Essa escolha é aceitável para demo e insuficiente para um starter que se propõe a escalar até produção.

### 8.3 Gate mínimo recomendado por perfil

| Perfil | Gate mínimo adicional |
|---|---|
| Demo | build de todos os packages, Docker build da plataforma alvo, `cdk synth`, smoke local/deploy, verificação de defaults sintéticos. |
| Piloto sensível | tudo da demo + AP2 schema/interop, component/e2e, concurrency/fault tests, secret/SAST/IaC/container scan, SBOM/licenças, OIDC deploy, restore test e security review. |
| Produção | tudo do piloto + artefato assinado/promovido, policy-as-code, canary/rollback, pós-deploy smoke, performance/SLO, reconciliation/failure injection e DR drill recorrente. |

## 9. Roadmap priorizado

A ordem abaixo é por dependência e risco, não por facilidade. Os IDs explícitos em cada item apontam para os findings acionáveis da seção 6; todos os P0–P3 aparecem em pelo menos uma fase.

### Fase D0 — tornar a demo realmente controlada

**Objetivo:** manter o uso atual sem sugerir segurança de piloto.

1. exigir conta sandbox isolada, identidades sintéticas e nenhum instrumento/PSP real;
2. fechar cadastro público e CORS para o público da demo;
3. tornar “OTP de demonstração” visualmente inequívoco;
4. habilitar WAF se houver exposição à Internet;
5. impedir operacionalmente confirmações/declines concorrentes como mitigação temporária de P0-01;
6. produzir evidência manual/CI de build, synth, imagem e smoke.

**Exit criteria:** runbook de demo, inventário de dados sintéticos, acesso limitado, custos/alertas ativos e nenhum claim de “produção” ou “strict AP2 conformance”.

### Fase P0-A — correção de autorização e conformidade AP2

**Dependências:** nenhuma; iniciar primeiro.

1. P0-01/P1-03: state machine atômica, reject da ConsentSession e writes condicionais que não reabrem intent terminal;
2. P0-03: validação completa de instrument/currency/payee no CP;
3. P0-04: consent card itemizado e server-derived;
4. P0-02: receipts canônicos, preservados e distribuídos;
5. P1-01/P1-02/P1-12: emissão recuperável, evidence correto e verificação de receipts;
6. fixar test vectors e schemas oficiais pelo commit da baseline.

**Exit criteria:** matriz AP2 sem “Não conforme”; concorrência não produz pagamento após decline; bundle de disputa verifica offline; todos os receipts validam no schema fixado.

### Fase P0-B — liberar piloto fechado com dados sensíveis

**Dependências:** P0-A.

1. P0-05: implementar step-up transacional real quando exigido pela política de risco;
2. P0-07: split de operações e IAM por principal/operação;
3. P0-08: retenção/DSAR/key lifecycle/backup/restore/RTO/RPO;
4. P1-09/P1-10: WAF, network/egress, signup invite-only, MFA required, threat protection e residência definidos;
5. P1-08: observabilidade de negócio, alertas de segurança e incident runbooks;
6. pipeline com scans, SBOM, OIDC e promoção de ambiente;
7. DPIA/threat model e decisão formal de residência/modelo.

**Exit criteria:** restore drill aprovado; nenhum demo default passa no profile pilot; principal do agent não alcança operações financeiras; incidentes e DSAR têm runbooks testados; dados reais têm retenção e ownership definidos.

### Fase P0-C — pagamentos reais e produção pública

**Dependências:** P0-A e P0-B.

1. P0-06: adapter PSP/adquirente, tokenização, webhooks e reconciler;
2. boundary PCI e 3DS/SCA conforme mercado/adquirente;
3. P1-07: workflow assíncrono durável para checkout/payment;
4. P1-06: store distribuído e concurrency control do agent;
5. P1-04/P1-05: GSIs, unicidade, paginação e eliminação de scans de caminho crítico;
6. HA/DR multi-região conforme RTO/RPO;
7. WAF/threat protection enforced, egress controlado e SLOs;
8. load, failure injection, canary, rollback e pós-deploy verification.

**Exit criteria:** nenhuma falha ambígua gera segunda cobrança; RPO/RTO e SLO são medidos; failover e reconciliação são demonstrados; artefato implantado é o mesmo assinado/promovido pelo pipeline.

### Fase P2 — transformar em starter reutilizável

1. P1-11: publicar OpenAPI/JSON Schemas e clients versionados;
2. P3-03: documentar o perfil AP2 local e decisões sobre ambiguidades da v0.2;
3. P2-06: trust registry, key discovery/rotation/revocation e interop suite;
4. P2-01: envelopes tipados para eventos do agent;
5. P2-02/P2-04: component/a11y tests e UX recuperável de erro/decline/receipt;
6. P2-07: migrations e compatibility policy;
7. P3-01/P3-02: consolidar toolchain/monorepo quando adequado e fixar runtime/base images;
8. P2-03: restringir CSP às origens exatas e formalizar o modelo de armazenamento de sessão/token;
9. P2-05: aplicar taxonomia e redaction de erros no boundary das tools.

**Exit criteria:** uma equipe nova consegue escolher demo/pilot/prod sem conhecer defaults implícitos; contratos, controles e gates são selecionados pelo perfil e falham fechados.

## 10. Critérios objetivos para mudar os vereditos

### Demo: de GO condicional para GO

- configuração demonstra apenas dados e métodos sintéticos;
- acesso e origem são restritos;
- build/synth/image/smoke têm evidência;
- limitações de concorrência e OTP sandbox estão explícitas;
- nenhum dado pessoal real é inserido.

### Piloto: de NO-GO para GO condicional

- P0-01 a P0-04, P0-07 e P0-08 concluídos; P0-05 concluído quando a política exigir step-up, ou decisão de risco documentada quando não exigir;
- receipts conformes e bundle de disputa verificável;
- state machine atômica e controle de step-up compatível com a política de risco, com canal transacional real sempre que exigido;
- política de dados, restore drill, IAM/rede e incident response aprovados;
- pipeline mínimo de segurança e deploy ativo;
- se PSP continuar simulado, piloto não movimenta dinheiro real e isso está contratualmente claro.

### Produção: de NO-GO para GO condicional

- todos os P0 e P1 concluídos;
- PSP real, PCI boundary, reconciliação, refunds/voids/disputes;
- store distribuído, paginação, workflow durável e observabilidade por SLO;
- HA/DR ensaiados;
- supply chain com artefatos assinados, promoção e rollback;
- revisão externa de segurança, privacidade e interoperabilidade AP2.

## 11. Decisões recomendadas

1. **Manter a separação agent propose-only / BFF Trusted Surface.** É a melhor decisão arquitetural do template.
2. **Não adicionar settlement como tool do modelo.** Corrigir IAM para que o runtime também reflita essa intenção.
3. **Tratar o fluxo atual como perfil AP2 local, não como conformidade genérica**, até resolver receipts e documentar ambiguidades.
4. **Não implementar `IntentMandate` apenas para “passar v0.2”.** Ele não é requisito do direct core; só adicioná-lo se houver objetivo funcional/auditável próprio.
5. **Priorizar correção de estado e receipts antes de novos features.** São os riscos que afetam autorização, dinheiro e prova.
6. **Separar claramente piloto com dados reais de piloto com dinheiro real.** O primeiro já exige P0-B; o segundo também exige P0-C.
7. **Transformar profiles em policy-as-code de release**, não somente validações de env no synth.

## 12. Veredito final

O template demonstra boa compreensão de trust boundaries agentic e contém mais controles criptográficos e de concorrência local que um protótipo comum. Para demos controladas, ele é um ponto de partida forte. Para piloto sensível, os riscos não estão em “falta de criptografia”, mas na composição entre UX de consentimento, state machines, IAM, step-up, dados e operação. Para produção pública, o maior salto é sair de uma cadeia síncrona com PSP e estado simulados para uma plataforma financeira reconciliável, observável, governada e recuperável.

**Classificação final:**

- **Demo controlada:** aprovada com condições e dados exclusivamente sintéticos.
- **Piloto fechado com dados sensíveis:** não aprovado no estado atual.
- **Produção pública:** não aprovada no estado atual.
- **AP2 v0.2 human-present/cartão:** caminho nominal substancialmente alinhado, porém conformidade estrita ainda não demonstrada devido aos gaps explícitos de receipt, distribuição, verificação de escopo, consentimento e disputa.

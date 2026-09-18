# Plano de CD — deploy na AWS ao fazer commit na `main`

> Status: **plano aprovado, implementação pendente.** Este documento descreve o desenho
> acordado; nenhum arquivo de workflow ou stack de bootstrap foi criado ainda.

## Objetivo

Permitir que um merge na branch `main` dispare um deploy automático na AWS, **mantendo intactas**
as garantias que o template já oferece:

- `ci.yml` continua sendo o gate **sem credenciais** (roda em qualquer fork, em qualquer plano).
- O deploy manual da máquina (`npm run deploy`) continua funcionando exatamente como hoje.
- **Zero chaves de longa duração** no GitHub — autenticação via OIDC.
- Mantém `cdk deploy --all --require-approval broadening` (nunca `deploy:no-approval` no pipeline).

Fecha o gap **OPS-01 / P2-01** (`assessment-v4.md`) e **P1 / B7** (`assessment.md`): hoje
`deploy` roda de uma máquina de dev com credenciais ambientes, e o CI nunca valida um template
contra uma conta.

## Escopo (decisões da Fase 0)

| Decisão | Escolha |
|---|---|
| Ambientes | **Um só: `main → prod`, deploy automático no merge.** |
| dev / hml | **Roadmap** (não neste primeiro corte). |
| `cdk diff` no PR | Fora deste corte (pode entrar depois, em job OIDC read-only separado). |
| Bootstrap de acesso | **Stack CDK separado e independente** (`infra/bootstrap/`), deployado à mão uma vez. |
| CD é opcional? | **Sim.** Um clone que nunca faz o setup continua idêntico ao de hoje. |

## Princípio 1 — O CD é puramente aditivo e opt-in

Um clone que **nunca** roda o setup tem que ter: testes verdes, `synth` verde e o deploy manual
funcionando — igual a hoje. Isso se apoia em quatro fronteiras já verificadas no repo:

1. **`infra/src/app.ts` não lê nenhuma variável de GitHub/OIDC.** O synth e o `cdk deploy` do app
   principal independem do setup ter acontecido. Nenhuma variável nova é obrigatória.
2. **O bootstrap é um segundo entrypoint CDK** (`cdk --app "npx tsx bootstrap/bootstrap-app.ts"`).
   Ele tem seu próprio `new cdk.App()`, então **nunca** entra no `cdk deploy --all` do app principal.
   Quem não roda, nunca o vê. A separação é estrutural, não convencional.
3. **`ci.yml` fica intacto e credential-free.** O gate que todo fork herda não passa a exigir
   credencial.
4. **`deploy.yml` tem um guard de opt-in** (ver Princípio 2): sem a role configurada, ele encerra
   **verde com um aviso**, não em vermelho.

## Princípio 2 — Guard de opt-in no `deploy.yml`

O `deploy.yml` dispara no push à `main`, mas o **primeiro step** verifica se a variável
`AWS_DEPLOY_ROLE_ARN` (GitHub Environment `prod`) existe:

- **Não configurada** → o job encerra com **sucesso** e imprime:
  `"CD não configurado — rode infra/bootstrap/ para habilitar (opcional). Veja docs/cd-plan.md."`
  O fork vê verde e uma instrução, nunca um erro.
- **Configurada** → o job assume a role por OIDC e roda `npm run deploy`.

## Como o OIDC funciona (autenticação sem chave)

```
GitHub Actions (roda o job de deploy)
   │  apresenta um token OIDC assinado: "sou repo gabrielmissio/aws-agentic-app-starter, ref main"
   ▼
AWS IAM OIDC Identity Provider  ← confia em token.actions.githubusercontent.com
   │  valida o token e permite assumir...
   ▼
IAM Role de deploy  ← trust policy restrita a repo:.../aws-agentic-app-starter:ref:refs/heads/main
   │  credenciais temporárias (~1h), escopadas
   ▼
cdk deploy --all --require-approval broadening
```

Nenhum segredo AWS vive no GitHub. O runner **troca** o token de identidade do próprio GitHub por
credenciais temporárias da AWS, e a role só confia em jobs vindos deste repo, na branch `main`.

## Arquitetura de arquivos

```
infra/
  src/
    app.ts                 ← os 4 stacks (agent/auth/bff/frontend) — INTACTO, o pipeline deploya isto
    stacks/…
  bootstrap/               ← NOVO, independente e opcional
    bootstrap-app.ts       ← 2º entrypoint CDK (novo new cdk.App())
    github-oidc-stack.ts   ← OIDC provider + IAM role de deploy escopada a main
    README.md              ← "rode uma vez, com perfil admin"
.github/
  workflows/
    ci.yml                 ← INTACTO, credential-free
    deploy.yml             ← NOVO, com guard de opt-in
```

## O stack de bootstrap (`infra/bootstrap/github-oidc-stack.ts`)

Cria, de forma idempotente:

1. **OIDC Identity Provider** para `token.actions.githubusercontent.com` (um por conta; reaproveita
   se já existir de outro projeto — o stack deve lidar com o caso "já existe").
2. **IAM Role de deploy** com:
   - **Trust policy** condicionada a
     `token.actions.githubusercontent.com:sub = repo:gabrielmissio/aws-agentic-app-starter:ref:refs/heads/main`
     (só esse repo, só a branch `main`).
   - **Permissions escopadas**: em vez de `AdministratorAccess`, só `sts:AssumeRole` nas roles que o
     `cdk bootstrap` já criou (`cdk-hnb659fds-deploy-role-*`, `-file-publishing-role-*`,
     `-image-publishing-role-*`). Quem tem os poderes de fato é o CDK; a role do GitHub só "vira" o CDK.
3. **Output**: o ARN da role, que vira a variável `AWS_DEPLOY_ROLE_ARN` no Environment `prod`.

Pré-requisito da conta: `cdk bootstrap` padrão (qualifier `hnb659fds`) já executado. O stack de
bootstrap **só** cuida do OIDC+role; os dois passos ficam documentados juntos no README.

### O chicken-egg de permissões (por que é feito à mão, uma vez)

Criar um OIDC provider e uma IAM role é uma ação privilegiada de IAM. O pipeline não pode
se auto-provisionar (ainda não tem acesso). Então a **primeira vez** é executada por alguém com
acesso admin na conta — provavelmente o mesmo perfil que hoje roda `npm run deploy`:

```
cd infra
npx cdk --app "npx tsx bootstrap/bootstrap-app.ts" deploy
```

O agente **não** executa este passo: é uma ação privilegiada na conta do usuário. O artefato é
entregue e revisável; o usuário (ou o admin da conta) executa.

## O workflow `deploy.yml`

- **Trigger**: `push: branches: [main]` + `workflow_dispatch` (deploy manual pelo botão).
- **`permissions`**: `id-token: write`, `contents: read`.
- **`concurrency`**: por ref, `cancel-in-progress: false` (não cancelar um deploy em voo).
- **`environment: prod`** (habilita futuros required reviewers sem mudar o workflow).
- **Steps**:
  1. **Guard de opt-in** — se `vars.AWS_DEPLOY_ROLE_ARN` vazio, encerra verde com aviso.
  2. `actions/checkout` (pinado por SHA, como o `ci.yml`).
  3. `actions/setup-node@22` + cache npm.
  4. `npm run bootstrap` (instala root + subpacotes).
  5. **Runner ARM64 nativo** (`runs-on: ubuntu-24.04-arm`) — o agent-stack constrói uma
     `DockerImageAsset` ARM64 (Graviton), que o CDK constrói para a arquitetura do runner no deploy.
     Build nativo dispensa QEMU/binfmt (emulação 5-10x mais lenta, feita para multi-arch). Nota para
     forks **privados**: runner ARM64 hospedado é grátis em repo público, **cobrado** em privado —
     alternativa documentada no workflow (voltar a `ubuntu-latest` + `docker/setup-qemu-action`).
  6. `aws-actions/configure-aws-credentials@v6.2.4` (OIDC, `role-to-assume`, `role-duration-seconds`
     explícito casando com o `maxSessionDuration` da role).
  7. Materializa `.env` a partir das vars do Environment (rejeita valores com newline).
  8. `npm run deploy` (`cdk deploy --all --require-approval broadening`).

### Ponto técnico a resolver na implementação

`infra` roda `dotenvx run -f .env --overload -- cdk deploy`, ou seja, **exige um arquivo `.env`**.
O pipeline não versiona `.env`. Duas saídas, a decidir na implementação:

- **(a)** Um step gera o `.env` a partir das vars/secrets do Environment `prod`
  (`DEPLOY_PROFILE`, `DEPLOY_ACCOUNT`, `DEPLOY_REGION`, `PROJECT_NAME`, e as flags gated) antes do
  `npm run deploy`.
- **(b)** Adicionar um script `deploy:ci` no `infra/package.json` que não dependa de `-f .env`
  (dotenvx lê do ambiente). Mais limpo, mas mexe no `package.json`.

Recomendação: **(a)** no primeiro corte (não altera scripts existentes), **(b)** como refino.

## GitHub Environment `prod` — variáveis a configurar (pós-bootstrap)

| Nome | Tipo | Origem |
|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | var | output do stack de bootstrap |
| `DEPLOY_ACCOUNT` | var | conta AWS de destino |
| `DEPLOY_REGION` | var | região de destino |
| `DEPLOY_PROFILE` | var | `prod` (o gate de posture do `config.ts` exige as flags corretas) |
| `PROJECT_NAME` | var | nome do projeto |

Nota: `DEPLOY_PROFILE=prod` aciona `assertDeploymentPosture` no `config.ts`, que **recusa** defaults
de sandbox. As flags obrigatórias sob `prod` (tracing, retenção, guardrail etc.) precisam estar
setadas nas vars do Environment, ou o deploy falha por design — o que é o comportamento correto.

## Fases de implementação

- **Fase 1 — Stack de bootstrap** (`infra/bootstrap/`): entrypoint + `github-oidc-stack.ts` + README.
  Verificar que `cdk --app "…app.ts" deploy --all` **não** enxerga o stack de bootstrap.
- **Fase 2 — `deploy.yml`**: guard de opt-in, OIDC, ARM64, geração de `.env`, `npm run deploy`.
- **Fase 3 — Docs**: seção "CD é opcional" no `README.md`; corrigir o bullet "no CD pipeline"
  (fecha DOC-04); atualizar `CONTRIBUTING.md`.
- **Verificação**: `ci.yml` permanece byte-idêntico; `npm run synth` verde sem nenhuma var nova;
  `deploy.yml` passa no guard num fork sem setup (verde + aviso).

## Roadmap (fora deste corte)

- **Múltiplos ambientes** (`dev` / `hml` / `prod`): matriz de Environments, uma role por ambiente,
  promoção `dev → hml → prod`.
- **`cdk diff` no PR**: job separado, OIDC com role **read-only**, comenta o diff no PR.
- **Approval gate**: required reviewers no Environment `prod`.
- **Dependabot/Renovate** cobrindo os 5 `package.json` + GitHub Actions (recomendação do assessment).

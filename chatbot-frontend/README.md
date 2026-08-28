# Chatbot Frontend

React + Vite chat UI, with Cognito sign-in and an admin panel. It has exactly one transport: every
request goes to the BFF. Repository-level architecture lives in the root [README.md](../README.md).

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Point `VITE_API_URL` at the local BFF (`http://localhost:3001`). `.env.example` documents the rest;
in a deployed environment those values arrive through a `config.js` written at deploy time, not
through a build-time `.env`.

| Script | Purpose |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check and build the production bundle |
| `npm run preview` | Preview the built bundle |
| `npm run typecheck` / `test` | `tsc --noEmit` · vitest |

## Rebranding

The UI is deliberately plain — one blue, one neutral ramp, four status hues, Inter, no imagery — so
a new project looks like its own product after editing two files:

| File | Owns |
|---|---|
| [`src/styles.css`](src/styles.css) | Colour, type and shadow tokens — everything visual resolves to one |
| [`src/lib/brand.ts`](src/lib/brand.ts) | Product name, tagline, and the agent's icon |
| [`src/components/ui/`](src/components/ui) | The primitives every screen is built from |

Two rules keep that cheap. No component hard-codes a colour — `bg-primary` resolves through a token,
so re-theming is never a hunt through JSX. And every class name is written out in full: Tailwind
scans source text, so an interpolated class is simply never generated and the failure is invisible in
review.

## Transport and auth

Chat and admin both go to the BFF at `VITE_API_URL`, authenticated with the Cognito **ID token** — a
REST Cognito authorizer that declares no scopes reads the credential as an identity token and rejects
an access token (the full reasoning sits next to the authorizer in `infra/src/stacks/bff-stack.ts`).

The browser never calls AgentCore, and holds no AWS credentials: Amplify is configured with the user
pool alone, no identity pool. See
[Why the BFF is the only transport](../README.md#why-the-bff-is-the-only-transport).

`VITE_PUBLIC_SIGNUP_ENABLED` (mirroring `PUBLIC_SIGNUP_ENABLED` in `infra/`) switches
[`AuthScreen`](src/components/AuthScreen.tsx) between self sign-up and invite-only, where the first
sign-in answers Cognito's `NEW_PASSWORD_REQUIRED` challenge.

## Admin panel

Members of the Cognito `admins` group get an **Admin** badge in the header opening
[`AdminPanel`](src/components/AdminPanel.tsx). There is no router: no page here is linkable, so
`App.tsx` swaps which component it renders — add one when a deep link becomes real.

The badge is reachability only. [`session-roles.ts`](src/lib/session-roles.ts) reads the
`cognito:groups` claim decoded in the browser, which proves nothing to a server; the BFF re-checks
membership on every call, so a stale or forged client-side claim can under-grant access but never
over-grant it.

## i18n

[`src/lib/i18n/`](src/lib/i18n) is a dependency-free layer: `core.ts` does fallback resolution and
CLDR pluralization via `Intl.PluralRules`, `index.tsx` wires it into React, `messages/` holds one
catalog per locale. A key missing from the active locale falls back to `en-US`; a key missing
everywhere renders as itself, because a visible `admin.inviteTitle` is a bug report where an empty
string looks like a blank label.

The locale is detected once (`localStorage`, then the browser, then English) and switchable at
runtime. Signing up writes it to `custom:inviteLocale` so the account's emails match. Server errors
are localized by `code`, never by prose — the server ships nothing anyone must translate.

## Streaming Markdown

The agent's replies are Markdown arriving a token at a time and not always well formed, so
[`src/lib/markdown.ts`](src/lib/markdown.ts) sits between the stream and the parser: complete lines
parse while the unfinished one stays plain text, a table flattened onto one line is re-chunked by its
delimiter row, and an unclosed code fence is closed for the parse. None of it runs inside a fenced
block, so a code sample may contain a line that looks like a table.

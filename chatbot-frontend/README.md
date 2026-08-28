# Chatbot Frontend

React + Vite chat UI, with Cognito sign-in and an admin panel.

This package owns the browser experience. It has exactly one transport: every request goes to the BFF, which is also the only thing that can reach the AgentCore runtime. Repository-level architecture and deployment context live in the root [README.md](../README.md).

## Local setup

```bash
npm install
cp .env.example .env
npm run dev
```

## Useful scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start the local Vite development server |
| `npm run build` | Type-check and build the production bundle |
| `npm run preview` | Preview the built bundle locally |
| `npm run typecheck` | Run `tsc --noEmit` on its own, without building |
| `npm run test` | Run the test suite (vitest) |

## Design system and reuse

The UI is deliberately plain: one blue, one neutral ramp, four status hues, Inter, and no imagery.
The point is that a new project can start from this package and look like its own product after
editing two files.

| File | Owns |
|---|---|
| [`src/styles.css`](src/styles.css) | The colour, type and shadow tokens — everything visual resolves to one of them |
| [`src/lib/brand.ts`](src/lib/brand.ts) | The product name, its tagline and the agent's icon |
| [`src/components/ui/`](src/components/ui) | The primitives every screen is built from |

`ui/` holds `Button`/`IconButton`, `Card`/`CardHeader`/`CardBody`, `Badge`, `Alert`, `Field`/
`TextInput`/`Select`, `SegmentedControl`, `EmptyState`, `BrandAvatar`/`InitialsAvatar` and the
`AppHeader` shared by the chat and the admin panel. The class strings themselves live
in [`ui/styles.ts`](src/components/ui/styles.ts) as plain functions — so a `<Link>` can look exactly
like a button without wrapping one, and so React Fast Refresh keeps working in the component modules
that import them.

Two rules keep the swap cheap. No component hard-codes a colour: `bg-primary` and `text-muted-
foreground` resolve through the tokens, so re-theming never turns into a hunt through JSX. And every
class name is written out in full — Tailwind scans source text, so an interpolated class is simply
never generated and the failure is invisible in review.

The agent's face is the brand icon in a filled circle rather than an illustration, so a rebrand is a
one-line change and nothing has to be downloaded before the first message renders.

## Transport

There is one, and it is not configurable: the chat stream and the admin routes both go to the BFF at
`VITE_API_URL`, authenticated with the Cognito **id token** — a REST Cognito authorizer declaring no
scopes reads the credential as an identity token and rejects an access token. Sign-in is required
before the chat UI is available.

The browser never calls the AgentCore runtime, and that is not configurable. On a direct path the
agent's identity block — the only way it learns who is asking — would be the opening lines of a
request body the browser composed, so any signed-in user could act as any other. See
[Why the BFF is the only transport](../README.md#why-the-bff-is-the-only-transport).

For the same reason the app holds no AWS credentials: Amplify is configured with the user pool alone,
with no identity pool.

## Sign-up mode

`VITE_PUBLIC_SIGNUP_ENABLED` (mirrors `PUBLIC_SIGNUP_ENABLED` in `infra/`, injected via `config.js` in deployed environments) toggles which auth screen [`AuthScreen`](src/components/AuthScreen.tsx) renders:

- `true` (default): sign in, or sign up and confirm via email code.
- `false`: sign in only — no sign-up form. An admin provisions the account (see [infra/README.md](../infra/README.md#user-provisioning-invite-only)), and the first sign-in answers Cognito's `NEW_PASSWORD_REQUIRED` challenge to replace the temporary password.

## Admin panel

Members of the Cognito `admins` group (see [infra/README.md](../infra/README.md#admin-group)) get an
**Admin** badge in the chat header opening [`AdminPanel`](src/components/AdminPanel.tsx). No router:
there are no linkable pages here, so `App.tsx` swaps which component it renders. Add a router when a
deep link becomes real.

The badge is reachability only. [`src/lib/session-roles.ts`](src/lib/session-roles.ts) reads the
`cognito:groups` claim decoded in the browser, which proves nothing to a server; the BFF's
`/admin/users` routes re-check membership on every call, so a stale or forged client-side claim can
under-grant access but never over-grant it.

## i18n

[`src/lib/i18n/`](src/lib/i18n) is a dependency-free translation layer: `core.ts` does fallback
resolution and CLDR pluralization via `Intl.PluralRules`, `index.tsx` wires it into React
(`useI18n()`, `<I18nProvider>`), and `messages/` holds one catalog per locale. A key missing from the
active locale falls back to `en-US`; a key missing everywhere renders as itself, because a visible
`admin.inviteTitle` is a bug report where an empty string looks like a blank label.

The locale is detected once (`localStorage`, then the browser's languages, then English) and
switchable at runtime. Signing up writes it to `custom:inviteLocale`, so the account's emails match —
see [infra/README.md](../infra/README.md#emails). Server error codes are localized separately:
`translateErrorCode()` maps `emailAlreadyExists` onto `error.emailAlreadyExists`, falling back to the
server's English. The server never ships prose to translate.

## Markdown from the agent

The agent's replies are Markdown, so the renderer has to hold up under text arriving a token at a
time and not always well formed.
[`src/lib/markdown.ts`](src/lib/markdown.ts) sits between the stream and the parser:

- **Complete lines parse, the unfinished one does not.** A table fills in row by row while the line
  still being written stays plain text, so a half-typed row never renders as a broken one.
- **A flattened table is repaired.** `| a | b | |---|---| | c | d |` on one line is a paragraph full
  of pipes to a line-based GFM parser. The delimiter row is the tell, so cells re-chunk into rows by
  the column count it declares — and once it arrives mid-stream the repair applies to the in-flight
  line too, so the table builds as it streams rather than snapping in at the end.
- **An open code fence is closed for the parse**, so a half-written block renders as a block.

None of it runs inside a fenced block, so a code sample may contain a line that looks like a table.
Covered by [`src/__tests__/markdown.test.ts`](src/__tests__/markdown.test.ts).

## Environment variables

Use [chatbot-frontend/.env.example](.env.example) as the source of truth.

| Variable | Required | Purpose |
|---|---|---|
| `VITE_API_URL` | Yes | Base URL for the BFF — `/chat` and `/admin/users` |
| `VITE_COGNITO_USER_POOL_ID` | Yes | Cognito user pool ID |
| `VITE_COGNITO_USER_POOL_CLIENT_ID` | Yes | Cognito app client ID |
| `VITE_AWS_REGION` | Yes | AWS region used by the frontend config |
| `VITE_PUBLIC_SIGNUP_ENABLED` | No | `false` hides self sign-up and switches the auth screen to invite-only. Defaults to enabled |
| `VITE_COGNITO_MFA` | No | `off` \| `optional` \| `required` — which second-factor surfaces the app offers. Mirrors `COGNITO_MFA` in `infra/` |

## Notes

- The deployed frontend receives runtime configuration through `config.js`
- The app uses Cognito through Amplify for browser authentication — user pool only, no identity pool
- Locally, point `VITE_API_URL` at the local BFF server, for example `http://localhost:3001`

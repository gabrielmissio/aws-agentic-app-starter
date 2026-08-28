# Pinned to the major the rest of the repo targets: tsup emits for node22. `node:latest` would
# silently move the container to a different runtime than the one it's built and tested against.
# `-slim` because nothing here needs the full Debian toolchain.
FROM public.ecr.aws/docker/library/node:22-slim AS build

WORKDIR /app

# Manifests first, on their own layer. Dependencies change far less often than source, so an edit
# under src/ reuses this layer instead of reinstalling the whole tree.
COPY package.json package-lock.json ./
RUN npm ci

# Then the sources — trimmed by .dockerignore, notably no node_modules, so nothing here overwrites
# the install above.
COPY . ./

RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
# A second stage so the build toolchain never ships: tsup, typescript and tsx are needed to produce
# dist/ and are dead weight once it exists.
FROM public.ecr.aws/docker/library/node:22-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

# package.json is required at runtime too, not just for `npm start`: it carries `"type": "module"`,
# without which Node refuses to load the ESM bundle.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Drop root before running the app. node:22-slim already ships a non-root `node` user (uid 1000);
# nothing here writes to disk at runtime, so read access to the root-owned files above is enough.
USER node

EXPOSE 8080

CMD ["npm", "start"]

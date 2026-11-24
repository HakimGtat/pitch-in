# One image for the web app, the worker, the migrations and the webhook relay.
# docker-compose.yml picks which one each container runs.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# gitleaks scans PR diffs for secrets (the Secrets check). A pinned release,
# checked against the sha256 in its published checksums file.
FROM node:24-alpine AS gitleaks
ARG TARGETARCH
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256_AMD64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG GITLEAKS_SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
RUN set -eu; \
    apk add --no-cache curl; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x64; sum="$GITLEAKS_SHA256_AMD64" ;; \
      arm64) arch=arm64; sum="$GITLEAKS_SHA256_ARM64" ;; \
      *) echo "No gitleaks build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    file="gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${file}"; \
    echo "${sum}  ${file}" | sha256sum -c -; \
    tar -xzf "$file" gitleaks; \
    install -m 0755 gitleaks /usr/local/bin/gitleaks

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=gitleaks /usr/local/bin/gitleaks /usr/local/bin/gitleaks
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
USER node
EXPOSE 3000
CMD ["node", "server.js"]

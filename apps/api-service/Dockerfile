FROM docker.io/oven/bun:1.3.14 AS manifests
WORKDIR /repo
COPY . .
RUN mkdir /manifests \
  && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /manifests \; \
  && cp bun.lock /manifests

FROM docker.io/oven/bun:1.3.14
WORKDIR /app
ENV NODE_ENV=production

COPY --from=manifests /manifests ./
RUN bun install --frozen-lockfile --production --filter api-service

COPY tsconfig.json ./
COPY packages ./packages
COPY apps/api-service ./apps/api-service

USER bun
EXPOSE 3000
CMD ["bun", "apps/api-service/src/main.ts"]

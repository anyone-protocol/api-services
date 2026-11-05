FROM docker.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS manifests
WORKDIR /repo
COPY . .
RUN mkdir /manifests \
  && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /manifests \; \
  && cp bun.lock /manifests

FROM docker.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598
WORKDIR /app
ENV NODE_ENV=production

COPY --from=manifests /manifests ./
RUN bun install --frozen-lockfile --production --filter hyperbeam-gateway

COPY tsconfig.json ./
COPY packages ./packages
COPY apps/hyperbeam-gateway ./apps/hyperbeam-gateway
RUN mkdir -p /app/data && chown bun:bun /app/data

USER bun
EXPOSE 3000
CMD ["bun", "apps/hyperbeam-gateway/src/main.ts"]

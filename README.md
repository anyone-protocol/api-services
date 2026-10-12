# api-services

Bun monorepo for Anyone Protocol API services. Each service under `apps/` builds into its own container image from this one checkout. Code shared between services lives under `packages/`.

| Service | Purpose |
| ------- | ------- |
| [apps/geo-ip-service](apps/geo-ip-service/) | Internal IP address geolocation lookups |
| [apps/api-service](apps/api-service/) | Public HTTP API |

| Package | Purpose |
| ------- | ------- |
| [packages/service-kit](packages/service-kit/) | Runtime pieces every service uses, free of any web framework |

## Layout

```
├── package.json        Bun workspaces (apps/*, packages/*), root scripts, pinned Bun release
├── bun.lock            one lockfile for the whole tree
├── tsconfig.json       one TypeScript configuration for the whole tree
├── tests/              checks on the repository itself
├── apps/
│   └── <service>/
│       ├── Dockerfile
│       ├── package.json
│       └── src/main.ts
└── packages/
    └── <package>/
        ├── package.json
        └── src/index.ts
```

Services are TypeScript on the Bun runtime, served with Express. Sources run directly; there is no build step and no `dist/`.

A service depends on a shared package through the workspace protocol:

```json
"dependencies": {
  "@anyone-protocol/service-kit": "workspace:*"
}
```

Packages are named `@anyone-protocol/<directory>`. Services are named after their directory.

## Local development

Requires [Bun](https://bun.sh) at the release named in the `packageManager` field of [package.json](package.json).

```sh
bun install
bun run --filter geo-ip-service dev
```

`dev` restarts the service when a source file changes. Every service listens on `PORT`, default 3000, and answers `GET /healthz`. To run two services side by side, give each its own port:

```sh
PORT=3001 bun run --filter api-service dev
```

## Tests and typecheck

```sh
bun run check       # typecheck, then every test in the tree
bun test            # tests only
bun test apps/geo-ip-service
bun run typecheck
```

Test files sit next to the code they cover and are named `*.test.ts`. The tests under [tests/](tests/) check the repository's own conventions: every service is named after its directory, and every Dockerfile uses the pinned Bun release and installs and starts its own service.

## Container images

Every Dockerfile builds from the repository root:

```sh
docker build -f apps/geo-ip-service/Dockerfile -t geo-ip-service .
docker run --rm -p 3000:3000 geo-ip-service
```

The image holds the production dependencies of that one service, the service's sources and `packages/`. It runs as the unprivileged `bun` user and listens on port 3000.

## Bun release

One Bun release is used everywhere. It is named in the `packageManager` field of [package.json](package.json) and in the `FROM` lines of every Dockerfile. To move to another release, change all of them in one commit, run `bun install` with the new release and commit the lockfile. `bun test` fails while they disagree.

## Adding a service

The example adds a service named `example-service`.

1. Create `apps/example-service/package.json`. The name must match the directory.

   ```json
   {
     "name": "example-service",
     "private": true,
     "type": "module",
     "scripts": {
       "dev": "bun --watch src/main.ts",
       "start": "bun src/main.ts"
     },
     "dependencies": {
       "@anyone-protocol/service-kit": "workspace:*",
       "express": "^4.22.3"
     },
     "devDependencies": {
       "@types/express": "^4.17.25"
     }
   }
   ```

2. Create the entrypoint `apps/example-service/src/main.ts`. It listens on `PORT` and serves `GET /healthz` from `service-kit`.

   ```ts
   import express from 'express';
   import { createHealthReporter } from '@anyone-protocol/service-kit';

   const port = Number(process.env.PORT ?? 3000);
   const health = createHealthReporter('example-service');
   const app = express();

   app.get('/healthz', (_req, res) => {
     res.json(health());
   });

   app.listen(port, () => {
     console.log(`example-service listening on :${port}`);
   });
   ```

   The existing services keep the Express app in `src/app.ts`, apart from `main.ts`, so tests can start it on a free port. See [apps/geo-ip-service/src/app.test.ts](apps/geo-ip-service/src/app.test.ts).

3. Copy a Dockerfile from another service and replace that service's name with the new one. It appears three times: the `--filter` argument, the `COPY apps/...` line and the `CMD`.

   ```sh
   sed 's/geo-ip-service/example-service/g' apps/geo-ip-service/Dockerfile > apps/example-service/Dockerfile
   ```

4. Install, so the workspace and the lockfile pick the service up, then check the tree.

   ```sh
   bun install
   bun run check
   ```

5. Build and run the image.

   ```sh
   docker build -f apps/example-service/Dockerfile -t example-service .
   docker run --rm -p 3000:3000 example-service
   curl localhost:3000/healthz
   ```

6. Add the service to the table at the top of this file and commit `bun.lock` with the new directory.

## Adding a shared package

Create `packages/<name>/package.json` with the name `@anyone-protocol/<name>`, `"private": true`, `"type": "module"` and `"main": "src/index.ts"`, export from `src/index.ts`, add it to the `dependencies` of each service that uses it as `workspace:*`, and run `bun install`. No Dockerfile changes are needed.

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
├── scripts/            repository tooling used by continuous integration
├── .github/            workflows
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

Services are TypeScript on the Bun runtime, served with `Bun.serve`, the runtime's built-in HTTP server, and no web framework. Sources run directly; there is no build step and no `dist/`.

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

Test files sit next to the code they cover and are named `*.test.ts`.

## Container images

Every Dockerfile builds from the repository root:

```sh
docker build -f apps/geo-ip-service/Dockerfile -t geo-ip-service .
docker run --rm -p 3000:3000 geo-ip-service
```

The image holds the production dependencies of that one service, the service's sources and `packages/`. It runs as the unprivileged `bun` user and listens on port 3000.

## Bun release

One Bun release is used everywhere. It is named in the `packageManager` field of [package.json](package.json) and in the `FROM` lines of every Dockerfile. To move to another release, change all of them in one commit, run `bun install` with the new release and commit the lockfile.

## Continuous integration

[.github/workflows/ci.yaml](.github/workflows/ci.yaml) runs on every push and pull request. It installs with the frozen lockfile and runs `bun run check`.

On the default branch it then publishes images to `ghcr.io/anyone-protocol/api-services/<service>`, tagged with the full commit SHA. Only the services affected by the push are published:

| Changed path | Published |
| ------------ | --------- |
| `apps/<service>/` | that service |
| `packages/<package>/` | every service that depends on the package, directly or through another package |
| `package.json`, `bun.lock`, `tsconfig.json`, `.dockerignore` | every service |
| anything else | nothing |

The selection is made by [scripts/affected-services.ts](scripts/affected-services.ts), which reads the dependency graph from the workspace manifests. The `plan` job prints the decision and the reason for each service in its log and in the run summary. To see what a range of commits would publish:

```sh
bun scripts/affected-services.ts --base <sha> --head <sha>
```

A service that a push did not affect has no image tagged with that commit. Its newest image carries the SHA of the last commit that did affect it.

To publish services at a commit regardless of what changed, run the workflow by hand on the default branch (Actions, CI, Run workflow). `services` takes `all` or a space separated list.

Nothing is deployed by continuous integration.

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
       "@anyone-protocol/service-kit": "workspace:*"
     }
   }
   ```

2. Create the entrypoint `apps/example-service/src/main.ts`. It listens on `PORT` and serves `GET /healthz` from `service-kit`.

   ```ts
   import { createHealthReporter } from '@anyone-protocol/service-kit';

   const health = createHealthReporter('example-service');

   const server = Bun.serve({
     port: Number(process.env.PORT ?? 3000),
     routes: {
       '/healthz': { GET: () => Response.json(health()) },
     },
     fetch: () => new Response('Not Found', { status: 404 }),
   });

   console.log(`example-service listening on :${server.port}`);
   ```

   The existing services keep the server in `src/app.ts`, apart from `main.ts`, so tests can start it on a free port. See [apps/geo-ip-service/src/app.test.ts](apps/geo-ip-service/src/app.test.ts).

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

No workflow changes are needed. Continuous integration finds services by listing `apps/`, and the first push that contains the new service publishes its image.

## Adding a shared package

Create `packages/<name>/package.json` with the name `@anyone-protocol/<name>`, `"private": true`, `"type": "module"` and `"main": "src/index.ts"`, export from `src/index.ts`, add it to the `dependencies` of each service that uses it as `workspace:*`, and run `bun install`. No Dockerfile changes are needed.

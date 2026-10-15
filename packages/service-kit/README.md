# @anyone-protocol/service-kit

The runtime pieces every service in this repository uses: environment parsing, secret handling, structured logging, the health endpoint, crash logging and graceful shutdown. It depends on nothing beyond the Bun runtime and the web standard `Request` and `Response`.

A service entrypoint uses all of them:

```ts
import { commonEnv, createHealthReporter, createLogger, env, handleShutdownSignals, handleUncaughtErrors, healthResponse, parseEnv } from '@anyone-protocol/service-kit';

const config = parseEnv({ ...commonEnv, UPSTREAM_URL: env.url(), UPSTREAM_TOKEN: env.secret(env.string()) });
const logger = createLogger({ service: 'example-service', level: config.LOG_LEVEL });
handleUncaughtErrors(logger);

const health = createHealthReporter('example-service');

const server = Bun.serve({
  port: config.PORT,
  routes: {
    '/healthz': { GET: () => healthResponse(health()) },
  },
  fetch: () => new Response('Not Found', { status: 404 }),
});

logger.info('Listening', { port: server.port });
handleShutdownSignals([['http server', () => server.stop()]], { logger });
```

## Environment

`parseEnv(schema)` reads `process.env` and returns an object typed from the schema. Each variable is declared with a parser:

| Parser | Accepts | Returns |
| ------ | ------- | ------- |
| `env.string()` | any value | `string` |
| `env.integer()` | an optional minus sign and digits | `number` |
| `env.durationMs()` | digits and a unit: `ms`, `s`, `m`, `h` or `d`, such as `30s` or `12h` | milliseconds as a `number` |
| `env.url()` | an absolute URL | `string` |
| `env.oneOf(values)` | one of `values`, exactly | the matching value |
| `env.secret(parser)` | whatever `parser` accepts | the parsed value wrapped in a `Secret` |

Every parser takes `{ default: value }` or `{ optional: true }`; `env.oneOf` takes them as its second argument. A variable that is unset, empty or only whitespace counts as unset: it gets its default, is `undefined` when optional, and is an error otherwise. Values are trimmed.

All problems are collected and thrown together as one error, for example `Invalid environment: UPSTREAM_URL is required; PORT must be an integer`. The message names variables and never includes their values, so a malformed secret does not end up in a log.

`commonEnv` holds the variables every service reads:

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `3000` | port the HTTP server listens on |
| `LOG_LEVEL` | `info` | lowest level written: `debug`, `info`, `warn` or `error` |

## Secrets

Declare every credential, key, token or password with `env.secret`, including a URL that carries a password:

```ts
const config = parseEnv({
  DB_USER: env.string(),
  DB_PASS: env.secret(env.string()),
  LICENSE_KEY: env.secret(env.string()),
});
```

The value comes back wrapped in a `Secret`. It prints as `[redacted]` in a log field, `JSON.stringify`, `console.log`, `Bun.inspect`, a template string and an error message, so logging the whole configuration or an object that holds a secret shows `[redacted]`. Call `reveal()` only where the value is handed to the code that uses it:

```ts
const pool = new Pool({ user: config.DB_USER, password: config.DB_PASS.reveal() });
```

Once revealed, a library can still repeat the value, for example in an error message. As a second line of defense, every `Secret` registers its value when it is created, and the logger and `healthResponse` replace any registered value in their output with `[redacted]`. The value is matched as written, URL-encoded and JSON-escaped. Values shorter than eight characters are not matched, since short strings would also match ordinary text; the `Secret` wrapper still covers them. A value that arrives some other way than the environment, such as a token fetched at runtime, gets the same treatment when wrapped with `new Secret(value)`. `redact(text)` applies the replacement to any other output a service writes.

Rules for code in this repository:

- Never log the environment, `process.env` or a configuration object built outside `parseEnv`.
- Send credentials in headers or request bodies, not in a URL path or query string, where they end up in error messages and access logs. When a provider accepts a credential only in the URL, keep that URL out of every error message and log line.
- Keep secret material out of health check details. `/healthz` can be public.

## Logging

`createLogger({ service, level })` writes one JSON object per line to standard output:

```json
{"timestamp":"2030-01-02T03:04:05.000Z","level":"info","message":"Listening","service":"example-service","port":3000}
```

`timestamp`, `level` and `message` come first, then `service`, then the fields passed with the entry. A field holding an `Error` is written as its `name`, `message` and `stack`. Registered secrets are redacted from the whole line, see [Secrets](#secrets). `logger.child(fields)` returns a logger that adds `fields` to every entry it writes, which suits a component or a request.

Nomad metadata such as the allocation and job name is not written by the service; the log shipper adds it when it collects the task's output.

## Health

`createHealthReporter(service, { checks })` returns a function that builds the health report. Each check is a function returning at least a `status` of `ok`, `degraded` or `down`, plus any details worth showing. The report's status is the worst status among the checks, and `ok` when there are none. A check that throws is reported as `down` with the error message.

```ts
const health = createHealthReporter('api-service', {
  checks: {
    geoIp: () => ({ status: geo.state().failing ? 'degraded' : 'ok', ...geo.state() }),
  },
});
```

`healthResponse(report)` answers `200` when the report is `ok` or `degraded` and `503` when it is `down`, with registered secrets redacted from the body. Consul's HTTP check treats `503` as critical and drops the instance from healthy service lookups, so reserve `down` for a service that cannot do its job, and use `degraded` for one that still serves, for example from a cache.

Every service serves the report at `GET /healthz`.

## Crashes

`handleUncaughtErrors(logger)` logs an uncaught exception or an unhandled promise rejection through the logger, so it is a JSON line with secrets redacted, and exits with `1`. Without it the runtime prints the raw error to standard error. Call it right after creating the logger, before anything that can fail.

## Shutdown

`handleShutdownSignals(tasks, { logger })` installs handlers for `SIGTERM` and `SIGINT`. On the first signal it runs the tasks one after another, in the order given, and exits with `0` when all of them finished and `1` when one failed or the whole shutdown ran past the timeout. A failing task is logged and the rest still run. A second signal exits with `1` at once.

A task is a name and a function, which may return a promise:

```ts
handleShutdownSignals(
  [
    ['http server', () => server.stop()],
    ['database', () => mongoose.disconnect()],
  ],
  { logger, timeoutMs: 4_000 },
);
```

Put the HTTP server first so no new requests arrive while later resources close. `server.stop()` stops accepting connections, closes idle keep-alive connections and waits for requests in flight.

The default timeout is `DEFAULT_SHUTDOWN_TIMEOUT_MS`, four seconds. Keep it below the job's `kill_timeout` in Nomad, which defaults to five seconds, so the service exits on its own before Nomad kills it.

The handlers are what make a service stop on `SIGTERM` at all inside a container: the Bun process runs as PID 1 there, and the kernel ignores signals for PID 1 that it has no handler for.

`runShutdown(tasks, options)` runs the same sequence without touching the process and resolves to whether it was clean, for tests and for services with their own exit handling.

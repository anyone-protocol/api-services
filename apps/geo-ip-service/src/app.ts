import { createHealthReporter } from '@anyone-protocol/service-kit';

export function startServer(port: number) {
  const health = createHealthReporter('geo-ip-service');

  return Bun.serve({
    port,
    routes: {
      '/healthz': { GET: () => Response.json(health()) },
    },
    fetch: () => new Response('Not Found', { status: 404 }),
  });
}

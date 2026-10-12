import express, { type Express } from 'express';
import { createHealthReporter } from '@anyone-protocol/service-kit';

export function createApp(): Express {
  const app = express();
  const health = createHealthReporter('api-service');

  app.get('/healthz', (_req, res) => {
    res.json(health());
  });

  return app;
}

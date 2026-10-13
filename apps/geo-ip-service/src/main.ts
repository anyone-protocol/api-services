import { startServer } from './app';

const server = startServer(Number(process.env.PORT ?? 3000));

console.log(`geo-ip-service listening on :${server.port}`);

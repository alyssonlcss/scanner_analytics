import { createServer } from './app/presentation/http/create-server.js';

const server = await createServer();

try {
  server.log.info('warming up Spotfire catalog before accepting requests');
  await server.warmupSpotfireCatalog();

  const address = await server.listen({
    host: '0.0.0.0',
    port: server.config.port,
  });

  server.log.info(`scanner backend listening on ${address}`);
} catch (error) {
  server.log.error(error, 'failed to start scanner backend');
  process.exit(1);
}
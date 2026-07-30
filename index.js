#!/usr/bin/env node

require('dotenv').config({ path: '.env', quiet: true });

const { loadConfig } = require('./src/config');
const { loadRegistry } = require('./src/letterheads');
const { MCP_PATH, startHttpServer } = require('./src/httpServer');

async function main() {
  const config = loadConfig(process.env);

  // Loaded once, at startup, and deliberately allowed to throw. A registry that
  // names a letterhead whose .docx is missing is a configuration error, and the
  // useful moment to find out is now — not when a caseworker asks for a letter.
  const registry = loadRegistry(process.env);

  const { server } = await startHttpServer({ config, registry });

  console.error(`letterwriter-mcp listening on http://${config.httpHost}:${config.httpPort}`);
  console.error(`LetterWriter MCP endpoint: ${MCP_PATH}`);
  console.error(
    `Letterheads: ${registry.letterheads.length} from ${registry.source}` +
      (registry.usingBundledRegistry
        ? ' (the bundled placeholder — set LETTERHEAD_DIR to use your own)'
        : ''),
  );

  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.error(`letterwriter-mcp received ${signal}, shutting down`);
    await new Promise((resolve) => server.close(resolve));
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown(signal)
        .then(() => process.exit(0))
        .catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        });
    });
  }

  return new Promise((resolve, reject) => {
    server.once('close', resolve);
    server.once('error', reject);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

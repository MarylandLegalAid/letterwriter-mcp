const { createMcpExpressApp } = require('@modelcontextprotocol/sdk/server/express.js');

const { createSharedSecretMiddleware, mountStatelessMcpRoute } = require('./http');
const { SERVER_VERSION, createMcpServer } = require('./mcpServer');

// The MCP route path. It is part of this server's public contract — a LibreChat
// deployment names it in librechat.yaml — so changing it breaks every consumer.
const MCP_PATH = '/letter-writer/mcp';

function createHttpApp({ config, registry }) {
  const runtime = {
    config,
    registry,
    organizationName: config.organizationName,
  };

  const app = createMcpExpressApp({
    host: config.httpHost,
    allowedHosts: config.allowedHosts || undefined,
  });

  // Reports what the server actually loaded, not merely that it is up. Which
  // registry is in force and how many letterheads it found is the first thing
  // worth knowing when a deployment renders every letter on the wrong
  // letterhead — the usual cause being a LETTERHEAD_DIR that is empty or not
  // mounted, which leaves the bundled placeholder in charge and looks fine.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'letterwriter-mcp',
      version: SERVER_VERSION,
      letterheads: {
        count: registry.letterheads.length,
        default: registry.defaultId,
        registry: registry.source,
        using_bundled_registry: Boolean(registry.usingBundledRegistry),
      },
    });
  });

  mountStatelessMcpRoute({
    app,
    path: MCP_PATH,
    createServer: () => createMcpServer({ runtime }),
    middleware: createSharedSecretMiddleware(config),
  });

  return { app, runtime };
}

async function startHttpServer(options) {
  const { app, runtime } = createHttpApp(options);

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(options.config.httpPort, options.config.httpHost);
    listener.once('error', reject);
    listener.once('listening', () => {
      listener.removeListener('error', reject);
      resolve(listener);
    });
  });

  return { app, runtime, server };
}

module.exports = {
  MCP_PATH,
  createHttpApp,
  startHttpServer,
};

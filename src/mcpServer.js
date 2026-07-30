const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { TOOLS, createLetter, listLetterheads } = require('./service');

const SERVER_NAME = 'letterwriter-mcp';
const SERVER_VERSION = require('../package.json').version;

function createMcpServer({ runtime }) {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === 'list_letterheads') {
        return await listLetterheads(runtime);
      }
      if (request.params.name === 'create_letter') {
        return await createLetter(request.params.arguments || {}, runtime);
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    } catch (error) {
      // Reported as a tool result rather than a transport error, so the model can
      // read what went wrong and correct its arguments instead of the whole call
      // failing opaquely.
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  return server;
}

module.exports = {
  SERVER_NAME,
  SERVER_VERSION,
  createMcpServer,
};

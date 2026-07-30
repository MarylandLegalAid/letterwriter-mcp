const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadConfig } = require('../src/config');
const { loadRegistry } = require('../src/letterheads');
const { MCP_PATH, startHttpServer } = require('../src/httpServer');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'letterheads');

async function withServer(env, run) {
  const config = loadConfig({ MCP_HTTP_HOST: '127.0.0.1', ...env });
  // Bind to an ephemeral port so tests cannot collide with each other or with
  // anything already running. Set after loadConfig on purpose: 0 is not a valid
  // value for a service to be configured with, and loadConfig rightly refuses
  // it — a deployment that set MCP_HTTP_PORT=0 would come up on a random port
  // nothing could reach.
  config.httpPort = 0;
  const registry = loadRegistry(env);
  const { server } = await startHttpServer({ config, registry });
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function rpc(body, headers = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

// The transport answers with server-sent events, so a JSON-RPC result arrives as
// a `data:` line rather than a JSON body.
async function readRpcResult(response) {
  const text = await response.text();
  const line = text.split('\n').find((candidate) => candidate.startsWith('data:'));
  assert.ok(line, `no SSE data line in response: ${text.slice(0, 200)}`);
  return JSON.parse(line.slice('data:'.length).trim());
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

test('healthz reports the loaded registry, not just liveness', async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.ok, true);
    assert.equal(body.service, 'letterwriter-mcp');
    // The field that tells an operator their LETTERHEAD_DIR never mounted, in the
    // case where everything otherwise looks healthy.
    assert.equal(body.letterheads.using_bundled_registry, true);
    assert.equal(body.letterheads.default, 'generic');
    assert.ok(body.letterheads.count >= 1);
  });
});

test('the MCP route is mounted where librechat.yaml expects it', async () => {
  assert.equal(MCP_PATH, '/letter-writer/mcp');
  await withServer({}, async (base) => {
    const response = await fetch(`${base}${MCP_PATH}`, rpc(INITIALIZE));
    assert.equal(response.status, 200);
    const result = await readRpcResult(response);
    assert.equal(result.result.serverInfo.name, 'letterwriter-mcp');
  });
});

test('GET and DELETE on the MCP route are refused', async () => {
  await withServer({}, async (base) => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${base}${MCP_PATH}`, { method });
      assert.equal(response.status, 405, `${method} should not be allowed`);
    }
  });
});

test('tools/list advertises both tools', async () => {
  await withServer({}, async (base) => {
    const response = await fetch(
      `${base}${MCP_PATH}`,
      rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    );
    const result = await readRpcResult(response);
    const names = result.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['create_letter', 'list_letterheads']);
  });
});

test('create_letter over HTTP returns the document as an embedded resource', async () => {
  // End to end through the real transport: the base64 blob has to survive JSON
  // serialisation and SSE framing intact, which is the part a unit test on
  // createLetter cannot show.
  await withServer({}, async (base) => {
    const response = await fetch(
      `${base}${MCP_PATH}`,
      rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_letter',
          arguments: {
            client_name: 'Alex Client',
            client_last_name: 'Client',
            address1: '100 Main Street',
            message_body: 'Sent over HTTP.',
            attorney: 'Jordan Lawyer',
          },
        },
      }),
    );

    const result = await readRpcResult(response);
    assert.equal(result.result.isError, undefined);

    const resource = result.result.content.find((part) => part.type === 'resource').resource;
    const bytes = Buffer.from(resource.blob, 'base64');
    assert.equal(bytes.subarray(0, 2).toString('ascii'), 'PK');
    assert.equal(resource.mimeType, require('../src/service').DOCX_MIME);
  });
});

test('a bad tool call comes back as a tool error, not a broken response', async () => {
  await withServer({}, async (base) => {
    const response = await fetch(
      `${base}${MCP_PATH}`,
      rpc({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'create_letter', arguments: { client_name: 'Only this one' } },
      }),
    );

    const result = await readRpcResult(response);
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /Missing or invalid required field/);
  });
});

test('the shared secret gate is off when unset and enforced when set', async () => {
  // Documented as deliberately unset in the Azure blueprint, where the server is
  // reachable only on a private container network. Asserted in both states so the
  // default is a choice on record rather than an accident.
  await withServer({}, async (base) => {
    const response = await fetch(`${base}${MCP_PATH}`, rpc(INITIALIZE));
    assert.equal(response.status, 200);
  });

  await withServer({ MCP_SHARED_SECRET: 'let-me-in' }, async (base) => {
    const missing = await fetch(`${base}${MCP_PATH}`, rpc(INITIALIZE));
    assert.equal(missing.status, 401);

    const wrong = await fetch(
      `${base}${MCP_PATH}`,
      rpc(INITIALIZE, { 'x-letterwriter-mcp-secret': 'nope' }),
    );
    assert.equal(wrong.status, 403);

    const right = await fetch(
      `${base}${MCP_PATH}`,
      rpc(INITIALIZE, { 'x-letterwriter-mcp-secret': 'let-me-in' }),
    );
    assert.equal(right.status, 200);
  });
});

test('config reads the host allow list and organization name', () => {
  const config = loadConfig({
    MCP_ALLOWED_HOSTS: 'letterwriter-mcp, localhost ,127.0.0.1,letterwriter-mcp',
    ORGANIZATION_NAME: '  Example Legal Aid  ',
    MCP_HTTP_PORT: '3002',
  });

  assert.deepEqual(config.allowedHosts, ['letterwriter-mcp', 'localhost', '127.0.0.1']);
  assert.equal(config.organizationName, 'Example Legal Aid');
  assert.equal(config.httpPort, 3002);
  assert.equal(config.sharedSecret, null);

  assert.equal(loadConfig({}).organizationName, 'Your Organization');
  assert.equal(loadConfig({}).allowedHosts, null);
  assert.throws(() => loadConfig({ MCP_HTTP_PORT: 'abc' }), /MCP_HTTP_PORT/);
});

// Keep the linter honest about the unused import in some configurations.
void TEMPLATES;

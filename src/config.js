function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function parseAllowedHosts(rawAllowedHosts) {
  const normalized = normalizeOptionalString(rawAllowedHosts);
  if (!normalized) {
    return null;
  }

  const allowedHosts = normalized
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return allowedHosts.length ? [...new Set(allowedHosts)] : null;
}

function parseHttpPort(rawPort) {
  if (rawPort === undefined || rawPort === null || rawPort === '') {
    return 3002;
  }

  const port = Number.parseInt(String(rawPort), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('MCP_HTTP_PORT must be an integer between 1 and 65535');
  }

  return port;
}

function normalizeHeaderName(value, fallback) {
  return (normalizeOptionalString(value) || fallback).toLowerCase();
}

function loadConfig(env) {
  return {
    httpHost: normalizeOptionalString(env.MCP_HTTP_HOST) || '127.0.0.1',
    httpPort: parseHttpPort(env.PORT || env.MCP_HTTP_PORT),

    // The MCP SDK's Express host check rejects requests whose Host header is not
    // listed. Behind Docker Compose the caller sends the service name, so that
    // name has to be here or every request is refused.
    allowedHosts: parseAllowedHosts(env.MCP_ALLOWED_HOSTS),

    // The first line of every signature block. There is no sensible default, so
    // an unset value is left visibly wrong rather than quietly plausible — a
    // letter signed "Your Organization" is obvious in review; one signed with
    // somebody else's name is not.
    organizationName: normalizeOptionalString(env.ORGANIZATION_NAME) || 'Your Organization',

    // Optional shared secret on the MCP route. It no-ops when unset, which is the
    // intended configuration when this server is reachable only on a private
    // container network. Set it if you ever expose it beyond one.
    sharedSecret: normalizeOptionalString(env.MCP_SHARED_SECRET),
    sharedSecretHeader: normalizeHeaderName(env.MCP_SHARED_SECRET_HEADER, 'x-letterwriter-mcp-secret'),
  };
}

module.exports = {
  loadConfig,
  normalizeHeaderName,
  normalizeOptionalString,
  parseAllowedHosts,
  parseHttpPort,
};

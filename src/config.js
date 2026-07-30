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

/*
 * LETTER_OUTPUT_DIR and LETTER_PUBLIC_BASE_URL are meaningless alone. Setting one
 * without the other is always a mistake, and it is the kind that produces no
 * error until a user clicks a link, so refuse to start instead.
 */
function assertDeliveryConfig(outputDir, baseUrl) {
  if (outputDir && !baseUrl) {
    throw new Error(
      'LETTER_OUTPUT_DIR is set but LETTER_PUBLIC_BASE_URL is not — letters would be ' +
        'written where nothing can serve them. Set both, or neither.',
    );
  }
  if (baseUrl && !outputDir) {
    throw new Error(
      'LETTER_PUBLIC_BASE_URL is set but LETTER_OUTPUT_DIR is not — letters would be ' +
        'advertised at a URL but never written. Set both, or neither.',
    );
  }
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    throw new Error('LETTER_PUBLIC_BASE_URL must be an absolute http(s) URL');
  }
}

function loadConfig(env) {
  const letterOutputDir = normalizeOptionalString(env.LETTER_OUTPUT_DIR);
  const letterPublicBaseUrl = normalizeOptionalString(env.LETTER_PUBLIC_BASE_URL);
  assertDeliveryConfig(letterOutputDir, letterPublicBaseUrl);

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

    // Where finished letters are written, and the public URL prefix that serves
    // that directory. BOTH must be set to enable URL delivery; with either unset
    // the server falls back to returning the document as MCP embedded-resource
    // bytes. See src/delivery.js for why URL delivery exists at all — LibreChat
    // v0.8.7 silently discards `blob`, so on that client the bytes never arrive.
    //
    // The two belong together and are validated as a pair: an output directory
    // with no URL writes files nobody can reach, and a URL with no output
    // directory advertises files that were never written. Both failures are
    // silent at startup and only visible when someone tries to open a letter.
    letterOutputDir,
    letterPublicBaseUrl,

    // Optional shared secret on the MCP route. It no-ops when unset, which is the
    // intended configuration when this server is reachable only on a private
    // container network. Set it if you ever expose it beyond one.
    sharedSecret: normalizeOptionalString(env.MCP_SHARED_SECRET),
    sharedSecretHeader: normalizeHeaderName(env.MCP_SHARED_SECRET_HEADER, 'x-letterwriter-mcp-secret'),
  };
}

module.exports = {
  assertDeliveryConfig,
  loadConfig,
  normalizeHeaderName,
  normalizeOptionalString,
  parseAllowedHosts,
  parseHttpPort,
};

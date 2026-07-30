/*
 * How the finished .docx reaches the user.
 *
 * There are two modes, and which one is active depends entirely on whether the
 * deployment has somewhere to put a file and a URL to serve it from.
 *
 * URL MODE (letterOutputDir + letterPublicBaseUrl both set)
 *   The document is written under a single-use random directory and the caller
 *   gets back an https URL. This exists because of a concrete limitation rather
 *   than a preference: LibreChat v0.8.7 does not read `blob` from an MCP
 *   embedded resource at all. Its tool-result handler has cases for text, image
 *   and resource, and the resource case reads only `ui://` URIs, `text`, `uri`
 *   and `mimeType` — the bytes are dropped on the floor and the model is handed
 *   a description of a file it cannot give anyone. Returning a URL is therefore
 *   the only way the document actually arrives.
 *
 * BLOB MODE (either unset — the default)
 *   The original behaviour: the bytes come back as an embedded resource. Kept
 *   because it is correct per the MCP specification and works with clients that
 *   implement it. A deployment that has not been given an output directory has
 *   nowhere to write and no URL to advertise, so this is the only thing it can
 *   sensibly do.
 *
 * SECURITY. The URL is a capability: whoever holds it can fetch the document,
 * with no further authentication. That is the same model as the presigned S3
 * link this replaced. Two properties keep it defensible:
 *
 *   - The token is 24 bytes from a CSPRNG, base64url-encoded. Not guessable.
 *   - The letter's text is already in the conversation that produced it — the
 *     agent drafted it there — so the file exposes nothing the conversation
 *     does not already hold.
 *
 * Deliberately NOT expiring. A link that dies looks like data loss to whoever
 * wrote the letter, which is the specific complaint that ended the S3 version.
 * Retention is the deployment's business: the directory is on the data disk and
 * covered by that host's backups. See docs for pruning if it ever matters.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

/*
 * A single-use directory name. The document keeps its real filename inside it so
 * the browser offers a sensible "Save as", rather than the token.
 */
function mintToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/*
 * Join a base URL and path segments without producing a double slash or losing
 * a path prefix already present on the base. encodeURIComponent on the filename
 * matters: letters are routinely named "Closing Letter - Jane Doe - 24-01.docx".
 */
function buildUrl(baseUrl, token, filename) {
  const trimmed = String(baseUrl).replace(/\/+$/, '');
  return `${trimmed}/${token}/${encodeURIComponent(filename)}`;
}

/*
 * Refuse to write outside the configured directory. `outName` reaches here from
 * safeFilename(), so this is defence in depth rather than the only check — but
 * the cost of being wrong is writing an attacker-chosen path as the MCP's user,
 * and the check is three lines.
 */
function resolveWithinDir(dir, token, filename) {
  const target = path.resolve(dir, token, filename);
  const root = path.resolve(dir) + path.sep;
  if (!target.startsWith(root)) {
    throw new Error('refusing to write a letter outside LETTER_OUTPUT_DIR');
  }
  return target;
}

async function writeLetterFile({ buffer, outName, outputDir }) {
  const token = mintToken();
  const target = resolveWithinDir(outputDir, token, outName);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  await fs.writeFile(target, buffer, { mode: 0o644 });
  return { token, target };
}

/*
 * Returns the MCP content array for a rendered letter.
 *
 * Note what URL mode does NOT include: the embedded resource. Sending bytes that
 * the client is known to discard costs a base64 copy of the document for no
 * benefit, and leaves two competing descriptions of where the letter is.
 */
async function buildLetterContent({ buffer, outName, letterhead, config }) {
  const fallbackNote = letterhead.match?.fallback ? ' (default fallback)' : '';
  const summary = `Letter created on the ${letterhead.label} letterhead${fallbackNote}: ${outName}`;

  const outputDir = config?.letterOutputDir;
  const baseUrl = config?.letterPublicBaseUrl;

  if (outputDir && baseUrl) {
    const { token } = await writeLetterFile({ buffer, outName, outputDir });
    const url = buildUrl(baseUrl, token, outName);
    return [
      {
        type: 'text',
        text: `${summary}\n\nDownload URL: ${url}`,
      },
    ];
  }

  return [
    { type: 'text', text: summary },
    {
      // An MCP embedded resource carrying the bytes. `blob` is base64 by
      // specification; a client that implements it decodes and attaches the file.
      type: 'resource',
      resource: {
        // A uri is required. encodeURI keeps a filename with spaces — which is
        // the normal case here — from producing an invalid one.
        uri: `file:///${encodeURI(outName)}`,
        name: outName,
        mimeType: config?.docxMime,
        blob: buffer.toString('base64'),
      },
    },
  ];
}

module.exports = {
  buildLetterContent,
  buildUrl,
  mintToken,
  resolveWithinDir,
  writeLetterFile,
};

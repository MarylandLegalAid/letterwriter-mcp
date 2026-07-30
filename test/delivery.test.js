const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  buildLetterContent,
  buildUrl,
  mintToken,
  resolveWithinDir,
  writeLetterFile,
} = require('../src/delivery');
const { assertDeliveryConfig } = require('../src/config');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const letterhead = { label: 'Baltimore City', match: { fallback: false } };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'letterwriter-delivery-'));
}

/* --------------------------------------------------------------------------- */
/* Config pairing                                                              */
/* --------------------------------------------------------------------------- */

test('half-configured delivery is rejected rather than silently ignored', () => {
  // Both failures are invisible until a user clicks a link, which is exactly why
  // they are startup errors.
  assert.throws(() => assertDeliveryConfig('/data/letters', null), /LETTER_PUBLIC_BASE_URL is not/);
  assert.throws(() => assertDeliveryConfig(null, 'https://x.org/l'), /LETTER_OUTPUT_DIR is not/);
});

test('a relative public base URL is rejected', () => {
  // A relative URL would produce a link that resolves against whatever page the
  // user happens to be on — which is the exact bug this whole change fixes.
  assert.throws(() => assertDeliveryConfig('/data/letters', '/letters'), /absolute http\(s\) URL/);
});

test('neither set is valid — that is blob mode', () => {
  assert.doesNotThrow(() => assertDeliveryConfig(null, null));
});

/* --------------------------------------------------------------------------- */
/* URL construction                                                            */
/* --------------------------------------------------------------------------- */

test('filenames with spaces and dashes survive into the URL', () => {
  const url = buildUrl('https://chat.example.org/letters', 'TOKEN', 'Closing Letter - Jane Doe - 24-01.docx');
  assert.equal(url, 'https://chat.example.org/letters/TOKEN/Closing%20Letter%20-%20Jane%20Doe%20-%2024-01.docx');
});

test('a trailing slash on the base URL does not produce a double slash', () => {
  assert.equal(buildUrl('https://x.org/letters/', 'T', 'a.docx'), 'https://x.org/letters/T/a.docx');
});

test('a path prefix on the base URL is preserved', () => {
  assert.equal(buildUrl('https://x.org/deep/letters', 'T', 'a.docx'), 'https://x.org/deep/letters/T/a.docx');
});

/* --------------------------------------------------------------------------- */
/* The token                                                                   */
/* --------------------------------------------------------------------------- */

test('tokens are long, URL-safe and do not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const token = mintToken();
    assert.match(token, /^[A-Za-z0-9_-]{32}$/, 'token must be URL-safe with no padding');
    assert.ok(!seen.has(token), 'tokens must not repeat');
    seen.add(token);
  }
});

/* --------------------------------------------------------------------------- */
/* Path containment                                                            */
/* --------------------------------------------------------------------------- */

test('a traversing filename cannot escape the output directory', () => {
  // safeFilename() upstream should already prevent this; the cost of being wrong
  // is writing an attacker-chosen path, so it is checked here too.
  assert.throws(
    () => resolveWithinDir('/data/letters', 'TOKEN', '../../etc/cron.d/x'),
    /outside LETTER_OUTPUT_DIR/,
  );
});

test('a traversing token cannot escape the output directory', () => {
  assert.throws(() => resolveWithinDir('/data/letters', '../..', 'a.docx'), /outside LETTER_OUTPUT_DIR/);
});

test('an ordinary name resolves inside the directory', () => {
  const resolved = resolveWithinDir('/data/letters', 'TOKEN', 'Letter.docx');
  assert.equal(resolved, path.join('/data/letters', 'TOKEN', 'Letter.docx'));
});

/* --------------------------------------------------------------------------- */
/* Writing                                                                     */
/* --------------------------------------------------------------------------- */

test('the letter is written under its own token directory, keeping its filename', async () => {
  const dir = tmpdir();
  const buffer = Buffer.from('PK-not-really-a-docx');
  const { token, target } = await writeLetterFile({ buffer, outName: 'Letter A.docx', outputDir: dir });

  assert.equal(path.basename(target), 'Letter A.docx');
  assert.equal(path.basename(path.dirname(target)), token);
  assert.deepEqual(fs.readFileSync(target), buffer);
});

test('two letters with identical filenames do not collide', async () => {
  const dir = tmpdir();
  const a = await writeLetterFile({ buffer: Buffer.from('A'), outName: 'Letter.docx', outputDir: dir });
  const b = await writeLetterFile({ buffer: Buffer.from('B'), outName: 'Letter.docx', outputDir: dir });

  assert.notEqual(a.token, b.token);
  assert.equal(fs.readFileSync(a.target, 'utf8'), 'A');
  assert.equal(fs.readFileSync(b.target, 'utf8'), 'B');
});

/* --------------------------------------------------------------------------- */
/* The two content shapes                                                      */
/* --------------------------------------------------------------------------- */

test('URL mode returns a link and NO embedded resource', async () => {
  const dir = tmpdir();
  const content = await buildLetterContent({
    buffer: Buffer.from('doc'),
    outName: 'Letter.docx',
    letterhead,
    config: { letterOutputDir: dir, letterPublicBaseUrl: 'https://chat.example.org/letters', docxMime: DOCX_MIME },
  });

  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /Baltimore City letterhead/);
  assert.match(content[0].text, /Download URL: https:\/\/chat\.example\.org\/letters\/[A-Za-z0-9_-]{32}\/Letter\.docx/);

  // Sending bytes a client is known to discard costs a base64 copy of the whole
  // document for nothing, and leaves two competing answers to "where is it".
  assert.ok(!content.some((part) => part.type === 'resource'), 'must not also embed the bytes');
});

test('URL mode actually wrote the file it advertises', async () => {
  const dir = tmpdir();
  const buffer = Buffer.from('the real bytes');
  const content = await buildLetterContent({
    buffer,
    outName: 'Letter.docx',
    letterhead,
    config: { letterOutputDir: dir, letterPublicBaseUrl: 'https://x.org/letters', docxMime: DOCX_MIME },
  });

  const token = content[0].text.match(/letters\/([A-Za-z0-9_-]{32})\//)[1];
  assert.deepEqual(fs.readFileSync(path.join(dir, token, 'Letter.docx')), buffer);
});

test('blob mode returns the embedded resource and writes nothing', async () => {
  const content = await buildLetterContent({
    buffer: Buffer.from('doc'),
    outName: 'Letter.docx',
    letterhead,
    config: { docxMime: DOCX_MIME },
  });

  assert.equal(content.length, 2);
  assert.equal(content[1].type, 'resource');
  assert.equal(content[1].resource.mimeType, DOCX_MIME);
  assert.equal(Buffer.from(content[1].resource.blob, 'base64').toString(), 'doc');
  assert.ok(!content[0].text.includes('Download URL'));
});

test('the fallback letterhead is still called out in URL mode', async () => {
  const dir = tmpdir();
  const content = await buildLetterContent({
    buffer: Buffer.from('doc'),
    outName: 'L.docx',
    letterhead: { label: 'Generic', match: { fallback: true } },
    config: { letterOutputDir: dir, letterPublicBaseUrl: 'https://x.org/l', docxMime: DOCX_MIME },
  });
  assert.match(content[0].text, /\(default fallback\)/);
});

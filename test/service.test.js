const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadRegistry } = require('../src/letterheads');
const {
  DOCX_MIME,
  buildSignatureLines,
  createLetter,
  resolveLetterhead,
  safeFilename,
} = require('../src/service');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'letterheads');

// A registry with more than one entry, so alias matching has something to choose
// between. Both point at the one placeholder template that ships here.
function testRegistry(overrides = {}) {
  return {
    templatesDir: TEMPLATES,
    source: '<test registry>',
    defaultId: 'generic',
    stopWords: ['office', 'example legal aid'],
    letterheads: [
      {
        id: 'generic',
        label: 'Generic',
        file: 'generic.docx',
        aliases: ['generic', 'default'],
        legalserver_offices: [],
        include_unit_name: false,
      },
      {
        id: 'riverside',
        label: 'Riverside',
        file: 'generic.docx',
        aliases: ['riverside', 'riverside branch'],
        legalserver_offices: ['Riverside Branch'],
        include_unit_name: true,
      },
      {
        id: 'riverside_suite_300',
        label: 'Riverside Suite 300',
        file: 'generic.docx',
        aliases: ['riverside suite 300'],
        legalserver_offices: [],
        include_unit_name: false,
      },
    ],
    ...overrides,
  };
}

const VALID_ARGS = {
  client_name: 'Alex Client',
  client_last_name: 'Client',
  address1: '100 Main Street',
  message_body: 'This is a test letter.',
  attorney: 'Jordan Lawyer',
};

test('an explicit letterhead_id wins over office matching', () => {
  const registry = testRegistry();
  const resolved = resolveLetterhead({ letterhead_id: 'riverside', office_hint: 'Generic' }, registry);
  assert.equal(resolved.id, 'riverside');
  assert.equal(resolved.match.source, 'letterhead_id');
  assert.equal(resolved.match.fallback, false);
});

test('office text matches through aliases and configured stop words', () => {
  const registry = testRegistry();

  // "Office" is a stop word, so it must not prevent a match.
  assert.equal(resolveLetterhead({ office_hint: 'Riverside Office' }, registry).id, 'riverside');
  // The organization's own name is a stop word too, which is why an office
  // labelled with it still resolves.
  assert.equal(
    resolveLetterhead({ office_hint: 'Example Legal Aid — Riverside' }, registry).id,
    'riverside',
  );
  // A LegalServer office name, matched exactly as that system spells it.
  assert.equal(resolveLetterhead({ office: { display: 'Riverside Branch' } }, registry).id, 'riverside');
});

test('the longest matching alias wins, not registry order', () => {
  // Both "riverside" and "riverside suite 300" match this hint. Picking by
  // registry order would silently return the wrong, less specific letterhead.
  const registry = testRegistry();
  assert.equal(
    resolveLetterhead({ office_hint: 'Riverside Suite 300' }, registry).id,
    'riverside_suite_300',
  );
});

test('an unmatched office falls back to the default and says so', () => {
  const registry = testRegistry();
  const resolved = resolveLetterhead({ office_hint: 'Unknown Satellite' }, registry);
  assert.equal(resolved.id, 'generic');
  assert.equal(resolved.match.fallback, true);
});

test('filenames cannot escape a directory or carry control characters', () => {
  assert.equal(safeFilename('../../Client "Name"'), '..-..-Client -Name-.docx');
  assert.equal(safeFilename('plain'), 'plain.docx');
  assert.match(safeFilename(''), /^letter-\d+\.docx$/);
  assert.ok(safeFilename('x'.repeat(400)).length <= 180);
});

test('unit_name reaches the signature block only for offices that opt in', () => {
  const registry = testRegistry();

  const optedIn = resolveLetterhead({ letterhead_id: 'riverside' }, registry);
  assert.equal(
    buildSignatureLines({}, optedIn, 'Housing Unit', 'Example Legal Aid'),
    'Example Legal Aid\nRiverside\nHousing Unit',
  );

  // The same call against an office that has not opted in must not gain the line.
  // This replaced a hardcoded `letterhead.id === 'baltimore_city'`.
  const notOptedIn = resolveLetterhead({ letterhead_id: 'generic' }, registry);
  assert.equal(
    buildSignatureLines({}, notOptedIn, 'Housing Unit', 'Example Legal Aid'),
    'Example Legal Aid\nGeneric',
  );
});

test('createLetter returns the DOCX as MCP binary content, not a link', async () => {
  // The point of the change away from S3: the bytes come back in the response, so
  // there is no URL to expire and no bucket to configure. A regression here would
  // most likely look like a `resource_link` reappearing.
  const registry = testRegistry();
  const result = await createLetter(
    { ...VALID_ARGS, letterhead_id: 'generic', filename: 'Letter for Client.docx' },
    { registry, organizationName: 'Example Legal Aid' },
  );

  const resources = result.content.filter((part) => part.type === 'resource');
  assert.equal(resources.length, 1);
  assert.equal(result.content.some((part) => part.type === 'resource_link'), false);
  assert.equal(result.content.some((part) => /https?:\/\//.test(part.text || '')), false);

  const { resource } = resources[0];
  assert.equal(resource.mimeType, DOCX_MIME);
  assert.equal(resource.name, 'Letter for Client.docx');
  assert.equal(resource.uri, 'file:///Letter%20for%20Client.docx');
  assert.ok(typeof resource.blob === 'string' && resource.blob.length > 0);

  // The blob must be base64 that decodes to a real .docx — a zip, whose first
  // two bytes are "PK" — and must contain the rendered text.
  const bytes = Buffer.from(resource.blob, 'base64');
  assert.equal(bytes.subarray(0, 2).toString('ascii'), 'PK');
  assert.ok(bytes.length > 500);
  assert.equal(resource.blob, bytes.toString('base64'), 'blob must be valid base64');
});

test('the rendered document actually contains the letter', async () => {
  // Guards against a template that renders but drops every placeholder, which a
  // byte-count assertion alone would happily accept.
  const PizZip = require('pizzip');
  const registry = testRegistry();
  const result = await createLetter(
    { ...VALID_ARGS, message_body: 'A distinctive sentence for the assertion.' },
    { registry, organizationName: 'Example Legal Aid' },
  );

  const blob = result.content.find((part) => part.type === 'resource').resource.blob;
  const xml = new PizZip(Buffer.from(blob, 'base64')).file('word/document.xml').asText();

  assert.match(xml, /A distinctive sentence for the assertion\./);
  assert.match(xml, /Alex Client/);
  assert.match(xml, /Jordan Lawyer/);
  assert.match(xml, /Example Legal Aid/);
  // Placeholders must be gone, not passed through literally.
  assert.equal(xml.includes('{message_body}'), false);
  assert.equal(xml.includes('{client_name}'), false);
});

test('required fields are enforced before anything is rendered', async () => {
  const registry = testRegistry();
  for (const missing of ['client_name', 'address1', 'client_last_name', 'message_body', 'attorney']) {
    const args = { ...VALID_ARGS };
    delete args[missing];
    await assert.rejects(
      () => createLetter(args, { registry, organizationName: 'Example Legal Aid' }),
      new RegExp(`Missing or invalid required field: ${missing}`),
    );
  }
});

test('input length limits are enforced', async () => {
  const registry = testRegistry();
  await assert.rejects(
    () => createLetter(
      { ...VALID_ARGS, message_body: 'x'.repeat(50001) },
      { registry, organizationName: 'Example Legal Aid' },
    ),
    /message_body must be at most 50000 characters/,
  );
});

test('list_letterheads reports the registry it is actually using', async () => {
  const { listLetterheads } = require('../src/service');
  const registry = testRegistry();
  const result = await listLetterheads({ registry });
  const parsed = JSON.parse(result.content[0].text);

  assert.equal(parsed.default_fallback, 'generic');
  assert.deepEqual(parsed.letterheads.map((entry) => entry.id), [
    'generic',
    'riverside',
    'riverside_suite_300',
  ]);
});

test('the bundled registry loads and can produce a letter with no configuration', async () => {
  // What a grantee gets before uploading anything. If this breaks, a fresh
  // install cannot start.
  const registry = loadRegistry({});
  assert.equal(registry.usingBundledRegistry, true);
  assert.equal(registry.defaultId, 'generic');

  const result = await createLetter(VALID_ARGS, { registry, organizationName: 'Your Organization' });
  assert.equal(result.content.filter((part) => part.type === 'resource').length, 1);
});

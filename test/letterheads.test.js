const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BUNDLED_REGISTRY,
  BUNDLED_TEMPLATES,
  loadRegistry,
  resolveRegistryPaths,
  validateRegistry,
} = require('../src/letterheads');

function validate(parsed, templatesDir = BUNDLED_TEMPLATES) {
  return validateRegistry(parsed, { source: '<test registry>', templatesDir });
}

test('a registry naming a template that does not exist is refused', () => {
  // The failure this guards against: someone adds an office, forgets to upload
  // its .docx, and finds out when a caseworker tries to send a letter.
  assert.throws(
    () => validate({ letterheads: [{ id: 'a', label: 'A', file: 'does-not-exist.docx' }] }),
    /does not exist/,
  );
});

test('every problem is reported at once, not one per run', () => {
  // Fixing configuration errors one restart at a time is the experience this
  // avoids, so the count matters as much as the detection.
  try {
    validate({
      letterheads: [
        { id: 'a', label: 'A', file: 'missing-one.docx' },
        { id: 'a', label: 'Duplicate', file: 'missing-two.docx' },
        { label: 'No id', file: 'generic.docx' },
      ],
      defaultId: 'nonexistent',
    });
    assert.fail('expected the registry to be refused');
  } catch (error) {
    assert.match(error.message, /missing-one\.docx/);
    assert.match(error.message, /missing-two\.docx/);
    assert.match(error.message, /duplicate id/);
    assert.match(error.message, /missing the required "id" field/);
    assert.match(error.message, /"defaultId": "nonexistent"/);
  }
});

test('a file field containing a path is refused', () => {
  // Whoever writes the registry could otherwise read any file the process can.
  assert.throws(
    () => validate({ letterheads: [{ id: 'a', label: 'A', file: '../../../etc/passwd' }] }),
    /must be a bare filename/,
  );
  assert.throws(
    () => validate({ letterheads: [{ id: 'a', label: 'A', file: 'sub/dir/x.docx' }] }),
    /must be a bare filename/,
  );
});

test('an empty or malformed registry is refused', () => {
  assert.throws(() => validate({ letterheads: [] }), /non-empty "letterheads" array/);
  assert.throws(() => validate({}), /non-empty "letterheads" array/);
  assert.throws(() => validate([]), /non-empty "letterheads" array/);
});

test('defaults are filled in so the matcher never sees undefined', () => {
  const registry = validate({ letterheads: [{ id: 'a', label: 'A', file: 'generic.docx' }] });
  assert.deepEqual(registry.letterheads[0].aliases, []);
  assert.deepEqual(registry.letterheads[0].legalserver_offices, []);
  assert.equal(registry.letterheads[0].include_unit_name, false);
  assert.equal(registry.defaultId, 'a', 'defaultId falls back to the first entry');
  assert.deepEqual(registry.stopWords, ['office']);
});

test('with no LETTERHEAD_DIR the bundled registry and templates are used', () => {
  const resolved = resolveRegistryPaths({});
  assert.equal(resolved.registryPath, BUNDLED_REGISTRY);
  assert.equal(resolved.templatesDir, BUNDLED_TEMPLATES);
  assert.equal(resolved.usingBundledRegistry, true);
});

test('LETTERHEAD_DIR is used when it holds a registry, and ignored when it does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letterheads-'));
  try {
    // An empty directory — a data disk that is mounted but not yet populated.
    // Falling back to the bundled placeholder keeps the server startable.
    const empty = resolveRegistryPaths({ LETTERHEAD_DIR: dir });
    assert.equal(empty.registryPath, BUNDLED_REGISTRY);
    assert.equal(empty.usingBundledRegistry, true);

    // Now the deployment's own registry exists.
    fs.copyFileSync(path.join(BUNDLED_TEMPLATES, 'generic.docx'), path.join(dir, 'generic.docx'));
    fs.writeFileSync(
      path.join(dir, 'letterheads.json'),
      JSON.stringify({
        defaultId: 'branch',
        letterheads: [{ id: 'branch', label: 'Branch', file: 'generic.docx' }],
      }),
    );

    const resolved = resolveRegistryPaths({ LETTERHEAD_DIR: dir });
    assert.equal(resolved.registryPath, path.join(dir, 'letterheads.json'));
    // Templates must come from the same directory as the registry that named
    // them — otherwise every one of the deployment's offices reads as missing.
    assert.equal(resolved.templatesDir, dir);
    assert.equal(resolved.usingBundledRegistry, false);

    const registry = loadRegistry({ LETTERHEAD_DIR: dir });
    assert.equal(registry.defaultId, 'branch');
    assert.equal(registry.letterheads.length, 1);
    assert.equal(registry.usingBundledRegistry, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable registry names the path it tried', () => {
  assert.throws(
    () => loadRegistry({ LETTERHEAD_REGISTRY_PATH: '/nonexistent/letterheads.json' }),
    /cannot read the letterhead registry at .*nonexistent/,
  );
});

test('the committed registry is valid', () => {
  // It ships as the working default, so a typo in it breaks every fresh install.
  const parsed = JSON.parse(fs.readFileSync(BUNDLED_REGISTRY, 'utf8'));
  const registry = validate(parsed);
  assert.ok(registry.letterheads.length >= 1);
  assert.equal(registry.defaultId, 'generic');
});

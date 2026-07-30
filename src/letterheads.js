// The letterhead registry.
//
// The set of letterheads is DATA, not code. It was a hardcoded array of thirteen
// Maryland Legal Aid offices; it is now a JSON file an organization supplies, so
// nobody has to edit JavaScript to describe their own offices and — more
// importantly — so no organization's letterhead artwork or office list has to
// exist in this public repository.
//
// Where the registry comes from, in order:
//
//   1. ${LETTERHEAD_DIR}/letterheads.json, if it exists. Templates are read from
//      LETTERHEAD_DIR too. This is the real deployment: on the Azure blueprint,
//      LETTERHEAD_DIR is a read-only bind mount from the VM's data disk, so the
//      .docx files are covered by the same backups as everything else and are
//      never in git.
//   2. The letterheads.json committed here, with templates from
//      templates/letterheads/. One generic placeholder, so a fresh install
//      starts and can produce a letter before anyone has uploaded anything.
//
// LETTERHEAD_REGISTRY_PATH and LETTERHEAD_TEMPLATES_DIR override either half
// independently, which is mostly useful in tests.

const fs = require('fs');
const path = require('path');

const BUNDLED_REGISTRY = path.join(__dirname, '..', 'letterheads.json');
const BUNDLED_TEMPLATES = path.join(__dirname, '..', 'templates', 'letterheads');

const DEFAULT_STOP_WORDS = ['office'];

// Resolve where the registry and the templates live, without reading either.
// Kept separate from loading so the decision can be asserted in a test and
// reported in the health endpoint.
function resolveRegistryPaths(env = process.env) {
  const letterheadDir = (env.LETTERHEAD_DIR || '').trim();
  const dirRegistry = letterheadDir
    ? path.join(path.resolve(letterheadDir), 'letterheads.json')
    : null;

  // An explicit path wins. Otherwise use the deployment's own registry when it
  // is actually there, and fall back to the bundled one when it is not.
  let registryPath;
  if (env.LETTERHEAD_REGISTRY_PATH && env.LETTERHEAD_REGISTRY_PATH.trim()) {
    registryPath = path.resolve(env.LETTERHEAD_REGISTRY_PATH.trim());
  } else if (dirRegistry && fs.existsSync(dirRegistry)) {
    registryPath = dirRegistry;
  } else {
    registryPath = BUNDLED_REGISTRY;
  }

  // Templates sit next to the registry that named them. Reading a deployment's
  // registry but the bundled templates would report every one of its offices as
  // a missing file, which is a confusing way to learn that LETTERHEAD_DIR is
  // wrong.
  let templatesDir;
  if (env.LETTERHEAD_TEMPLATES_DIR && env.LETTERHEAD_TEMPLATES_DIR.trim()) {
    templatesDir = path.resolve(env.LETTERHEAD_TEMPLATES_DIR.trim());
  } else if (registryPath === BUNDLED_REGISTRY) {
    templatesDir = BUNDLED_TEMPLATES;
  } else {
    templatesDir = path.dirname(registryPath);
  }

  return {
    registryPath,
    templatesDir,
    usingBundledRegistry: registryPath === BUNDLED_REGISTRY,
  };
}

// Split out from file reading so the validation rules can be tested directly,
// without writing fixture files to disk.
function validateRegistry(parsed, { source, templatesDir }) {
  const entries = Array.isArray(parsed) ? parsed : parsed && parsed.letterheads;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`letterwriter: ${source} must contain a non-empty "letterheads" array.`);
  }

  // Validate everything up front and report ALL problems at once. Discovering a
  // missing .docx one letter at a time, in production, when someone is trying to
  // send mail to a client, is exactly the experience this avoids.
  const problems = [];
  const seenIds = new Set();

  entries.forEach((entry, index) => {
    const where = entry && entry.id ? `"${entry.id}"` : `entry ${index + 1}`;
    if (!entry || typeof entry !== 'object') {
      problems.push(`${where} is not an object`);
      return;
    }
    for (const key of ['id', 'label', 'file']) {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) {
        problems.push(`${where} is missing the required "${key}" field`);
      }
    }
    if (typeof entry.id === 'string' && entry.id.trim()) {
      if (seenIds.has(entry.id)) problems.push(`${where} has a duplicate id`);
      seenIds.add(entry.id);
    }
    if (typeof entry.file === 'string' && entry.file.trim()) {
      // A file field is a filename, not a path. Allowing "../../etc/passwd"
      // would let whoever writes the registry read any file the process can.
      if (entry.file !== path.basename(entry.file)) {
        problems.push(`${where} has a "file" containing a path; it must be a bare filename`);
      } else if (!fs.existsSync(path.join(templatesDir, entry.file))) {
        problems.push(`${where} references "${entry.file}", which does not exist in ${templatesDir}`);
      }
    }
  });

  const defaultId = (Array.isArray(parsed) ? null : parsed.defaultId) || entries[0].id;
  if (!seenIds.has(defaultId)) {
    problems.push(`"defaultId": "${defaultId}" does not match any letterhead id`);
  }

  if (problems.length > 0) {
    throw new Error(
      `letterwriter: the letterhead registry at ${source} is not usable:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
  }

  const stopWords = Array.isArray(parsed.stopWords) ? parsed.stopWords : DEFAULT_STOP_WORDS;

  return {
    letterheads: entries.map((entry) => ({
      aliases: [],
      legalserver_offices: [],
      include_unit_name: false,
      ...entry,
    })),
    defaultId,
    stopWords,
    templatesDir,
    source,
  };
}

function loadRegistry(env = process.env) {
  const { registryPath, templatesDir, usingBundledRegistry } = resolveRegistryPaths(env);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `letterwriter: cannot read the letterhead registry at ${registryPath} — ${error.message}`,
    );
  }

  const registry = validateRegistry(parsed, { source: registryPath, templatesDir });
  return { ...registry, usingBundledRegistry };
}

module.exports = {
  BUNDLED_REGISTRY,
  BUNDLED_TEMPLATES,
  DEFAULT_STOP_WORDS,
  loadRegistry,
  resolveRegistryPaths,
  validateRegistry,
};

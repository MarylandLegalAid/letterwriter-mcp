// Letter generation: match an office to a letterhead, fill the template, and
// return the .docx.
//
// HOW THE DOCUMENT COMES BACK. This used to upload the rendered file to S3 and
// return a presigned download link. It now returns the bytes themselves, as an
// MCP embedded resource with a base64 `blob`, and the client attaches them to
// the conversation. That is not a simplification for its own sake:
//
//   - A presigned link expires. A letter in a conversation from three weeks ago
//     became a dead URL, which looks like data loss to the person who wrote it.
//   - It removes object storage, and its credentials, from this server entirely.
//     There is now nothing here to leak and no bucket policy to get wrong.
//   - It works the same whether the deployment stores files on a disk or in a
//     bucket, because the decision is no longer this server's to make.

const fs = require('fs');
const path = require('path');

const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// -----------------------------------------------------------------------------
// Matching an office to a letterhead
// -----------------------------------------------------------------------------

function buildStopWordsPattern(stopWords) {
  const escaped = (stopWords || [])
    .map((word) => String(word).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean);
  // An empty alternation would match everywhere, deleting the whole string.
  if (escaped.length === 0) return null;
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'g');
}

function normalizeMatchText(value, stopWordsPattern) {
  let out = String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ');

  if (stopWordsPattern) {
    // A fresh lastIndex each time: a /g regex reused across calls otherwise
    // resumes from where it last matched and silently misses.
    stopWordsPattern.lastIndex = 0;
    out = out.replace(stopWordsPattern, ' ');
  }

  return out.replace(/\s+/g, ' ').trim();
}

function normalizeLetterheadId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function collectLetterheadHints(args) {
  const hints = [];
  for (const key of ['office_hint', 'office_display', 'office_name', 'office_code']) {
    if (typeof args?.[key] === 'string' && args[key].trim()) hints.push(args[key]);
  }

  const office = args?.office;
  if (typeof office === 'string' && office.trim()) hints.push(office);
  if (office && typeof office === 'object') {
    for (const key of ['display', 'office_display', 'name', 'office_name', 'code', 'office_code']) {
      if (typeof office[key] === 'string' && office[key].trim()) hints.push(office[key]);
    }
  }

  return hints;
}

function getAliasMatches(letterhead, hint, stopWordsPattern) {
  const normalizedHint = normalizeMatchText(hint, stopWordsPattern);
  if (!normalizedHint) return [];

  return [...(letterhead.legalserver_offices || []), ...(letterhead.aliases || [])]
    .map((alias) => normalizeMatchText(alias, stopWordsPattern))
    .filter(Boolean)
    .filter((alias) => normalizedHint === alias || normalizedHint.includes(alias))
    .sort((a, b) => b.length - a.length);
}

function resolveLetterhead(args = {}, registry) {
  const byId = new Map(registry.letterheads.map((letterhead) => [letterhead.id, letterhead]));
  const stopWordsPattern = buildStopWordsPattern(registry.stopWords);

  const requestedId = normalizeLetterheadId(args.letterhead_id);
  if (requestedId && byId.has(requestedId)) {
    return {
      ...byId.get(requestedId),
      match: { source: 'letterhead_id', value: args.letterhead_id, fallback: false },
    };
  }

  // Longest alias wins, so "baltimore county suite 300" beats "baltimore county"
  // when both are present rather than depending on registry order.
  const ranked = [];
  for (const hint of collectLetterheadHints(args)) {
    for (const letterhead of registry.letterheads) {
      const matches = getAliasMatches(letterhead, hint, stopWordsPattern);
      if (matches.length) {
        ranked.push({ letterhead, hint, alias: matches[0], score: matches[0].length });
      }
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  if (ranked[0]) {
    return {
      ...ranked[0].letterhead,
      match: { source: 'office_hint', value: ranked[0].hint, alias: ranked[0].alias, fallback: false },
    };
  }

  return {
    ...byId.get(registry.defaultId),
    match: { source: 'fallback', value: collectLetterheadHints(args)[0] || args.letterhead_id || null, fallback: true },
  };
}

// -----------------------------------------------------------------------------
// The signature block
// -----------------------------------------------------------------------------

function firstCleanString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function getSignatureOfficeName(args, letterhead) {
  const office = args?.office;
  const officeNameFromObject = office && typeof office === 'object'
    ? firstCleanString(office.name, office.office_name, office.display, office.office_display)
    : '';

  const officeName = firstCleanString(
    officeNameFromObject,
    typeof office === 'string' ? office : '',
    args?.office_name,
    args?.office_display,
    args?.office_hint,
  );

  if (officeName) return officeName;
  if (letterhead.match?.fallback && letterhead.match.value) return String(letterhead.match.value).trim();
  return letterhead.label;
}

function buildSignatureLines(args, letterhead, unitName, organizationName) {
  const signatureOfficeName = getSignatureOfficeName(args, letterhead);
  const lines = [organizationName, signatureOfficeName].filter(Boolean);

  // Whether a unit name belongs in the signature is a per-office convention, so
  // it is a flag on the letterhead rather than a special case in code. It was
  // `letterhead.id === 'baltimore_city'` here, which no other organization could
  // possibly want.
  if (letterhead.include_unit_name && unitName) {
    lines.push(unitName);
  }

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function loadTemplateBuffer(letterhead, registry) {
  const templatePath = path.join(registry.templatesDir, letterhead.file);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found at: ${templatePath}`);
  }
  return fs.readFileSync(templatePath);
}

function formatDateLong(dateString) {
  if (!dateString) {
    return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  const tryISO = /^\d{4}-\d{2}-\d{2}$/.test(dateString) ? `${dateString}T00:00:00` : dateString;
  const d = new Date(tryISO);
  if (Number.isNaN(d.getTime())) return dateString;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function renderDocx(data, letterhead, registry) {
  const zip = new PizZip(loadTemplateBuffer(letterhead, registry));
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter() {
      return '';
    },
  });

  try {
    doc.render(data);
  } catch (err) {
    const details = err?.properties?.errors?.map((e) => ({
      id: e.id,
      explanation: e.properties?.explanation,
      context: e.properties?.context,
      file: e.properties?.file,
      offset: e.properties?.offset,
    }));
    const pretty = details ? JSON.stringify(details, null, 2) : '';
    throw new Error(`DOCX template render failed: ${err.message}\nDetails:\n${pretty}`);
  }

  return doc.getZip().generate({ type: 'nodebuffer' });
}

function safeFilename(name) {
  const base = String(name || '').trim() || `letter-${Date.now()}.docx`;
  let out = base;
  if (!out.toLowerCase().endsWith('.docx')) out += '.docx';
  // strip path separators + control chars
  out = out.replace(/[/\\"\0-\x1F\x7F]/g, '-');
  // compress spaces
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > 180) {
    out = `${out.slice(0, 175).trim()}.docx`;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------------

const CREATE_LETTER_TOOL = {
  name: 'create_letter',
  description:
    'Create a DOCX letter on the best matching office letterhead and return the document itself as an attachment. Falls back to the default letterhead when no office matches.',
  inputSchema: {
    type: 'object',
    properties: {
      today: { type: 'string', maxLength: 100, description: 'Maps to {today} (YYYY-MM-DD or readable string). Defaults to today.' },
      client_name: { type: 'string', maxLength: 500, description: 'Maps to {client_name}.' },
      address1: { type: 'string', maxLength: 500, description: 'Maps to {address1}.' },
      address2: { type: 'string', maxLength: 500, description: 'Maps to {address2} (optional).' },
      honorific: { type: 'string', maxLength: 50, description: 'Maps to {honorific} (e.g., Mr., Ms., Dr.). Optional.' },
      client_last_name: { type: 'string', maxLength: 250, description: 'Maps to {client_last_name}.' },
      message_body: { type: 'string', maxLength: 50000, description: 'Maps to {message_body}. Use \\n for paragraphs.' },
      attorney: { type: 'string', maxLength: 500, description: 'Maps to {attorney} (template adds ", Esq.").' },
      unit_name: { type: 'string', description: 'Optional unit/program name. Included in the signature block only for offices whose letterhead sets include_unit_name.' },
      letterhead_id: { type: 'string', description: 'Optional explicit letterhead ID. If omitted or unknown, office fields are matched and then the default letterhead is used.' },
      office_hint: { type: 'string', description: 'Optional office text used to choose letterhead, preferably primary_advocate_assignment.office.display or .name.' },
      office_name: { type: 'string', description: 'Optional office name used to choose letterhead.' },
      office_display: { type: 'string', description: 'Optional office display value used to choose letterhead.' },
      office_code: { type: 'string', description: 'Optional office code used to choose letterhead.' },
      office: {
        anyOf: [
          { type: 'string' },
          {
            type: 'object',
            properties: {
              name: { type: 'string' },
              display: { type: 'string' },
              code: { type: 'string' },
            },
          },
        ],
        description: 'Optional office object/string from primary_advocate_assignment.office.',
      },
      filename: { type: 'string', maxLength: 180, description: 'Optional output filename.' },
    },
    required: ['client_name', 'address1', 'client_last_name', 'message_body', 'attorney'],
    additionalProperties: false,
  },
};

const LIST_LETTERHEADS_TOOL = {
  name: 'list_letterheads',
  description: 'List available office letterhead IDs and labels for create_letter.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

const TOOLS = [CREATE_LETTER_TOOL, LIST_LETTERHEADS_TOOL];

const REQUIRED_FIELDS = ['client_name', 'address1', 'client_last_name', 'message_body', 'attorney'];

const FIELD_LIMITS = {
  today: 100,
  client_name: 500,
  address1: 500,
  address2: 500,
  honorific: 50,
  client_last_name: 250,
  message_body: 50000,
  attorney: 500,
  filename: 180,
};

async function createLetter(args, { registry, organizationName }) {
  for (const key of REQUIRED_FIELDS) {
    if (!args || typeof args[key] !== 'string' || args[key].trim() === '') {
      throw new Error(`Missing or invalid required field: ${key}`);
    }
  }

  for (const [key, maxLength] of Object.entries(FIELD_LIMITS)) {
    if (typeof args?.[key] === 'string' && args[key].length > maxLength) {
      throw new Error(`${key} must be at most ${maxLength} characters`);
    }
  }

  const letterhead = resolveLetterhead(args, registry);
  const unitName = typeof args.unit_name === 'string' && args.unit_name.trim()
    ? args.unit_name.trim()
    : organizationName;
  const signatureLines = buildSignatureLines(args, letterhead, unitName, organizationName);

  const data = {
    today: formatDateLong(args.today),
    client_name: args.client_name.trim(),
    address1: args.address1.trim(),
    address2: typeof args.address2 === 'string' ? args.address2.trim() : '',
    honorific: typeof args.honorific === 'string' ? args.honorific.trim() : '',
    client_last_name: args.client_last_name.trim(),
    message_body: args.message_body.trim(),
    attorney: args.attorney.trim(),
    signature_lines: signatureLines,
    // Backward compatibility for older copied templates that still have {unit_name}.
    unit_name: signatureLines,
  };

  const buffer = renderDocx(data, letterhead, registry);
  const outName = safeFilename(args.filename || `Letter - ${args.client_last_name}.docx`);

  return {
    content: [
      {
        type: 'text',
        text: `Letter created on the ${letterhead.label} letterhead${letterhead.match?.fallback ? ' (default fallback)' : ''}: ${outName}`,
      },
      {
        // An MCP embedded resource carrying the bytes. `blob` is base64 by
        // specification; the client decodes it and attaches the file.
        type: 'resource',
        resource: {
          // A uri is required. encodeURI keeps a filename with spaces — which is
          // the normal case here — from producing an invalid one.
          uri: `file:///${encodeURI(outName)}`,
          name: outName,
          mimeType: DOCX_MIME,
          blob: buffer.toString('base64'),
        },
      },
    ],
  };
}

async function listLetterheads({ registry }) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          default_fallback: registry.defaultId,
          letterheads: registry.letterheads.map((letterhead) => ({
            id: letterhead.id,
            label: letterhead.label,
            legalserver_offices: letterhead.legalserver_offices || [],
            aliases: letterhead.aliases || [],
          })),
        }, null, 2),
      },
    ],
  };
}

module.exports = {
  CREATE_LETTER_TOOL,
  DOCX_MIME,
  LIST_LETTERHEADS_TOOL,
  TOOLS,
  buildSignatureLines,
  createLetter,
  formatDateLong,
  listLetterheads,
  normalizeMatchText,
  resolveLetterhead,
  safeFilename,
};

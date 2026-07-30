# letterwriter-mcp

An MCP server that generates DOCX letters on **your organization's own letterhead** and
returns the document as an attachment.

Point an AI assistant at it and "write Ms. Okonkwo a closing letter for her Riverside
case" produces a correctly branded Word document, signed by the right office, that
someone can review and send.

It speaks [MCP](https://modelcontextprotocol.io) over streamable HTTP, so it works with
LibreChat, Claude Desktop, or anything else that speaks the protocol. It is useful to any
organization that sends letters on headed paper — legal aid, clinics, nonprofits — and
knows nothing about the deployment it came from.

## Tools

| Tool | Does |
|---|---|
| `create_letter` | Renders a letter and returns the `.docx` itself |
| `list_letterheads` | Lists the letterhead IDs and labels available |

`create_letter` returns the document as **MCP binary content** — an embedded resource
carrying the bytes — rather than a download link. There is no object storage here, no
credentials to leak, and no URL that expires and turns a letter from last month into a
dead link.

## Your letterheads never live in this repository

This repository ships **one** template: a 1.3 KB placeholder that says
`[ YOUR LETTERHEAD ARTWORK GOES HERE ]`. Your own letterheads stay outside it.

At runtime the server reads a **registry** — a `letterheads.json` describing your offices
— and the `.docx` files it names:

```
${LETTERHEAD_DIR}/            # default /data/letterheads
├── letterheads.json
├── baltimore-city.docx
├── montgomery-county.docx
└── ...
```

If `${LETTERHEAD_DIR}/letterheads.json` exists, that registry and those templates are
used. If it does not, the server falls back to the copy committed here, so a fresh
install starts and can produce a letter before anyone has uploaded anything.

`/healthz` reports which one is in force:

```json
{"ok":true,"service":"letterwriter-mcp","version":"1.0.0",
 "letterheads":{"count":13,"default":"generic",
                "registry":"/data/letterheads/letterheads.json",
                "using_bundled_registry":false}}
```

**Check `using_bundled_registry` first** when every letter comes out on the wrong
letterhead. A `LETTERHEAD_DIR` that is empty or never mounted leaves the placeholder in
charge, and everything else looks perfectly healthy.

### The registry

```json
{
  "defaultId": "generic",
  "stopWords": ["office", "example legal aid"],
  "letterheads": [
    {
      "id": "riverside",
      "label": "Riverside",
      "file": "riverside.docx",
      "aliases": ["riverside", "riverside branch", "north county"],
      "legalserver_offices": ["Riverside Branch"],
      "include_unit_name": true
    }
  ]
}
```

| Field | Means |
|---|---|
| `id` | Stable machine name; what `letterhead_id` accepts |
| `label` | Human name, shown by `list_letterheads` |
| `file` | A **bare filename** in the same directory as the registry |
| `aliases` | Free-text spellings an assistant might be handed for this office |
| `legalserver_offices` | Exact office names as [LegalServer](https://legalserver.org) spells them, if you use it |
| `include_unit_name` | When true, a `unit_name` argument is added to this office's signature block |
| `defaultId` | Which letterhead to use when nothing matches |
| `stopWords` | Words ignored when matching. **Add your organization's own name**, so "Example Legal Aid — Riverside Office" matches `riverside`. |

The whole registry is validated at startup and **every** problem is reported at once — a
missing `.docx`, a duplicate id, a `defaultId` matching nothing. Finding those one letter
at a time, in production, while someone waits to send mail to a client, is the experience
this avoids.

Matching prefers the **longest** alias, so `riverside suite 300` beats `riverside` rather
than depending on the order of the file.

### Making a template

Copy `templates/letterheads/generic.docx`, put your artwork in it, and keep the
placeholders. They are [docxtemplater](https://docxtemplater.com) tags:

`{today}` `{client_name}` `{address1}` `{address2}` `{honorific}` `{client_last_name}`
`{message_body}` `{attorney}` `{signature_lines}`

`{signature_lines}` is filled with your organization name, the office name, and — for
offices setting `include_unit_name` — the unit.

## Running it

```bash
docker run -d --name letterwriter-mcp \
  -e ORGANIZATION_NAME="Example Legal Aid" \
  -e MCP_ALLOWED_HOSTS=letterwriter-mcp,localhost,127.0.0.1 \
  -v /srv/letterheads:/data/letterheads:ro \
  -p 127.0.0.1:3002:3002 \
  ghcr.io/marylandlegalaid/letterwriter-mcp:v1.1.0
```

| Variable | Default | Means |
|---|---|---|
| `ORGANIZATION_NAME` | `Your Organization` | First line of every signature block. **Set this.** |
| `LETTERHEAD_DIR` | `/data/letterheads` | Your registry and templates |
| `MCP_HTTP_HOST` | `127.0.0.1` | `0.0.0.0` in a container |
| `MCP_HTTP_PORT` | `3002` | |
| `MCP_ALLOWED_HOSTS` | unset | **See below** |
| `MCP_SHARED_SECRET` | unset | Optional shared-secret header; no-ops when unset |
| `LETTER_OUTPUT_DIR` | unset | Where finished letters are written. **Set with the next one or neither** |
| `LETTER_PUBLIC_BASE_URL` | unset | Absolute URL prefix serving that directory |
| `LETTERHEAD_REGISTRY_PATH` | — | Override just the registry path |
| `LETTERHEAD_TEMPLATES_DIR` | — | Override just the template directory |

### How the document comes back

Two modes, chosen by whether `LETTER_OUTPUT_DIR` and `LETTER_PUBLIC_BASE_URL` are set.

**Unset (default) — embedded bytes.** `create_letter` returns the `.docx` as an MCP
embedded resource with a base64 `blob`. This is what the MCP specification provides for
and needs no storage.

**Both set — a download URL.** The letter is written to
`${LETTER_OUTPUT_DIR}/<random-token>/<filename>.docx` and the tool returns an absolute
URL. Setting only one is a startup error: an output directory with no URL writes files
nobody can reach, and a URL with no directory advertises files that were never written.
Both are invisible until someone clicks a link, so they are refused up front.

!!! warning "LibreChat users: you need URL mode"
    **LibreChat v0.8.7 does not read `blob`.** Its MCP tool-result handler has cases for
    text, image and resource, and the resource case reads only `ui://` URIs, `text`, `uri`
    and `mimeType`. The bytes are dropped, and the model is handed a description of a file
    it cannot give anyone — typically producing a plausible-looking link to `file:///…`,
    which a browser resolves against the current page. Configure URL mode.

The URL is a capability: whoever has it can fetch the document, with no further
authentication. The token is 24 CSPRNG bytes, base64url-encoded, so it is not guessable.
Note that in the LibreChat case the letter's text is already in the conversation that
produced it, so the file exposes nothing that conversation does not.

Links **do not expire**, deliberately — an expiring link makes a letter written three
weeks ago look like data loss. Retention is the deployment's business; the directory is
ordinary files on disk and can be pruned by age if it ever needs to be.

**`MCP_ALLOWED_HOSTS` will bite you.** The MCP SDK rejects requests whose `Host` header
it does not recognize. Behind Docker Compose the caller sends the *service name*, so that
name has to be in this list or every request is refused. Symptom: the server is healthy,
the client reports a connection error, and nothing obviously connects the two.

### With LibreChat

```yaml
mcpSettings:
  allowedAddresses:
    - "letterwriter-mcp:3002"      # LibreChat blocks internal hostnames without this

mcpServers:
  LetterWriter:
    type: streamable-http
    url: http://letterwriter-mcp:3002/letter-writer/mcp
    description: "Create DOCX letters on organization letterhead"
    chatMenu: true
```

`allowedAddresses` is not optional. LibreChat treats a Docker service name as an SSRF
target and refuses every connection without it, reporting `Domain ... is not allowed`.

A worked deployment — Compose service, storage, backups — is in
[MarylandLegalAid/librechat-azure](https://github.com/MarylandLegalAid/librechat-azure).

## Trust boundary

This server has **no authentication by default**, on purpose. It is built to run on a
private container network reachable only by the application that calls it, and that
network is the boundary.

Set `MCP_SHARED_SECRET` if you ever put it anywhere else. Note also that it renders
whatever text it is given onto your letterhead: whoever can reach it can produce a
document that looks official.

## Development

```bash
npm install
npm test            # 29 tests, no network, no fixtures on disk
npm start
```

## License

MIT — see [LICENSE](LICENSE). No warranty; see the license text.

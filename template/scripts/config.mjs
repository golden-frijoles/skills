#!/usr/bin/env node
// config.mjs — `frijoles-kit config`: read and change golden-frijoles.config.json (golden-frijoles-plugin S4.1, D10).
//
//   frijoles-kit config list [--json]            every section's effective value, where it came from, any duplicates
//   frijoles-kit config get <key> [--json]       one key's effective value (or its registry default)
//   frijoles-kit config set <key> <value>        write one key; <value> is parsed as JSON when it is valid JSON
//   frijoles-kit config migrate [--dry-run]      fold the legacy files into golden-frijoles.config.json (never edits them)
//
// A thin front end: every rule (precedence, the secret guard, what migrate folds) lives in lib/config.mjs, which the
// `gf` CLI imports too. Exit 0 ok · 1 usage · 2 configuration error (a malformed file, a secret, an unknown section).

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, ConfigError, getKey, loadConfig, migrate, setKey } from './lib/config.mjs';

const USAGE = 'usage: frijoles-kit config list|get <key>|set <key> <value>|migrate [--dry-run] [--json]';

/** Pure — a CLI value: JSON when it parses (true, 3, ["a"], null), otherwise the literal string. */
export function parseValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function main(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json' && a !== '--dry-run');
  const [verb, key, ...rest] = args;
  try {
    if (verb === 'list') {
      const c = loadConfig();
      if (json) return out(`${JSON.stringify(c, null, 2)}\n`), 0;
      const names = Object.keys(c.sections);
      if (!names.length) out(`No settings yet: no ${CONFIG_FILENAME} and no legacy config files.\n`);
      for (const name of names) {
        out(`${name}  (${c.sources[name].map((s) => s.split('/').pop()).join(' + ')})\n`);
        out(`${JSON.stringify(c.sections[name], null, 2).replace(/^/gm, '  ')}\n`);
      }
      if (c.duplicates.length) out(`\nset in both the new file and a legacy file (the new file wins): ${c.duplicates.join(', ')}\n`);
      return 0;
    }
    if (verb === 'get' && key) {
      const value = getKey(key);
      out(json ? `${JSON.stringify({ key, value })}\n` : `${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
      return 0;
    }
    if (verb === 'set' && key && rest.length) {
      setKey(key, parseValue(rest.join(' ')));
      out(json ? `${JSON.stringify({ key, value: getKey(key) })}\n` : `${key} = ${JSON.stringify(getKey(key))}\n`);
      return 0;
    }
    if (verb === 'migrate') {
      const dryRun = argv.includes('--dry-run');
      const r = migrate({ dryRun });
      if (json) return out(`${JSON.stringify({ dryRun, ...r }, null, 2)}\n`), 0;
      if (!r.folded.length) out('Nothing to migrate: no legacy settings the new file does not already have.\n');
      else if (dryRun) out(`Would write ${CONFIG_FILENAME}:\n${JSON.stringify(r.config, null, 2)}\n`);
      else out(`Wrote ${CONFIG_FILENAME} (${r.folded.length} setting(s) folded; the legacy files are untouched).\n`);
      if (r.skipped.length) out(`Skipped (look like secrets; keep them in .env.local): ${r.skipped.join(', ')}\n`);
      return 0;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      err(`frijoles-kit config: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  err(`${USAGE}\n`);
  return 1;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));

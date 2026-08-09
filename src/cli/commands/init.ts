// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode init` — generate a starter crisismode.yaml or scaffold a check plugin.
 */

import { writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { generateTemplate } from '../../config/init.js';
import { printSuccess, printInfo } from '../output.js';
import type { CheckPluginManifest } from '../../framework/check-plugin.js';

export interface InitOptions {
  /**
   * `--plugin <name>` — canonical flag: scaffold a check plugin. Typed loosely
   * because the CLI parses with `strict: false`, where a valueless `--plugin`
   * arrives as `true` rather than a name.
   */
  plugin?: string | boolean | undefined;
  /**
   * `--agent <name>` — deprecated alias for `--plugin`, kept working for
   * existing users. It never scaffolded a RecoveryAgent (`src/agent/*`); the
   * name misled about what the command creates.
   */
  agent?: string | boolean | undefined;
}

/** Plugin names become a directory under `checks/`, so keep them path-safe. */
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function pluginNameFrom(flag: 'plugin' | 'agent', value: string | boolean | undefined): string | undefined {
  // Only `undefined` means "flag omitted". The parser registers these as string
  // options with no default, so an absent flag is always `undefined` and never
  // `false` — anything else, including `false`, is bad input and gets a usage
  // error rather than silently falling through to writing crisismode.yaml.
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`--${flag} requires a plugin name, e.g. crisismode init --${flag} my-check`);
  }
  if (!PLUGIN_NAME_PATTERN.test(value)) {
    throw new Error(
      `Invalid plugin name "${value}". Use letters, digits, ".", "_", or "-" — the name becomes a directory under checks/.`,
    );
  }
  return value;
}

/**
 * Deprecation notices go to stderr, not stdout: they describe how the command
 * was invoked rather than what it produced, so they stay out of piped output
 * and are never swallowed the way `printWarning` is in machine mode.
 */
function printDeprecation(msg: string): void {
  process.stderr.write(`  ! ${msg}\n`);
}

export async function runInit(outputPath?: string, options: InitOptions = {}): Promise<void> {
  const plugin = pluginNameFrom('plugin', options.plugin);
  const agent = pluginNameFrom('agent', options.agent);

  if (agent) {
    // `--plugin` wins when both are given — the canonical flag is the one the
    // user is being pointed at, so honoring it keeps the two invocations from
    // disagreeing about which name gets scaffolded.
    if (plugin && plugin !== agent) {
      printDeprecation(
        `--agent is deprecated; scaffolding --plugin ${plugin} and ignoring --agent ${agent}.`,
      );
    } else {
      printDeprecation(
        `--agent is deprecated and will be removed in a future release. Use: crisismode init --plugin ${agent}`,
      );
    }
  }

  const pluginName = plugin ?? agent;
  if (pluginName) {
    await scaffoldCheckPlugin(pluginName);
    return;
  }

  const targetPath = resolve(outputPath || 'crisismode.yaml');

  if (existsSync(targetPath)) {
    throw new Error(`File already exists: ${targetPath}\nRemove it first or specify a different path: crisismode init other.yaml`);
  }

  writeFileSync(targetPath, generateTemplate(), 'utf-8');
  printSuccess(`Created ${targetPath}`);
  console.log('');
  printInfo('Next steps:');
  printInfo('  1. Edit crisismode.yaml with your infrastructure details');
  printInfo('  2. Set environment variables for credentials');
  printInfo('  3. Run: crisismode diagnose');
}

async function scaffoldCheckPlugin(name: string): Promise<void> {
  const pluginDir = resolve('checks', name);

  if (existsSync(pluginDir)) {
    throw new Error(`Directory already exists: ${pluginDir}\nRemove it first or choose a different name.`);
  }

  // Create the plugin directory
  mkdirSync(pluginDir, { recursive: true });

  // Write manifest.json
  const manifest: CheckPluginManifest = {
    name,
    description: `Custom check plugin: ${name}`,
    version: '0.1.0',
    targetKinds: ['generic'],
    verbs: ['health', 'diagnose', 'plan'],
    executable: './check.sh',
    timeoutMs: 10_000,
  };

  writeFileSync(
    join(pluginDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );

  // Write check.sh
  const checkScript = `#!/usr/bin/env bash
# ${name} — CrisisMode check plugin
# Receives JSON on stdin, returns JSON on stdout.
# Exit codes: 0=OK, 1=warning, 2=critical, 3=unknown

set -euo pipefail

# Read the full request from stdin
REQUEST="$(cat)"

# Extract the verb from the JSON request
VERB="$(echo "$REQUEST" | sed -n 's/.*"verb"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"

case "$VERB" in
  health)
    cat <<'JSON'
{
  "status": "healthy",
  "summary": "${name} reports all systems nominal",
  "confidence": 0.8,
  "signals": [
    {
      "source": "${name}",
      "status": "healthy",
      "detail": "Basic health check passed"
    }
  ],
  "recommendedActions": []
}
JSON
    ;;
  diagnose)
    cat <<'JSON'
{
  "healthy": true,
  "summary": "No issues detected by ${name}",
  "findings": []
}
JSON
    ;;
  plan)
    cat <<'JSON'
{
  "name": "${name}-recovery",
  "description": "Recovery plan generated by ${name}",
  "steps": []
}
JSON
    ;;
  *)
    echo "{\\"error\\": \\"Unknown verb: $VERB\\"}" >&2
    exit 3
    ;;
esac

exit 0
`;

  writeFileSync(join(pluginDir, 'check.sh'), checkScript, 'utf-8');
  chmodSync(join(pluginDir, 'check.sh'), 0o755);

  printSuccess(`Scaffolded check plugin at ${pluginDir}/`);
  console.log('');
  printInfo('Created files:');
  printInfo(`  ${join(pluginDir, 'manifest.json')}  — plugin manifest`);
  printInfo(`  ${join(pluginDir, 'check.sh')}       — executable check script`);
  console.log('');
  printInfo('Next steps:');
  printInfo('  1. Edit check.sh with your health/diagnose/plan logic');
  printInfo('  2. Update manifest.json targetKinds to match your system');
  printInfo(`  3. Test: echo '{"verb":"health","target":{"name":"test","kind":"generic"}}' | ./checks/${name}/check.sh`);
}

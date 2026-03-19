#!/usr/bin/env node
/**
 * git-doc-mcp CLI entry point.
 *
 * Usage:
 *   npx git-doc-mcp --manifest <url-or-path> [options]
 *   npx git-doc-mcp serve --manifest <url-or-path> [options]
 *
 * Options:
 *   --manifest <path>          URL or local path to manifest.yml
 *   --manifest-header <header> Header for fetching manifest (can be repeated)
 *   --manifest-hash <hash>     Expected manifest hash (for pinning)
 *   --action-code-header <h>   Header for downloading action scripts
 *   --secret <name=value>      Pre-approved secret (can be repeated)
 *   --help                     Show help
 *   --version                  Show version
 */

import { Command } from 'commander';
import { serveCommand, type ServeOptions } from './commands/serve.js';

const program = new Command();

program
  .name('git-doc-mcp')
  .description('Turn any manifest into an MCP server')
  .version('0.2.2');

// Top-level options (allow running without 'serve' subcommand)
program
  .option('--manifest <path>', 'URL or local path to manifest.yml')
  .option('--manifest-header <header>', 'Header for fetching manifest (can be repeated)', collect, [])
  .option('--manifest-hash <hash>', 'Expected manifest hash for pinning')
  .option('--action-code-header <header>', 'Header for downloading action scripts', collect, [])
  .option('--resource-header <header>', 'Header for fetching resources (can be repeated)', collect, [])
  .option('--secret <name=value>', 'Pre-approved secret (can be repeated)', collect, [])
  .option('--timeout <ms>', 'Worker timeout in milliseconds', '60000')
  .option('--memory-limit <bytes>', 'Memory limit for sandbox', '134217728')
  .option('--allow-http', 'Allow insecure HTTP connections (default: HTTPS-only)', false)
  .option('--trust-changed', 'Accept manifest changes on TOFU hash mismatch', false)
  .option('--rate-limit <calls-per-minute>', 'Rate limit for tool calls (0 = unlimited)', '60')
  .action((options: ServeOptions) => {
    // If --manifest is provided at top level, run serve directly
    if (options.manifest) {
      return serveCommand(options);
    }
    // Otherwise show help
    program.outputHelp();
  });

// 'serve' subcommand (explicit)
program
  .command('serve')
  .description('Start MCP server from a manifest')
  .requiredOption('--manifest <path>', 'URL or local path to manifest.yml')
  .option('--manifest-header <header>', 'Header for fetching manifest (can be repeated)', collect, [])
  .option('--manifest-hash <hash>', 'Expected manifest hash for pinning')
  .option('--action-code-header <header>', 'Header for downloading action scripts', collect, [])
  .option('--resource-header <header>', 'Header for fetching resources (can be repeated)', collect, [])
  .option('--secret <name=value>', 'Pre-approved secret (can be repeated)', collect, [])
  .option('--timeout <ms>', 'Worker timeout in milliseconds', '60000')
  .option('--memory-limit <bytes>', 'Memory limit for sandbox', '134217728')
  .option('--allow-http', 'Allow insecure HTTP connections (default: HTTPS-only)', false)
  .option('--trust-changed', 'Accept manifest changes on TOFU hash mismatch', false)
  .option('--rate-limit <calls-per-minute>', 'Rate limit for tool calls (0 = unlimited)', '60')
  .action(serveCommand);

/**
 * Collect repeated option values.
 */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// Parse arguments
program.parse();

export { program };
#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  console.log('Starting MCP client + server...\n');
  const transport = new StdioClientTransport({
    command: 'node', args: ['dist/cli/index.js', '--manifest', '.mcp/manifest.yml', '--trust-changed', '--rate-limit', '0'],
    cwd: '/app/git-doc-mcp',
  });
  const client = new Client({ name: 'e2e-test', version: '1.0.0' });
  await client.connect(transport);

  const results = [];
  function test(name, fn) { results.push({ name, fn }); }

  test('List tools (5)', async () => { const r = await client.listTools(); console.log(`  ${r.tools.map(t=>t.name).join(', ')}`); if (r.tools.length !== 5) throw new Error(`got ${r.tools.length}`); });
  test('List resources (3)', async () => { const r = await client.listResources(); console.log(`  ${r.resources.map(t=>t.name).join(', ')}`); if (r.resources.length !== 3) throw new Error(`got ${r.resources.length}`); });
  test('List prompts (3)', async () => { const r = await client.listPrompts(); console.log(`  ${r.prompts.map(t=>t.name).join(', ')}`); if (r.prompts.length !== 3) throw new Error(`got ${r.prompts.length}`); });
  test('list_topics', async () => { const r = await client.callTool({ name: 'list_topics', arguments: {} }); if (!r.content[0].text.includes('documentation topics')) throw new Error('bad'); console.log(`  OK ${r.content[0].text.length}b`); });
  test('get_guide', async () => { const r = await client.callTool({ name: 'get_guide', arguments: { topic: 'Getting-Started' } }); if (!r.content[0].text.includes('Getting Started')) throw new Error('bad'); console.log(`  OK ${r.content[0].text.length}b`); });
  test('search_docs', async () => { const r = await client.callTool({ name: 'search_docs', arguments: { query: 'secret scope' } }); if (r.content.length < 2) throw new Error(`${r.content.length} blocks`); console.log(`  OK ${r.content.length} blocks`); });
  test('get_example', async () => { const r = await client.callTool({ name: 'get_example', arguments: { name: 'github-repo-tools' } }); if (!r.content[0].text.includes('GitHub Repo Tools')) throw new Error('bad'); console.log(`  OK ${r.content[0].text.length}b`); });
  test('get_action_api', async () => { const r = await client.callTool({ name: 'get_action_api', arguments: {} }); if (!r.content[0].text.includes('ctx.fetch')) throw new Error('bad'); console.log(`  OK ${r.content[0].text.length}b`); });
  test('Resource read', async () => { const r = await client.readResource({ uri: 'https://raw.githubusercontent.com/wiki/Z-M-Huang/git-doc-mcp/Getting-Started.md' }); if (!r.contents[0].text.includes('Getting Started')) throw new Error('bad'); console.log(`  OK ${r.contents[0].text.length}b`); });
  test('Prompt args', async () => { const r = await client.getPrompt({ name: 'create-manifest', arguments: { project_name: 'test-proj', description: 'test' } }); if (!r.messages.find(m=>m.content.type==='text').content.text.includes('test-proj')) throw new Error('bad'); console.log(`  OK ${r.messages.length} msgs`); });

  console.log('--- E2E Tests ---\n');
  let p=0, f=0;
  for (const {name, fn} of results) { try { await fn(); console.log(`PASS: ${name}`); p++; } catch(e) { console.log(`FAIL: ${name} — ${e.message}`); f++; } }
  console.log(`\n--- ${p} passed, ${f} failed ---`);
  await client.close();
  process.exit(f > 0 ? 1 : 0);
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });

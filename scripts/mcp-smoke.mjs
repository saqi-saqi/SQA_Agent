// Smoke test: talk to the MCP server over stdio (dev-only helper).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/stdio.js'],
});
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map(t => t.name).join(', '));

const res = await client.callTool({ name: 'explain_finding', arguments: { rule_id: 'api-status-mismatch' } });
console.log('explain_finding →', res.content[0].text.slice(0, 200));

const bad = await client.callTool({ name: 'explain_finding', arguments: { wrong: true } });
console.log('schema violation isError:', bad.isError, '|', bad.content?.[0]?.text?.slice(0, 120));

const blocked = await client.callTool({ name: 'quick_check', arguments: { url: 'http://192.168.1.1/' } });
console.log('SSRF-blocked isError:', blocked.isError, '|', blocked.content?.[0]?.text?.slice(0, 120));

await client.close();

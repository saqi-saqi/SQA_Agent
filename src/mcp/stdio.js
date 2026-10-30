#!/usr/bin/env node
/**
 * mcp/stdio.js — TestFlow MCP server entry point (stdio transport).
 *
 * Local-process-only by design: the agent spawns this as a subprocess and
 * speaks MCP over stdin/stdout. Nothing listens on the network. If an
 * HTTP/SSE transport is added later for remote use, authentication becomes
 * MANDATORY before that ships — do not expose this server as-is.
 *
 * Register in the agent's .mcp.json:
 *   { "mcpServers": { "testflow": { "command": "node",
 *       "args": ["<absolute-path>/sqa-agent/src/mcp/stdio.js"] } } }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOL_DEFS } from './tools.js';

const server = new McpServer({
  name: 'testflow',
  version: '0.3.0',
});

for (const tool of TOOL_DEFS) {
  server.registerTool(tool.name, {
    title: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }, tool.handler);
}

// Log to stderr only — stdout is the MCP protocol channel.
console.error(`testflow-mcp: starting with ${TOOL_DEFS.length} tools (stdio transport, local process only)`);

await server.connect(new StdioServerTransport());
console.error('testflow-mcp: connected');

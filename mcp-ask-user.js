#!/usr/bin/env node
// A small stdio MCP server. Only protocol replies go to stdout.
const readline = require('node:readline');
const fs = require('node:fs');

const settings = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : process.env;

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const tool = {
  name: 'ask_user',
  description: 'Ask the person using CLI Web a question and wait for their answer before continuing. Use when you need a choice, confirmation, or missing detail during this turn.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to show the user' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional choices to list' }
    },
    required: ['question']
  }
};

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
  const fail = message => send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message } });
  if (request.method === 'initialize') {
    return reply({
      protocolVersion: request.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'cli-web-ask-user', version: '1.0.0' }
    });
  }
  if (request.method === 'ping') return reply({});
  if (request.method === 'tools/list') return reply({ tools: [tool] });
  if (request.method !== 'tools/call' || request.params?.name !== 'ask_user') return fail('Unknown method or tool');
  const args = request.params.arguments || {};
  if (typeof args.question !== 'string' || !args.question.trim()) return fail('Question is required');
  try {
    const response = await fetch(`http://127.0.0.1:${settings.CLI_WEB_MCP_PORT}/api/mcp/question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': settings.CLI_WEB_MCP_TOKEN },
      body: JSON.stringify({ session: settings.CLI_WEB_MCP_SESSION, question: args.question, options: args.options }),
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    const result = await response.json();
    if (!response.ok) return fail(result.error || 'Question could not be delivered');
    reply({ content: [{ type: 'text', text: result.answer }] });
  } catch { fail('Question timed out or the chat disconnected'); }
});

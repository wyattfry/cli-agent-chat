const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { createServer } = require('./server');

const originalHome = process.env.HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-agent-chat-home-'));
const project = path.join(testHome, 'project');
fs.mkdirSync(project);
process.env.HOME = testHome;
test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

test('Given explicit CLI credentials, when a CLI starts or resumes, then it inherits them unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-web-auth-'));
  const bin = path.join(dir, 'fake-cli');
  const keys = ['CODER_SESSION_TOKEN', 'AZURE_OPENAI_API_KEY', 'CLI_AUTH_TEST_CONTEXT'];
  const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  fs.writeFileSync(bin, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const text = JSON.stringify({ key: process.env.AZURE_OPENAI_API_KEY, context: process.env.CLI_AUTH_TEST_CONTEXT });
  if (process.argv.includes('-p')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));
  } else {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  }
});`);
  fs.chmodSync(bin, 0o755);
  const server = createServer({ codexBin: bin, claudeBin: bin, sessionsDir: path.join(dir, 'sessions') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const { token } = await (await fetch(url + '/api/config')).json();
    for (const scenario of [
      { provider: 'codex', sessionToken: 'dummy-current-token', key: 'dummy-stale-token', expected: 'dummy-stale-token' },
      { provider: 'codex', sessionToken: 'dummy-current-token', key: undefined, expected: undefined },
      { provider: 'codex', sessionToken: undefined, key: 'dummy-explicit-key', expected: 'dummy-explicit-key' },
      { provider: 'codex', sessionToken: '', key: 'dummy-explicit-key', expected: 'dummy-explicit-key' },
      { provider: 'claude', sessionToken: 'dummy-current-token', key: 'dummy-explicit-key', expected: 'dummy-explicit-key' }
    ]) {
      for (const [key, value] of Object.entries({ CODER_SESSION_TOKEN: scenario.sessionToken, AZURE_OPENAI_API_KEY: scenario.key, CLI_AUTH_TEST_CONTEXT: 'dummy-context' })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      let session;
      for (const prompt of ['start', 'resume']) {
        const response = await fetch(url + '/api/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Token': token },
          body: JSON.stringify({ provider: scenario.provider, cwd: project, prompt, session })
        });
        assert.equal(response.status, 200);
        const events = (await response.text()).trim().split('\n').map(JSON.parse);
        session = events.find(event => event.type === 'session').id;
        const output = JSON.parse(events.filter(event => event.type === 'text').map(event => event.text).join(''));
        assert.equal(output.key, scenario.expected, `${scenario.provider} ${prompt}`);
        assert.equal(output.context, 'dummy-context');
        assert.equal(process.env.AZURE_OPENAI_API_KEY, scenario.key, 'the server environment must remain unchanged');
      }
    }
  } finally {
    for (const key of keys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Given a workspace home, when the page loads, then chats default to that existing directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-web-cwd-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.env.CLI_AGENT_CHAT_CWD;
  process.env.HOME = dir;
  process.env.CLI_AGENT_CHAT_CWD = path.join(dir, 'missing-repo');
  const server = createServer({ sessionsDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = await (await fetch(`http://127.0.0.1:${server.address().port}/api/config`)).json();
    assert.equal(config.cwd, fs.realpathSync(dir));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCwd === undefined) delete process.env.CLI_AGENT_CHAT_CWD;
    else process.env.CLI_AGENT_CHAT_CWD = originalCwd;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Given a local page, when prompts are sent, then each CLI streams text and resumes its session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-web-'));
  const bin = path.join(dir, 'fake-cli');
  const sessionsDir = path.join(dir, 'sessions');
  fs.writeFileSync(bin, `#!/usr/bin/env node
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const claude = process.argv.includes('-p');
  const resume = process.argv.includes('resume') || process.argv.includes('--resume');
  const modelFlag = process.argv.findIndex(arg => arg === '-m' || arg === '--model');
  const model = modelFlag >= 0 ? process.argv[modelFlag + 1] : 'default';
  const id = '11111111-1111-4111-8111-111111111111';
  if (prompt === 'ask') {
    const fs = require('node:fs');
    const mcpArgs = claude
      ? JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.cli_web.args
      : JSON.parse(process.argv.find(arg => arg.startsWith('mcp_servers.cli_web.args=')).slice('mcp_servers.cli_web.args='.length));
    const env = JSON.parse(fs.readFileSync(mcpArgs[1], 'utf8'));
    if (claude) console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
    else console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
    if (claude) console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Before question' }] } }));
    else console.log(JSON.stringify({ type: 'item.completed', item: { id: 'before', type: 'agent_message', text: 'Before question' } }));
    fetch('http://127.0.0.1:' + env.CLI_WEB_MCP_PORT + '/api/mcp/question', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MCP-Token': env.CLI_WEB_MCP_TOKEN },
      body: JSON.stringify({ session: env.CLI_WEB_MCP_SESSION, question: 'Choose a letter', options: ['A', 'B'] })
    }).then(response => response.json()).then(result => {
      if (claude) console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Answer: ' + result.answer }] } }));
      else console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Answer: ' + result.answer } }));
    });
    return;
  }
  if (claude) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
    if (prompt === 'stream') {
      console.log(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } }));
      console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'par' } } }));
      setTimeout(() => {
        console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'tial' } } }));
        console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }));
      }, 50);
      return;
    }
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: (resume ? 'again ' : 'first ') + prompt + ' model=' + model }] } }));
  } else {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
    if (prompt === 'stream') {
      console.log(JSON.stringify({ type: 'turn.started' }));
      console.log(JSON.stringify({ type: 'item.updated', item: { id: 'one', type: 'agent_message', text: 'par' } }));
      setTimeout(() => console.log(JSON.stringify({ type: 'item.completed', item: { id: 'one', type: 'agent_message', text: 'partial' } })), 50);
      return;
    }
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: (resume ? 'again ' : 'first ') + prompt + ' model=' + model } }));
  }
});


`);
  fs.chmodSync(bin, 0o755);
  let server = createServer({ codexBin: bin, claudeBin: bin, sessionsDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const config = await (await fetch(url + '/api/config')).json();
    const page = await (await fetch(url + '/?prompt=hello&submit=1')).text();
    assert.match(page, /Codex/);
    assert.match(page, /Claude/);
    assert.match(page, /vendor\/markdown-it\.js/);
    assert.equal((await fetch(url + '/vendor/markdown-it.js')).status, 200);

    const ids = {};
    for (const provider of ['codex', 'claude']) {
      const model = provider === 'codex' ? 'dummy-codex-model' : 'dummy-claude-model';
      let session;
      for (const [index, prompt] of ['hello', 'next'].entries()) {
        const response = await fetch(url + '/api/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Token': config.token },
          body: JSON.stringify({ provider, model, cwd: project, prompt, session })
        });
        assert.equal(response.status, 200);
        const events = (await response.text()).trim().split('\n').map(JSON.parse);
        session = events.find(event => event.type === 'session').id;
        ids[provider] = session;
        assert.match(events.find(event => event.type === 'text').text, new RegExp(`${index ? 'again' : 'first'} ${prompt}`));
        assert.match(events.find(event => event.type === 'text').text, new RegExp(`model=${model}`));
        assert.equal(events.at(-1).type, 'done');
      }
    }

    const listing = await (await fetch(url + '/api/conversations', { headers: { 'X-UI-Token': config.token } })).json();
    assert.equal(listing.length, 2);
    assert.deepEqual(new Set(listing.map(item => item.id)), new Set(Object.values(ids)));
    assert.equal(listing.find(item => item.id === ids.codex).title, 'hello');
    assert.equal(listing.find(item => item.id === ids.claude).model, 'dummy-claude-model');
    assert.equal(listing.find(item => item.id === ids.codex).status, 'Ready');
    const renameDenied = await fetch(url + '/api/conversations/' + ids.codex, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Private name' })
    });
    assert.equal(renameDenied.status, 403);
    const renameInvalid = await fetch(url + '/api/conversations/' + ids.codex, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-UI-Token': config.token }, body: JSON.stringify({ title: '  ' })
    });
    assert.equal(renameInvalid.status, 400);
    const rename = await fetch(url + '/api/conversations/' + ids.codex, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-UI-Token': config.token }, body: JSON.stringify({ title: 'AWS study' })
    });
    assert.equal(rename.status, 200);
    assert.equal((await rename.json()).title, 'AWS study');
    const conversation = await (await fetch(url + '/api/conversations/' + ids.codex, { headers: { 'X-UI-Token': config.token } })).json();
    assert.deepEqual(conversation.messages.map(message => message.kind), ['user', 'assistant', 'user', 'assistant']);
    assert.match(conversation.messages.at(-1).text, /again next/);
    assert.equal(conversation.model, 'dummy-codex-model');

    const wrongModel = await fetch(url + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Token': config.token },
      body: JSON.stringify({ provider: 'codex', model: 'other', cwd: project, prompt: 'hello', session: ids.codex })
    });
    assert.equal(wrongModel.status, 400);
    const invalidModel = await fetch(url + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Token': config.token },
      body: JSON.stringify({ provider: 'codex', model: '--bad', cwd: project, prompt: 'hello' })
    });
    assert.equal(invalidModel.status, 400);

    const forbidden = await fetch(url + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Token': config.token, Origin: 'https://other.example' },
      body: JSON.stringify({ provider: 'codex', cwd: project, prompt: 'hello' })
    });
    assert.equal(forbidden.status, 403);
    const invalidPath = await fetch(url + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Token': config.token },
      body: JSON.stringify({ provider: 'codex', cwd: '/tmp', prompt: 'hello' })
    });
    assert.equal(invalidPath.status, 400);

    for (const provider of ['codex', 'claude']) {
      const events = await new Promise((resolve, reject) => {
        const socket = new WebSocket(url.replace('http:', 'ws:') + '/api/stream', ['cli-web', config.token], { origin: url });
        const received = [];
        socket.on('open', () => socket.send(JSON.stringify({ type: 'run', provider, cwd: project, prompt: 'stream' })));
        socket.on('message', data => {
          const event = JSON.parse(data.toString());
          received.push(event);
          if (event.type === 'done') { socket.close(); resolve(received); }
        });
        socket.on('error', reject);
      });
      assert.equal(events.at(-1).type, 'done');
      assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'partial\n');
      assert.ok(events.find(event => event.type === 'status'));
      assert.ok(events.findIndex(event => event.type === 'text') < events.findIndex(event => event.type === 'done'));
    }

    const unauthorizedQuestion = await fetch(url + '/api/mcp/question', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'wrong' },
      body: JSON.stringify({ session: ids.codex, question: 'Denied' })
    });
    assert.equal(unauthorizedQuestion.status, 403);
    for (const provider of ['codex', 'claude']) {
      const userAnswer = provider === 'claude' ? '2' : 'B';
      const events = await new Promise((resolve, reject) => {
        const socket = new WebSocket(url.replace('http:', 'ws:') + '/api/stream', ['cli-web', config.token], { origin: url });
        const received = [];
        const timeout = setTimeout(() => { socket.close(); reject(new Error('Question test timed out')); }, 10000);
        socket.on('open', () => socket.send(JSON.stringify({ type: 'run', provider, cwd: project, prompt: 'ask' })));
        socket.on('message', data => {
          const event = JSON.parse(data.toString());
          received.push(event);
          if (event.type === 'question') socket.send(JSON.stringify({ type: 'answer', id: event.id, answer: userAnswer }));
          if (event.type === 'done') { clearTimeout(timeout); socket.close(); resolve(received); }
        });
        socket.on('error', reject);
      });
      assert.deepEqual(events.find(event => event.type === 'question').options, ['A', 'B']);
      assert.match(events.filter(event => event.type === 'text').map(event => event.text).join(''),
        provider === 'claude' ? /Selected option 2 of 2 \(1-based\): B/ : /Answer: B/);
      const id = events.find(event => event.type === 'session').id;
      const saved = await (await fetch(url + '/api/conversations/' + id, { headers: { 'X-UI-Token': config.token } })).json();
      assert.deepEqual(saved.messages.map(message => message.kind), ['user', 'assistant', 'assistant', 'user', 'assistant']);
      assert.match(saved.messages[1].text, /Before question/);
      assert.equal(saved.messages[3].text, userAnswer);
    }


    await new Promise(resolve => server.close(resolve));
    server = createServer({ codexBin: bin, claudeBin: bin, sessionsDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const restartedUrl = `http://127.0.0.1:${server.address().port}`;
    const restartedConfig = await (await fetch(restartedUrl + '/api/config')).json();
    const restored = await (await fetch(restartedUrl + '/api/conversations/' + ids.codex, { headers: { 'X-UI-Token': restartedConfig.token } })).json();
    assert.equal(restored.messages.length, 4);
    const renamed = await (await fetch(restartedUrl + '/api/conversations', { headers: { 'X-UI-Token': restartedConfig.token } })).json();
    assert.equal(renamed.find(item => item.id === ids.codex).title, 'AWS study');
    const resumed = await fetch(restartedUrl + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Token': restartedConfig.token },
      body: JSON.stringify({ provider: 'codex', model: 'dummy-codex-model', cwd: project, prompt: 'after restart', session: ids.codex })
    });
    assert.match(await resumed.text(), /again after restart/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Given a small text attachment, when a prompt runs, then the CLI can read it and chat keeps its name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-web-upload-'));
  const bin = path.join(dir, 'read-attachment');
  fs.writeFileSync(bin, `#!/usr/bin/env node
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const fs = require('node:fs');
  const file = prompt.match(/notes\\.txt \\(text\\): (\\S+)/)?.[1];
  const text = file ? fs.readFileSync(file, 'utf8').trim() : 'missing';
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
});`);
  fs.chmodSync(bin, 0o755);
  const server = createServer({ codexBin: bin, sessionsDir: path.join(dir, 'sessions') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const { token } = await (await fetch(url + '/api/config')).json();
    const headers = { 'X-UI-Token': token, 'X-File-Name': 'notes.txt' };
    const denied = await fetch(url + '/api/attachments', { method: 'POST', headers: { 'X-File-Name': 'notes.txt' }, body: 'secret' });
    assert.equal(denied.status, 403);
    const wrongOrigin = await fetch(url + '/api/attachments', { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: 'secret' });
    assert.equal(wrongOrigin.status, 403);
    const tooLarge = await fetch(url + '/api/attachments', { method: 'POST', headers, body: 'x'.repeat(256 * 1024 + 1) });
    assert.equal(tooLarge.status, 413);
    const binary = await fetch(url + '/api/attachments', { method: 'POST', headers, body: Buffer.from([0, 1, 2]) });
    assert.equal(binary.status, 400);
    const badName = await fetch(url + '/api/attachments', { method: 'POST', headers: { ...headers, 'X-File-Name': '../bad.txt' }, body: 'secret' });
    assert.equal(badName.status, 400);
    const uploaded = await fetch(url + '/api/attachments', { method: 'POST', headers, body: 'hello attachment' });
    assert.equal(uploaded.status, 201);
    const attachment = await uploaded.json();
    assert.equal(attachment.name, 'notes.txt');
    const invalidRun = await fetch(url + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Token': token },
      body: JSON.stringify({ provider: 'codex', cwd: project, prompt: 'Read it', attachments: ['../../etc/passwd'] })
    });
    assert.equal(invalidRun.status, 400);
    const response = await fetch(url + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Token': token },
      body: JSON.stringify({ provider: 'codex', cwd: project, prompt: 'Read it', attachments: [attachment.id] })
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.find(event => event.type === 'text').text, 'hello attachment');
    const id = events.find(event => event.type === 'session').id;
    const saved = await (await fetch(url + '/api/conversations/' + id, { headers: { 'X-UI-Token': token } })).json();
    assert.equal(saved.messages[0].text, 'Read it');
    assert.deepEqual(saved.messages[0].attachments, [{ id: attachment.id, name: 'notes.txt', type: 'text' }]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Given a pasted PNG, when sent to either CLI, then the image is available and preview access is protected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-web-image-'));
  const bin = path.join(dir, 'read-image');
  fs.writeFileSync(bin, `#!/usr/bin/env node
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const fs = require('node:fs');
  const line = prompt.split(String.fromCharCode(10)).find(value => value.startsWith('screenshot.png (image): '));
  const file = line?.slice('screenshot.png (image): '.length);
  const codex = process.argv.includes('exec');
  const nativeImage = process.argv.includes('--image=' + file);
  const readable = file && fs.readFileSync(file).subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  const text = (codex ? 'codex' : 'claude') + ' native=' + nativeImage + ' readable=' + readable;
  if (codex) console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  else console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));
});`);
  fs.chmodSync(bin, 0o755);
  const server = createServer({ codexBin: bin, claudeBin: bin, sessionsDir: path.join(dir, 'sessions') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const { token } = await (await fetch(url + '/api/config')).json();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/qXcAAAAASUVORK5CYII=', 'base64');
    const headers = { 'X-UI-Token': token, 'X-File-Name': 'screenshot.png', 'Content-Type': 'image/png' };
    const invalid = await fetch(url + '/api/attachments', { method: 'POST', headers, body: Buffer.from('not an image') });
    assert.equal(invalid.status, 400);
    const mismatch = await fetch(url + '/api/attachments', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/jpeg' }, body: png });
    assert.equal(mismatch.status, 400);
    const oversized = await fetch(url + '/api/attachments', { method: 'POST', headers, body: Buffer.alloc(5 * 1024 * 1024 + 1) });
    assert.equal(oversized.status, 413);
    const uploaded = await fetch(url + '/api/attachments', { method: 'POST', headers, body: png });
    assert.equal(uploaded.status, 201);
    const attachment = await uploaded.json();
    assert.equal(attachment.type, 'image');
    const denied = await fetch(url + '/api/attachments/' + attachment.id);
    assert.equal(denied.status, 403);
    const preview = await fetch(url + '/api/attachments/' + attachment.id, { headers: { 'X-UI-Token': token } });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
    for (const provider of ['codex', 'claude']) {
      const response = await fetch(url + '/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Token': token },
        body: JSON.stringify({ provider, cwd: project, prompt: 'What is in this screenshot?', attachments: [attachment.id] })
      });
      assert.equal(response.status, 200);
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      const output = events.filter(event => event.type === 'text').map(event => event.text).join('');
      assert.match(output, new RegExp(`${provider} native=${provider === 'codex'} readable=true`));
      const id = events.find(event => event.type === 'session').id;
      const saved = await (await fetch(url + '/api/conversations/' + id, { headers: { 'X-UI-Token': token } })).json();
      assert.equal(saved.messages[0].text, 'What is in this screenshot?');
      assert.deepEqual(saved.messages[0].attachments, [{ id: attachment.id, name: 'screenshot.png', type: 'image' }]);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

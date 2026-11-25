const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocketServer, WebSocket } = require('ws');

const PAGE = fs.readFileSync(path.join(__dirname, 'index.html'));
const MARKDOWN_JS = fs.readFileSync(path.join(__dirname, 'node_modules/markdown-it/dist/browser/markdown-it.umd.min.js'));
const MAX_BODY = 64 * 1024;
const MAX_ATTACHMENT = 256 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_PROMPT = 5;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.log', '.xml', '.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.sh', '.sql', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.rb', '.php', '.tf', '.hcl']);
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MCP_SCRIPT = path.join(__dirname, 'mcp-ask-user.js');
const MCP_INSTRUCTION = 'When you need a choice, confirmation, or missing detail from the person before continuing this turn, call the cli_web ask_user MCP tool and wait for its answer. Do not invent the person\'s answer.';

function createServer(options = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const mcpToken = crypto.randomBytes(32).toString('hex');
  const sessions = new Map();
  const activeRuns = new Map();
  const pendingQuestions = new Map();
  const home = fs.realpathSync(require('node:os').homedir());
  const defaultCwd = home;
  const sessionsDir = options.sessionsDir || path.join(__dirname, '.sessions');
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const attachmentsDir = path.join(sessionsDir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true, mode: 0o700 });
  const bins = { codex: options.codexBin || 'codex', claude: options.claudeBin || 'claude' };
  const isId = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  function getSession(id) {
    if (!isId(id)) return null;
    if (sessions.has(id)) return sessions.get(id);
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(sessionsDir, id + '.json'), 'utf8'));
      if (!['codex', 'claude'].includes(saved.provider) || !Array.isArray(saved.messages)) return null;
      const session = { ...saved, running: null };
      sessions.set(id, session);
      return session;
    } catch { return null; }
  }

  function saveSession(id, session) {
    const file = path.join(sessionsDir, id + '.json');
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    const saved = {
      provider: session.provider, model: session.model, cwd: session.cwd, cliId: session.cliId,
      title: session.title, createdAt: session.createdAt, updatedAt: Date.now(),
      messages: session.messages
    };
    fs.writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 });
    fs.renameSync(temp, file);
    session.updatedAt = saved.updatedAt;
  }

  function listSessions() {
    return fs.readdirSync(sessionsDir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const id = name.slice(0, -5);
        const session = getSession(id);
        return session && {
          id, provider: session.provider, model: session.model || '', title: session.title,
          status: session.running
            ? ([...pendingQuestions.values()].some(question => question.session === id) ? 'Waiting for response' : 'Working')
            : 'Ready',
          updatedAt: session.updatedAt
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) return false;
      } catch { return false; }
    }
    return true;
  }

  function authorized(req) {
    return sameOrigin(req) && req.headers['x-ui-token'] === token;
  }

  async function body(req) {
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      if (data.length > MAX_BODY) throw new Error('Request is too large');
    }
    return JSON.parse(data);
  }

  async function upload(req, res) {
    if (!authorized(req)) return json(res, 403, { error: 'Forbidden' });
    let name;
    try { name = decodeURIComponent(req.headers['x-file-name'] || ''); }
    catch { return json(res, 400, { error: 'Invalid filename' }); }
    const extension = path.extname(name).toLowerCase();
    const imageType = IMAGE_TYPES[extension];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name) ||
        (!TEXT_EXTENSIONS.has(extension) && !imageType)) {
      return json(res, 400, { error: 'Choose a supported text or image file with a simple filename' });
    }
    if (imageType && req.headers['content-type'] !== imageType) return json(res, 400, { error: 'Image type does not match filename' });
    const limit = imageType ? MAX_IMAGE : MAX_ATTACHMENT;
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) return json(res, 413, { error: imageType ? 'Image must be 5 MB or smaller' : 'File must be 256 KB or smaller' });
        chunks.push(chunk);
      }
    } catch { return json(res, 400, { error: 'Could not read file' }); }
    if (!size) return json(res, 400, { error: 'File is empty' });
    const data = Buffer.concat(chunks);
    if (imageType) {
      const valid = imageType === 'image/png'
        ? data.length >= 24 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && data.toString('ascii', 12, 16) === 'IHDR'
        : imageType === 'image/jpeg'
          ? data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9
          : data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
      if (!valid) return json(res, 400, { error: 'Invalid image data' });
    } else {
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
      catch { return json(res, 400, { error: 'File must contain UTF-8 text' }); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) {
        return json(res, 400, { error: 'Binary files are not supported' });
      }
    }
    const id = crypto.randomUUID();
    const dir = path.join(attachmentsDir, id);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(path.join(dir, name), data, { flag: 'wx', mode: 0o600 });
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      return json(res, 500, { error: 'Could not save file' });
    }
    json(res, 201, { id, name, type: imageType ? 'image' : 'text' });
  }

  function attachmentById(id) {
    if (typeof id !== 'string' || !isId(id)) return null;
    try {
      const dir = path.join(attachmentsDir, id);
      const names = fs.readdirSync(dir);
      if (names.length !== 1) return null;
      const name = names[0];
      const extension = path.extname(name).toLowerCase();
      const type = IMAGE_TYPES[extension] ? 'image' : TEXT_EXTENSIONS.has(extension) ? 'text' : null;
      if (!type || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name)) return null;
      const file = path.join(dir, name);
      if (!fs.lstatSync(file).isFile()) return null;
      return { id, name, type, path: file };
    } catch { return null; }
  }

  function getAttachment(req, res, id) {
    if (!authorized(req)) return json(res, 403, { error: 'Forbidden' });
    const attachment = attachmentById(id);
    if (!attachment || attachment.type !== 'image') return json(res, 404, { error: 'Image not found' });
    res.writeHead(200, {
      'Content-Type': IMAGE_TYPES[path.extname(attachment.name).toLowerCase()],
      'Content-Length': fs.statSync(attachment.path).size,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(attachment.path).pipe(res);
  }

  async function rename(req, res, id) {
    if (!authorized(req)) return json(res, 403, { error: 'Forbidden' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'Conversation not found' });
    let input;
    try { input = await body(req); } catch { return json(res, 400, { error: 'Invalid request' }); }
    if (typeof input?.title !== 'string' || !input.title.trim() || input.title.trim().length > 60 ||
        /[\x00-\x1f\x7f]/.test(input.title)) return json(res, 400, { error: 'Name must be 1–60 characters' });
    session.title = input.title.trim();
    saveSession(id, session);
    json(res, 200, { id, title: session.title });
  }

  function resolveAttachments(ids) {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS_PER_PROMPT ||
        new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !isId(id))) return null;
    try {
      return ids.map(id => {
        const attachment = attachmentById(id);
        if (!attachment) throw new Error();
        return attachment;
      });
    } catch { return null; }
  }

  function cancelQuestions(sessionId) {
    for (const [id, pending] of pendingQuestions) {
      if (pending.session !== sessionId) continue;
      clearTimeout(pending.timer);
      pendingQuestions.delete(id);
      if (!pending.res.writableEnded) json(pending.res, 410, { error: 'Chat turn ended' });
    }
  }

  async function askQuestion(req, res) {
    if (req.headers['x-mcp-token'] !== mcpToken) return json(res, 403, { error: 'Forbidden' });
    let input;
    try { input = await body(req); } catch { return json(res, 400, { error: 'Invalid question' }); }
    if (!input || !isId(input.session) || typeof input.question !== 'string' ||
        !input.question.trim() || input.question.length > 4000 ||
        (input.options !== undefined && (!Array.isArray(input.options) || input.options.length > 12 ||
          input.options.some(value => typeof value !== 'string' || value.length > 500)))) {
      return json(res, 400, { error: 'Invalid question' });
    }
    const run = activeRuns.get(input.session);
    if (!run) return json(res, 409, { error: 'Conversation is not running' });
    const id = crypto.randomUUID();
    const pending = { session: input.session, res, timer: null, options: input.options || [] };
    pending.timer = setTimeout(() => {
      pendingQuestions.delete(id);
      if (!res.writableEnded) json(res, 408, { error: 'Question timed out' });
    }, 10 * 60 * 1000);
    pending.timer.unref();
    pendingQuestions.set(id, pending);
    const question = input.question.trim();
    const choices = input.options || [];
    const display = [question, ...choices.map((choice, index) => `${index + 1}. ${choice}`)].join('\n');
    run.addQuestion(display);
    run.send({ type: 'question', id, question, options: choices });
    res.on('close', () => { clearTimeout(pending.timer); pendingQuestions.delete(id); });
  }

  async function run(req, res) {
    if (!authorized(req)) return json(res, 403, { error: 'Forbidden' });
    let input;
    try { input = await body(req); } catch { return json(res, 400, { error: 'Invalid request' }); }
    if (!input || !['codex', 'claude'].includes(input.provider) ||
        typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000 ||
        typeof input.cwd !== 'string' || input.cwd.length > 1024 ||
        (input.model !== undefined && (typeof input.model !== 'string' ||
          (input.model !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/.test(input.model)))) ||
        (input.session !== undefined && typeof input.session !== 'string')) {
      return json(res, 400, { error: 'Check CLI, model, prompt, and working directory' });
    }
    const requestedModel = input.model || '';
    const attachments = resolveAttachments(input.attachments);
    if (!attachments) return json(res, 400, { error: 'Invalid attachments' });

    let cwd;
    try {
      cwd = fs.realpathSync(input.cwd);
      if (cwd !== home && !cwd.startsWith(home + path.sep)) throw new Error();
      if (!fs.statSync(cwd).isDirectory()) throw new Error();
    } catch { return json(res, 400, { error: `Choose a directory under ${home}` }); }

    const previous = input.session ? getSession(input.session) : undefined;
    if (input.session && (!previous || previous.provider !== input.provider || (previous.model || '') !== requestedModel || previous.cwd !== cwd)) {
      return json(res, 400, { error: 'Conversation does not match this CLI, model, and directory' });
    }
    if (previous?.running) return json(res, 409, { error: 'This session is already running' });

    const handle = previous ? input.session : crypto.randomUUID();
    const session = previous || {
      provider: input.provider, model: requestedModel, cwd, cliId: null, running: null, messages: [],
      title: input.prompt.trim().replace(/\s+/g, ' ').slice(0, 60), createdAt: Date.now()
    };
    sessions.set(handle, session);
    const mcpEnv = {
      CLI_WEB_MCP_SESSION: handle,
      CLI_WEB_MCP_PORT: String(server.address().port),
      CLI_WEB_MCP_TOKEN: mcpToken
    };
    const mcpConfigPath = path.join(sessionsDir, `.mcp-${handle}.json`);
    const mcpSettingsPath = path.join(sessionsDir, `.mcp-settings-${handle}.json`);
    fs.writeFileSync(mcpSettingsPath, JSON.stringify(mcpEnv), { mode: 0o600 });
    if (input.provider === 'claude') {
      fs.writeFileSync(mcpConfigPath, JSON.stringify({
        mcpServers: { cli_web: { command: process.execPath, args: [MCP_SCRIPT, mcpSettingsPath] } }
      }), { mode: 0o600 });
    }
    const codexMcpArgs = input.provider === 'codex' ? [
      '-c', `mcp_servers.cli_web.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.cli_web.args=${JSON.stringify([MCP_SCRIPT, mcpSettingsPath])}`,
      '-c', `developer_instructions=${JSON.stringify(MCP_INSTRUCTION)}`
    ] : [];
    const modelArgs = session.model ? (input.provider === 'codex' ? ['-m', session.model] : ['--model', session.model]) : [];
    const imageArgs = attachments.filter(file => file.type === 'image').map(file => `--image=${file.path}`);
    const attachmentDirs = attachments.flatMap(file => ['--add-dir', path.dirname(file.path)]);
    const args = input.provider === 'codex'
      ? session.cliId
        ? [...codexMcpArgs, 'exec', 'resume', '--json', '--skip-git-repo-check', ...modelArgs, ...imageArgs, session.cliId, '-']
        : [...codexMcpArgs, 'exec', '--json', '--skip-git-repo-check', ...modelArgs, ...imageArgs, '-']
      : session.cliId
        ? ['-p', '--resume', session.cliId, ...modelArgs, ...attachmentDirs, '--mcp-config', mcpConfigPath, '--append-system-prompt', MCP_INSTRUCTION, '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
        : ['-p', ...modelArgs, ...attachmentDirs, '--mcp-config', mcpConfigPath, '--append-system-prompt', MCP_INSTRUCTION, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

    const env = { ...process.env };
    let child;
    try { child = spawn(bins[input.provider], args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch {
      fs.rmSync(mcpSettingsPath, { force: true });
      if (input.provider === 'claude') fs.rmSync(mcpConfigPath, { force: true });
      return json(res, 500, { error: 'Could not start CLI' });
    }
    session.running = child;
    session.messages.push({ kind: 'user', text: input.prompt.trim(), attachments: attachments.map(({ id, name, type }) => ({ id, name, type })) });
    let answer = { kind: 'assistant', text: '' };
    session.messages.push(answer);
    saveSession(handle, session);
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    });
    const send = (data) => { if (!res.destroyed) res.write(JSON.stringify(data) + '\n'); };
    let currentStatus = '';
    const sendStatus = (message) => {
      if (message !== currentStatus) { currentStatus = message; send({ type: 'status', message }); }
    };
    const sendText = (value) => {
      if (!value) return;
      sendStatus('Writing response…');
      answer.text += value;
      send({ type: 'text', text: value });
    };
    const sendError = (message) => {
      answer.text += (answer.text ? '\n' : '') + message;
      answer.error = true;
      send({ type: 'error', message });
    };
    const runState = { send, session, answer, addQuestion(display) {
      if (answer.text) {
        session.messages.push({ kind: 'assistant', text: display });
        answer = { kind: 'assistant', text: '' };
        session.messages.push(answer);
        runState.answer = answer;
      } else {
        session.messages.splice(session.messages.indexOf(answer), 0, { kind: 'assistant', text: display });
      }
    } };
    activeRuns.set(handle, runState);
    send({ type: 'session', id: handle });
    sendStatus('Waiting for response…');
    const attachmentPrompt = attachments.length
      ? `\n\nAttached files (read text files and use image viewing tools for images when relevant):\n${attachments.map(file => `${file.name} (${file.type}): ${file.path}`).join('\n')}`
      : '';
    child.stdin.end(input.prompt + attachmentPrompt);

    let stdout = '';
    let stderr = '';
    let hadText = false;
    const codexSeen = new Map();
    let claudePartial = false;
    const processLine = (line) => {
      if (!line) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (input.provider === 'codex') {
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') session.cliId = event.thread_id;
        if (event.type === 'turn.started') sendStatus('Thinking…');
        if (event.type === 'item.started') {
          if (event.item?.type === 'command_execution') sendStatus('Running command…');
          else if (event.item?.type === 'file_change') sendStatus('Editing files…');
          else if (event.item?.type === 'web_search') sendStatus('Searching…');
          else if (event.item?.type === 'agent_message') sendStatus('Writing response…');
        }
        if ((event.type === 'item.updated' || event.type === 'item.completed') && event.item?.type === 'agent_message') {
          const id = event.item.id || 'message';
          const previous = codexSeen.get(id) || '';
          const full = event.item.text || '';
          if (full.startsWith(previous)) {
            const delta = full.slice(previous.length);
            if (delta) { hadText = true; sendText(delta); }
          }
          codexSeen.set(id, full);
          if (event.type === 'item.completed' && full) sendText('\n');
        }
        if (event.type === 'error' && event.message) sendError(event.message);
      } else {
        if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') session.cliId = event.session_id;
        if (event.type === 'stream_event') {
          const update = event.event || {};
          if (update.type === 'message_start') { claudePartial = false; sendStatus('Thinking…'); }
          if (update.type === 'content_block_start' && update.content_block?.type === 'tool_use') {
            sendStatus(`Using ${update.content_block.name || 'tool'}…`);
          }
          if (update.type === 'content_block_delta' && update.delta?.type === 'text_delta' && update.delta.text) {
            claudePartial = true;
            hadText = true;
            sendText(update.delta.text);
          }
        }
        if (event.type === 'assistant') {
          if (!claudePartial) {
            for (const block of event.message?.content || []) {
              if (block.type === 'text' && block.text) {
                hadText = true; sendText(block.text);
              }
            }
          }
          if (event.message?.content?.some(block => block.type === 'text' && block.text)) sendText('\n');
          claudePartial = false;
        }
        if (event.type === 'result' && event.is_error) sendError(event.result || 'Claude failed');
        if (event.type === 'result' && !event.is_error && !hadText && event.result) {
          hadText = true; sendText(event.result);
        }
      }
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      let end;
      while ((end = stdout.indexOf('\n')) >= 0) {
        processLine(stdout.slice(0, end));
        stdout = stdout.slice(end + 1);
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', (error) => sendError(error.code === 'ENOENT' ? `${input.provider} CLI is not installed` : 'CLI failed to start'));
    child.on('close', (code) => {
      processLine(stdout);
      session.running = null;
      activeRuns.delete(handle);
      cancelQuestions(handle);
      if (input.provider === 'claude') fs.rmSync(mcpConfigPath, { force: true });
      fs.rmSync(mcpSettingsPath, { force: true });
      if (code !== 0) sendError(stderr.trim() || `${input.provider} exited with code ${code}`);
      if (!answer.text) answer.text = 'No text response.';
      saveSession(handle, session);
      send({ type: 'done', code });
      res.end();
    });
    res.on('close', () => {
      if (session.running && !res.writableEnded) {
        cancelQuestions(handle);
        child.kill('SIGTERM');
      }
    });
  }

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/vendor/markdown-it.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(MARKDOWN_JS);
    }
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'"
      });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && pathname === '/api/config') return json(res, 200, { token, home, cwd: defaultCwd });
    if (req.method === 'GET' && pathname === '/api/conversations') {
      if (!authorized(req)) return json(res, 403, { error: 'Forbidden' });
      return json(res, 200, listSessions());
    }
    if (req.method === 'GET' && pathname.startsWith('/api/conversations/')) {
      if (!authorized(req)) return json(res, 403, { error: 'Forbidden' });
      const id = pathname.slice('/api/conversations/'.length);
      const session = getSession(id);
      return session
        ? json(res, 200, { id, provider: session.provider, model: session.model || '', cwd: session.cwd, messages: session.messages, running: !!session.running })
        : json(res, 404, { error: 'Conversation not found' });
    }
    if (req.method === 'PATCH' && pathname.startsWith('/api/conversations/')) {
      return void rename(req, res, pathname.slice('/api/conversations/'.length));
    }
    if (req.method === 'POST' && pathname === '/api/run') return void run(req, res);
    if (req.method === 'POST' && pathname === '/api/attachments') return void upload(req, res);
    if (req.method === 'GET' && pathname.startsWith('/api/attachments/')) return void getAttachment(req, res, pathname.slice('/api/attachments/'.length));
    if (req.method === 'POST' && pathname === '/api/mcp/question') return void askQuestion(req, res);
    json(res, 404, { error: 'Not found' });
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });
  server.on('upgrade', (req, socket, head) => {
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
    if (new URL(req.url, 'http://localhost').pathname !== '/api/stream' ||
        !sameOrigin(req) || !protocols.includes('cli-web') || !protocols.includes(token)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    const abort = new AbortController();
    let started = false;
    let runHandle = null;
    const send = value => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
    ws.on('close', () => abort.abort());
    ws.on('message', async (data, binary) => {
      if (binary) { send({ type: 'error', message: 'Invalid WebSocket request' }); return; }
      let input;
      try { input = JSON.parse(data.toString()); }
      catch { send({ type: 'error', message: 'Invalid request' }); ws.close(); return; }
      if (started) {
        if (input?.type === 'answer' && typeof input.id === 'string' && typeof input.answer === 'string' && input.answer.length <= 4000) {
          const pending = pendingQuestions.get(input.id);
          if (!pending || pending.session !== runHandle) return send({ type: 'error', message: 'Question is no longer pending' });
          clearTimeout(pending.timer);
          pendingQuestions.delete(input.id);
          const run = activeRuns.get(runHandle);
          if (run) run.session.messages.splice(run.session.messages.indexOf(run.answer), 0, { kind: 'user', text: input.answer });
          const rawAnswer = input.answer.trim();
          const number = /^\d+$/.test(rawAnswer) ? Number(rawAnswer) : 0;
          const answerForAgent = number >= 1 && number <= pending.options.length
            ? `Selected option ${number} of ${pending.options.length} (1-based): ${pending.options[number - 1]}`
            : rawAnswer;
          json(pending.res, 200, { answer: answerForAgent });
          return;
        }
        return send({ type: 'error', message: 'Invalid WebSocket request' });
      }
      started = true;
      if (input?.type !== 'run') { send({ type: 'error', message: 'Expected run request' }); ws.close(); return; }
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/run`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-UI-Token': token },
          body: JSON.stringify(input), signal: abort.signal
        });
        if (!response.ok) {
          const error = await response.json();
          send({ type: 'error', message: error.error || 'Request failed' });
          send({ type: 'done', code: response.status });
          ws.close();
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line) continue;
            try { const event = JSON.parse(line); if (event.type === 'session') runHandle = event.id; } catch {}
            if (ws.readyState === WebSocket.OPEN) ws.send(line);
          }
        }
        if (ws.readyState === WebSocket.OPEN) ws.close();
      } catch {
        if (!abort.signal.aborted) {
          send({ type: 'error', message: 'Stream disconnected' });
          send({ type: 'done', code: 500 });
          ws.close();
        }
      }
    });
  });

  return server;
}


if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '127.0.0.1', () => console.log(`CLI Agent Chat is running at http://localhost:${port}`));
}

module.exports = { createServer };

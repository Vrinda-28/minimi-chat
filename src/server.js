import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { validZone } from './dates.js';
import { buildContext } from './context.js';
import { AgentError, answer } from './agent.js';

const dataFile = process.env.DATA_FILE || fileURLToPath(new URL('../data/chat.sqlite', import.meta.url));
const store = openStore(dataFile);
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || 'gpt-6-astra';
const port = Number(process.env.PORT || 3000);
const pending = new Set();
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, content) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(content));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24_000) {
      // Drain the request before writing the error response.
      chunks.length = 0;
    } else chunks.push(chunk);
  }
  if (size > 24_000) throw new AgentError('Message is too large.', 413);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError('Expected JSON object');
  return body;
}

async function chatReply(req, res, owner, chatId) {
  const body = await readBody(req);
  const question = typeof body.question === 'string' && body.question.trim();
  if (!question || question.length > 8000 || typeof body.id !== 'string' || !uuid.test(body.id)) {
    throw new AgentError('Enter a message of up to 8,000 characters.', 400);
  }
  const saved = store.turn(chatId, body.id);
  if (saved) {
    if (saved.question !== question) throw new AgentError('This message ID is already in use.', 409);
    return json(res, 200, { turn: saved, chat: store.chat(owner, chatId) });
  }
  if (!apiKey) throw new AgentError('Set OPENAI_API_KEY in .env and restart the server.', 503);
  if (pending.has(chatId)) throw new AgentError('This chat is already answering a message.', 409);

  const askedAt = Date.now();
  const zone = validZone(typeof body.timeZone === 'string' ? body.timeZone : 'UTC');
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on('close', onClose);
  const deadline = AbortSignal.timeout(85_000);
  const signal = AbortSignal.any([controller.signal, deadline]);
  const emit = event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
  const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 12_000);
  pending.add(chatId);
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  });
  emit({ type: 'working' });
  try {
    const context = buildContext({ store, owner, chatId, question, now: askedAt, zone });
    const result = await answer({ context, signal, emit, apiKey, model });
    signal.throwIfAborted();
    const turn = { id: body.id, chatId, askedAt, question, parts: result.parts };
    store.save(turn);
    emit({ type: 'done', turn, chat: store.chat(owner, chatId) });
    console.info(JSON.stringify({
      event: 'reply', model, elapsedMs: Date.now() - askedAt,
      firstTextMs: result.firstTextAt && result.firstTextAt - askedAt,
      firstSearchMs: result.firstSearchAt && result.firstSearchAt - askedAt,
      searches: result.searches, usage: result.usage,
    }));
  } catch (error) {
    if (!res.destroyed) emit({
      type: 'error',
      message: deadline.aborted ? 'The reply took too long. Please try again.'
        : error instanceof AgentError ? error.message : 'The reply was interrupted. Please try again.',
    });
    if (!(error instanceof AgentError) && !signal.aborted) console.error('Reply failed', error.name);
  } finally {
    clearInterval(heartbeat);
    pending.delete(chatId);
    res.off('close', onClose);
    res.end();
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  const path = req.url.split('?')[0];
  const asset = Object.hasOwn(staticFiles, path) && staticFiles[path];
  if (asset && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
    return createReadStream(new URL('../public/' + asset[0], import.meta.url)).pipe(res);
  }
  if (!path.startsWith('/api/')) return json(res, 404, { error: 'Page not found.' });
  try {
    if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      throw new AgentError('Expected a JSON request.', 415);
    }
    let owner = /(?:^|;\s*)minimi_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (!owner || !uuid.test(owner)) {
      owner = randomUUID();
      res.setHeader('Set-Cookie', 'minimi_session=' + owner + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000');
    }
    if (path === '/api/chats' && req.method === 'GET') return json(res, 200, {
      chats: store.list(owner), configured: Boolean(apiKey),
    });
    if (path === '/api/chats' && req.method === 'POST') {
      return json(res, 201, { chat: store.create(owner, Date.now()) });
    }
    const route = /^\/api\/chats\/([^/]+)(\/reply)?$/.exec(path);
    const chat = route && store.chat(owner, route[1]);
    if (chat && !route[2] && req.method === 'GET') return json(res, 200, { chat, turns: store.history(chat.id) });
    if (chat && route[2] && req.method === 'POST') return await chatReply(req, res, owner, chat.id);
    return json(res, 404, { error: 'Chat not found.' });
  } catch (error) {
    const status = error instanceof AgentError ? error.status : error instanceof SyntaxError ? 400 : 500;
    const message = status === 500 ? 'Something went wrong. Please try again.' : error.message;
    if (status === 500) console.error('Request failed', error.name);
    if (!res.headersSent) json(res, status, { error: message });
    else res.end();
  }
});

server.listen(port, '127.0.0.1', () => console.info('Minimi Chat at http://localhost:' + server.address().port));

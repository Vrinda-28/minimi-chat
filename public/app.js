const byId = id => document.getElementById(id);
const messages = byId('messages');
const conversation = byId('conversation');
const form = byId('composer');
const question = byId('question');
const status = byId('status');
const errorBox = byId('error');
const send = byId('send');
const stop = byId('stop');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let chats = [];
let currentId;
let loaded = false;
let busy = false;
let controller;
let retry;

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function request(path, options = {}) {
  const res = await fetch('/api/chats' + path, {
    ...options,
    headers: options.method === 'POST' ? { 'Content-Type': 'application/json' } : {},
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'The server could not complete the request.');
  }
  return res;
}

function updateChat(chat) {
  chats = [chat, ...chats.filter(other => other.id !== chat.id)];
  drawChats();
}

function drawChats() {
  byId('chats').replaceChildren(...chats.map(chat => {
    const button = element('button', chat.title);
    button.title = chat.title;
    button.disabled = busy;
    if (chat.id === currentId) button.setAttribute('aria-current', 'page');
    button.onclick = () => selectChat(chat.id);
    return button;
  }));
  byId('chat-title').textContent = chats.find(chat => chat.id === currentId)?.title || 'New chat';
}

function setSidebar(open) {
  byId('sidebar').classList.toggle('open', open);
  byId('toggle-sidebar').setAttribute('aria-expanded', String(open));
}

function setBusy(value) {
  busy = value;
  send.hidden = value;
  send.disabled = !loaded;
  stop.hidden = !controller || !value;
  byId('new-chat').disabled = value;
  drawChats();
}

function showError(text, onRetry) {
  errorBox.hidden = !text;
  errorBox.replaceChildren();
  if (text) errorBox.append(text);
  if (onRetry) {
    const button = element('button', 'Retry');
    button.type = 'button';
    button.onclick = onRetry;
    errorBox.append(button);
  }
}

function showConversation() {
  byId('empty').hidden = messages.childElementCount > 0;
  conversation.scrollTop = conversation.scrollHeight;
}

function bubble(role, text) {
  const node = element('article', text);
  node.className = 'message ' + role;
  node.setAttribute('aria-label', role === 'user' ? 'Your message' : 'Assistant reply');
  messages.append(node);
  return node;
}

function annotate({ text, citations }, sources) {
  const chars = [...text];
  let cursor = 0;
  let result = '';
  const inserts = new Map();
  for (const citation of citations) {
    if (!sources.has(citation.url)) sources.set(citation.url, { ...citation, number: sources.size + 1 });
    const end = Number.isInteger(citation.end) && citation.end > 0 && citation.end <= chars.length ? citation.end : chars.length;
    const start = Number.isInteger(citation.start) && citation.start < end ? Math.max(0, citation.start) : end;
    // A provider citation may span an existing Markdown link. Replace that marker only.
    const span = chars.slice(start, end).join('');
    const index = /^\[.*\]\(https?:\/\/.*\)$/.test(span) ? start : end;
    const existing = inserts.get(index);
    const marker = '\uE000' + sources.get(citation.url).number + '\uE001';
    if (!existing) inserts.set(index, { end, marker });
    else if (!existing.marker.includes(marker)) existing.marker += marker;
  }
  for (const [index, { end, marker }] of [...inserts].sort(([a], [b]) => a - b)) {
    if (index < cursor) continue;
    result += chars.slice(cursor, index).join('') + marker;
    cursor = end;
  }
  return result + chars.slice(cursor).join('');
}

function appendInline(node, text, sources) {
  const pattern = /\uE000(\d+)\uE001|\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    node.append(text.slice(cursor, match.index));
    if (match[1]) {
      const source = sources[Number(match[1]) - 1];
      if (source) {
        const anchor = element('a', String(source.number));
        anchor.className = 'citation';
        anchor.href = source.url;
        anchor.title = source.title || source.url;
        anchor.setAttribute('aria-label', 'Source ' + source.number + ': ' + anchor.title);
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        node.append(anchor);
      }
    } else if (match[2]) {
      const bold = element('strong');
      appendInline(bold, match[2], sources);
      node.append(bold);
    } else if (match[3]) node.append(element('code', match[3]));
    else {
      const anchor = element('a', match[4]);
      anchor.href = match[5];
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      node.append(anchor);
    }
    cursor = match.index + match[0].length;
  }
  node.append(text.slice(cursor));
}

function renderReply(node, parts) {
  node.classList.remove('streaming');
  node.replaceChildren();
  const sources = new Map();
  const lines = parts.map(part => annotate(part, sources)).join('\n\n').split('\n');
  const citations = [...sources.values()];
  const listPattern = /^\s*(?:([-*])|(\d+)\.)\s+(.+)/;
  const tableLine = value => value?.trim().startsWith('|');
  const divider = /^\s*\|?\s*:?-{2,}/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('```')) {
      const code = [];
      while (++i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i]);
      node.append(element('pre', code.join('\n')));
    } else if (tableLine(line) && divider.test(lines[i + 1] || '')) {
      const wrap = element('div');
      wrap.className = 'table-wrap';
      const table = element('table');
      const cells = (row, type) => {
        const tr = element('tr');
        for (const value of row.trim().replace(/^\||\|$/g, '').split('|')) {
          const cell = element(type);
          appendInline(cell, value.trim(), citations);
          tr.append(cell);
        }
        return tr;
      };
      const head = element('thead');
      head.append(cells(line, 'th'));
      const body = element('tbody');
      i += 2;
      for (; tableLine(lines[i]); i++) body.append(cells(lines[i], 'td'));
      i--;
      table.append(head, body);
      wrap.append(table);
      node.append(wrap);
    } else if (listPattern.test(line)) {
      const ordered = Boolean(listPattern.exec(line)[2]);
      const list = element(ordered ? 'ol' : 'ul');
      for (; i < lines.length; i++) {
        const item = listPattern.exec(lines[i]);
        if (!item || Boolean(item[2]) !== ordered) break;
        const li = element('li');
        appendInline(li, item[3], citations);
        list.append(li);
      }
      i--;
      node.append(list);
    } else {
      const heading = /^(#{1,6})\s+(.+)/.exec(line);
      const block = element(heading ? 'h' + Math.min(heading[1].length + 1, 4) : 'p');
      appendInline(block, heading ? heading[2] : line, citations);
      node.append(block);
    }
  }
}

async function selectChat(id) {
  if (busy) return;
  setBusy(true);
  setSidebar(false);
  showError();
  try {
    const { turns } = await (await request('/' + id)).json();
    currentId = id;
    localStorage.setItem('minimi-chat', id);
    retry = undefined;
    messages.replaceChildren();
    for (const turn of turns) {
      bubble('user', turn.question);
      renderReply(bubble('assistant'), turn.parts);
    }
    showConversation();
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

async function submit(draft) {
  if (busy || !draft.question) return;
  controller = new AbortController();
  question.readOnly = true;
  retry = draft;
  setBusy(true);
  showError();
  status.textContent = 'Thinking…';
  const user = bubble('user', draft.question);
  const assistant = bubble('assistant');
  assistant.classList.add('streaming');
  showConversation();
  let completed = false;
  const finish = ({ turn, chat }) => {
    completed = true;
    retry = undefined;
    question.value = '';
    renderReply(assistant, turn.parts);
    updateChat(chat);
    showConversation();
  };
  try {
    if (!currentId) {
      const { chat } = await (await request('', {
        method: 'POST', body: '{}', signal: controller.signal,
      })).json();
      currentId = chat.id;
      localStorage.setItem('minimi-chat', chat.id);
      updateChat(chat);
    }
    const res = await request('/' + currentId + '/reply', {
      method: 'POST', body: JSON.stringify({ ...draft, timeZone }), signal: controller.signal,
    });
    if (res.headers.get('content-type').includes('application/json')) finish(await res.json());
    else {
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let rest = '';
      try {
        while (!completed) {
          const { value, done } = await reader.read();
          if (done) break;
          rest += value;
          const lines = rest.split('\n');
          rest = lines.pop();
          for (const line of lines.filter(Boolean)) {
            const event = JSON.parse(line);
            if (event.type === 'search') status.textContent = 'Searching the web…';
            if (event.type === 'delta') {
              status.textContent = 'Writing reply…';
              const stick = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
              assistant.append(event.text);
              if (stick) conversation.scrollTop = conversation.scrollHeight;
            }
            if (event.type === 'error') throw new Error(event.message);
            if (event.type === 'done') finish(event);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    if (!completed) throw new Error('The reply was interrupted. Please try again.');
  } catch (error) {
    user.remove();
    assistant.remove();
    showConversation();
    const stopped = controller.signal.aborted;
    showError(stopped ? 'Reply stopped.' : error.message, () => submit(draft));
  } finally {
    controller = undefined;
    status.textContent = '';
    question.readOnly = false;
    setBusy(false);
    question.focus();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (!loaded || busy || !question.value.trim()) return;
  const text = question.value.trim();
  submit(retry?.question === text ? retry : { id: crypto.randomUUID(), question: text });
});
question.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
stop.onclick = () => controller?.abort();
byId('toggle-sidebar').onclick = () => setSidebar(!byId('sidebar').classList.contains('open'));
byId('new-chat').onclick = () => {
  if (busy) return;
  currentId = undefined;
  retry = undefined;
  localStorage.removeItem('minimi-chat');
  question.value = '';
  messages.replaceChildren();
  showError();
  drawChats();
  showConversation();
  setSidebar(false);
  question.focus();
};
document.querySelectorAll('.suggestions button').forEach(button => {
  button.onclick = () => {
    question.value = button.textContent;
    question.focus();
  };
});

try {
  setBusy(true);
  const data = await (await request('')).json();
  chats = data.chats;
  loaded = true;
  setBusy(false);
  const last = localStorage.getItem('minimi-chat');
  if (chats.some(chat => chat.id === last)) await selectChat(last);
  if (!data.configured) showError('To enable replies, add OPENAI_API_KEY to .env and restart the server.');
} catch (error) {
  showError(error.message);
  setBusy(false);
}

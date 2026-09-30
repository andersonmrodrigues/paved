const article = document.getElementById('document');
const comments = document.getElementById('comments');
const compose = document.getElementById('compose');
// A comment the agent has not picked up after this long offers the copy-to-agent fallback.
const STALE_MS = 30_000;
let state;
let current = { path: '', sha: '', html: '' };
let selected;

let messageTimer;
function message(text) {
  document.getElementById('message').textContent = text;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { document.getElementById('message').textContent = ''; }, 8000);
}

async function request(path, payload) {
  const response = await fetch(path, payload === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function requestedPath() {
  const hash = decodeURIComponent(location.hash.slice(1));
  return state.documents.some((entry) => entry.path === hash) ? hash : state.documents[0]?.path;
}

function textRange(start, length) {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node;
  let offset = 0;
  let started = false;
  while ((node = walker.nextNode())) {
    const end = offset + node.textContent.length;
    if (!started && start < end) { range.setStart(node, start - offset); started = true; }
    if (started && start + length <= end) { range.setEnd(node, start + length - offset); return range; }
    offset = end;
  }
  return null;
}

const documentComments = () => state.review.comments.filter((entry) => entry.document === current.path);
const pending = () => state.review.comments.filter((entry) => entry.status !== 'resolved');

function highlights() {
  if (!window.CSS?.highlights) return;
  const all = article.textContent;
  const ranges = [];
  for (const comment of documentComments().filter((entry) => entry.status !== 'resolved')) {
    let position = all.slice(comment.offset, comment.offset + comment.quote.length) === comment.quote ? comment.offset : -1;
    if (position < 0) position = all.indexOf(comment.quote);
    if (position >= 0) {
      const range = textRange(position, comment.quote.length);
      if (range) ranges.push(range);
    }
  }
  CSS.highlights.set('paved-comments', new Highlight(...ranges));
}

const STATUS = {
  open: 'Enviado · aguardando o agente receber',
  received: 'Recebido pelo agente',
  working: 'Agente trabalhando neste comentário',
  resolved: 'Resolvido pelo agente',
};

function renderNavigation() {
  const folder = state.kind === 'folder';
  document.getElementById('navigation').hidden = !folder;
  document.getElementById('pager').hidden = !folder || state.documents.length < 2;
  const list = document.getElementById('documents');
  list.replaceChildren();
  for (const entry of state.documents) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${encodeURIComponent(entry.path)}`;
    const prefix = state.target === '.' ? '' : `${state.target}/`;
    link.textContent = folder && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
    if (entry.path === current.path) link.setAttribute('aria-current', 'page');
    item.append(link);
    if (entry.unresolved > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(entry.unresolved);
      item.append(badge);
    }
    list.append(item);
  }
  const index = state.documents.findIndex((entry) => entry.path === current.path);
  document.getElementById('previous').disabled = index <= 0;
  document.getElementById('next').disabled = index < 0 || index >= state.documents.length - 1;
}

function renderComments() {
  comments.replaceChildren();
  const here = documentComments();
  const open = here.filter((entry) => entry.status !== 'resolved').length;
  const total = pending().length;
  document.getElementById('count').textContent = state.kind === 'folder'
    ? `${open} aqui · ${total} no total` : `${open} pendente${open === 1 ? '' : 's'}`;
  for (const comment of here.toReversed()) {
    const card = document.createElement('section');
    card.className = `comment ${comment.status}`;
    const quote = document.createElement('blockquote');
    quote.textContent = comment.quote;
    const body = document.createElement('p');
    body.textContent = comment.body;
    const status = document.createElement('span');
    status.className = `status ${comment.status}`;
    status.textContent = STATUS[comment.status];
    card.append(quote, body, status);
    if (comment.reply) {
      const reply = document.createElement('p');
      reply.className = 'reply';
      reply.textContent = comment.reply;
      card.append(reply);
    }
    comments.append(card);
  }
  highlights();
}

function renderHandoff() {
  const waiting = pending();
  const stale = waiting.some((entry) => entry.status === 'open' && Date.now() - Date.parse(entry.created_at) > STALE_MS);
  const show = waiting.length > 0 && (!state.watching || stale);
  document.getElementById('handoff').hidden = !show;
  if (show) {
    document.getElementById('handoff-reason').textContent = state.watching
      ? 'O agente ainda não pegou alguns comentários. Copie o prompt e cole no terminal do agente.'
      : 'O agente não está acompanhando esta revisão. Copie o prompt e cole no terminal do agente (Claude, Codex ou outro).';
  }
}

function handoffPrompt() {
  const lines = [
    `Aplique os comentários de revisão do preview do Paved em \`${state.target}\`.`,
    'Para cada comentário: rode `paved preview working ' + state.target + ' <id> --json`, altere o documento indicado,'
      + ' e depois rode `paved preview resolve ' + state.target + ' <id> --reply "<o que mudou>" --json`.',
    'Não invente informação; se um comentário pedir algo que o repositório e a conversa não sustentam, pergunte.',
    `Ao terminar, continue a revisão com \`paved preview wait ${state.target} ${state.review.revision} --json\` sem encerrar o turno.`,
    '',
  ];
  for (const comment of pending()) {
    lines.push(`- id: ${comment.id}`, `  documento: ${comment.document}`, `  trecho: "${comment.quote.replace(/\s+/g, ' ')}"`,
      `  comentário: ${comment.body.replace(/\n/g, '\n  ')}`, '');
  }
  return lines.join('\n');
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall back below */ }
  const area = document.createElement('textarea');
  area.value = text;
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

async function refresh() {
  try {
    state = await request('/api/state');
    document.getElementById('connection').textContent = state.watching ? 'Conectado · agente acompanhando' : 'Conectado · agente não está acompanhando';
    document.getElementById('target').textContent = state.target;
    const path = requestedPath();
    const entry = state.documents.find((item) => item.path === path);
    if (entry && (entry.path !== current.path || entry.sha !== current.sha)) {
      const changedDocument = entry.path !== current.path;
      current = await request(`/api/document?path=${encodeURIComponent(entry.path)}`);
      article.innerHTML = current.html;
      for (const link of article.querySelectorAll('a')) { link.rel = 'noreferrer noopener'; link.target = '_blank'; }
      compose.hidden = true;
      if (changedDocument) window.scrollTo(0, 0);
    }
    document.getElementById('filename').textContent = current.path;
    document.getElementById('version').textContent = current.sha ? `Versão ${current.sha.slice(0, 8)}` : '';
    renderNavigation();
    renderComments();
    renderHandoff();
  } catch (error) {
    document.getElementById('connection').textContent = 'Desconectado';
    message(error.message);
  }
}

function go(step) {
  const index = state.documents.findIndex((entry) => entry.path === current.path);
  const target = state.documents[index + step];
  if (target) location.hash = encodeURIComponent(target.path);
}

article.addEventListener('mouseup', () => {
  if (!state || !current.path) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !article.contains(selection.anchorNode) || !article.contains(selection.focusNode)) return;
  const range = selection.getRangeAt(0);
  const raw = range.toString();
  const quote = raw.trim();
  if (!quote || quote.length > 4000) return;
  const before = document.createRange();
  before.selectNodeContents(article);
  before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length + raw.length - raw.trimStart().length;
  const full = article.textContent;
  selected = { document: current.path, quote, prefix: full.slice(Math.max(0, offset - 80), offset),
    suffix: full.slice(offset + quote.length, offset + quote.length + 80), offset, document_sha256: current.sha };
  document.getElementById('selection-quote').textContent = quote;
  compose.hidden = false;
  document.getElementById('comment-body').focus();
});

document.getElementById('cancel-comment').addEventListener('click', () => { compose.hidden = true; });
document.getElementById('send-comment').addEventListener('click', async () => {
  try {
    const body = document.getElementById('comment-body').value.trim();
    await request('/api/comments', { ...selected, body });
    compose.hidden = true;
    document.getElementById('comment-body').value = '';
    message(state.watching ? 'Comentário enviado. Acompanhe o status: recebido, trabalhando, resolvido.'
      : 'Comentário salvo, mas o agente não está acompanhando. Use "Copiar prompt para o agente" e cole no terminal.');
    await refresh();
  } catch (error) { message(error.message); }
});
document.getElementById('copy-prompt').addEventListener('click', async () => {
  await copy(handoffPrompt());
  message('Prompt copiado. Cole no terminal do agente.');
});
document.getElementById('previous').addEventListener('click', () => go(-1));
document.getElementById('next').addEventListener('click', () => go(1));
window.addEventListener('hashchange', refresh);
refresh();
setInterval(refresh, 1500);

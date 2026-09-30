const article = document.getElementById('document');
const comments = document.getElementById('comments');
const compose = document.getElementById('compose');
let state;
let selected;
let lastRevision = -1;
let lastSha = '';

function message(text) { document.getElementById('message').textContent = text; }

async function request(path, payload) {
  const response = await fetch(path, payload === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
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

function highlights() {
  if (!window.CSS?.highlights) return;
  const all = article.textContent;
  const ranges = [];
  for (const comment of state.review.comments.filter((entry) => entry.status === 'open')) {
    let position = all.slice(comment.offset, comment.offset + comment.quote.length) === comment.quote ? comment.offset : -1;
    if (position < 0) position = all.indexOf(comment.quote);
    if (position >= 0) {
      const range = textRange(position, comment.quote.length);
      if (range) ranges.push(range);
    }
  }
  CSS.highlights.set('paved-comments', new Highlight(...ranges));
}

function renderComments() {
  comments.replaceChildren();
  const open = state.review.comments.filter((entry) => entry.status === 'open').length;
  document.getElementById('count').textContent = `${open} aberto${open === 1 ? '' : 's'}`;
  for (const comment of state.review.comments.toReversed()) {
    const card = document.createElement('section');
    card.className = `comment ${comment.status}`;
    const quote = document.createElement('blockquote');
    quote.textContent = comment.quote;
    const body = document.createElement('p');
    body.textContent = comment.body;
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = comment.status === 'resolved' ? 'Resolvido pelo agente'
      : state.watching ? 'Aberto · aguardando ajuste do agente' : 'Aberto · o agente não está acompanhando; peça no chat para aplicar os comentários';
    card.append(quote, body, status);
    comments.append(card);
  }
  const approved = state.approved;
  document.getElementById('approval-state').textContent = approved
    ? `Aprovado por ${state.review.approval.decided_by} nesta versão.`
    : open ? 'Resolva todos os comentários antes de aprovar.' : 'Aprova somente a versão exibida agora.';
  document.getElementById('approve').disabled = approved || open > 0;
  highlights();
}

async function refresh() {
  try {
    const next = await request('/api/state');
    state = next;
    document.getElementById('connection').textContent = next.watching ? 'Conectado · agente acompanhando' : 'Conectado · agente não está acompanhando';
    document.getElementById('filename').textContent = next.document;
    document.getElementById('version').textContent = `Versão ${next.sha.slice(0, 8)}`;
    if (next.sha !== lastSha) {
      article.innerHTML = next.html;
      for (const link of article.querySelectorAll('a')) { link.rel = 'noreferrer noopener'; link.target = '_blank'; }
      lastSha = next.sha;
      compose.hidden = true;
    }
    if (next.review.revision !== lastRevision || next.sha !== lastSha) {
      lastRevision = next.review.revision;
      renderComments();
    } else renderComments();
  } catch (error) {
    document.getElementById('connection').textContent = 'Desconectado';
    message(error.message);
  }
}

article.addEventListener('mouseup', () => {
  if (!state) return;
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
  selected = { quote, prefix: full.slice(Math.max(0, offset - 80), offset),
    suffix: full.slice(offset + quote.length, offset + quote.length + 80), offset, document_sha256: state.sha };
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
    message(state.watching ? 'Comentário enviado. O agente vai aplicar o ajuste.'
      : 'Comentário salvo, mas o agente não está acompanhando esta revisão. Peça no chat para ele aplicar os comentários.');
    await refresh();
  } catch (error) { message(error.message); }
});
document.getElementById('approve').addEventListener('click', async () => {
  try {
    await request('/api/approve', { document_sha256: state.sha });
    message('Documento aprovado.');
    await refresh();
  } catch (error) { message(error.message); }
});
refresh();
setInterval(refresh, 1500);

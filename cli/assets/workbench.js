const labels = {
  classification: 'Classificação', context: 'Contexto', discovery: 'Descoberta', planning: 'Planejamento', implementation: 'Implementação', testing: 'Testes', validation: 'Validação', verification: 'Verificação', review: 'Revisão', completion: 'Conclusão',
  running: 'Em andamento', 'awaiting-approval': 'Aprovação pendente', 'awaiting-input': 'Decisão pendente', completed: 'Concluída', 'completed-with-warnings': 'Concluída com avisos', failed: 'Falhou', blocked: 'Bloqueada', cancelled: 'Cancelada', pending: 'Pendente',
};
const $ = (id) => document.getElementById(id);
const text = (value) => labels[value] || value || '—';
const escapeDate = (value) => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'horário desconhecido' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); };

function action(run) {
  if (run.status === 'awaiting-input' || run.status === 'awaiting-approval') return `paved status`;
  if (!run.workflow) return `paved intent`;
  const phase = run.phases.find((item) => item.status === 'running' || item.status === 'failed' || item.status === 'blocked') || run.phases.find((item) => item.status === 'pending');
  if (phase?.phase === 'planning' || run.status === 'awaiting-approval') return `paved plan --run ${run.id}`;
  if (phase) return `paved execute --run ${run.id}`;
  return `paved status`;
}

function renderRun(run) {
  const card = document.createElement('article'); card.className = 'run';
  const top = document.createElement('div'); top.className = 'run-top';
  const id = document.createElement('span'); id.className = 'run-id'; id.textContent = run.id;
  const badge = document.createElement('span'); badge.className = `badge ${['awaiting-input','awaiting-approval','blocked'].includes(run.status) ? 'wait' : ['completed','completed-with-warnings'].includes(run.status) ? 'done' : ['failed','cancelled'].includes(run.status) ? 'fail' : ''}`; badge.textContent = text(run.status);
  top.append(id,badge); card.append(top);
  const request = document.createElement('p'); request.className = 'run-request'; request.textContent = run.inputs?.find((item) => item.id === 'request')?.value || run.workflow?.id || 'Classificação ainda pendente'; card.append(request);
  if (run.phases?.length) {
    const phases = document.createElement('div'); phases.className = 'phases';
    for (const phase of run.phases) { const part = document.createElement('div'); part.className = `phase ${phase.status}`; const track = document.createElement('div'); track.className = 'track'; const label = document.createElement('span'); label.textContent = text(phase.phase); part.title = `${text(phase.phase)} · ${text(phase.status)}`; part.append(track,label); phases.append(part); }
    card.append(phases);
  }
  const meta = document.createElement('div'); meta.className = 'run-meta';
  const workflow = document.createElement('span'); workflow.textContent = run.workflow?.id || 'Tipo de mudança pendente'; meta.append(workflow);
  const started = document.createElement('span'); started.textContent = `Iniciada ${escapeDate(run.started_at)}`; meta.append(started);
  const command = document.createElement('button'); command.textContent = 'Copiar próximo comando'; command.type = 'button'; command.dataset.copy = action(run); meta.append(command);
  if (run.outputs?.some((item) => item.kind === 'review')) { const preview = document.createElement('span'); preview.textContent = 'Review disponível no preview local'; meta.append(preview); }
  card.append(meta);
  const pending = (run.decisions || []).filter((decision) => ['PENDING','ASKED'].includes(decision.status));
  const pendingApproval = (run.phases || []).flatMap((phase) => phase.gates || []).some((gate) => gate.status === 'awaiting-approval');
  if (pending.length || pendingApproval || run.status === 'awaiting-input' || run.status === 'awaiting-approval') { const notice = document.createElement('div'); notice.className = 'notice'; notice.textContent = pending.length ? `${pending.length} decisão${pending.length === 1 ? '' : 'ões'} aguardando resposta` : pendingApproval || run.status === 'awaiting-approval' ? 'Aguardando aprovação humana do plano' : 'Aguardando uma informação para continuar'; card.append(notice); }
  if (run.failure) { const notice = document.createElement('div'); notice.className = 'notice error'; notice.textContent = run.failure.reason || 'A execução encontrou uma falha.'; card.append(notice); }
  return card;
}

function renderActivity(entry) {
  const row = document.createElement('div'); row.className = 'activity';
  const icon = document.createElement('span'); icon.className = 'agent-icon'; icon.textContent = entry.agent === 'codex' ? 'CX' : 'CC';
  const content = document.createElement('div'); const p = document.createElement('p');
  const event = { SessionStart:'iniciou a sessão', UserPromptSubmit:'enviou uma mensagem', PostToolUse:'usou uma ferramenta', Stop:'encerrou um turno', SessionEnd:'encerrou a sessão', Interrupt:'interrompeu um turno' }[entry.event] || entry.event;
  p.textContent = `${entry.agent === 'codex' ? 'Codex' : 'Claude Code'} ${event}${entry.tool ? ` · ${entry.tool}` : ''}`;
  const small = document.createElement('small'); small.textContent = `${escapeDate(entry.at)} · sessão ${entry.session.slice(0,8)}`; content.append(p,small); row.append(icon,content); return row;
}

function render(data) {
  const open = data.runs.filter((run) => !['completed','completed-with-warnings','blocked','cancelled'].includes(run.status));
  const waiting = data.runs.filter((run) => ['awaiting-input','awaiting-approval','blocked'].includes(run.status));
  const done = data.runs.filter((run) => ['completed','completed-with-warnings'].includes(run.status));
  $('open-count').textContent = open.length; $('waiting-count').textContent = waiting.length; $('done-count').textContent = done.length; $('session-count').textContent = data.activity.length;
  $('run-total').textContent = `${data.runs.length} no total`;
  const runList = $('runs'); runList.replaceChildren(); for (const run of [...open, ...data.runs.filter((item) => !open.includes(item))]) runList.append(renderRun(run)); $('empty-runs').hidden = data.runs.length > 0;
  const activity = $('activity'); activity.replaceChildren(); for (const entry of data.activity) activity.append(renderActivity(entry)); $('empty-activity').hidden = data.activity.length > 0;
  if (data.unreadable.length) { const warning = document.createElement('div'); warning.className = 'notice error'; warning.textContent = `${data.unreadable.length} registro(s) de run não puderam ser lidos. Use paved status para ver os diagnósticos.`; runList.prepend(warning); }
  $('updated').textContent = `Atualizado ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second:'2-digit' })}`;
}

async function refresh() {
  try { const response = await fetch('/api/state', { cache: 'no-store' }); if (!response.ok) throw new Error(`HTTP ${response.status}`); render(await response.json()); $('error').textContent = ''; }
  catch (error) { $('error').textContent = `Não foi possível atualizar o painel: ${error.message}`; }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]'); if (!button) return;
  try { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = 'Comando copiado'; setTimeout(() => { button.textContent = 'Copiar próximo comando'; }, 1500); }
  catch { $('error').textContent = `Copie este comando: ${button.dataset.copy}`; }
});
$('refresh').addEventListener('click', refresh); refresh(); setInterval(refresh, 2000);

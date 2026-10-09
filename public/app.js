import {triageKey, parseTriage, addTriage, editNote, removeTriage} from './triage.js';
import {createState, transition, queryParams, savedView, announcement, isResultCurrent, canPaginate, addressIntent, overviewKey, isOverviewCurrent} from './state.js';

const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const human = value => String(value).replaceAll('_', ' ');
const utc = value => value ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Not resolved';
const facets = {service: ['Accounts', 'Billing', 'Search', 'Uploads', 'Notifications', 'Integrations'], status: ['open', 'in_progress', 'resolved'], severity: ['critical', 'high', 'medium', 'low']};
let state = transition(createState(), {type: 'address', intent: addressIntent(new URLSearchParams(location.search))});
function writeAddress(method) {
  history[method](null, '', `${location.pathname}?${queryParams(state.intent)}${location.hash}`);
}
writeAddress('replaceState');
let resultController, detailController, exportController, overviewController;
let triage = [];
try {
  const raw = localStorage.getItem(triageKey);
  try { triage = parseTriage(raw); }
  catch { $('triage-storage').textContent = 'Saved triage is malformed and could not be restored. Your triage is usable for this visit; add incidents to start a new saved list.'; }
} catch { $('triage-storage').textContent = 'Triage could not be read because of unavailable browser storage. Your triage is usable for this visit; earlier saved entries could not be restored.'; }
let returnIncident = null, returnElement = null;
let renderedResult, renderedBlocked, renderedDetail, renderedIntent;
const storageKey = 'incident-explorer.views.v1';
let views = [];
try {
  const stored = JSON.parse(localStorage.getItem(storageKey) || '[]');
  if (Array.isArray(stored)) views = stored.filter(v => v && typeof v.name === 'string' && v.view && typeof v.view === 'object').map(v => ({name: v.name.slice(0, 80), view: savedView(v.view)}));
} catch { $('storage-message').textContent = 'Saved views could not be read. You can still explore incidents.'; }

function dispatch(event) { const next = transition(state, event); if (next === state) return; state = next; render(); }
function restoreFocus() {
  const button = [...$('rows').querySelectorAll('button')].find(b => b.dataset.incident === returnIncident);
  const target = button && !button.disabled ? button : returnElement?.isConnected && !returnElement.disabled ? returnElement : $('results');
  target.focus();
}
function closeDetail() {
  detailController?.abort();
  dispatch({type: 'detail:close'});
}
function change(event) {
  const next = transition(state, event);
  if (next === state) return;
  $('to').setCustomValidity('');
  resultController?.abort(); detailController?.abort(); exportController?.abort();
  const overviewChanged = overviewKey(next.intent) !== overviewKey(state.intent);
  if (overviewChanged) overviewController?.abort();
  state = next;
  if (event.type === 'address') { $('search').value = state.intent.q; renderedIntent = undefined; writeAddress('replaceState'); }
  else writeAddress('pushState');
  render(); loadResults(); if (overviewChanged) loadOverview();
}
async function checked(response) {
  if (response.ok) return response;
  let message = `Request failed (${response.status}).`;
  try { const body = await response.json(); if (typeof body.error?.message === 'string') message = body.error.message; } catch { /* Preserve the HTTP error when no structured error is available. */ }
  throw new Error(message);
}
const errorText = error => error instanceof Error ? error.message : 'The request failed. Please retry.';
async function loadResults() {
  resultController?.abort();
  const controller = resultController = new AbortController();
  dispatch({type: 'result:start'});
  const token = state.resultOp.token, params = queryParams(state.intent);
  try {
    const response = await checked(await fetch(`/api/incidents?${params}`, {signal: controller.signal}));
    const data = await response.json();
    const ownsResult = token === state.resultOp.token && state.resultOp.pending;
    dispatch({type: 'result:success', token, data});
    if (ownsResult) writeAddress('replaceState');
  } catch (error) { if (error.name !== 'AbortError') dispatch({type: 'result:failure', token, error: errorText(error)}); }
  finally { dispatch({type: 'result:finish', token}); }
}
async function loadOverview() {
  overviewController?.abort();
  const controller = overviewController = new AbortController();
  dispatch({type: 'overview:start'});
  const token = state.overviewOp.token, params = queryParams(state.intent, {pagination: false});
  try {
    const response = await checked(await fetch(`/api/overview?${params}`, {signal: controller.signal}));
    dispatch({type: 'overview:success', token, data: await response.json()});
  } catch (error) { if (error.name !== 'AbortError') dispatch({type: 'overview:failure', token, error: errorText(error)}); }
  finally { dispatch({type: 'overview:finish', token}); }
}
async function loadDetail() {
  detailController?.abort();
  const controller = detailController = new AbortController();
  dispatch({type: 'detail:start'});
  const {token, id} = state.detail;
  try {
    const response = await checked(await fetch(`/api/incidents/${encodeURIComponent(id)}`, {signal: controller.signal}));
    dispatch({type: 'detail:success', token, data: await response.json()});
  } catch (error) { if (error.name !== 'AbortError') dispatch({type: 'detail:failure', token, error: errorText(error)}); }
  finally { dispatch({type: 'detail:finish', token}); }
}
async function exportCSV() {
  exportController?.abort();
  const controller = exportController = new AbortController();
  dispatch({type: 'export:start'});
  const token = state.exportOp.token, params = queryParams(state.intent, {pagination: false});
  let url;
  try {
    const response = await checked(await fetch(`/api/export.csv?${params}`, {signal: controller.signal}));
    const blob = await response.blob();
    if (token !== state.exportOp.token || !state.exportOp.pending) return;
    url = URL.createObjectURL(blob);
    const link = node('a'); link.href = url; link.download = 'incidents.csv'; document.body.append(link); link.click(); link.remove();
    dispatch({type: 'export:success', token});
  } catch (error) { if (error.name !== 'AbortError') dispatch({type: 'export:failure', token, error: errorText(error)}); }
  finally { if (url) { const downloadURL = url; setTimeout(() => URL.revokeObjectURL(downloadURL), 1000); } dispatch({type: 'export:finish', token}); }
}
const renderedMessages = new WeakMap();
function operationMessage(element, message, retry, error = false) {
  const previous = renderedMessages.get(element);
  if (previous && previous.message === message && previous.retry === retry && previous.error === error) return;
  renderedMessages.set(element, {message, retry, error});
  element.replaceChildren(); element.classList.toggle('error', error);
  if (!message) return;
  element.append(node('span', message));
  if (retry) { const button = node('button', 'Retry', 'secondary'); button.type = 'button'; button.addEventListener('click', retry); element.append(button); }
}
function renderControls() {
  const intent = state.intent;
  const signature = JSON.stringify(intent);
  if (signature === renderedIntent) return;
  renderedIntent = signature;
  // Updating values in place preserves keyboard focus and typed search while requests complete.
  if (document.activeElement !== $('search')) $('search').value = intent.q;
  for (const key of ['from', 'to', 'sort', 'direction']) $(key).value = intent[key];
  $('page-size').value = intent.pageSize;
  for (const key of Object.keys(facets)) for (const input of $(key).querySelectorAll('input')) input.checked = intent[key].includes(input.value);
  $('active-filters').replaceChildren();
  for (const key of ['q', 'service', 'status', 'severity', 'from', 'to']) {
    const values = Array.isArray(intent[key]) ? intent[key] : intent[key] ? [intent[key]] : [];
    for (const value of values) {
      const label = `${key === 'q' ? 'Search' : human(key)}: ${key === 'status' ? human(value) : value}`;
      const button = node('button', `${label} ×`); button.type = 'button'; button.setAttribute('aria-label', `Clear ${label}`);
      button.addEventListener('click', () => change({type: 'intent', patch: {[key]: Array.isArray(state.intent[key]) ? state.intent[key].filter(v => v !== value) : ''}}));
      $('active-filters').append(button);
    }
  }
  if (!$('active-filters').children.length) $('active-filters').append(node('span', 'No search or filters applied', 'muted'));
}
function renderSnapshot() {
  const current = isResultCurrent(state), blocked = state.resultOp.pending || !current;
  $('results').dataset.stale = String(!current && !!state.result);
  $('freshness').textContent = state.resultOp.pending ? (state.result ? 'Updating · previous results shown' : 'Loading…') : !current && state.result ? 'Previous results · selections have changed' : state.result ? 'Current selections' : '';
  $('results').setAttribute('aria-busy', String(state.resultOp.pending));
  operationMessage($('result-message'), state.resultOp.error || (state.resultOp.pending ? (state.result ? 'Updating results. Rows and summaries below belong to the previous completed query.' : 'Loading incidents and summaries…') : !state.result ? 'No results loaded.' : !state.result.data.total ? 'No incidents match these selections. Try clearing a filter or changing your search.' : ''), state.resultOp.error ? loadResults : null, !!state.resultOp.error);
  const data = state.result?.data;
  if (state.result !== renderedResult) {
    $('summary').replaceChildren();
    for (const [label, key] of [['Matching incidents', 'total'], ['Unresolved', 'unresolved'], ['Critical + high', 'highSeverity']]) {
      const card = node('div', undefined, 'metric'); card.append(node('strong', data ? data.summary[key].toLocaleString() : '—'), node('span', label)); $('summary').append(card);
    }
    const days = data?.summary.openedByDay || [], maximum = Math.max(1, ...days.map(d => d.count));
    $('chart-bars').replaceChildren();
    for (const day of days) { const bar = node('span'); bar.style.height = `${day.count / maximum * 100}%`; $('chart-bars').append(bar); }
    $('chart-text').textContent = data ? days.length ? days.map(d => `${d.date}: ${d.count} incident${d.count === 1 ? '' : 's'}`).join('; ') : 'No matching incidents were opened in this range.' : 'Daily counts will appear when results load.';
  }
  if (state.result !== renderedResult || blocked !== renderedBlocked) {
    $('rows').replaceChildren();
    for (const item of data?.items || []) {
      const row = node('tr'), cell = node('td'), button = node('button', undefined, 'incident-link');
      button.type = 'button'; button.dataset.incident = item.id; button.disabled = blocked;
      button.append(node('span', item.id), document.createTextNode(item.title));
      button.addEventListener('click', () => { returnIncident = item.id; returnElement = button; dispatch({type: 'detail:select', id: item.id}); loadDetail(); });
      cell.append(button); row.append(cell, node('td', item.service));
      const severity = node('td'); severity.append(node('span', human(item.severity), `badge ${item.severity}`)); row.append(severity, node('td', human(item.status)), node('td', utc(item.openedAt))); $('rows').append(row);
    }
    renderedResult = state.result; renderedBlocked = blocked;
  }
  $('previous').disabled = !canPaginate(state) || state.intent.page <= 1;
  $('next').disabled = !canPaginate(state) || state.intent.page >= (data?.totalPages || 0);
  $('page-label').textContent = data ? data.totalPages ? `Page ${data.page} of ${data.totalPages} · ${data.total.toLocaleString()} incidents${current ? '' : ' (previous query)'}` : '0 incidents · no pages' : 'Pages unavailable';
}
function renderDetail() {
  const detail = state.detail, dialog = $('detail');
  if (!detail.id) { renderedDetail = null; if (dialog.open) { dialog.close(); restoreFocus(); } return; }
  if (renderedDetail && ['token', 'id', 'pending', 'data', 'error'].every(key => renderedDetail[key] === detail[key])) return;
  const contentHadFocus = $('detail-content').contains(document.activeElement);
  renderedDetail = detail;
  $('detail-title').textContent = detail.data ? `${detail.data.id} · ${detail.data.title}` : `Incident ${detail.id}`;
  $('detail-content').replaceChildren();
  if (detail.pending || detail.error || !detail.data) {
    const message = node('div', undefined, 'operation-message'); operationMessage(message, detail.error || 'Loading complete incident details…', detail.error ? loadDetail : null, !!detail.error); $('detail-content').append(message);
  } else {
    const fields = node('dl', undefined, 'detail-fields');
    for (const [key, label] of [['id', 'ID'], ['title', 'Title'], ['description', 'Description'], ['service', 'Service'], ['severity', 'Severity'], ['status', 'Status'], ['openedAt', 'Opened (UTC)'], ['resolvedAt', 'Resolved (UTC)'], ['team', 'Team'], ['region', 'Region'], ['tags', 'Tags']]) {
      const value = detail.data[key];
      fields.append(node('dt', label), node('dd', key.endsWith('At') ? utc(value) : Array.isArray(value) ? value.join(', ') || 'None' : key === 'status' ? human(value) : String(value ?? '—')));
    }
    $('detail-content').append(fields);
    const add = node('button', triage.some(x => x.id === detail.id) ? 'In personal triage' : 'Add to personal triage');
    add.type = 'button';
    add.addEventListener('click', () => {
      triage = addTriage(triage, detail.data); persistTriage(); renderTriage();
      add.textContent = 'In personal triage';
    });
    $('detail-content').append(add);
  }
  if (!dialog.open) { dialog.showModal(); $('close-detail').focus(); }
  else if (contentHadFocus) $('close-detail').focus();
}
function render() {
  renderControls(); renderOverview(); renderSnapshot(); renderDetail();
  $('export').disabled = state.exportOp.pending;
  operationMessage($('export-message'), state.exportOp.error || (state.exportOp.pending ? 'Preparing a CSV of all matching incidents…' : ''), state.exportOp.error ? exportCSV : null, !!state.exportOp.error);
  $('announcement').textContent = announcement(state);
}
function selectionText(intent) {
  const parts = [];
  if (intent.q) parts.push(`Search: “${intent.q}”`);
  for (const key of ['service', 'status', 'severity']) if (intent[key].length) parts.push(`${human(key)}: ${intent[key].map(human).join(', ')}`);
  if (intent.from || intent.to) parts.push(`Opened UTC: ${intent.from || 'any start'} through ${intent.to || 'any end'} (inclusive)`);
  return parts.join(' · ') || 'All incidents · no search or filters';
}
let renderedOverview;
function renderOverview() {
  const current = isOverviewCurrent(state), op = state.overviewOp;
  $('overview').setAttribute('aria-busy', String(op.pending));
  $('overview').dataset.stale = String(!current);
  // Hide old measures when filters change: displayed cards always belong to this selection.
  $('overview-selection').textContent = `Selection: ${selectionText(state.intent)}`;
  operationMessage($('overview-message'), op.error ? `Overview unavailable for this selection: ${op.error}` : op.pending ? 'Loading service measures for this selection…' : current && !state.overview.data.total ? 'No services match these selections. Clear a filter or change your search to compare services.' : '', op.error ? loadOverview : null, !!op.error);
  const snapshot = current ? state.overview : null;
  if (renderedOverview === snapshot) return;
  renderedOverview = snapshot;
  $('service-cards').replaceChildren();
  for (const item of snapshot?.data.services || []) {
    const card = node('article', undefined, 'service-card'); card.append(node('h3', item.service));
    const measures = node('dl');
    for (const [label, value] of [['Incidents', item.incidentCount], ['Unresolved', item.unresolvedCount], ['Critical + high', item.highSeverityCount], ['Average resolution', item.averageResolutionHours === null ? 'Unavailable' : `${item.averageResolutionHours.toFixed(1)} hours`]]) measures.append(node('dt', label), node('dd', String(value)));
    card.append(measures); $('service-cards').append(card);
  }
}
function persistTriage() {
  try { localStorage.setItem(triageKey, JSON.stringify(triage)); $('triage-storage').textContent = 'Personal triage saved in this browser.'; }
  catch { $('triage-storage').textContent = 'Browser storage is unavailable. Your triage and notes remain usable for this visit, but may not survive a reload.'; }
}
function renderTriage() {
  $('triage-list').replaceChildren();
  if (!triage.length) $('triage-list').append(node('li', 'No incidents in personal triage. Open full incident details and choose Add to personal triage.', 'muted'));
  for (const entry of triage) {
    const row = node('li'), open = node('button', `${entry.id} · ${entry.title}`, 'secondary'); open.type = 'button'; open.dataset.incident = entry.id;
    open.setAttribute('aria-label', `Open triage incident ${entry.id}`);
    open.addEventListener('click', () => { returnIncident = null; returnElement = open; dispatch({type: 'detail:select', id: entry.id}); loadDetail(); });
    const label = node('label', `Note for ${entry.id}`), note = node('textarea'); note.id = `note-${entry.id}`; label.htmlFor = note.id; note.maxLength = 1000; note.rows = 3; note.value = entry.note;
    note.addEventListener('input', () => { triage = editNote(triage, entry.id, note.value); persistTriage(); });
    const remove = node('button', 'Remove from triage', 'secondary'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${entry.id} from triage`);
    remove.addEventListener('click', () => { triage = removeTriage(triage, entry.id); persistTriage(); renderTriage(); $('triage').focus(); });
    row.append(open, node('p', `${entry.service} · ${human(entry.status)} · ${entry.severity}`), label, note, node('p', 'Plain text · up to 1,000 characters', 'muted'), remove); $('triage-list').append(row);
  }
}
function renderViews() {
  $('views').replaceChildren();
  if (!views.length) $('views').append(node('li', 'No saved views yet.', 'muted'));
  views.forEach((entry, index) => {
    const row = node('li'), open = node('button', entry.name, 'secondary'), remove = node('button', 'Delete', 'secondary'); open.type = remove.type = 'button';
    open.setAttribute('aria-label', `Open saved view ${entry.name}`); remove.setAttribute('aria-label', `Delete saved view ${entry.name}`);
    open.addEventListener('click', () => { $('search').value = entry.view.q; change({type: 'restore', view: entry.view}); });
    remove.addEventListener('click', () => { views.splice(index, 1); persistViews(); renderViews(); $('view-name').focus(); });
    row.append(open, remove); $('views').append(row);
  });
}
function persistViews() {
  try { localStorage.setItem(storageKey, JSON.stringify(views)); $('storage-message').textContent = 'Saved views updated in this browser.'; }
  catch { $('storage-message').textContent = 'Browser storage is unavailable. These views will last only for this visit.'; }
}
function queryPatch() {
  const patch = {q: $('search').value, from: $('from').value, to: $('to').value};
  for (const key of Object.keys(facets)) patch[key] = [...$(key).querySelectorAll('input:checked')].map(input => input.value);
  return patch;
}
function applyForm() {
  $('to').setCustomValidity($('from').value && $('to').value && $('from').value > $('to').value ? 'Choose an end date on or after the start date.' : '');
  if ($('query-form').reportValidity()) change({type: 'intent', patch: queryPatch()});
}
for (const [key, values] of Object.entries(facets)) for (const value of values) {
  const label = node('label', undefined, 'check'), input = node('input'); input.type = 'checkbox'; input.name = key; input.value = value;
  label.append(input, document.createTextNode(human(value))); $(key).append(label);
}
$('query-form').addEventListener('submit', event => { event.preventDefault(); applyForm(); });
$('query-form').addEventListener('change', event => { if (event.target !== $('search')) applyForm(); });
$('clear').addEventListener('click', () => { $('search').value = ''; $('to').setCustomValidity(''); change({type: 'intent', patch: {q: '', service: [], status: [], severity: [], from: '', to: ''}}); });
for (const key of ['sort', 'direction']) $(key).addEventListener('change', () => change({type: 'intent', patch: {[key]: $(key).value}}));
$('page-size').addEventListener('change', () => change({type: 'intent', patch: {pageSize: Number($('page-size').value)}}));
$('previous').addEventListener('click', () => change({type: 'page', delta: -1}));
$('next').addEventListener('click', () => change({type: 'page', delta: 1}));
$('export').addEventListener('click', exportCSV);
$('close-detail').addEventListener('click', closeDetail);
$('detail').addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
$('save-form').addEventListener('submit', event => { event.preventDefault(); const name = $('view-name').value.trim(); if (!name) { $('view-name').setCustomValidity('Enter a view name.'); $('view-name').reportValidity(); return; } views.push({name, view: savedView(state.intent)}); persistViews(); renderViews(); $('view-name').value = ''; });
$('view-name').addEventListener('input', () => $('view-name').setCustomValidity(''));
window.addEventListener('popstate', () => change({type: 'address', intent: addressIntent(new URLSearchParams(location.search))}));
renderViews(); renderTriage(); render(); loadResults(); loadOverview();

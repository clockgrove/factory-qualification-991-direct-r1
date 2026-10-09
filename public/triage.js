// Personal snapshots are separate from canonical incident data and search state.
export const triageKey = 'incident-explorer.triage.v1';
export function parseTriage(raw) {
  if (raw === null) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.some(x => !x || !/^INC-\d{6}$/.test(x.id) ||
    !['title', 'service', 'status', 'severity', 'note'].every(k => typeof x[k] === 'string') || x.note.length > 1000) ||
    new Set(value.map(x => x.id)).size !== value.length) throw new Error('Malformed triage');
  return value.map(({id, title, service, status, severity, note}) => ({id, title, service, status, severity, note}));
}
export function addTriage(list, incident) {
  if (list.some(x => x.id === incident.id)) return list;
  const {id, title, service, status, severity} = incident;
  return [...list, {id, title, service, status, severity, note: ''}];
}
export function editNote(list, id, note) {
  return list.map(x => x.id === id ? {...x, note: note.slice(0, 1000)} : x);
}
export function removeTriage(list, id) { return list.filter(x => x.id !== id); }

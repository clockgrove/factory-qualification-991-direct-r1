import test from 'node:test';
import assert from 'node:assert/strict';
import {createState, transition, isOverviewCurrent} from '../../public/state.js';
import {parseTriage, addTriage, removeTriage, editNote} from '../../public/triage.js';

test('overview ownership rejects obsolete success, failure and cleanup; pagination retains measures', () => {
  let s = transition(createState(), {type: 'overview:start'});
  const old = s.overviewOp.token;
  s = transition(s, {type: 'intent', patch: {service: ['Billing']}});
  s = transition(s, {type: 'overview:start'});
  for (const type of ['overview:success', 'overview:failure', 'overview:finish']) assert.equal(transition(s, {type, token: old, error: 'obsolete', data: {total: 2400}}), s);
  s = transition(s, {type: 'overview:success', token: s.overviewOp.token, data: {total: 400}});
  const overview = s.overview;
  assert.ok(isOverviewCurrent(s));
  s = transition(s, {type: 'intent', patch: {pageSize: 50, sort: 'severity'}});
  assert.equal(s.overview, overview); assert.ok(isOverviewCurrent(s));
  s = transition(s, {type: 'intent', patch: {q: 'new'}});
  assert.equal(isOverviewCurrent(s), false);
});

test('triage maintains addition order, literal notes, deduplication and removal without note residue', () => {
  const a = {id: 'INC-000001', title: 'First', service: 'Search', status: 'open', severity: 'high'};
  const b = {...a, id: 'INC-000002', title: 'Second'};
  let list = addTriage(addTriage([], a), b);
  assert.equal(addTriage(list, a), list);
  const note = '<script>alert("x")</script> & **text**, punctuation!';
  list = editNote(list, a.id, note);
  assert.deepEqual(parseTriage(JSON.stringify(list)), list);
  assert.deepEqual(list.map(x => x.id), [a.id, b.id]);
  list = addTriage(removeTriage(list, a.id), a);
  assert.deepEqual(list.map(x => x.id), [b.id, a.id]); assert.equal(list[1].note, '');
  for (const raw of ['{', '{}', '[{"id":"INC-000001"}]', JSON.stringify([list[0], list[0]])]) assert.throws(() => parseTriage(raw));
  assert.deepEqual(parseTriage(null), []);
});

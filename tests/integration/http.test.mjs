import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createAppServer } from '../../server/app.mjs';
import { rows, expected, parseCSV, csvRows } from './oracle.js';

function parameters(options) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    for (const item of Array.isArray(value) ? value : [value]) result.append(key, item);
  }
  return result;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

test('integration: canonical data through real HTTP, complete pages, summaries, details and CSV', async t => {
  const server = await createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const list = async (options = {}) => {
      const response = await fetch(`${base}/api/incidents?${parameters(options)}`);
      assert.equal(response.status, 200);
      const actual = await response.json();
      const oracle = expected(options);
      const pageSize = Number(options.pageSize ?? 25);
      const totalPages = Math.ceil(oracle.items.length / pageSize);
      const page = Math.min(Number(options.page ?? 1), totalPages || 1);
      assert.deepEqual(actual, {
        items: oracle.items.slice((page - 1) * pageSize, page * pageSize),
        page, pageSize, total: oracle.items.length, totalPages, summary: oracle.summary,
      });
      return actual;
    };

    await t.test('unfiltered defaults and summaries include every day and all pages', async () => {
      const initial = await list();
      assert.equal(initial.total, 2400);
      assert.equal(initial.items.length, 25);
      assert.equal(initial.summary.openedByDay.length, 90);
      assert.equal(initial.summary.openedByDay.reduce((n, day) => n + day.count, 0), rows.length);
    });

    await t.test('search, OR facets, AND across facets and inclusive UTC boundaries', async () => {
      for (const q of ['iNc-000001', 'SLOW RESPONSE', 'second LINE: <sample>', '"retry, then continue"', '.*', 'Cobalt']) await list({ q });
      const combined = { q: 'incident', service: ['Accounts', 'Billing'], status: ['open', 'in_progress'], severity: ['critical', 'high'], from: '2026-04-01', to: '2026-06-29' };
      assert.ok((await list(combined)).total > 50);
      await list({ service: ['Accounts', 'Accounts', 'Billing'] });
      for (const options of [
        { from: '2026-04-01', to: '2026-04-01' },
        { from: '2026-06-29', to: '2026-06-29' },
        { from: '2026-04-01', to: '2026-06-29' },
        { from: '2026-06-29' }, { to: '2026-04-01' },
        { q: 'no incident matches this', page: 42 },
      ]) await list(options);
      for (const day of ['2026-04-01', '2026-06-29']) {
        const actual = await list({ from: day, to: day, pageSize: 50 });
        assert.ok(actual.total > 0);
        assert.ok(actual.items.every(row => row.openedAt.startsWith(day)));
      }
    });

    await t.test('every page, sort direction, page size, ties and repeated pagination', async () => {
      for (const sort of ['openedAt', 'severity']) {
        for (const direction of ['asc', 'desc']) {
          for (const pageSize of [25, 50]) {
            const options = { sort, direction, pageSize };
            const collected = [];
            const totalPages = Math.ceil(rows.length / pageSize);
            for (let page = 1; page <= totalPages; page++) {
              const actual = await list({ ...options, page });
              collected.push(...actual.items);
              if (page === 2 || page === totalPages) assert.deepEqual(await list({ ...options, page }), actual);
            }
            assert.deepEqual(collected, expected(options).items);
            assert.equal(new Set(collected.map(row => row.id)).size, rows.length);
            const firstTie = collected.findIndex(row => row.id === rows[0].id);
            assert.equal(collected[firstTie + 1].id, rows[1].id);
            await list({ ...options, page: 99999 });
          }
        }
      }
    });

    await t.test('every detail field for all incidents is unchanged', async () => {
      // Sequential requests avoid creating an artificial connection-pressure failure.
      for (const row of rows) {
        const response = await fetch(`${base}/api/incidents/${row.id}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), row);
      }
      const missing = await fetch(`${base}/api/incidents/INC-999999`);
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, 'NOT_FOUND');
    });

    await t.test('parsed CSV preserves every field and punctuation beyond the visible page', async () => {
      for (const options of [
        {}, { sort: 'openedAt', direction: 'asc' },
        { sort: 'severity', direction: 'asc' }, { sort: 'severity', direction: 'desc' },
        { q: 'Note:', service: ['Accounts', 'Billing'], status: ['open', 'resolved'] },
        { q: 'no incident matches this' },
      ]) {
        const response = await fetch(`${base}/api/export.csv?${parameters({ ...options, page: 2, pageSize: 25 })}`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/csv/);
        assert.match(response.headers.get('content-disposition'), /attachment/);
        assert.deepEqual(parseCSV(await response.text()), csvRows(expected(options).items));
      }
      assert.ok(rows.some(row => /[",\n]/.test(row.description)));
      assert.ok(rows.some(row => row.resolvedAt === null));
    });
  } finally {
    await close(server);
  }
});

test('integration: exact npm run start serves the app and the owned process group shuts down', { timeout: 20000 }, async () => {
  const child = spawn('npm', ['run', 'start'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, PORT: '0' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '', errors = '', startupTimer, endpoint;
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    endpoint = await new Promise((resolve, reject) => {
      startupTimer = setTimeout(() => reject(new Error(`npm run start timed out: ${errors}`)), 10000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`npm run start exited before readiness: ${errors}`)));
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/Incident explorer: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      });
    });
    clearTimeout(startupTimer);
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const incidents = await fetch(`${endpoint}/api/incidents`);
    assert.deepEqual((await incidents.json()).items, expected().items.slice(0, 25));
  } finally {
    clearTimeout(startupTimer);
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const force = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }, 3000);
    try { await exited; }
    finally { clearTimeout(force); }
    if (endpoint) {
      await assert.rejects(fetch(`${endpoint}/api/incidents`, { signal: AbortSignal.timeout(2000) }));
    }
  }
});

test('integration: operational overview uses canonical full filtered data over real HTTP', async t => {
  const server = await createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const overview = async (options = {}) => {
      const response = await fetch(`${base}/api/overview?${parameters(options)}`);
      assert.equal(response.status, 200);
      const actual = await response.json();
      const matches = expected(options).items;
      assert.equal(actual.total, matches.length);
      const services = [...new Set(matches.map(row => row.service))].map(service => {
        const incidents = matches.filter(row => row.service === service);
        const resolved = incidents.filter(row => row.status === 'resolved');
        const elapsedMilliseconds = resolved.reduce((sum, row) => sum + Date.parse(row.resolvedAt) - Date.parse(row.openedAt), 0);
        return {
          service, incidentCount: incidents.length,
          unresolvedCount: incidents.filter(row => row.status === 'open' || row.status === 'in_progress').length,
          highSeverityCount: incidents.filter(row => row.severity === 'critical' || row.severity === 'high').length,
          averageResolutionHours: resolved.length ? elapsedMilliseconds / resolved.length / 3_600_000 : null,
        };
      }).sort((a, b) => b.unresolvedCount - a.unresolvedCount || a.service.localeCompare(b.service));
      assert.equal(actual.services.length, services.length);
      for (let i = 0; i < services.length; i++) {
        const { averageResolutionHours, ...counts } = actual.services[i];
        const { averageResolutionHours: expectedAverage, ...expectedCounts } = services[i];
        assert.deepEqual(counts, expectedCounts);
        if (expectedAverage === null) assert.equal(averageResolutionHours, null);
        else assert.ok(Math.abs(averageResolutionHours - expectedAverage) < 1e-10,
          `${counts.service} average ${averageResolutionHours} differs from canonical ${expectedAverage}`);
      }
      return actual;
    };
    await t.test('all services and filtered multipage result ignore page, size and sorting', async () => {
      await overview();
      const options = { q: 'incident', service: ['Accounts', 'Billing'], severity: ['critical', 'high'], from: '2026-04-01', to: '2026-06-29' };
      const first = await overview({ ...options, page: 1, pageSize: 25 });
      assert.ok(first.total > 50, 'selected fixture must span multiple pages');
      assert.deepEqual(await overview({ ...options, page: 2, pageSize: 25 }), first);
      assert.deepEqual(await overview({ ...options, page: 3, pageSize: 50 }), first);
      const otherSort = await overview({ ...options, sort: 'severity', direction: 'asc' });
      for (let i = 0; i < first.services.length; i++) {
        assert.ok(Math.abs(first.services[i].averageResolutionHours - otherSort.services[i].averageResolutionHours) < 1e-10);
        assert.deepEqual({ ...otherSort.services[i], averageResolutionHours: first.services[i].averageResolutionHours }, first.services[i]);
      }
    });
    await t.test('resolved-only means exclude unresolved durations; missing averages are null', async () => {
      const all = await overview();
      const resolved = await overview({ status: ['resolved'] });
      for (const service of resolved.services) {
        assert.equal(service.unresolvedCount, 0);
        assert.equal(service.averageResolutionHours, all.services.find(row => row.service === service.service).averageResolutionHours);
      }
      const unresolved = await overview({ status: ['open', 'in_progress'] });
      assert.ok(unresolved.services.length > 0);
      assert.ok(unresolved.services.every(service => service.averageResolutionHours === null));
      const one = rows.find(row => row.status === 'open');
      const isolated = await overview({ q: one.id });
      assert.equal(isolated.services.length, 1);
      assert.equal(isolated.services[0].averageResolutionHours, null);
    });
    await t.test('unresolved descending order, service-name ties, inclusive dates and empty state contract', async () => {
      const all = await overview();
      for (let i = 1; i < all.services.length; i++) assert.ok(all.services[i - 1].unresolvedCount >= all.services[i].unresolvedCount);
      const tied = await overview({ status: ['resolved'] });
      assert.deepEqual(tied.services.map(row => row.service), tied.services.map(row => row.service).sort());
      for (const day of ['2026-04-01', '2026-06-29']) {
        assert.ok((await overview({ from: day, to: day })).total > 0);
      }
      await overview({ q: 'SECOND line: <SAMPLE>', service: ['Accounts', 'Billing'], status: ['open', 'resolved'] });
      assert.deepEqual(await overview({ q: 'no incident matches this' }), { total: 0, services: [] });
    });
    await t.test('overview retains incident query validation', async () => {
      for (const query of ['page=0', 'pageSize=10', 'from=2026-02-30', 'service=Unknown', 'q=a&q=b', 'unknown=1', 'from=2026-06-01&to=2026-05-01']) {
        const response = await fetch(`${base}/api/overview?${query}`);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, 'INVALID_QUERY');
      }
    });
  } finally {
    await close(server);
  }
});

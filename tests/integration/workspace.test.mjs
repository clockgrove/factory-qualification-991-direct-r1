import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {once} from 'node:events';
import {createAppServer} from '../../server/app.mjs';
import {expected} from './oracle.js';

const alias = dirname(execFileSync('bash', ['-c', 'command -v qualification-chromium'], {encoding: 'utf8'}).trim());
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(alias, '../browsers');
await mkdir('.runtime/browser-tmp', {recursive: true});
for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = '.runtime/browser-tmp';
const {chromium} = await import('playwright');
async function until(read, wanted = true) {
  const deadline = Date.now() + 10000;
  let actual;
  do { actual = await read(); if (actual === wanted) return; await new Promise(r => setTimeout(r, 25)); } while (Date.now() < deadline);
  assert.equal(actual, wanted);
}

test('real browser operational overview and personal triage journeys', {timeout: 120000}, async t => {
  const before = await readFile('.runtime/incidents.json');
  let server, browser, context, port;
  const start = async () => { server = await createAppServer(); server.listen(port || 0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port; };
  const stop = async () => { if (!server?.listening) return; await new Promise((res, rej) => { server.close(e => e ? rej(e) : res()); server.closeAllConnections(); }); };
  try {
    await start();
    browser = await chromium.launch({channel: 'chromium', headless: true, chromiumSandbox: true, env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      LD_LIBRARY_PATH: resolve(alias, '../host-libs/usr/lib/x86_64-linux-gnu'),
      ALSA_CONFIG_PATH: resolve(alias, '../host-libs/usr/share/alsa/alsa.conf'),
      TMPDIR: '.runtime/browser-tmp', TMP: '.runtime/browser-tmp', TEMP: '.runtime/browser-tmp'
    }});
    context = await browser.newContext();
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const base = `http://127.0.0.1:${port}`;
    const ready = async () => { await until(() => page.locator('#overview').getAttribute('aria-busy'), 'false'); await until(() => page.locator('#results').getAttribute('aria-busy'), 'false'); };
    const search = async q => { await page.locator('#search').fill(q); await page.locator('#search').press('Enter'); };
    const checkOverview = async options => {
      await ready();
      const {items} = expected(options);
      const names = [...new Set(items.map(x => x.service))].sort((a,b) => items.filter(x => x.service === b && x.status !== 'resolved').length - items.filter(x => x.service === a && x.status !== 'resolved').length || a.localeCompare(b));
      assert.deepEqual(await page.locator('.service-card h3').allTextContents(), names);
      for (let n = 0; n < names.length; n++) {
        const subset = items.filter(x => x.service === names[n]), resolved = subset.filter(x => x.status === 'resolved');
        const average = resolved.length ? (resolved.reduce((sum, x) => sum + (Date.parse(x.resolvedAt) - Date.parse(x.openedAt)) / 3600000, 0) / resolved.length).toFixed(1) + ' hours' : 'Unavailable';
        assert.deepEqual(await page.locator('.service-card').nth(n).locator('dd').allTextContents(), [subset.length, subset.filter(x => x.status !== 'resolved').length, subset.filter(x => ['critical', 'high'].includes(x.severity)).length].map(String).concat(average));
      }
    };
    await t.test('fresh phone lands on overview; navigation, measures and keyboard fit', async () => {
      await page.setViewportSize({width: 375, height: 812}); await page.goto(base); await checkOverview({});
      const bounds = await page.locator('#overview-title').boundingBox(); assert.ok(bounds.y < 812);
      assert.ok(await page.locator('#overview').evaluate(x => x.getBoundingClientRect().top < document.querySelector('aside').getBoundingClientRect().top));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      for (const card of await page.locator('.service-card').all()) assert.ok(await card.evaluate(x => x.getBoundingClientRect().right <= innerWidth));
      await page.screenshot({path: '.runtime/workspace-phone-landing.png'});
      const incidents = page.getByRole('link', {name: 'Incidents', exact: true}); await incidents.focus(); await page.keyboard.press('Enter');
      await until(() => page.locator('#results').evaluate(x => x === document.activeElement));
      await page.getByRole('link', {name: 'Personal triage', exact: true}).focus(); await page.keyboard.press('Enter');
      await until(() => page.locator('#triage').evaluate(x => x === document.activeElement));
      await page.screenshot({path: '.runtime/workspace-phone.png', fullPage: true});
      await page.setViewportSize({width: 1280, height: 900});
    });
    await t.test('selection updates, page independence, empty state and actual connection failure/retry', async () => {
      await search('Billing'); await checkOverview({q: 'Billing'});
      const measures = await page.locator('#service-cards').textContent();
      await page.locator('#next').click(); await ready(); assert.equal(await page.locator('#service-cards').textContent(), measures);
      await page.locator('#page-size').selectOption('50'); await ready(); assert.equal(await page.locator('#service-cards').textContent(), measures);
      await search('nothing matches this phrase'); await checkOverview({q: 'nothing matches this phrase'});
      assert.match(await page.locator('#overview-message').textContent(), /No services match.*Clear a filter/);
      assert.equal(await page.locator('#overview-message').isVisible(), true);
      await stop(); await search('Uploads');
      await until(() => page.locator('#overview-message button').count(), 1);
      assert.match(await page.locator('#overview-selection').textContent(), /Uploads/);
      assert.equal(await page.locator('.service-card').count(), 0);
      await start(); await page.locator('#overview-message button').focus(); await page.keyboard.press('Enter'); await checkOverview({q: 'Uploads'});
      await page.locator('#result-message button').click(); await ready();
    });
    await t.test('bounded overlapping selections keep current ownership after old request failure', async () => {
      const cdp = await context.newCDPSession(page); await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 800, downloadThroughput: -1, uploadThroughput: -1});
      try {
        const old = page.waitForRequest(r => r.url().includes('/api/overview?') && new URL(r.url()).searchParams.get('q') === 'Billing');
        await search('Billing'); await old;
        await stop(); await search('Search');
        await until(() => page.locator('#overview-message button').count(), 1);
        assert.match(await page.locator('#overview-selection').textContent(), /Search/);
        assert.equal(await page.locator('.service-card').count(), 0);
        await start(); await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
        await page.locator('#overview-message button').click(); await checkOverview({q: 'Search'});
        await page.locator('#result-message button').click(); await ready();
        await new Promise(r => setTimeout(r, 900)); await checkOverview({q: 'Search'});
      } finally { await cdp.detach(); }
    });
    await t.test('triage order, duplicate add, literal edited note, reload, details and removal', async () => {
      await page.goto(`${base}/?q=incident&service=Billing`); await checkOverview({q: 'incident', service: ['Billing']});
      const ids = await page.locator('#rows button').evaluateAll(xs => xs.slice(0, 2).map(x => x.dataset.incident));
      const add = async index => {
        const button = page.locator('#rows button').nth(index); await button.focus(); await page.keyboard.press('Enter');
        await until(() => page.getByRole('button', {name: 'Add to personal triage', exact: true}).count(), 1);
        await page.getByRole('button', {name: 'Add to personal triage', exact: true}).focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
        assert.equal(await button.evaluate(x => x === document.activeElement), true);
      };
      await add(0); await add(1);
      await page.locator('#rows button').first().click(); await until(() => page.getByRole('button', {name: 'In personal triage', exact: true}).count(), 1);
      await page.getByRole('button', {name: 'In personal triage', exact: true}).click(); await page.keyboard.press('Escape');
      assert.deepEqual(await page.locator('#triage-list button[data-incident]').evaluateAll(xs => xs.map(x => x.dataset.incident)), ids);
      const note = '<script>alert("triage")</script> & **check**, "quoted"; punctuation!?';
      const input = page.getByLabel(`Note for ${ids[0]}`); await input.fill('draft'); await input.fill(note);
      await page.reload(); await ready(); assert.equal(await page.getByLabel(`Note for ${ids[0]}`).inputValue(), note);
      assert.equal(await page.locator('#triage-list script').count(), 0);
      const address = page.url(), rows = await page.locator('#rows').textContent();
      const open = page.getByRole('button', {name: `Open triage incident ${ids[0]}`, exact: true}); await open.focus(); await page.keyboard.press('Enter');
      await until(() => page.locator('#detail-content dd').count(), 11); await page.keyboard.press('Escape');
      assert.equal(page.url(), address); assert.equal(await page.locator('#rows').textContent(), rows); assert.equal(await open.evaluate(x => x === document.activeElement), true);
      await page.setViewportSize({width: 375, height: 812});
      await page.getByLabel(`Note for ${ids[0]}`).focus(); assert.notEqual(await page.getByLabel(`Note for ${ids[0]}`).evaluate(x => getComputedStyle(x).outlineStyle), 'none');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const remove = page.getByRole('button', {name: `Remove ${ids[0]} from triage`, exact: true}); await remove.focus(); await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('incident-explorer.triage.v1')).map(x => x.id)), [ids[1]]);
      await add(0); assert.equal(await page.getByLabel(`Note for ${ids[0]}`).inputValue(), '');
      await page.reload(); await ready(); assert.deepEqual(await page.locator('#triage-list button[data-incident]').evaluateAll(xs => xs.map(x => x.dataset.incident)), [ids[1], ids[0]]);
      await page.screenshot({path: '.runtime/workspace-triage-phone.png', fullPage: true});
    });
    await t.test('malformed persisted triage leaves explorer and new triage usable', async () => {
      await page.evaluate(() => localStorage.setItem('incident-explorer.triage.v1', '{bad json'));
      await page.reload(); await ready();
      assert.match(await page.locator('#triage-storage').textContent(), /malformed.*usable for this visit/);
      assert.match(await page.locator('#triage-list').textContent(), /No incidents/);
      await page.locator('#rows button').first().click(); await until(() => page.getByRole('button', {name: 'Add to personal triage', exact: true}).count(), 1);
      await page.getByRole('button', {name: 'Add to personal triage', exact: true}).click(); await page.keyboard.press('Escape');
      assert.equal(await page.locator('#triage-list button[data-incident]').count(), 1);
    });
    await t.test('runtime storage denial retains membership and notes for the visit', async () => {
      const denied = await browser.newContext();
      try {
        await denied.addInitScript(() => { Storage.prototype.getItem = () => { throw new DOMException('Denied', 'SecurityError'); }; Storage.prototype.setItem = () => { throw new DOMException('Denied', 'SecurityError'); }; });
        const p = await denied.newPage(); await p.goto(base);
        await until(() => p.locator('#results').getAttribute('aria-busy'), 'false');
        assert.match(await p.locator('#triage-storage').textContent(), /unavailable browser storage/);
        await p.locator('#rows button').first().click(); await until(() => p.getByRole('button', {name: 'Add to personal triage', exact: true}).count(), 1);
        await p.getByRole('button', {name: 'Add to personal triage', exact: true}).click(); await p.keyboard.press('Escape');
        await p.locator('#triage-list textarea').fill('<b>still usable</b>!');
        assert.match(await p.locator('#triage-storage').textContent(), /remain usable for this visit/);
        assert.equal(await p.locator('#triage-list textarea').inputValue(), '<b>still usable</b>!');
        await p.locator('#triage-list button[data-incident]').click(); await until(() => p.locator('#detail-content dd').count(), 11); await p.keyboard.press('Escape');
        assert.equal(await p.locator('#triage-list textarea').inputValue(), '<b>still usable</b>!');
      } finally { await denied.close(); }
    });
    assert.deepEqual(errors, []);
  } finally {
    try { await context?.close(); } finally { try { await browser?.close(); } finally { await stop(); } }
    assert.deepEqual(await readFile('.runtime/incidents.json'), before);
  }
});

import { execSync } from 'node:child_process';
import { withBrowser, ORIGIN } from './cdp.mjs';
const [jar, shotDir, project] = process.argv.slice(2);
const compose = (args) => execSync(`docker compose ${args}`, { cwd: project, stdio: 'ignore' });
const apiGet = (page, path) => page.eval(`fetch('/api/v1${path}', { credentials: 'same-origin' }).then(r => r.json())`);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

await withBrowser(jar, async (page) => {
  // A. sidecar down -> load error with retry, not a login prompt; retry recovers
  compose('stop cleaningplan-api');
  await page.goto(`${ORIGIN}/m/cleaningplan`);
  await page.waitFor(`document.querySelector('#cleaningplan-plan .empty-state--error, #cleaningplan-plan [data-variant="error"], #cleaningplan-plan .empty-state')`, { label: 'error state' });
  console.log('--- sidecar down ---'); console.log((await page.text('#cleaningplan-plan')).replace(/\n+/g, ' | '));
  console.log('still on module page:', await page.eval('location.pathname'), '| login form present:', await page.eval(`Boolean(document.querySelector('form[action*="login"], input[name="password"]'))`));
  await page.shot(`${shotDir}/t9-1-sidecar-down.png`);
  compose('start cleaningplan-api');
  await new Promise((r) => setTimeout(r, 1500));
  await page.click('#cleaningplan-plan button');
  await page.waitFor(`document.querySelector('.cleaningplan-room')`, { label: 'plan after retry', timeout: 15000 });
  console.log('after retry:', (await page.text('#cleaningplan-plan')).split('\n').slice(0, 3).join(' | '));

  // B. escaping: rename the room to something hostile, generate, check page and task titles
  await page.click('.cleaningplan-room [data-action="edit-room"]');
  await page.waitFor(`document.querySelector('form[data-form="room"]')`);
  await page.fill('form[data-form="room"] input[name="name"]', '<b>Bad</b> "kitchen"');
  await page.submit('form[data-form="room"]');
  await page.waitFor(`!document.querySelector('form[data-form="room"]')`);
  const roomHtml = await page.eval(`document.querySelector('.cleaningplan-room__title span').innerHTML`);
  console.log('--- escaping --- room title innerHTML:', roomHtml, '| bold elements in page:', await page.eval(`document.querySelectorAll('#cleaningplan-plan b').length`));
  await page.click('[data-action="generate"]');
  await page.waitFor(`document.querySelector('form[data-form="generate"]')`);
  await page.fill('input[name="start_date"]', tomorrow);
  await page.submit('form[data-form="generate"]');
  await page.waitFor(`document.querySelector('.cleaningplan-iteration--open') && !document.querySelector('.cleaningplan-progress')`, { label: 'generated', timeout: 30000 });
  const tasks = (await apiGet(page, '/tasks?tag=cleaningplan')).data.filter((t) => t.status !== 'done');
  console.log('task titles in Yuvomi:', [...new Set(tasks.map((t) => t.title))].join(' || '));
  console.log('todo title innerHTML:', await page.eval(`document.querySelector('.cleaningplan-todo .list-row__name').innerHTML`));
  await page.shot(`${shotDir}/t9-2-escaping.png`);
  // tidy: delete the iteration (removes the open tasks), rename the room back
  await page.click('[data-action="delete-iteration"]');
  await page.waitFor(`document.querySelectorAll('.cleaningplan-iteration').length === 0`, { timeout: 30000 });
  await page.click('.cleaningplan-room [data-action="edit-room"]');
  await page.waitFor(`document.querySelector('form[data-form="room"]')`);
  await page.fill('form[data-form="room"] input[name="name"]', 'Kitchen');
  await page.submit('form[data-form="room"]');
  await page.waitFor(`!document.querySelector('form[data-form="room"]')`);
  console.log('tasks left tagged cleaningplan:', (await apiGet(page, '/tasks?tag=cleaningplan')).data.map((t) => `${t.title} ${t.status}`).join('; '));
  console.log('--- errors ---'); console.log(page.errors.length ? page.errors.join('\n') : '(none)');
});

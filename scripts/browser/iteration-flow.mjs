import { withBrowser, ORIGIN } from './cdp.mjs';
const [jar, shotDir] = process.argv.slice(2);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const apiGet = (page, path) => page.eval(`fetch('/api/v1${path}', { credentials: 'same-origin' }).then(r => r.json())`);
const apiPatch = (page, path, body) => page.eval(`import('/api.js').then(m => m.api.patch(${JSON.stringify(path)}, ${JSON.stringify(body)}))`);
const noProgress = `!document.querySelector('.cleaningplan-progress')`;

await withBrowser(jar, async (page) => {
  await page.goto(`${ORIGIN}/m/cleaningplan`);
  await page.waitFor(`document.querySelectorAll('.cleaningplan-activity').length >= 2`, { label: 'plan with activities' });
  const iterationsBefore = await page.eval(`document.querySelectorAll('.cleaningplan-iteration').length`);
  await page.waitFor(`document.querySelector('#cleaningplan-iterations .page-section')`, { label: 'iterations section' });
  console.log('--- iterations before ---'); console.log(await page.text('#cleaningplan-iterations'));

  // 0. room selection: generate for the first room only, check every to-do names it, delete again
  await page.click('[data-action="generate"]');
  await page.waitFor(`document.querySelector('form[data-form="generate"]')`);
  const roomBoxes = await page.eval(`document.querySelectorAll('input[name="room_ids"]').length`);
  if (roomBoxes > 1) {
    await page.eval(`(() => { [...document.querySelectorAll('input[name="room_ids"]')].slice(1).forEach((b) => { b.checked = false; }); return true; })()`);
    await page.submit('form[data-form="generate"]');
    await page.waitFor(`document.querySelector('.cleaningplan-iteration--open') && ${noProgress}`, { label: 'room-limited iteration', timeout: 30000 });
    const rowText = await page.eval(`document.querySelector('.cleaningplan-iteration--open').innerText`);
    const roomsNamed = await page.eval(`[...new Set([...document.querySelectorAll('.cleaningplan-todo .list-row__name')].map((n) => n.innerText.split(':')[0]))]`);
    console.log('--- room-limited --- row:', rowText.replace(/\n/g, ' | '), '| rooms in to-dos:', roomsNamed.join(','));
    await page.click('[data-action="delete-iteration"]');
    await page.waitFor(`document.querySelectorAll('.cleaningplan-iteration').length === ${iterationsBefore}`, { label: 'room-limited iteration deleted', timeout: 30000 });
  } else {
    await page.click('[data-action="cancel-generate"]');
    console.log('--- room-limited --- skipped (one room only)');
  }

  // 1. generate a 7-day iteration starting tomorrow
  await page.click('[data-action="generate"]');
  await page.waitFor(`document.querySelector('form[data-form="generate"]')`);
  console.log('default start =', await page.eval(`document.querySelector('input[name="start_date"]').value`), 'tomorrow =', tomorrow);
  await page.fill('input[name="tags"]', 'week-46, Deep Clean');
  await page.submit('form[data-form="generate"]');
  await page.waitFor(`document.querySelector('.cleaningplan-iteration--open') && ${noProgress}`, { label: 'iteration generated and open', timeout: 30000 });
  console.log('--- after generate ---'); console.log(await page.text('#cleaningplan-iterations'));
  await page.shot(`${shotDir}/t8-1-generated.png`);

  const itId = await page.eval(`Number(document.querySelector('.cleaningplan-iteration--open').dataset.iterationId)`);
  const tasks = (await apiGet(page, `/tasks?tag=${encodeURIComponent('cleaningplan:' + itId)}`)).data;
  console.log('--- yuvomi tasks ---', tasks.length, 'tasks; category', [...new Set(tasks.map((t) => t.category))].join(','));
  for (const t of tasks.sort((a, b) => (a.due_date + (a.due_time || '')).localeCompare(b.due_date + (b.due_time || '')))) console.log(` ${t.due_date} ${t.due_time || '     '} ${t.title.padEnd(26)} assigned=${t.assigned_to} tags=${t.tags.join('|')} points=${t.points}`);
  console.log('tasks carrying week-46:', tasks.filter((t) => t.tags.includes('week-46')).length, 'of', tasks.length);
  const cats = (await apiGet(page, '/tasks/categories')).data;
  console.log('category row:', JSON.stringify(cats.find((c) => c.key === tasks[0].category)));

  // 2. tick one off naming Kim, reopen the iteration, see "done by Kim"
  const vac = tasks.find((t) => t.title === 'Kitchen: Vacuum') || tasks[0];
  await apiPatch(page, `/tasks/${vac.id}/status`, { status: 'done', done_by_user_id: 3 });
  await page.click('[data-action="open-iteration"]'); // close
  await page.waitFor(`!document.querySelector('.cleaningplan-iteration--open')`);
  await page.click('[data-action="open-iteration"]'); // reopen (refetch)
  await page.waitFor(`document.querySelector('.cleaningplan-todo--done')`, { label: 'a done todo' });
  const doneText = await page.eval(`document.querySelector('.cleaningplan-todo--done').innerText`);
  console.log('--- done row ---', doneText.replace(/\n/g, ' | '));
  console.log('--- counts row ---', (await page.eval(`document.querySelector('.cleaningplan-iteration--open').innerText`)).replace(/\n/g, ' | '));
  console.log('url =', await page.eval('location.search'));
  await page.shot(`${shotDir}/t8-2-done.png`);

  // 3. generate again over the same window -> 0 to-dos, then delete that empty newest one
  await page.click('[data-action="generate"]');
  await page.waitFor(`document.querySelector('form[data-form="generate"]')`);
  await page.fill('input[name="start_date"]', tomorrow);
  await page.submit('form[data-form="generate"]');
  await page.waitFor(`document.querySelectorAll('.cleaningplan-iteration').length === ${iterationsBefore + 2} && ${noProgress}`, { label: 'second iteration', timeout: 30000 });
  console.log('--- after second generate ---'); console.log((await page.text('#cleaningplan-iterations')).split('\n').slice(0, 8).join('\n'));
  const tasksAfter = (await apiGet(page, '/tasks?tag=cleaningplan')).data;
  console.log('tasks tagged cleaningplan now:', tasksAfter.length);
  await page.click('[data-action="delete-iteration"]');
  await page.waitFor(`document.querySelectorAll('.cleaningplan-iteration').length === ${iterationsBefore + 1}`, { label: 'empty iteration deleted' });

  // 4. delete the real iteration: open tasks gone, the done one stays, next_due restored
  await page.click('[data-action="open-iteration"]');
  await page.waitFor(`document.querySelector('[data-action="delete-iteration"]')`);
  await page.click('[data-action="delete-iteration"]');
  await page.waitFor(`document.querySelectorAll('.cleaningplan-iteration').length === ${iterationsBefore}`, { label: 'iteration deleted', timeout: 30000 });
  const remaining = (await apiGet(page, '/tasks?tag=cleaningplan')).data;
  console.log('--- after delete --- remaining tasks:', remaining.map((t) => `${t.title} ${t.status}`).join('; '));
  console.log('plan after delete:'); console.log(await page.text('#cleaningplan-plan'));
  console.log('dialogs:', page.dialogs.length);
  console.log('--- errors ---'); console.log(page.errors.length ? page.errors.join('\n') : '(none)');
});

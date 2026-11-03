import { withBrowser, ORIGIN } from './cdp.mjs';
const [jar, shotDir] = process.argv.slice(2);
await withBrowser(jar, async (page) => {
  await page.goto(`${ORIGIN}/m/cleaningplan`);
  await page.waitFor(`document.querySelector('#cleaningplan-plan .page-section')`, { label: 'plan section' });
  console.log('--- initial ---'); console.log(await page.text('#cleaningplan-plan'));
  await page.shot(`${shotDir}/t7-1-empty.png`);

  // clean slate: delete only the room this script creates (exercises the delete + confirm path)
  const ownRoom = `[...document.querySelectorAll('.cleaningplan-room')].find((r) => r.querySelector('.cleaningplan-room__title span')?.textContent === 'Kitchen')`;
  while (await page.eval(`Boolean(${ownRoom})`)) {
    await page.eval(`(() => { ${ownRoom}.querySelector('[data-action="edit-room"]').click(); return true; })()`);
    await page.waitFor(`document.querySelector('[data-action="delete-room"]')`);
    const n = await page.eval(`document.querySelectorAll('.cleaningplan-room').length`);
    await page.click('[data-action="delete-room"]');
    await page.waitFor(`document.querySelectorAll('.cleaningplan-room').length === ${n - 1}`, { label: 'room deleted' });
  }
  console.log('--- dialogs so far ---', page.dialogs.join(' | ') || '(none)');
  await page.click('[data-action="add-room"]');
  await page.waitFor(`document.querySelector('form[data-form="room"]')`);
  await page.fill('form[data-form="room"] input[name="name"]', 'Kitchen');
  await page.submit('form[data-form="room"]');
  await page.waitFor(`document.querySelector('.cleaningplan-room')`, { label: 'room row' });

  const addActivity = async (values) => {
    await page.click('[data-action="add-activity"]');
    await page.waitFor(`document.querySelector('form[data-form="activity"]')`);
    for (const [name, v] of Object.entries(values).filter(([k]) => !k.startsWith('_'))) await page.fill(`form[data-form="activity"] [name="${name}"]`, v);
    await page.submit('form[data-form="activity"]');
    await page.waitFor(`!document.querySelector('form[data-form="activity"]') && document.querySelectorAll('.cleaningplan-activity').length === ${values._expect}`, { label: `activity count ${values._expect}` });
  };
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await addActivity({ name: 'Wipe counters', interval_value: '1', interval_unit: 'days', first_due: tomorrow, _expect: 1 });
  await addActivity({ name: 'Vacuum', interval_value: '2', interval_unit: 'days', default_assignee_id: '2', target_time: '18:00', first_due: tomorrow, _expect: 2 });
  console.log('--- after adding ---'); console.log(await page.text('#cleaningplan-plan'));

  // edit the first activity's name and confirm it survives a reload
  await page.click('.cleaningplan-activity [data-action="edit-activity"]');
  await page.waitFor(`document.querySelector('form[data-form="activity"] [name="active"]')`);
  await page.fill('form[data-form="activity"] [name="name"]', 'Wipe counters & sink');
  await page.submit('form[data-form="activity"]');
  await page.waitFor(`!document.querySelector('form[data-form="activity"]')`);
  await page.goto(`${ORIGIN}/m/cleaningplan`);
  await page.waitFor(`document.querySelectorAll('.cleaningplan-activity').length === 2`, { label: '2 activities after reload' });
  console.log('--- after reload ---'); console.log(await page.text('#cleaningplan-plan'));
  await page.shot(`${shotDir}/t7-2-plan.png`);
  console.log('--- nav entry ---', await page.eval(`[...document.querySelectorAll('a[href="/m/cleaningplan"]')].map(a => a.innerText.trim()).join('|')`));
  console.log('--- errors ---'); console.log(page.errors.length ? page.errors.join('\n') : '(none)');
});

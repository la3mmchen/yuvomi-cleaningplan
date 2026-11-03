import { withBrowser, ORIGIN } from './cdp.mjs';
const [jar, shotDir] = process.argv.slice(2);
await withBrowser(jar, async (page) => {
  await page.goto(`${ORIGIN}/m/cleaningplan`);
  await page.waitFor(`document.querySelector('#cleaningplan-plan .page-section')`, { label: 'plan section' });
  console.log('--- read-only page ---'); console.log(await page.text('.app-page__body'));
  console.log('controls present:', await page.eval(`document.querySelectorAll('#cleaningplan-plan [data-action]').length`));
  console.log('hint hidden:', await page.eval(`document.querySelector('#cleaningplan-readonly').hidden`));
  await page.shot(`${shotDir}/t7-3-readonly.png`);
  console.log('--- errors ---'); console.log(page.errors.length ? page.errors.join('\n') : '(none)');
});

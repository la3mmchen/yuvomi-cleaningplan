// `node --import ./test/module/register.mjs --test …` maps the absolute
// browser imports (/i18n.js, /utils/…) the module uses to small stubs, so render
// functions that return HTML strings can be tested without a browser.
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);

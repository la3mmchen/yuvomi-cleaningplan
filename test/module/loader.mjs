const STUBS = new URL('./stubs/', import.meta.url);
const MAP = {
  '/i18n.js': 'i18n.js',
  '/api.js': 'api.js',
  '/utils/html.js': 'html.js',
};
export async function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: new URL(MAP[specifier], STUBS).href, shortCircuit: true };
  return next(specifier, context);
}

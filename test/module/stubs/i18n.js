// t() stub: returns the key, with params appended so tests can see interpolation.
export function t(key, params) {
  if (!params || !Object.keys(params).length) return key;
  return `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})`;
}

// Page and empty-state markup built from Yuvomi's documented CSS classes.
// Since 2.93.0 Yuvomi ships bundled and a module may import only /api.js,
// /i18n.js and /utils/html.js (MODULES.md); /utils/page-layout.js and
// /utils/empty-state.js have no address any more. These helpers produce the
// same markup those did, for the options this module uses.

import { esc } from '/utils/html.js';

const cls = (...names) => names.filter(Boolean).join(' ');
const idAttr = (id) => (id ? ` id="${esc(id)}"` : '');

// Slot contents (title, content) are markup the caller has already escaped.
export const renderPageTitle = (text) => `<h1 class="page-toolbar__title">${text}</h1>`;

export const renderPageHeader = ({ title = '' } = {}) =>
  `<div class="page-toolbar page-toolbar--narrow">\n${title}\n</div>`;

export const renderPageBody = ({ content = '' } = {}) =>
  `<div class="app-page__body">\n${content}\n</div>`;

export const renderPageSection = ({ className = '', content = '', id = '' } = {}) =>
  `<section class="${cls('page-section', 'page-measure', esc(className))}"${idAttr(id)}>\n${content}\n</section>`;

export const renderListSection = ({ className = '', content = '', id = '' } = {}) =>
  renderPageSection({ className: cls('page-section--list', className), content, id });

// Text fields are plain text and escaped here.
export function emptyStateHTML({ icon = 'inbox', title = '', description = '' } = {}) {
  return `<div class="empty-state">`
    + `<i data-lucide="${esc(icon)}" class="empty-state__icon" aria-hidden="true"></i>`
    + (title ? `<h2 class="empty-state__title">${esc(title)}</h2>` : '')
    + (description ? `<p class="empty-state__description">${esc(description)}</p>` : '')
    + `</div>`;
}

function errorDetail(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status > 0) return `HTTP ${status}`;
  if (error instanceof Error && error.message) return `${error.name}: ${error.message}`;
  return '';
}

// Replaces target's content with an error state and a retry button.
export function mountLoadError(target, { title, description = '', error, retryLabel, onRetry } = {}) {
  if (!target) return null;
  const box = document.createElement('div');
  box.className = 'empty-state';
  box.setAttribute('role', 'alert');
  box.insertAdjacentHTML('beforeend',
    `<i data-lucide="triangle-alert" class="empty-state__icon" aria-hidden="true"></i>`
    + `<h2 class="empty-state__title">${esc(title ?? '')}</h2>`
    + (description ? `<p class="empty-state__description">${esc(description)}</p>` : ''));
  const detail = errorDetail(error);
  if (detail) {
    const details = document.createElement('details');
    details.className = 'empty-state__details';
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    const pre = document.createElement('pre');
    pre.textContent = detail;
    details.append(summary, pre);
    box.append(details);
  }
  if (typeof onRetry === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--primary empty-state__cta';
    button.insertAdjacentHTML('afterbegin', '<i data-lucide="refresh-cw" aria-hidden="true" class="icon-md"></i>');
    button.append(document.createTextNode(retryLabel ?? ''));
    button.addEventListener('click', onRetry);
    box.append(button);
  }
  target.replaceChildren(box);
  window.lucide?.createIcons?.({ el: box });
  return box;
}

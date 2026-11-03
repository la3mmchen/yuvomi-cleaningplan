export const emptyStateHTML = ({ title = '', description = '' } = {}) => `<div class="empty-state"><h3>${title}</h3><p>${description}</p></div>`;
export const loadErrorHTML = ({ title = '', description = '', retryLabel = '', action } = {}) => `<div class="empty-state empty-state--error"><h3>${title}</h3><p>${description}</p><button ${attrs(action?.attrs)}>${retryLabel}</button></div>`;
const attrs = (a = {}) => Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ');

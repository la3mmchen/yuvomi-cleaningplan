export const renderPageHeader = ({ title = '', actions = '' } = {}) => `<header class="page-toolbar">${title}${actions}</header>`;
export const renderPageTitle = (text) => `<h1 class="page-toolbar__title">${text}</h1>`;
export const renderPageActions = (content) => `<div class="page-toolbar__actions">${content}</div>`;
export const renderPageBody = ({ content = '', className = '', id = '' } = {}) => `<div class="app-page__body ${className}" id="${id}">${content}</div>`;
export const renderPageSection = ({ content = '', className = '', id = '' } = {}) => `<section class="page-section ${className}" id="${id}">${content}</section>`;
export const renderListSection = ({ content = '', className = '', id = '' } = {}) => `<section class="page-section page-section--list ${className}" id="${id}">${content}</section>`;

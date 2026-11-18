// "All tools" page: one card per tool, grouped like the sidebar.
import { h, ICONS } from './lib.js';
import { TOOLS } from './shell.js';

const root = document.getElementById('home');
let group = null;
for (const t of TOOLS) {
  if (t.group) {
    group = h('div', { class: 'cards' });
    root.append(h('section', { class: 'home-group' }, h('h2', {}, t.group), group));
  } else {
    group.append(h('a', { class: 'card', href: t.href },
      h('span', { class: 'ci', html: ICONS[t.icon] }),
      h('span', {}, h('h3', {}, t.label), h('p', {}, t.desc))));
  }
}

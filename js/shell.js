// Builds the page frame shared by every tool: top bar, sidebar, footer notice.
import { h, ICONS } from './lib.js';

export const TOOLS = [
  { group: 'Organize' },
  { id: 'merge', label: 'Merge', href: 'merge.html', icon: 'merge', desc: 'Combine pages from several PDFs into one, in any order.' },
  { id: 'split', label: 'Split', href: 'split.html', icon: 'split', desc: 'Cut one PDF into several smaller files.' },
  { id: 'rotate', label: 'Rotate', href: 'rotate.html', icon: 'rotate', desc: 'Turn pages that are sideways or upside down.' },
  { id: 'delete', label: 'Delete pages', href: 'delete-pages.html', icon: 'trash', desc: 'Remove pages you don\'t need.' },
  { id: 'extract', label: 'Extract pages', href: 'extract-pages.html', icon: 'extract', desc: 'Save selected pages as a new PDF.' },
  { group: 'Optimize & convert' },
  { id: 'compress', label: 'Compress', href: 'compress.html', icon: 'compress', desc: 'Make a PDF smaller so it\'s easier to email or upload.' },
  { id: 'pdf-to-image', label: 'PDF to image', href: 'pdf-to-image.html', icon: 'image', desc: 'Save PDF pages as JPG or PNG pictures.' },
  { id: 'image-to-pdf', label: 'Image to PDF', href: 'image-to-pdf.html', icon: 'toPdf', desc: 'Turn photos and scans into one PDF.' },
  { id: 'ocr', label: 'OCR (make searchable)', href: 'ocr.html', icon: 'ocr', desc: 'Recognize text in scanned PDFs so you can search and copy it.' },
  { group: 'Edit & sign' },
  { id: 'edit', label: 'Edit', href: 'edit.html', icon: 'edit', desc: 'Add text, drawings, highlights, shapes, images, redactions and watermarks.' },
  { id: 'sign', label: 'Sign', href: 'sign.html', icon: 'sign', desc: 'Draw, type or upload your signature and place it on a PDF.' },
];

const current = document.body.dataset.tool || 'home';

function sidebar() {
  const nav = h('nav', { class: 'sidebar', 'aria-label': 'Tools' });
  nav.append(link({ id: 'home', label: 'All tools', href: './', icon: 'home' }));
  for (const t of TOOLS) {
    if (t.group) nav.append(h('div', { class: 'nav-group' }, t.group));
    else nav.append(link(t));
  }
  return nav;
}

function link(t) {
  const active = t.id === current;
  return h('a', {
    class: 'nav-link' + (active ? ' active' : ''),
    href: t.href,
    'aria-current': active ? 'page' : null,
  }, h('span', { class: 'nav-icon', html: ICONS[t.icon] }), h('span', { class: 'nav-label' }, t.label));
}

function topbar() {
  const tool = TOOLS.find((t) => t.id === current);
  return h('header', { class: 'topbar' },
    h('div', { class: 'topbar-inner' },
      h('a', { class: 'brand', href: './', title: 'All tools' },
        h('img', { class: 'brand-logo', src: 'assets/logo-full.png', alt: 'Star Sleep & Wellness', width: 129, height: 44 })),
      h('span', { class: 'tool-name' }, tool ? tool.label : 'PDF Tools'),
    ));
}

function footer() {
  const block = (icon, tone, title, text, action) => h('div', { class: `foot-block ${tone}` },
    h('span', { class: 'foot-icon', html: ICONS[icon] }),
    h('div', { class: 'foot-text' }, h('h2', {}, title), h('p', {}, text)),
    action);

  return h('footer', { class: 'foot' },
    h('div', { class: 'foot-inner' },
      block('shield', 'fb-privacy', 'Privacy by design',
        'Your files stay securely on your computer—no uploads, no accounts, and no tracking.',
        h('a', {
          href: './#privacy', class: 'foot-btn privacy-link', 'aria-controls': 'privacy', 'aria-expanded': 'false', onclick: togglePrivacy,
        }, h('span', { class: 'privacy-link-label' }, 'How this works'), h('span', { class: 'chev', html: ICONS.chevron }))),
      block('lock', 'fb-internal', 'For internal use only',
        'Please do not use or release this tool to the public. For any issues or concerns, reach out to the SDA Team.',
        h('a', { href: 'mailto:integrations@stswell.com', class: 'foot-btn' },
          h('span', { html: ICONS.mail }), 'integrations@stswell.com')),
    ),
    h('p', { class: 'foot-copy' },
      h('img', { src: 'assets/logo.png', alt: '', width: 20, height: 19 }),
      `© ${new Date().getFullYear()} Star Sleep & Wellness · Internal PDF Tools`),
  );
}

/**
 * The privacy details on the home page start hidden. The footer link opens them
 * (scrolling to them and flashing them), and closes them again on a second click.
 * On other pages the link simply goes to the home page, which opens them.
 */
function togglePrivacy(e) {
  const target = document.getElementById('privacy');
  if (!target) return;
  e.preventDefault();
  if (target.hidden) openPrivacy(target);
  else closePrivacy(target);
}

function openPrivacy(target) {
  target.hidden = false;
  history.replaceState(null, '', '#privacy');
  setLink(true);
  target.scrollIntoView();
  flash(target);
}

function closePrivacy(target) {
  target.hidden = true;
  history.replaceState(null, '', location.pathname);
  setLink(false);
}

function setLink(open) {
  const a = document.querySelector('.privacy-link');
  if (!a) return;
  a.querySelector('.privacy-link-label').textContent = open ? 'Hide details' : 'How this works';
  a.setAttribute('aria-expanded', String(open));
}

function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
}

// Move the page's own content into the frame.
const content = h('div', { class: 'content' });
for (const node of [...document.body.childNodes]) {
  if (node.nodeName === 'SCRIPT' || node.classList?.contains('file-overlay')) continue;
  content.append(node);
}
content.append(footer());
document.body.prepend(topbar(), h('div', { class: 'layout' }, sidebar(), content));
if (!document.querySelector('.file-overlay')) {
  document.body.append(h('div', { class: 'file-overlay', 'aria-hidden': 'true' }, h('div', {}, 'Drop files to add them')));
}
document.title = `${TOOLS.find((t) => t.id === current)?.label ?? 'PDF Tools'} · Star Sleep & Wellness`;

// Moving the content into the frame cancels the browser's jump to #section links; redo it.
// Wait for 'load' so page scripts (e.g. the home page cards) have filled in first.
if (location.hash.length > 1) {
  window.addEventListener('load', () => {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (!target) return;
    if (target.id === 'privacy') openPrivacy(target);
    else target.scrollIntoView();
  }, { once: true });
}

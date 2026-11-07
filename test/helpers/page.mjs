// Runs the real src/main.js against a minimal stand-in for the browser, so a
// test can read the markup the page draws and drive it through the same
// delegated listeners the athlete's taps reach. Not a DOM: elements are plain
// objects, and #app's innerHTML is only ever read back as a string. Each
// openPage() imports a fresh copy of main.js; pass the same `storage` to
// reopen a workout the way a reload would.

let runs = 0;

const b64url = s => Buffer.from(s, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function element(id) {
  const listeners = {};
  return {
    id, innerHTML: '', textContent: '', value: '', hidden: false, dataset: {}, childNodes: [],
    classList: { toggle() {}, add() {}, remove() {} },
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelector: () => null,
    focus() {}, setAttribute() {}, click() {}
  };
}

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

const settle = () => new Promise(r => setTimeout(r, 0));

export async function openPage(wod, { storage = new Map() } = {}) {
  const els = new Map();
  const el = id => { if (!els.has(id)) els.set(id, element(id)); return els.get(id); };
  const matchMedia = () => ({ matches: false });

  define('document', {
    getElementById: el, addEventListener() {}, querySelectorAll: () => [],
    activeElement: null, visibilityState: 'visible', createElement: () => element('a')
  });
  define('window', { addEventListener() {}, matchMedia });
  define('matchMedia', matchMedia);
  define('localStorage', {
    getItem: k => storage.has(k) ? storage.get(k) : null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k)
  });
  define('location', { hash: '#wj=' + b64url(JSON.stringify(wod)), search: '', origin: 'http://localhost', pathname: '/' });

  await import(`../../src/main.js?page=${++runs}`);
  await settle();

  const app = el('app');
  const fire = (node, type, target) => (node.listeners[type] || []).forEach(fn => fn({ target, preventDefault() {} }));

  return {
    storage,
    html: () => app.innerHTML,
    /** A checkbox change, as the page's change delegate sees it. */
    tick(data, checked) {
      fire(app, 'change', { id: '', value: '', checked, dataset: data, classList: { toggle() {} } });
    },
    /** Opens the submit sheet and returns the digest it shows. */
    digest() {
      fire(app, 'click', { id: 'log', closest: () => null });
      return el('digest').textContent;
    },
    /** The result JSON the Download button would save. */
    async result() {
      this.digest();
      let blob = null;
      const { createObjectURL, revokeObjectURL } = URL;
      URL.createObjectURL = b => { blob = b; return 'blob:test'; };
      URL.revokeObjectURL = () => {};
      try {
        await Promise.all((el('scrim').listeners.click || []).map(fn =>
          fn({ target: { id: '', closest: () => ({ dataset: { sink: 'download' } }) } })));
      } finally {
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
      }
      return JSON.parse(await blob.text());
    }
  };
}

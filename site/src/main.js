/* Single entry point for every page.

   Each page declares what it needs on <body data-features="...">. Controllers are imported
   on demand, so a chapter page only downloads the code for its own figures, and Three.js
   loads only on pages with a 3D scene. */
import './styles/tokens.css';
import './styles/components.css';
import './styles/site.css';
import { setupShell } from './core/shell.js';
import { showError } from './core/common.js';

const ORDER = ['viewer', 'lab', 'theory', 'advanced', 'scenes'];
const NEEDS_PHANTOM = new Set(['viewer', 'lab', 'advanced', 'scenes']);
const LOADERS = {
  viewer: () => import('./ui/viewer.js'),
  lab: () => import('./ui/lab.js'),
  theory: () => import('./ui/theory.js'),
  advanced: () => import('./ui/advanced.js'),
  scenes: () => import('./ui/scenes.js'),
};

async function start() {
  setupShell();
  const features = (document.body.dataset.features || '').split(/\s+/).filter(Boolean);
  if (!features.length) return;
  // The theory chapters need the phantom only for the attenuation and TOF reconstructions.
  const wantsPhantom =
    features.some((f) => NEEDS_PHANTOM.has(f)) ||
    (features.includes('theory') && (document.getElementById('acOn') || document.getElementById('tofConvergence')));
  let phantom = null;
  if (wantsPhantom) {
    try {
      const { loadPhantom } = await import('./core/phantom.js');
      phantom = await loadPhantom();
    } catch (e) {
      showError('The synthetic phantom could not load. ' + e.message + ' Analytic figures still work.');
      console.error(e);
    }
  }
  for (const name of ORDER) {
    if (!features.includes(name)) continue;
    if (NEEDS_PHANTOM.has(name) && !phantom) continue;
    try {
      const module = await LOADERS[name]();
      module.init(phantom);
    } catch (e) {
      showError('Part of this page could not start: ' + e.message);
      console.error(e);
    }
  }
}

start();

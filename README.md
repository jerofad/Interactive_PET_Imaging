# From Decay to Voxel

An interactive, multi-page guide to the positron emission tomography (PET) pipeline. It runs ten chapters in pipeline order, from tracer to artifacts, plus three labs and a reference section. Every figure is computed in the browser from a synthetic brain phantom.

The site was migrated from the single-file notebook `index.html` at the project root. That file is kept unchanged as a reference. The site no longer uses it.

## Quick start

Requires Node.js 18.18 or newer.

```bash
npm install
npm run dev        # local server with hot reload
npm test           # unit tests for the physics models and reconstruction engine
npm run build      # static site in dist/
npm run test:e2e   # opens every built page in Chrome and checks it (needs Google Chrome)
```

Set `CHROME_PATH` if Chrome is not at `/usr/bin/google-chrome`. Set `SCREENSHOTS=1` to save screenshots of every page at 375, 768 and 1440 px, in light and dark themes, to `test-results/`.

## Structure

```
site/                      Vite root; each folder with an index.html is one page
  index.html               landing page
  1-tracers/ … 10-artifacts/   chapters in pipeline order
  labs/scanner/            all four 3D scenes with every setting
  labs/reconstruction/     count sweep and reconstruction lab
  labs/viewer/             tri-planar phantom viewer and rotating MIP
  reference/               trade-offs, glossary, model notes and sources
  og-image.png             social preview image (used when SITE_URL is set)
  src/
    main.js                single entry; loads only the controllers a page declares
    core/                  shared helpers, chart, phantom loader, page shell
    models/                pure physics and reconstruction models (unit tested)
    workers/               Web Workers for the heavy computations
    ui/                    one controller per interactive family
    data/                  phantom (gzip, ~100 KB), phantom metadata, glossary
    styles/                tokens.css (themes), components.css, site.css
tests/unit/                Vitest tests
tests/e2e/smoke.mjs        browser smoke test of the built site
```

### How a page declares its interactives

Each page sets `<body data-features="...">`. The features are `lab`, `theory`, `advanced`, `scenes` and `viewer`. `main.js` imports only those controllers. It downloads the phantom only when a feature needs it, and Three.js only when the page contains a 3D scene.

Controllers find elements by id through `$` in `core/common.js`. If a page leaves out part of a controller's interface, `$` returns a detached copy of the original element with its default value. This is how a chapter can show only a few of the scanner settings. When you add an element with a new id that a controller reads, add a default entry for it to `core/registry.json`.

### Editing content

The page HTML files are the source. Edit them directly. Conventions:

- **Glossary links.** A term link is `<a class="term" data-term="lor" href="../reference/#g-lor">`, and it shows the definition from `src/data/glossary.json` on hover and focus. Add new terms to that file and to the glossary list on the reference page.
- **Model caveats.** Long caveats go in `<details class="assumptions">` so the main text stays readable.
- **Links.** Use relative links between pages, such as `../5-data/`. The build then works at any URL path.

## Deployment

`npm run build` writes a static site to `dist/`. The build uses relative asset paths, so the same output works at a domain root or in any subfolder of an existing website. Copy `dist/` to the server.

The live site is at https://jerryfadugba.com/pet/. Netlify builds it from `main` using `netlify.toml`, and the main site proxies `/pet/*` to it. GitHub Actions only runs the tests.

Optional environment variables at build time:

| Variable | Effect |
|---|---|
| `SITE_URL` | Absolute URL of the site, such as `https://example.com/pet/`. Adds canonical links, `og:url`, `og:image`, `sitemap.xml` and a `robots.txt` that points to the sitemap. |
| `BASE_PATH` | Overrides the relative base, for example `/pet/`. Usually not needed. |

**GitHub Pages.** `.github/workflows/deploy.yml` runs the unit tests, builds, runs the browser smoke test and deploys on every push to `main`. In the repository settings, choose GitHub Actions as the Pages source. Then set the repository variable `SITE_URL` to the public URL.

**Content Security Policy.** Each built page carries a strict policy as a meta tag. It allows scripts only from the site itself plus the hash of the inline theme script, and it allows no third-party origins. If your host adds its own policy header, it must allow `worker-src 'self'`, because the reconstructions run in Web Workers.

## Models and limits

The models are teaching approximations, not scanner specifications or clinical guidance. The reference page lists the assumptions and sources. The unit tests pin the key numbers:

- noiseless cylinder recovery for MLEM, OSEM and FBP, and the projector adjoint
- point-source localisation and Poisson sampling
- half-lives and positron fractions, Compton kinematics and NECR
- TOF localisation, the HU to μ mapping, and the sphere recovery formula
- SUV units and the material-specific detector attenuation

## Performance

The landing page, chapters and reconstruction lab score 98 to 100 in Lighthouse for performance, accessibility, best practices and SEO. The scanner lab scores lower on performance, because it builds up to four WebGL scenes. Each scene is created only when it scrolls near the viewport.

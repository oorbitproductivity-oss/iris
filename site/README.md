# Iris Code — marketing site

Static marketing site for **Iris Code**. Pure HTML + CSS + a tiny bit of vanilla JS. No build step, no npm, no frameworks.

## Preview locally

Open `site/index.html` in any browser — double-click works on Windows. The site is self-contained inside `site/` (the icon lives at `site/assets/iris-icon.png`), so it can be served from the `site/` folder directly. The download buttons point at `/download/win-x64` and `/download/win-arm64`, which are wired through `_redirects` to the actual hosted installer URLs once deployed — locally those will 404 unless you swap them for the file paths in `dist/`.

## File tree

```
site/
├── index.html          # Landing
├── product.html        # Features deep dive + roadmap
├── download.html       # Download + install + changelog
├── docs.html           # Long-form documentation
├── robots.txt
├── README.md
├── css/
│   ├── site.css        # Design tokens + base + shared components
│   └── pages.css       # Page-specific layouts
└── js/
    └── site.js         # Mobile nav, smooth-scroll, reveal-on-scroll, docs TOC
```

The brand mark and favicon live at `assets/iris-icon.png` (copied from `../app/assets/iris-icon.png`), so the published site has no `../` parent escapes.

## Deploy

Push the `site/` folder to any static host:

- **GitHub Pages** — set Pages source to the `site/` folder on the default branch.
- **Netlify** — drag-and-drop the `site/` folder into the Netlify dashboard, or point at the repo with publish directory `site`.
- **Cloudflare Pages** — same setup, publish directory `site`.

No build command is required.

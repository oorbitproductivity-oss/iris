/* Iris Code — marketing site JS */
(function () {
  'use strict';

  // -- Mobile nav toggle --------------------------------------------------
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    links.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') {
        links.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // -- Smooth-scroll for in-page anchors ----------------------------------
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (id.length > 1) {
        const target = document.querySelector(id);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          history.replaceState(null, '', id);
        }
      }
    });
  });

  // -- Reveal on scroll ---------------------------------------------------
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && reveals.length) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('is-visible'));
  }

  // -- Docs mobile TOC ----------------------------------------------------
  const tocSelect = document.querySelector('.docs-toc-mobile select');
  if (tocSelect) {
    tocSelect.addEventListener('change', () => {
      const id = tocSelect.value;
      if (id) {
        const target = document.querySelector(id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  // -- Inject "Share with a friend" CTA above the footer bottom ----------
  // Skipped on share.html itself (the whole page is the share UI).
  const footer = document.querySelector('.site-footer .container');
  const onSharePage = /\/share\.html?$/.test(location.pathname) || document.title.includes('Share');
  if (footer && !onSharePage) {
    const bar = document.createElement('div');
    bar.className = 'share-bar';
    bar.innerHTML =
      '<span class="share-bar__copy">Like Iris Code? Tell someone.</span>' +
      '<a class="btn btn--primary" href="share.html">Share this with a friend</a>';
    const bottom = footer.querySelector('.footer-bottom, .footer-meta');
    if (bottom) footer.insertBefore(bar, bottom);
    else footer.appendChild(bar);
  }

  // -- Highlight current docs section in TOC ------------------------------
  const docsContent = document.querySelector('.docs-content');
  const tocLinks = document.querySelectorAll('.docs-toc a');
  if (docsContent && tocLinks.length && 'IntersectionObserver' in window) {
    const headings = docsContent.querySelectorAll('h2[id]');
    const tocMap = new Map();
    tocLinks.forEach((a) => {
      const href = a.getAttribute('href');
      if (href && href.startsWith('#')) tocMap.set(href.slice(1), a);
    });
    const setActive = (id) => {
      tocLinks.forEach((a) => a.classList.remove('active'));
      const a = tocMap.get(id);
      if (a) a.classList.add('active');
    };
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(e.target.id);
        });
      },
      { rootMargin: '-100px 0px -60% 0px' }
    );
    headings.forEach((h) => obs.observe(h));
  }
})();

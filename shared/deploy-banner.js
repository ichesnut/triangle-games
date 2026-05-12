// Renders a small banner at the top of every page showing the most recent
// deploy timestamp. The info icon reveals a tooltip listing the changes
// included in that deploy. Data comes from /deploy-info.json, generated at
// build time by scripts/generate-deploy-info.mjs.

const STYLE = `
  .deploy-banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    /* env(safe-area-inset-top) keeps the banner clear of the iOS status bar
       and Dynamic Island when running as a standalone PWA. */
    padding: calc(0.3rem + env(safe-area-inset-top)) 0.75rem 0.3rem;
    background: rgba(15, 22, 46, 0.92);
    color: #cfd3e0;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 0.75rem;
    line-height: 1.2;
    border-bottom: 1px solid #2a3050;
    box-sizing: border-box;
    -webkit-backdrop-filter: blur(4px);
    backdrop-filter: blur(4px);
  }
  .deploy-banner-spacer {
    height: calc(28px + env(safe-area-inset-top));
    flex: 0 0 calc(28px + env(safe-area-inset-top));
  }
  .deploy-banner .deploy-label { color: #8a90a8; }
  .deploy-banner .deploy-time { color: #eee; font-weight: 600; }
  .deploy-banner .deploy-info-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    /* Reserve a 44x44 tap target around the visual icon without changing
       layout. The button itself stays 18px; ::before extends the hit area. */
    width: 44px;
    height: 44px;
    justify-content: center;
    margin: -13px 0;
  }
  .deploy-banner .deploy-info-btn {
    appearance: none;
    background: transparent;
    border: 1px solid #3a4070;
    color: #cfd3e0;
    width: 18px;
    height: 18px;
    min-width: 18px;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
    position: relative;
  }
  .deploy-banner .deploy-info-btn::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 44px;
    height: 44px;
    transform: translate(-50%, -50%);
  }
  .deploy-banner .deploy-info-btn:hover,
  .deploy-banner .deploy-info-btn:focus-visible {
    color: #fff;
    border-color: #e94560;
    outline: none;
  }
  .deploy-banner .deploy-tooltip {
    position: absolute;
    top: calc(100% - 8px);
    right: 0;
    min-width: 240px;
    max-width: min(360px, calc(100vw - 1rem));
    background: #16213e;
    color: #eee;
    border: 1px solid #2a3050;
    border-radius: 10px;
    padding: 0.6rem 0.75rem;
    font-size: 0.78rem;
    line-height: 1.35;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    display: none;
    text-align: left;
  }
  .deploy-banner .deploy-tooltip.open { display: block; }
  .deploy-banner .deploy-tooltip-title {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #8a90a8;
    margin-bottom: 0.4rem;
    font-weight: 700;
  }
  .deploy-banner .deploy-tooltip ul {
    margin: 0;
    padding-left: 1.1rem;
  }
  .deploy-banner .deploy-tooltip li {
    margin-bottom: 0.2rem;
    word-break: break-word;
  }
  .deploy-banner .deploy-tooltip li:last-child { margin-bottom: 0; }
  .deploy-banner .deploy-tooltip .deploy-empty {
    color: #8a90a8;
    font-style: italic;
  }
  .deploy-banner .deploy-tooltip .deploy-commit {
    margin-top: 0.4rem;
    padding-top: 0.4rem;
    border-top: 1px solid #2a3050;
    color: #8a90a8;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.72rem;
  }
`;

function formatDeployTime(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const date = d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${date} at ${time}`;
}

function renderBanner(info) {
  if (document.getElementById('deploy-banner')) return;

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const banner = document.createElement('div');
  banner.id = 'deploy-banner';
  banner.className = 'deploy-banner';

  const label = document.createElement('span');
  label.className = 'deploy-label';
  label.textContent = 'Deployed';

  const time = document.createElement('span');
  time.className = 'deploy-time';
  time.textContent = formatDeployTime(info.deployedAt);
  if (info.deployedAt) time.title = info.deployedAt;

  const wrap = document.createElement('span');
  wrap.className = 'deploy-info-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'deploy-info-btn';
  btn.textContent = 'i';
  btn.setAttribute('aria-label', 'Show deploy changes');
  btn.setAttribute('aria-expanded', 'false');

  const tip = document.createElement('div');
  tip.className = 'deploy-tooltip';
  tip.setAttribute('role', 'tooltip');

  const tipTitle = document.createElement('div');
  tipTitle.className = 'deploy-tooltip-title';
  tipTitle.textContent = 'Changes in this deploy';
  tip.appendChild(tipTitle);

  if (Array.isArray(info.changes) && info.changes.length > 0) {
    const ul = document.createElement('ul');
    for (const change of info.changes) {
      const li = document.createElement('li');
      li.textContent = change;
      ul.appendChild(li);
    }
    tip.appendChild(ul);
  } else {
    const empty = document.createElement('div');
    empty.className = 'deploy-empty';
    empty.textContent = 'No change details available.';
    tip.appendChild(empty);
  }

  if (info.commit) {
    const commit = document.createElement('div');
    commit.className = 'deploy-commit';
    commit.textContent = `commit ${info.commit}`;
    tip.appendChild(commit);
  }

  function open() {
    tip.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  }
  function close() {
    tip.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }

  // Hover-to-open is gated on devices that actually have a hover-capable
  // primary pointer. On touch devices, iOS/Android synthesize a mouseenter
  // immediately before the click, which would race the click toggle and
  // close the tooltip on tap. Touch devices use the click handler only.
  const hoverCapable = typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: hover)').matches;
  if (hoverCapable) {
    wrap.addEventListener('mouseenter', open);
    wrap.addEventListener('mouseleave', close);
  }
  btn.addEventListener('focus', open);
  btn.addEventListener('blur', close);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tip.classList.contains('open')) close(); else open();
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) close();
  });

  wrap.appendChild(btn);
  wrap.appendChild(tip);

  banner.appendChild(label);
  banner.appendChild(time);
  banner.appendChild(wrap);

  const spacer = document.createElement('div');
  spacer.className = 'deploy-banner-spacer';
  document.body.insertBefore(spacer, document.body.firstChild);
  document.body.appendChild(banner);
}

async function init() {
  try {
    const res = await fetch('/deploy-info.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const info = await res.json();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => renderBanner(info));
    } else {
      renderBanner(info);
    }
  } catch {
    // Silently no-op: missing deploy info should not break the page.
  }
}

init();

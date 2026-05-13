// Renders a global "Impersonating <name> · Stop" banner whenever /me reports
// an active impersonator. Sits directly under the deploy-banner spacer so
// the two stack cleanly. Uses an amber accent so it is visually distinct
// from the deploy banner — admins should never confuse "this is what the
// target sees" with build metadata.

const STYLE = `
  .impersonation-banner {
    position: fixed;
    top: calc(28px + env(safe-area-inset-top));
    left: 0;
    right: 0;
    z-index: 9998;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    padding: 0.35rem 0.75rem;
    background: #f5b342;
    color: #1a1a2e;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 0.8rem;
    line-height: 1.2;
    box-sizing: border-box;
    border-bottom: 1px solid #b07a13;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }
  .impersonation-banner .imp-target {
    font-weight: 700;
  }
  .impersonation-banner .imp-stop {
    appearance: none;
    background: #1a1a2e;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 0.35rem 0.75rem;
    font-size: 0.8rem;
    font-weight: 700;
    cursor: pointer;
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
    min-height: 36px;
  }
  .impersonation-banner .imp-stop:hover,
  .impersonation-banner .imp-stop:focus-visible {
    background: #2a2a4e;
    outline: none;
  }
  .impersonation-banner .imp-stop:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .impersonation-banner-spacer {
    height: 44px;
    flex: 0 0 44px;
  }
`;

async function fetchCsrfToken() {
  try {
    const res = await fetch('/api/chesnuts/csrf-token', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.csrfToken || null;
  } catch {
    return null;
  }
}

function renderBanner(impersonator, target) {
  if (document.getElementById('impersonation-banner')) return;

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const banner = document.createElement('div');
  banner.id = 'impersonation-banner';
  banner.className = 'impersonation-banner';

  const label = document.createElement('span');
  label.textContent = 'Impersonating';

  const name = document.createElement('span');
  name.className = 'imp-target';
  name.textContent = target?.displayName || `user #${target?.id ?? ''}`;
  if (impersonator?.displayName) {
    banner.title = `Original session: ${impersonator.displayName}`;
  }

  const sep = document.createElement('span');
  sep.textContent = '·';

  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'imp-stop';
  stop.textContent = 'Stop impersonating';
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try {
      const token = await fetchCsrfToken();
      const res = await fetch('/api/chesnuts/stop-impersonating', {
        method: 'POST',
        credentials: 'same-origin',
        headers: token ? { 'X-CSRF-Token': token } : {},
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
    } catch {
      // fall through to re-enable
    }
    stop.disabled = false;
  });

  banner.appendChild(label);
  banner.appendChild(name);
  banner.appendChild(sep);
  banner.appendChild(stop);

  const spacer = document.createElement('div');
  spacer.className = 'impersonation-banner-spacer';

  // Insert spacer after the deploy-banner spacer so layout pushes down by
  // both banners combined. If the deploy banner hasn't rendered yet, just
  // prepend — the deploy banner will insert above us on its own pass.
  const deploySpacer = document.querySelector('.deploy-banner-spacer');
  if (deploySpacer && deploySpacer.parentNode === document.body) {
    document.body.insertBefore(spacer, deploySpacer.nextSibling);
  } else {
    document.body.insertBefore(spacer, document.body.firstChild);
  }
  document.body.appendChild(banner);
}

async function init() {
  try {
    const res = await fetch('/api/chesnuts/me', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.impersonator || !data.user) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => renderBanner(data.impersonator, data.user));
    } else {
      renderBanner(data.impersonator, data.user);
    }
  } catch {
    // Silently no-op: missing /me should not break the page.
  }
}

init();

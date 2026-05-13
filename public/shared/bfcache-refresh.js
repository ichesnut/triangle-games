// When the browser restores this page from the back-forward cache (bfcache),
// reload it. Without this, pages that were mid-init when the user navigated
// away come back with their original "Loading…" state and a pending fetch
// promise that the browser already aborted — leaving the UI stuck until the
// user refreshes manually.
//
// `event.persisted === true` only fires on a true bfcache restore, never on
// the initial page load, so this is a no-op for fresh navigations.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    location.reload();
  }
});

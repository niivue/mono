// The status bar's right side: `state` colours it, 'wait' (yellow) while the
// page waits for a click or a load, 'ok' (green) for a result, 'error' (red),
// and nothing for a plain message.
const el = document.getElementById('status')
export function setStatus(text, state = '') {
  el.textContent = text
  el.dataset.state = state
}

// A load that fails (a top-level await rejecting, a 404 slide) shows in red
// rather than leaving the bar on "Loading...". Only errors with an Error:
// benign browser reports ("ResizeObserver loop ...", cross-origin "Script
// error.") carry none and must not turn the bar red.
addEventListener('error', (e) => {
  if (e.error) setStatus(e.error.message ?? String(e.error), 'error')
})
addEventListener('unhandledrejection', (e) =>
  setStatus(e.reason?.message ?? String(e.reason), 'error'),
)

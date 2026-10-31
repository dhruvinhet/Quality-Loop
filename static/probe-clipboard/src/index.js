import { events, view } from '@forge/bridge';

const button = document.getElementById('copy');
const status = document.getElementById('status');
const fallback = document.getElementById('fallback');
let results = '';

button.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(results);
    status.textContent = 'Results copied.';
    fallback.hidden = true;
  } catch {
    fallback.value = results;
    fallback.hidden = false;
    fallback.focus();
    fallback.select();
    status.textContent = 'Clipboard access was blocked. Copy the selected plain text with Ctrl+C or Cmd+C.';
  }
});

async function initialise() {
  await view.theme.enable();
  const { localId } = await view.getContext();
  const channel = `qualityloop-e1-${localId}`;
  let attempts = 0;
  let retry;
  const subscription = await events.on(`${channel}:results`, ({ text } = {}) => {
    if (typeof text !== 'string') return;
    results = text;
    button.disabled = false;
    status.textContent = 'Ready to copy.';
    clearInterval(retry);
  });
  window.addEventListener('pagehide', () => {
    clearInterval(retry);
    subscription.unsubscribe();
  }, { once: true });
  // Retry readiness to cover either side finishing its subscription first.
  retry = setInterval(() => {
    attempts += 1;
    if (attempts >= 10) {
      clearInterval(retry);
      status.textContent = 'Results could not reach the copy control. Reopen the panel and retry.';
      return;
    }
    events.emit(`${channel}:ready`).catch(() => {});
  }, 1000);
  await events.emit(`${channel}:ready`);
}

initialise().catch(() => { status.textContent = 'Copy control could not load. Reopen the issue panel and retry.'; });

/**
 * Fast voice search (SpeechRecognition) — not AI voice control.
 */
export function initVoiceSearch() {
  // Hook is applied when search UI is rendered; also listen globally
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#voiceSearchBtn, .mic-btn');
    if (!btn) return;
    e.preventDefault();
    startVoice(btn);
  });
}

function startVoice(btn) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert('Voice search is not supported in this browser.');
    return;
  }
  const rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  btn.classList.add('recording');
  btn.setAttribute('aria-label', 'Listening…');
  rec.onresult = (ev) => {
    const text = ev.results?.[0]?.[0]?.transcript || '';
    const input = document.getElementById('searchInput') || document.querySelector('input[type="search"], input[name="q"]');
    if (input && text) {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Trigger search form submit if present
      const form = input.closest('form');
      if (form) form.requestSubmit?.();
      else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      // Fallback: click search button
      document.querySelector('[data-action="search"], #searchBtn')?.click();
    }
  };
  rec.onerror = () => {
    btn.classList.remove('recording');
    btn.setAttribute('aria-label', 'Voice search');
  };
  rec.onend = () => {
    btn.classList.remove('recording');
    btn.setAttribute('aria-label', 'Voice search');
  };
  try { rec.start(); } catch (_) {
    btn.classList.remove('recording');
  }
}

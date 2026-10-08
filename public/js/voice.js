/**
 * Keyboard mic helper — focuses search field so the user can use
 * the OS/keyboard voice input (no overlapping floating SpeechRecognition UI).
 */
export function initVoiceSearch() {
  document.addEventListener('click', (e) => {
    const hint = e.target.closest('.search-hint, [data-action="focus-search"]');
    if (hint) {
      const input = document.getElementById('searchInput');
      if (input) {
        input.focus();
        try { input.click(); } catch (_) {}
      }
    }
  });
  // After search tab renders, ensure input is easy to reach for keyboard mic
  document.addEventListener('focusin', (e) => {
    if (e.target && e.target.id === 'searchInput') {
      e.target.setAttribute('inputmode', 'search');
    }
  });
}

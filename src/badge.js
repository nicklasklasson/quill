/* global badge */
(() => {
  const el = document.getElementById('badge');
  const count = document.getElementById('count');

  // state: { kind: 'idle' | 'ok' | 'issues', count, busy, app }
  badge.onState((state) => {
    el.className = `badge ${state.kind}${state.busy ? ' busy' : ''}`;
    count.textContent = state.count > 9 ? '9+' : String(state.count || '');
    count.style.fontSize = state.count > 9 ? '9px' : '';
    const what = state.kind === 'issues' ? `${state.count} ${state.count === 1 ? 'thing' : 'things'} to fix`
      : state.kind === 'ok' ? 'Looks good' : 'Quill is checking this field';
    el.title = `${what}. Click to open, right-click for options.`;
  });

  el.addEventListener('click', () => badge.click());
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); badge.menu(); });
})();

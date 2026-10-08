/* global quill */
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    panel: $('panel'), dot: $('dot'), title: $('title'), notice: $('notice'),
    scratch: $('scratch'), scratchText: $('scratchText'),
    issuesSection: $('issuesSection'), issuesSummary: $('issuesSummary'), fixAllBtn: $('fixAllBtn'), issueList: $('issueList'),
    modelState: $('modelState'), modelStateText: $('modelStateText'),
    rewriteSection: $('rewriteSection'), rewriteTools: $('rewriteTools'), modelCardMain: $('modelCardMain'),
    modes: $('modes'), result: $('result'), resultText: $('resultText'), replaceBtn: $('replaceBtn'), copyBtn: $('copyBtn'),
    resultNote: $('resultNote'), resultBy: $('resultBy'), busy: $('busy'), busyText: $('busyText'), cancelBtn: $('cancelBtn'), rewriteError: $('rewriteError'),
    main: $('main'), settings: $('settings'), welcome: $('welcome'),
    settingsBtn: $('settingsBtn'), closeBtn: $('closeBtn'), backBtn: $('backBtn'),
    hotkey: $('hotkey'), dialect: $('dialect'), isolateEnglish: $('isolateEnglish'), autoCheck: $('autoCheck'),
    alwaysOn: $('alwaysOn'), excludedList: $('excludedList'),
    dictList: $('dictList'), dictInput: $('dictInput'), dictAdd: $('dictAdd'),
    teamSection: $('teamSection'), teamList: $('teamList'), teamHiddenRow: $('teamHiddenRow'), suggestRow: $('suggestRow'), suggestBtn: $('suggestBtn'), ignoredSection: $('ignoredSection'), ignoredList: $('ignoredList'), pausedSection: $('pausedSection'), pausedList: $('pausedList'),
    launchAtLogin: $('launchAtLogin'), about: $('about'), showInDock: $('showInDock'), diagBtn: $('diagBtn'), diagNote: $('diagNote'),
    modelCardSettings: $('modelCardSettings'), modelCardWelcome: $('modelCardWelcome'),
    welcomeHotkey: $('welcomeHotkey'), welcomeDoneBtn: $('welcomeDoneBtn'),
  };

  const state = {
    status: {},
    settings: {},
    session: { mode: 'none', appName: '', text: '' },
    issues: [],
    truncated: false,
    harperReady: false,
    model: { enabled: false, state: 'idle', checked: false },
    models: null,
    downloadError: null,
    modes: {},
    rewrite: { busy: false, mode: null, result: null, error: null },
    view: 'main',
    version: '',
    autoReason: null,
  };

  // ------------------------------------------------------------------------------------------
  // Boot

  quill.ready().then((init) => {
    state.status = init.status;
    state.settings = init.settings;
    state.session = init.session;
    state.modes = init.modes;
    state.models = init.models;
    state.version = init.version;
    buildModes();
    fillSettings();
    render();
  });

  quill.on('status', (status) => { state.status = status; render(); });
  quill.on('session', (session) => {
    const changedMode = session.mode !== state.session.mode;
    state.session = session;
    state.issues = [];
    state.truncated = false;
    state.harperReady = false;
    if (changedMode || session.mode === 'none') clearRewrite();
    state.autoReason = null;
    if (session.mode === 'scratch') {
      els.scratchText.value = session.text || '';
      autoGrow();
      setTimeout(() => els.scratchText.focus(), 30);
    }
    if (session.mode !== 'none') state.view = 'main';
    render();
  });
  quill.on('lint', (payload) => {
    if (state.session.mode === 'scratch' && payload.text !== els.scratchText.value) return; // stale
    state.session.text = payload.text;
    state.issues = payload.issues;
    state.truncated = payload.truncated;
    state.harperReady = payload.harperReady;
    state.model = payload.model;
    renderIssues();
    scheduleResize();
  });
  quill.on('scratch-set', ({ text, caret }) => {
    els.scratchText.value = text;
    const pos = typeof caret === 'number' ? caret : text.length;
    els.scratchText.setSelectionRange(pos, pos);
    autoGrow();
  });
  quill.on('open-view', (view) => {
    state.view = view;
    fillSettings();
    refreshModels();
    render();
  });
  quill.on('models', (models) => { state.models = models; renderModelCards(); scheduleResize(); });
  quill.on('permission-granted', () => {
    state.permissionGranted = true;
    render();
    setTimeout(() => { state.permissionGranted = false; if (state.session.mode === 'none') quill.close(); else render(); }, 3500);
  });
  quill.on('auto-reason', (reason) => { state.autoReason = reason; render(); });
  quill.on('rewrite-reset', () => { clearRewrite(); state.view = 'main'; render(); });
  quill.on('settings-changed', (settings) => { state.settings = settings; fillSettings(); render(); });

  function currentText() {
    return state.session.mode === 'scratch' ? els.scratchText.value : state.session.text;
  }

  function hasModel() {
    return !!(state.status.model && state.models && state.models.catalog.some((m) => m.id === state.status.model && m.installed));
  }

  // ------------------------------------------------------------------------------------------
  // Rendering

  function render() {
    const s = state.session;
    const inScratch = s.mode === 'scratch';
    els.main.hidden = state.view !== 'main';
    els.settings.hidden = state.view !== 'settings';
    els.welcome.hidden = state.view !== 'welcome';
    els.settingsBtn.hidden = state.view === 'welcome';

    els.dot.className = 'dot' + (s.mode === 'watch' ? ' live' : (state.status.helper !== 'ready' || !state.status.trusted) && s.mode !== 'none' ? ' warn' : '');
    if (state.view === 'welcome') els.title.textContent = 'Welcome to Quill';
    else if (s.mode === 'watch') els.title.textContent = s.appName ? `Checking ${s.appName}` : 'Checking';
    else if (inScratch) els.title.textContent = 'Scratchpad';
    else els.title.textContent = 'Quill';

    const notice = buildNotice();
    els.notice.hidden = !notice;
    els.notice.replaceChildren(...(notice || []));

    els.scratch.hidden = !inScratch;
    els.issuesSection.hidden = s.mode === 'none';
    els.rewriteSection.hidden = s.mode === 'none';
    els.welcomeHotkey.textContent = prettyHotkey(state.status.hotkey || state.settings.hotkey);
    renderIssues();
    renderRewrite();
    renderModelCards();
    scheduleResize();
  }

  function buildNotice() {
    const s = state.session;
    const st = state.status;
    const nodes = [];
    const hk = prettyHotkey(st.hotkey || state.settings.hotkey || '');

    if (st.helper === 'missing') {
      nodes.push(text('The Accessibility helper isn’t built, so Quill can only check text here in the scratchpad. In the project folder, run '), code('npm run build:helper'), text(' and restart Quill.'));
    } else if (st.helper === 'failed') {
      nodes.push(text('The Accessibility helper stopped. Restart Quill; if it keeps happening, rebuild it with '), code('npm run build:helper'), text('.'));
    } else if (state.permissionGranted) {
      nodes.push(text('Quill is allowed now. Click into any text field and the badge appears.'));
    } else if (s.needsPermission || (st.helper === 'ready' && st.trusted === false && s.mode !== 'watch')) {
      nodes.push(boldText('Quill needs the Accessibility permission'));
      nodes.push(text(' to see the text field you’re typing in. In System Settings, switch on Quill under Privacy & Security › Accessibility.'));
      nodes.push(div('muted small', text('Already switched on? After an update macOS can treat Quill as a new app. Click Reset permission, then switch Quill on again.')));
      nodes.push(actions(
        button('Open System Settings', () => quill.openAccessibility(), 'primary'),
        button('Reset permission', async () => { await quill.resetPermission(); }),
        ...(s.needsPermission ? [button('Try again', () => quill.retryFocus())] : []),
      ));
    } else if (state.autoReason && s.mode === 'watch') {
      const r = state.autoReason;
      const app = r.app || s.appName || 'this app';
      const texts = {
        off: ['Automatic checking is turned off, so there’s no badge in text fields. You can still check any field with the hotkey.', 'Turn it on'],
        'paused-all': [`Quill is paused everywhere ${r.label}.`, 'Resume now'],
        'paused-app': [`Quill is paused in ${app} ${r.label}.`, `Resume in ${app}`],
        excluded: [`Quill doesn’t check ${app} automatically: it’s on your list of excluded apps.`, `Check ${app} automatically`],
        missed: ['Quill should have checked this field by itself but didn’t. Copy the diagnostics and send them to Nicklas, so he can find out why.', 'Copy diagnostics'],
        unreadable: [`${app} doesn’t let Quill read the text in this field. Paste your text into the scratchpad to check it there, and copy diagnostics for Nicklas.`, 'Open scratchpad'],
      };
      const [message, action] = texts[r.code] || [null, null];
      if (message) {
        nodes.push(text(message));
        nodes.push(actions(button(action, async () => {
          if (r.code === 'unreadable') {
            await quill.copy(await quill.diagnostics());
            quill.openScratch();
            return;
          }
          if (r.code === 'missed') {
            await quill.copy(await quill.diagnostics());
            state.autoReason = null; render(); note('Diagnostics copied.');
            return;
          }
          state.settings = await quill.autoFix(r);
          state.autoReason = null; fillSettings(); render();
          note('Done. The badge will appear in text fields again.');
        }, 'primary'), button('Not now', () => { state.autoReason = null; render(); })));
      }
    } else if (s.noField) {
      nodes.push(text(s.appName ? `No text field has focus in ${s.appName}. ` : 'No text field has focus. '), text(`Click into one and press ${hk}, or use this scratchpad.`));
    } else if (!st.hotkeyOk) {
      nodes.push(text(`The hotkey ${hk} is taken by another app. Pick a different one in settings.`));
    } else if (s.mode === 'none' && state.view === 'main') {
      nodes.push(text(`Press ${hk} in any text field to check it, or open the scratchpad from the menu bar icon.`));
    }
    return nodes.length ? nodes : null;
  }

  function renderIssues() {
    const s = state.session;
    if (s.mode === 'none') return;
    const textValue = currentText();
    const issues = state.issues;
    const fixable = issues.filter((i) => i.suggestions.length > 0);
    const m = state.model || {};
    const modelBusy = m.enabled && (m.state === 'starting' || m.state === 'checking' || m.state === 'waiting');

    if (!state.status.checkerReady) els.issuesSummary.textContent = 'Loading the dictionary…';
    else if (state.truncated) els.issuesSummary.textContent = 'Too long to check (over 20,000 characters)';
    else if (!textValue.trim()) els.issuesSummary.textContent = s.mode === 'watch' ? 'Start typing and Quill checks as you go' : 'Nothing to check yet';
    else if (issues.length === 0) els.issuesSummary.textContent = modelBusy || !state.harperReady ? 'Looks good so far' : 'Looks good';
    else els.issuesSummary.textContent = issues.length === 1 ? '1 thing to fix' : `${issues.length} things to fix`;

    // What the writing model is doing, shown quietly next to the summary.
    let label = '';
    if (m.enabled && textValue.trim()) {
      if (m.state === 'starting') label = 'Starting the writing model';
      else if (m.state === 'checking') label = 'Checking more closely';
      else if (m.state === 'error') label = 'Deeper check failed';
    }
    els.modelState.hidden = !label;
    els.modelStateText.textContent = label;
    els.modelState.querySelector('.spinner').hidden = m.state === 'error';

    els.fixAllBtn.hidden = fixable.length < 2;

    const items = issues.map((issue) => {
      const li = document.createElement('li');
      li.className = `issue kind-${issue.kind.toLowerCase()}`;
      const main = document.createElement('div');
      main.className = 'issue-main';
      const problem = document.createElement('span');
      problem.className = 'problem-text';
      problem.textContent = issue.problem.trim() || '␣';
      problem.title = issue.kindLabel;
      main.append(problem);

      const [first, ...rest] = issue.suggestions;
      if (first) {
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = '→';
        main.append(arrow, fixButton(issue, first));
        for (const alt of rest.slice(0, 3)) main.append(fixButton(issue, alt, true));
      }
      li.append(main);
      const message = document.createElement('div');
      message.className = 'issue-message';
      message.textContent = issue.message;
      li.append(message);
      li.append(issueActions(issue));
      return li;
    });
    els.issueList.replaceChildren(...items);
  }

  /** "Add to dictionary" for single words that were flagged; "Always ignore" for anything. */
  function issueActions(issue) {
    const row = div('issue-actions');
    const word = issue.problem.trim();
    const isWord = /^[\p{L}\p{N}][\p{L}\p{N}’'_-]*$/u.test(word);
    if (isWord && (issue.kind === 'Spelling' || issue.kind === 'Model' || issue.kind === 'Typo')) {
      row.append(button(`Add “${word}” to dictionary`, async () => {
        state.settings = await quill.addWord(word);
        note(`Added “${word}” to your dictionary.`);
      }, 'link small'));
    }
    row.append(button('Always ignore', async () => {
      state.settings = await quill.ignoreAlways({ problem: issue.problem, suggestions: issue.suggestions.slice(0, 1) });
      note('Quill won’t suggest that again.');
    }, 'link small'));
    return row;
  }

  function fixButton(issue, suggestion, alt) {
    const b = document.createElement('button');
    b.className = 'fix' + (suggestion.kind === 'remove' ? ' remove' : '') + (alt ? ' alt' : '');
    b.textContent = suggestion.kind === 'remove' ? 'remove' : suggestion.kind === 'insertAfter' ? `${issue.problem}${suggestion.text}` : (suggestion.text.trim() || '␣');
    b.title = suggestion.kind === 'remove' ? 'Remove this' : `Replace with “${suggestion.text}”`;
    b.addEventListener('click', async () => {
      b.disabled = true;
      const result = await quill.applyFix(issue, suggestion);
      if (!result.ok) note(`Couldn’t change the text (${result.error || 'unknown reason'}).`);
      else if (result.method === 'paste') note('Replaced by pasting.');
    });
    return b;
  }

  function buildModes() {
    const buttons = Object.entries(state.modes).map(([key, spec]) => {
      const b = document.createElement('button');
      b.dataset.mode = key;
      b.textContent = spec.label;
      b.title = spec.hint;
      b.addEventListener('click', () => rewrite(key));
      return b;
    });
    els.modes.replaceChildren(...buttons);
  }

  function renderRewrite() {
    const model = hasModel();
    els.rewriteTools.hidden = !model;
    const r = state.rewrite;
    for (const b of els.modes.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.mode === r.mode && (r.busy || !!r.result));
      b.disabled = state.session.mode === 'none';
    }
    els.busy.hidden = !r.busy;
    if (r.busy) els.busyText.textContent = state.status.engine === 'ready' ? 'Rewriting…' : 'Starting the writing model…';
    els.result.hidden = !r.result;
    if (r.result) {
      renderDiff(r.result.original, r.result.text);
      els.resultBy.textContent = r.result.modelLabel ? `Rewritten by ${r.result.modelLabel}` : '';
      els.replaceBtn.textContent = state.session.mode === 'watch' && state.session.appName ? `Replace in ${state.session.appName}` : 'Replace text';
    }
    els.rewriteError.hidden = !r.error;
    if (r.error) els.rewriteError.replaceChildren(...errorNodes(r.error));
  }

  function errorNodes(error) {
    if (error.code === 'cancelled') return [];
    if (error.code === 'no-model') return [text('The writing model isn’t downloaded yet.')];
    return [
      text(`The rewrite failed: ${error.message}`),
      actions(button('Try again', () => rewrite(state.rewrite.mode))),
    ];
  }

  async function rewrite(mode) {
    if (!mode) return;
    state.rewrite = { busy: true, mode, result: null, error: null };
    renderRewrite(); scheduleResize();
    const result = await quill.rewrite(mode);
    if (!state.rewrite.busy || state.rewrite.mode !== mode) return;
    if (result.ok && result.text === result.original) {
      state.rewrite = { busy: false, mode, result: null, error: null };
      renderRewrite(); scheduleResize();
      note(mode === 'fix' ? 'The writing model found nothing to fix.' : 'The writing model kept the text as it is.');
      return;
    }
    state.rewrite = { busy: false, mode, result: result.ok ? result : null, error: result.ok ? null : result.error };
    renderRewrite(); scheduleResize();
  }

  function clearRewrite() {
    state.rewrite = { busy: false, mode: null, result: null, error: null };
  }

  // ------------------------------------------------------------------------------------------
  // The writing model: download, progress, choice

  async function refreshModels() {
    state.models = await quill.models.state();
    renderModelCards();
    scheduleResize();
  }

  function renderModelCards() {
    if (!state.models) return;
    const showMain = state.view === 'main' && state.session.mode !== 'none' && !hasModel();
    els.modelCardMain.hidden = !showMain;
    if (showMain) els.modelCardMain.replaceChildren(...modelCard('main'));
    if (state.view === 'settings') els.modelCardSettings.replaceChildren(...modelCard('settings'));
    if (state.view === 'welcome') els.modelCardWelcome.replaceChildren(...modelCard('welcome'));
  }

  function modelCard(where) {
    const ms = state.models;
    const nodes = [];
    const d = ms.download;

    if (d) {
      const model = ms.catalog.find((m) => m.id === d.id);
      const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : 0;
      const label = d.phase === 'verifying' ? 'Checking the download…'
        : d.phase === 'resuming' ? 'Continuing where it stopped…'
          : `Downloading ${model.label}`;
      nodes.push(div('', text(label)));
      const bar = div('progress', div(''));
      bar.firstChild.style.width = `${pct.toFixed(1)}%`;
      nodes.push(bar);
      const eta = d.speed > 0 && d.total > d.received ? ` · about ${formatDuration((d.total - d.received) / d.speed)} left` : '';
      nodes.push(div('progress-row',
        span('', `${formatBytes(d.received)} of ${formatBytes(d.total)}${eta}`),
        span('spacer', ''),
        d.phase === 'downloading' ? button('Pause', () => quill.models.cancel(), 'link') : span('', ''),
      ));
      return nodes;
    }

    const current = ms.catalog.find((m) => m.id === state.status.model && m.installed);
    if (current && where !== 'main') {
      nodes.push(div('model-installed',
        span('name', current.label),
        span('muted', `${current.name}, ${formatBytes(current.approxBytes)}`),
      ));
      if (where === 'welcome') {
        nodes.push(div('muted', text('Installed. Rewrites and deeper checks are ready.')));
      } else {
        const others = ms.catalog.filter((m) => m.id !== current.id);
        const buttons = others.map((m) => button(
          m.installed ? `Use ${m.label}` : `Download ${m.label} (${formatBytes(m.approxBytes)})`,
          () => (m.installed ? useModel(m.id) : download(m.id)),
        ));
        buttons.push(button('Remove', () => removeModel(current.id)));
        buttons.push(button('Show in Finder', () => quill.models.reveal(), 'link'));
        nodes.push(div('model-actions', ...buttons));
        for (const m of others.filter((o) => o.installed)) {
          nodes.push(div('model-actions', span('muted', `${m.label} is also downloaded (${formatBytes(m.approxBytes)}).`), button('Remove', () => removeModel(m.id), 'link')));
        }
      }
    } else {
      if (where === 'main') {
        nodes.push(div('', text('Rewrites and the deeper check need the writing model. It runs on this Mac and is a one-time download.')));
      } else if (where === 'settings') {
        nodes.push(div('muted', text('Not downloaded yet. Spelling and grammar checks work without it.')));
      }
      const options = ms.catalog.map((m) => {
        const b = document.createElement('button');
        b.className = 'model-option';
        const grow = div('grow', div('name', text(m.label)), div('meta', text(m.blurb)));
        const right = div('', ...(m.id === ms.recommended ? [div('badge', text('Suggested for this Mac'))] : []),
          div('size', text(m.partialBytes ? `${formatBytes(m.partialBytes)} of ${formatBytes(m.approxBytes)}` : formatBytes(m.approxBytes))));
        right.style.textAlign = 'right';
        b.append(grow, right);
        b.addEventListener('click', () => download(m.id));
        return b;
      });
      // Suggested option first.
      options.sort((a, b) => Number(b.textContent.includes('Suggested')) - Number(a.textContent.includes('Suggested')));
      nodes.push(div('model-options', ...options));
      if (where !== 'main') {
        nodes.push(div('muted', text(`This Mac has ${ms.memoryGB} GB of memory. The download comes from Hugging Face and is checked against a fingerprint built into Quill before it is used.`)));
      }
    }
    if (state.downloadError) nodes.push(div('error-text', text(state.downloadError)));
    return nodes;
  }

  async function download(id) {
    state.downloadError = null;
    const result = await quill.models.download(id);
    if (!result.ok && result.code !== 'cancelled') state.downloadError = result.error;
    if (!result.ok && result.code === 'cancelled') state.downloadError = null;
    await refreshModels();
    render();
  }

  async function useModel(id) {
    state.settings = await quill.setSettings({ model: id });
    render();
  }

  async function removeModel(id) {
    state.models = await quill.models.remove(id);
    render();
  }

  // ------------------------------------------------------------------------------------------
  // Diff: highlight what changed in the rewrite.

  function renderDiff(before, after) {
    const a = tokens(before);
    const b = tokens(after);
    els.resultText.replaceChildren();
    if (a.length * b.length > 250000) { els.resultText.textContent = after; return; }
    const n = a.length; const m = b.length;
    const dp = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
      }
    }
    let i = 0; let j = 0; let plain = ''; let changed = '';
    const flush = () => {
      if (plain) { els.resultText.append(document.createTextNode(plain)); plain = ''; }
      if (changed) { const mark = document.createElement('mark'); mark.textContent = changed; els.resultText.append(mark); changed = ''; }
    };
    while (i < n && j < m) {
      if (a[i] === b[j]) { if (changed) flush(); plain += b[j]; i++; j++; }
      else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { i++; }
      else { if (plain) flush(); changed += b[j]; j++; }
    }
    while (j < m) { if (plain) flush(); changed += b[j++]; }
    flush();
  }

  function tokens(s) {
    return s.match(/\s+|[\p{L}\p{N}’']+|[^\s\p{L}\p{N}]/gu) || [];
  }

  // ------------------------------------------------------------------------------------------
  // Settings

  function fillSettings() {
    const s = state.settings;
    els.hotkey.value = prettyHotkey(s.hotkey);
    els.dialect.value = s.dialect;
    els.isolateEnglish.checked = !!s.isolateEnglish;
    els.autoCheck.checked = s.autoCheck !== false;
    els.alwaysOn.checked = s.alwaysOn !== false;
    renderExcluded();
    renderDictionary();
    renderPaused();
    els.launchAtLogin.checked = !!s.launchAtLogin;
    els.showInDock.checked = s.showInDock !== false;
    els.about.replaceChildren(text(`Quill ${state.version}. Spelling and grammar checks by Harper; rewrites by a language model run with llama.cpp. Both run on this Mac, and nothing you write is sent anywhere.`));
  }

  async function save(patch) {
    state.settings = await quill.setSettings(patch);
    render();
  }

  els.dialect.addEventListener('change', () => save({ dialect: els.dialect.value }));
  els.isolateEnglish.addEventListener('change', () => save({ isolateEnglish: els.isolateEnglish.checked }));
  els.autoCheck.addEventListener('change', () => save({ autoCheck: els.autoCheck.checked }));
  els.alwaysOn.addEventListener('change', () => save({ alwaysOn: els.alwaysOn.checked }));

  async function renderTeam() {
    const team = await quill.teamState();
    state.team = team;
    const hidden = new Set(team.hidden.map((w) => w.toLowerCase()));
    els.teamSection.hidden = team.words.length === 0;
    els.teamList.replaceChildren(...team.words.filter((w) => !hidden.has(w.toLowerCase())).map((w) => {
      const chip = span('chip team', w);
      const x = button('×', async () => { state.settings = await quill.hideTeamWord(w); renderTeam(); scheduleResize(); }, 'chip-x');
      x.title = `Switch off “${w}” just for you`;
      chip.append(x);
      return chip;
    }));
    const hiddenWords = team.words.filter((w) => hidden.has(w.toLowerCase()));
    els.teamHiddenRow.hidden = hiddenWords.length === 0;
    els.teamHiddenRow.replaceChildren(text('Switched off for you: '), ...hiddenWords.flatMap((w, i) => [
      ...(i ? [text(', ')] : []),
      button(w, async () => { state.settings = await quill.showTeamWord(w); renderTeam(); scheduleResize(); }, 'link'),
    ]), text(' (click to switch back on)'));
    const own = (state.settings.dictionary || []).filter((w) => !team.words.some((t) => t.toLowerCase() === w.toLowerCase()));
    els.suggestRow.hidden = !team.contact || own.length === 0;
    scheduleResize();
  }

  els.suggestBtn.addEventListener('click', () => quill.suggestTeamWords(state.settings.dictionary || []));

  function renderDictionary() {
    renderTeam();
    const words = state.settings.dictionary || [];
    els.dictList.replaceChildren(...words.map((w) => {
      const chip = span('chip', w);
      const x = button('×', async () => { state.settings = await quill.removeWord(w); renderDictionary(); scheduleResize(); }, 'chip-x');
      x.title = `Remove “${w}”`;
      chip.append(x);
      return chip;
    }));
    if (!words.length) els.dictList.replaceChildren(span('muted', 'No words yet.'));
    const ignored = state.settings.ignoredSuggestions || [];
    els.ignoredSection.hidden = ignored.length === 0;
    els.ignoredList.replaceChildren(...ignored.map((i) => {
      const li = document.createElement('li');
      li.append(span('', i.replacement ? `${i.problem} → ${i.replacement}` : i.problem), button('Show again', async () => {
        state.settings = await quill.unignore(i);
        renderDictionary();
        scheduleResize();
      }, 'link'));
      return li;
    }));
  }

  async function addTypedWord() {
    const word = els.dictInput.value.trim();
    if (!word) return;
    state.settings = await quill.addWord(word);
    els.dictInput.value = '';
    renderDictionary();
    scheduleResize();
  }
  els.dictAdd.addEventListener('click', addTypedWord);
  els.dictInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTypedWord(); } });

  async function renderPaused() {
    const p = await quill.pauses();
    const items = [];
    if (p.all) {
      const li = document.createElement('li');
      li.append(span('', `Everywhere, ${p.all}`), button('Resume', async () => { state.settings = await quill.resumeAll(); renderPaused(); }, 'link'));
      items.push(li);
    }
    for (const a of p.apps) {
      const li = document.createElement('li');
      li.append(span('', `${a.name}, ${a.label}`), button('Resume', async () => { state.settings = await quill.resumeApp(a.id); renderPaused(); }, 'link'));
      items.push(li);
    }
    els.pausedList.replaceChildren(...items);
    els.pausedSection.hidden = items.length === 0;
    scheduleResize();
  }

  function renderExcluded() {
    const list = state.settings.excludedApps || [];
    els.excludedList.replaceChildren(...list.map((a) => {
      const li = document.createElement('li');
      li.append(span('', a.name), button('Check it again', async () => {
        state.settings = await quill.removeExcluded(a.id);
        renderExcluded();
        scheduleResize();
      }, 'link'));
      return li;
    }));
    if (list.length === 0) els.excludedList.replaceChildren(div('muted', text('None.')));
  }
  els.launchAtLogin.addEventListener('change', () => save({ launchAtLogin: els.launchAtLogin.checked }));
  els.showInDock.addEventListener('change', () => save({ showInDock: els.showInDock.checked }));
  els.diagBtn.addEventListener('click', async () => {
    await quill.copy(await quill.diagnostics());
    els.diagNote.textContent = 'Copied. Paste it into a message to Nicklas.';
    setTimeout(() => { els.diagNote.textContent = 'For reporting a problem. Contains no text you’ve written.'; }, 4000);
  });

  els.hotkey.addEventListener('focus', () => { els.hotkey.classList.add('capturing'); els.hotkey.value = 'Press keys…'; });
  els.hotkey.addEventListener('blur', () => { els.hotkey.classList.remove('capturing'); els.hotkey.value = prettyHotkey(state.settings.hotkey); });
  els.hotkey.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const accelerator = toAccelerator(e);
    if (!accelerator) return;
    save({ hotkey: accelerator }).then(() => els.hotkey.blur());
  });

  function toAccelerator(e) {
    const mods = [];
    if (e.metaKey) mods.push('Command');
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (mods.length === 0) return null;
    let key = null;
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
    else if (/^F[0-9]{1,2}$/.test(e.code)) key = e.code;
    else if (e.code === 'Space') key = 'Space';
    else if (['Enter', 'Tab', 'Backspace', 'Delete', 'Escape'].includes(e.code)) key = e.code === 'Enter' ? 'Return' : e.code;
    else if (/^(Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/.test(e.code)) {
      key = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`' }[e.code];
    }
    if (!key) return null;
    return [...mods, key].join('+');
  }

  /** "CommandOrControl+Alt+G" → "⌥⌘G", in the order macOS shows modifiers (⌃⌥⇧⌘). */
  function prettyHotkey(accelerator) {
    const parts = String(accelerator || '').split('+').filter(Boolean);
    const symbols = { Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘' };
    const order = ['⌃', '⌥', '⇧', '⌘'];
    const mods = parts.filter((p) => symbols[p]).map((p) => symbols[p]).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const key = parts.filter((p) => !symbols[p]).join('');
    return mods.join('') + key;
  }

  // ------------------------------------------------------------------------------------------
  // Scratchpad

  let scratchTimer;
  els.scratchText.addEventListener('input', () => {
    autoGrow();
    clearTimeout(scratchTimer);
    scratchTimer = setTimeout(() => quill.scratchText(els.scratchText.value), 150);
  });
  function autoGrow() {
    els.scratchText.style.height = 'auto';
    els.scratchText.style.height = `${Math.min(180, els.scratchText.scrollHeight)}px`;
    scheduleResize();
  }

  // ------------------------------------------------------------------------------------------
  // Buttons

  els.fixAllBtn.addEventListener('click', async () => {
    els.fixAllBtn.disabled = true;
    const result = await quill.fixAll();
    els.fixAllBtn.disabled = false;
    if (!result.ok && result.error !== 'nothing-to-fix') note(`Couldn’t change the text (${result.error}).`);
  });
  els.replaceBtn.addEventListener('click', async () => {
    const r = state.rewrite.result;
    if (!r) return;
    els.replaceBtn.disabled = true;
    const result = await quill.replace(r.text);
    els.replaceBtn.disabled = false;
    if (result.ok) {
      clearRewrite();
      renderRewrite();
      scheduleResize();
      note(result.method === 'paste' ? 'Replaced by pasting.' : 'Replaced.');
    } else {
      els.resultNote.textContent = 'Couldn’t replace';
    }
  });
  els.copyBtn.addEventListener('click', async () => {
    const r = state.rewrite.result;
    if (!r) return;
    await quill.copy(r.text);
    els.resultNote.textContent = 'Copied';
    setTimeout(() => { els.resultNote.textContent = ''; }, 2500);
  });
  els.cancelBtn.addEventListener('click', () => { quill.cancelRewrite(); clearRewrite(); renderRewrite(); scheduleResize(); });
  els.settingsBtn.addEventListener('click', () => {
    state.view = state.view === 'settings' ? 'main' : 'settings';
    if (state.view === 'settings') { fillSettings(); refreshModels(); }
    render();
  });
  els.backBtn.addEventListener('click', () => { state.view = 'main'; render(); });
  els.welcomeDoneBtn.addEventListener('click', () => { quill.welcomeDone(); quill.close(); state.view = 'main'; });
  els.closeBtn.addEventListener('click', () => { if (state.view === 'welcome') quill.welcomeDone(); state.view = 'main'; quill.close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.view === 'settings') { state.view = 'main'; render(); return; }
    if (state.view === 'welcome') quill.welcomeDone();
    state.view = 'main';
    quill.close();
  });

  let noteTimer;
  function note(message) {
    els.issuesSummary.textContent = message;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(renderIssues, 3000);
  }

  // ------------------------------------------------------------------------------------------
  // Window height follows content.

  let resizeTimer;
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => quill.resize(els.panel.offsetHeight), 10);
  }
  new ResizeObserver(() => scheduleResize()).observe(els.panel);

  // ------------------------------------------------------------------------------------------
  // Helpers

  function formatBytes(n) {
    if (!n) return '0 MB';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
    return `${Math.max(1, Math.round(n / 1e6))} MB`;
  }
  function formatDuration(seconds) {
    if (seconds < 60) return 'a minute';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }
  function text(s) { return document.createTextNode(s); }
  function boldText(s) { const b = document.createElement('b'); b.textContent = s; return b; }
  function code(s) { const c = document.createElement('code'); c.textContent = s; return c; }
  function span(cls, s) { const e = document.createElement('span'); if (cls) e.className = cls; e.textContent = s; return e; }
  function div(cls, ...children) { const d = document.createElement('div'); if (cls) d.className = cls; d.append(...children); return d; }
  function button(label, onClick, cls) { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.addEventListener('click', onClick); return b; }
  function actions(...buttons) { const d = document.createElement('div'); d.className = 'actions'; d.append(...buttons); return d; }
})();

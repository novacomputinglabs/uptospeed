const els = {
  title: document.getElementById('title'),
  detail: document.getElementById('detail'),
  message: document.getElementById('message'),
  error: document.getElementById('error'),
  importPanel: document.getElementById('importPanel'),
  progressPanel: document.getElementById('progressPanel'),
  errorPanel: document.getElementById('errorPanel'),
  steps: document.getElementById('steps'),
  logs: document.getElementById('logs'),
  importBtn: document.getElementById('importBtn'),
  continueBtn: document.getElementById('continueBtn'),
  retryBtn: document.getElementById('retryBtn'),
  logsBtn: document.getElementById('logsBtn'),
  quitBtn: document.getElementById('quitBtn'),
};

function setHidden(el, hidden) {
  if (!el) return;
  el.hidden = hidden;
}

function renderSteps(steps) {
  els.steps.innerHTML = '';
  for (const step of Array.isArray(steps) ? steps : []) {
    const item = document.createElement('div');
    item.className = 'step';

    const label = document.createElement('span');
    label.className = 'step-label';
    label.textContent = step.label || '';

    const status = document.createElement('span');
    status.className = `step-status status-${step.status || 'pending'}`;
    status.textContent = step.status || 'pending';

    item.append(label, status);
    els.steps.appendChild(item);
  }
}

function renderState(state) {
  els.title.textContent = state.title || 'UP TO SPEED Desktop';
  els.detail.textContent = state.detail || '';
  els.logs.textContent = Array.isArray(state.logs) && state.logs.length
    ? state.logs.join('\n')
    : 'Waiting for startup output…';

  if (state.message) {
    els.message.textContent = state.message;
    setHidden(els.message, false);
  } else {
    setHidden(els.message, true);
  }

  if (state.error) {
    els.error.textContent = state.error;
    setHidden(els.error, false);
  } else {
    setHidden(els.error, true);
  }

  const mode = state.mode || 'starting';
  setHidden(els.importPanel, mode !== 'import-prompt');
  setHidden(els.progressPanel, mode !== 'starting');
  setHidden(els.errorPanel, mode !== 'error');

  renderSteps(state.steps || []);
}

els.importBtn.addEventListener('click', () => {
  window.desktopBootstrap.importLegacy();
});

els.continueBtn.addEventListener('click', () => {
  window.desktopBootstrap.continueWithoutImport();
});

els.retryBtn.addEventListener('click', () => {
  window.desktopBootstrap.retryLaunch();
});

els.logsBtn.addEventListener('click', () => {
  window.desktopBootstrap.openLogsDir();
});

els.quitBtn.addEventListener('click', () => {
  window.desktopBootstrap.quit();
});

window.desktopBootstrap.onState(renderState);
window.desktopBootstrap.getState().then(renderState);

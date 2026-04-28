'use strict';

const API_BASE = window.location.origin;
let authToken = localStorage.getItem('zoniq-token');
let currentScenarioId = null;
let currentEditScenarioId = null;

// ── API ───────────────────────────────────────────────────────────────────────

async function apiCall(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API_BASE + path, opts);
  if (res.status === 401) { logout(); return null; }
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  errorEl.style.display = 'none';
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error('Invalid credentials');
    const data = await res.json();
    authToken = data.token;
    localStorage.setItem('zoniq-token', authToken);
    document.getElementById('username').textContent = data.username;
    document.getElementById('nav').style.display = 'flex';
    document.getElementById('loginView').classList.remove('active');
    showView('scenarios');
  } catch (err) {
    errorEl.textContent = 'Login failed: ' + err.message;
    errorEl.style.display = 'block';
  }
}

function logout() {
  authToken = null;
  localStorage.removeItem('zoniq-token');
  document.getElementById('nav').style.display = 'none';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('loginView').classList.add('active');
}

// ── Views ─────────────────────────────────────────────────────────────────────

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(name + 'View');
  if (el) el.classList.add('active');
  document.querySelectorAll('nav a[data-view]').forEach(a => {
    a.classList.toggle('active', a.dataset.view === name);
  });
  if (name === 'scenarios') loadScenarios();
  if (name === 'runs') loadRuns();
  if (name === 'plans') loadPlans();
}

function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ── Scenarios ─────────────────────────────────────────────────────────────────

async function loadScenarios() {
  const list = document.getElementById('scenariosList');
  list.textContent = 'Loading...';
  try {
    const scenarios = await apiCall('/api/scenarios');
    if (!scenarios) return;
    if (!scenarios.length) { list.innerHTML = '<p class="text-secondary">No scenarios yet.</p>'; return; }
    list.innerHTML = scenarios.map(sc => `
      <div class="scenario-row">
        <div class="scenario-info" data-action="show-scenario" data-id="${esc(sc.id)}">
          <div class="scenario-name">${esc(sc.name)}</div>
          <div class="scenario-url">${esc(sc.targetUrl)}</div>
        </div>
        <div class="actions">
          <button class="btn btn-success btn-sm" data-action="run-scenario" data-id="${esc(sc.id)}">Run</button>
          <button class="btn btn-danger btn-sm" data-action="delete-scenario" data-id="${esc(sc.id)}">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    list.textContent = 'Error loading scenarios.';
  }
}

async function showScenarioDetail(id) {
  currentScenarioId = id;
  const sc = await apiCall(`/api/scenarios/${id}`);
  if (!sc) return;
  document.getElementById('detailName').textContent = sc.name;
  document.getElementById('detailUrl').textContent = sc.targetUrl;
  document.getElementById('detailScript').textContent = sc.script;
  document.getElementById('detailLastRun').textContent = 'Loading...';
  document.getElementById('detailRunHistory').innerHTML = '';
  showView('scenarioDetail');
  loadScenarioRunHistory(id);
}

async function loadScenarioRunHistory(id) {
  const runs = await apiCall('/api/runs');
  if (!runs) return;
  const mine = runs.filter(r => r.scenarioId === id).slice(0, 5);
  document.getElementById('detailLastRun').textContent = mine[0]
    ? (mine[0].completedAt ? new Date(mine[0].completedAt).toLocaleString() : 'Running...')
    : 'Never';
  document.getElementById('detailRunHistory').innerHTML = mine.length
    ? mine.map(runRowHtml).join('')
    : '<p class="text-secondary">No runs yet.</p>';
}

function showCreateScenarioModal() {
  currentEditScenarioId = null;
  document.getElementById('scenarioModalTitle').textContent = 'New Scenario';
  document.getElementById('formName').value = '';
  document.getElementById('formUrl').value = '';
  document.getElementById('formUsername').value = '';
  document.getElementById('formPassword').value = '';
  document.getElementById('formScript').value =
    "test('my test', async ({ page }) => {\n  await page.goto('https://your-app.com');\n});";
  openModal('scenarioModal');
}

async function editScenario() {
  if (!currentScenarioId) return;
  currentEditScenarioId = currentScenarioId;
  const sc = await apiCall(`/api/scenarios/${currentScenarioId}`);
  if (!sc) return;
  document.getElementById('scenarioModalTitle').textContent = 'Edit Scenario';
  document.getElementById('formName').value = sc.name;
  document.getElementById('formUrl').value = sc.targetUrl;
  document.getElementById('formUsername').value = sc.credentials?.username || '';
  document.getElementById('formPassword').value = sc.credentials?.password || '';
  document.getElementById('formScript').value = sc.script;
  openModal('scenarioModal');
}

async function saveScenario(e) {
  e.preventDefault();
  const sc = {
    id: currentEditScenarioId || undefined,
    name: document.getElementById('formName').value,
    targetUrl: document.getElementById('formUrl').value,
    credentials: {
      username: document.getElementById('formUsername').value,
      password: document.getElementById('formPassword').value,
    },
    script: document.getElementById('formScript').value,
  };
  try {
    await apiCall('/api/scenarios', 'POST', sc);
    closeModal('scenarioModal');
    if (currentEditScenarioId) showScenarioDetail(currentEditScenarioId);
    else showView('scenarios');
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

async function deleteScenario(id) {
  if (!confirm('Delete this scenario?')) return;
  try {
    await apiCall(`/api/scenarios/${id}`, 'DELETE');
    showView('scenarios');
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

async function runScenario(id) {
  try {
    const res = await apiCall(`/api/execute-scenario/${id}`, 'POST', {});
    if (!res) return;
    openModal('progressModal');
    pollRun(res.runId);
  } catch (err) {
    alert('Run failed: ' + err.message);
  }
}

async function pollRun(runId) {
  let elapsed = 0;
  const progressText = document.getElementById('progressText');
  const iv = setInterval(async () => {
    try {
      elapsed += 2;
      progressText.textContent = `${elapsed}s elapsed…`;
      const run = await apiCall(`/api/runs/${runId}`);
      if (!run) { clearInterval(iv); closeModal('progressModal'); return; }
      if (run.status !== 'running') {
        clearInterval(iv);
        closeModal('progressModal');
        showRunDetail(runId);
      }
    } catch { /* keep polling */ }
  }, 2000);
  setTimeout(() => clearInterval(iv), 600000);
}

// ── Runs ──────────────────────────────────────────────────────────────────────

function runRowHtml(r) {
  const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏳';
  const t = r.completedAt || r.startedAt;
  const steps = r.results?.stepList?.length || 0;
  const dur = r.completedAt
    ? ((new Date(r.completedAt) - new Date(r.startedAt)) / 1000).toFixed(1) + 's'
    : '';
  return `<div class="run-item" data-action="show-run" data-id="${esc(r.runId)}">
    <div style="display:flex;justify-content:space-between">
      <span>${icon} ${esc(r.testName || 'Test')}</span>
      <span class="text-secondary">${new Date(t).toLocaleString()}</span>
    </div>
    <div style="display:flex;gap:2rem;margin-top:0.5rem;font-size:0.9rem;color:var(--text-secondary)">
      <span>${r.status === 'pass' ? 'Passed' : r.status === 'fail' ? 'Failed' : 'Running'}</span>
      <span>${steps} steps</span>
      ${dur ? `<span>${dur}</span>` : ''}
    </div>
  </div>`;
}

async function loadRuns() {
  const list = document.getElementById('runsList');
  list.textContent = 'Loading...';
  try {
    const runs = await apiCall('/api/runs');
    if (!runs) return;
    list.innerHTML = runs.length
      ? runs.slice(0, 50).map(runRowHtml).join('')
      : '<p class="text-secondary">No runs yet.</p>';
  } catch (err) {
    list.textContent = 'Error loading runs.';
  }
}

async function showRunDetail(runId) {
  const run = await apiCall(`/api/runs/${runId}`);
  if (!run) return;
  document.getElementById('runDetailId').textContent = runId.substring(0, 8);
  document.getElementById('runDetailScenario').textContent = run.testName || runId;
  document.getElementById('runDetailStarted').textContent = new Date(run.startedAt).toLocaleString();
  document.getElementById('runDetailStatusText').textContent =
    run.status === 'pass' ? '✅ Pass' : run.status === 'fail' ? '❌ Fail' : '⏳ Running';
  const dur = run.completedAt
    ? ((new Date(run.completedAt) - new Date(run.startedAt)) / 1000).toFixed(2) + 's'
    : 'Running…';
  document.getElementById('runDetailDuration').textContent = dur;
  const steps = run.results?.stepList || [];
  document.getElementById('runDetailSteps').innerHTML = steps.length
    ? steps.map((label, i) => {
        const s = run.results.stepResults?.[i];
        const cls = s === 'pass' ? 'pass' : s === 'fail' ? 'fail' : 'pending';
        const icon = s === 'pass' ? '✓' : s === 'fail' ? '✗' : '•';
        return `<div class="step-item"><div class="step-status ${cls}">${icon}</div><span>${esc(label)}</span></div>`;
      }).join('')
    : '<p class="text-secondary">No step data.</p>';
  showView('runDetail');
}

// ── Plans ─────────────────────────────────────────────────────────────────────

async function loadPlans() {
  const list = document.getElementById('plansList');
  list.textContent = 'Loading...';
  try {
    const plans = await apiCall('/api/plans');
    if (!plans) return;
    list.innerHTML = plans.length
      ? plans.map(p => `
          <div class="scenario-row">
            <div class="scenario-info">
              <div class="scenario-name">${esc(p.name)}</div>
              <div class="scenario-url">${(p.scenarioIds || []).length} scenario(s)</div>
            </div>
            <div class="actions">
              <button class="btn btn-danger btn-sm" data-action="delete-plan" data-id="${esc(p.id)}">Delete</button>
            </div>
          </div>`).join('')
      : '<p class="text-secondary">No plans yet.</p>';
  } catch (err) {
    list.textContent = 'Error loading plans.';
  }
}

async function showCreatePlanModal() {
  const scenarios = await apiCall('/api/scenarios');
  if (!scenarios) return;
  document.getElementById('planName').value = '';
  document.getElementById('planDesc').value = '';
  document.getElementById('planScenarioCheckboxes').innerHTML = scenarios.map(sc => `
    <label style="display:block;margin-bottom:0.5rem;cursor:pointer">
      <input type="checkbox" name="scenario" value="${esc(sc.id)}"> ${esc(sc.name)}
    </label>`).join('');
  openModal('planModal');
}

async function savePlan(e) {
  e.preventDefault();
  const scenarioIds = Array.from(
    document.querySelectorAll('input[name="scenario"]:checked')
  ).map(x => x.value);
  if (!scenarioIds.length) { alert('Select at least one scenario'); return; }
  try {
    await apiCall('/api/plans', 'POST', {
      name: document.getElementById('planName').value,
      description: document.getElementById('planDesc').value,
      scenarioIds,
    });
    closeModal('planModal');
    loadPlans();
  } catch (err) {
    alert('Create plan failed: ' + err.message);
  }
}

async function deletePlan(id) {
  if (!confirm('Delete this plan?')) return;
  try {
    await apiCall(`/api/plans/${id}`, 'DELETE');
    loadPlans();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Nav links
  document.querySelectorAll('nav a[data-view]').forEach(a => {
    a.addEventListener('click', () => showView(a.dataset.view));
  });

  // Auth
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // Static scenario detail buttons
  document.getElementById('newScenarioBtn').addEventListener('click', showCreateScenarioModal);
  document.getElementById('backToScenariosBtn').addEventListener('click', () => showView('scenarios'));
  document.getElementById('runBtn').addEventListener('click', () => runScenario(currentScenarioId));
  document.getElementById('editBtn').addEventListener('click', editScenario);
  document.getElementById('deleteBtn').addEventListener('click', () => deleteScenario(currentScenarioId));
  document.getElementById('backToRunsBtn').addEventListener('click', () => showView('runs'));
  document.getElementById('newPlanBtn').addEventListener('click', showCreatePlanModal);

  // Forms
  document.getElementById('scenarioForm').addEventListener('submit', saveScenario);
  document.getElementById('planForm').addEventListener('submit', savePlan);

  // Modal close (data-close)
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  // Click outside modal to close
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(modal.id); });
  });

  // Event delegation for dynamically generated buttons/rows
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    if (action === 'show-scenario') showScenarioDetail(id);
    else if (action === 'run-scenario') runScenario(id);
    else if (action === 'delete-scenario') deleteScenario(id);
    else if (action === 'show-run') showRunDetail(id);
    else if (action === 'delete-plan') deletePlan(id);
  });

  // Auto-login from stored token
  if (authToken) {
    apiCall('/api/auth/me').then(user => {
      if (!user) return;
      document.getElementById('username').textContent = user.username;
      document.getElementById('nav').style.display = 'flex';
      document.getElementById('loginView').classList.remove('active');
      showView('scenarios');
    }).catch(logout);
  }
});

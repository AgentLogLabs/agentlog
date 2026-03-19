const vscode = acquireVsCodeApi();
let state = { sessions: [], total: 0, page: 1, pageSize: 20, stats: {}, backendAlive: false, loading: false };

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'loadSessions':
      state.sessions = msg.payload.sessions;
      state.total = msg.payload.total;
      state.page = msg.payload.page;
      state.pageSize = msg.payload.pageSize;
      renderTable();
      break;
    case 'loadStats':
      state.stats = msg.payload;
      renderStats();
      break;
    case 'backendStatus':
      state.backendAlive = msg.payload.alive;
      renderStatusBadge();
      break;
    case 'loading':
      state.loading = msg.payload.loading;
      renderLoading();
      break;
    case 'error':
      showError(msg.payload.message);
      break;
  }
});

vscode.postMessage({ command: 'ready' });

function renderApp() {
  document.getElementById('app').innerHTML = `
    <div class="dashboard">
      <div class="sidebar">
        <div style="margin-bottom:16px">
          <span id="status-badge"><span class="status-dot offline"></span>离线</span>
        </div>
        <button class="primary" style="width:100%;margin-bottom:8px" onclick="exportReport('weekly-report')">📝 导出周报</button>
        <button class="secondary" style="width:100%;margin-bottom:8px" onclick="exportReport('pr-description')">🔗 导出 PR 说明</button>
        <button class="secondary" style="width:100%;margin-bottom:8px" onclick="exportReport('jsonl')">💾 导出 JSONL</button>
        <hr style="border-color:var(--vscode-widget-border);margin:12px 0">
        <button class="secondary" style="width:100%" onclick="openSettings()">⚙️ 设置</button>
      </div>
      <div class="main">
        <div id="stats-area" class="stat-cards"></div>
        <div class="search-bar">
          <input type="text" id="keyword" placeholder="搜索 Prompt / 回复…" onkeydown="if(event.key==='Enter') search()">
          <button class="primary" onclick="search()">搜索</button>
          <button class="secondary" onclick="resetSearch()">重置</button>
        </div>
        <div id="error-area"></div>
        <div id="loading-area"></div>
        <table>
          <thead>
            <tr>
              <th>时间</th><th>模型</th><th>来源</th><th>Prompt 预览</th><th>Commit</th><th>操作</th>
            </tr>
          </thead>
          <tbody id="sessions-tbody"></tbody>
        </table>
        <div class="pagination" id="pagination"></div>
      </div>
    </div>
  `;
}

renderApp();

function renderStats() {
  const s = state.stats;
  document.getElementById('stats-area').innerHTML = `
    <div class="stat-card"><div class="value">${s.total || 0}</div><div class="label">总会话数</div></div>
    <div class="stat-card"><div class="value">${s.boundToCommit || 0}</div><div class="label">已绑定</div></div>
    <div class="stat-card"><div class="value">${s.unbound || 0}</div><div class="label">未绑定</div></div>
    <div class="stat-card"><div class="value">${Math.round((s.avgDurationMs || 0) / 1000)}s</div><div class="label">平均耗时</div></div>
  `;
}

function renderTable() {
  const tbody = document.getElementById('sessions-tbody');
  if (!tbody) return;
  if (state.sessions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--vscode-descriptionForeground);padding:24px">暂无记录</td></tr>';
  } else {
    tbody.innerHTML = state.sessions.map(s => `
      <tr>
        <td style="white-space:nowrap;font-size:11px">${formatTime(s.createdAt)}</td>
        <td><span class="badge">${escHtml(s.model)}</span></td>
        <td><span class="badge">${escHtml(s.source)}</span></td>
        <td class="prompt-cell" onclick="viewSession('${escHtml(s.id)}')" title="${escHtml(s.prompt)}">${escHtml(s.prompt.slice(0, 60))}${s.prompt.length > 60 ? '…' : ''}</td>
        <td>${s.commitHash ? '<span class="badge" style="background:#16a34a;color:#fff">' + escHtml(s.commitHash.slice(0,7)) + '</span>' : '<span style="color:var(--vscode-descriptionForeground)">-</span>'}</td>
        <td>
          <button class="secondary" onclick="viewSession('${escHtml(s.id)}')">详情</button>
          <button class="secondary" onclick="deleteSession('${escHtml(s.id)}')" style="margin-left:4px">删除</button>
        </td>
      </tr>
    `).join('');
  }
  renderPagination();
}

function renderPagination() {
  const el = document.getElementById('pagination');
  if (!el) return;
  const totalPages = Math.ceil(state.total / state.pageSize);
  el.innerHTML = `
    <button class="secondary" onclick="goPage(${state.page - 1})" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
    <span>第 ${state.page} / ${totalPages} 页（共 ${state.total} 条）</span>
    <button class="secondary" onclick="goPage(${state.page + 1})" ${state.page >= totalPages ? 'disabled' : ''}>下一页</button>
  `;
}

function renderStatusBadge() {
  const el = document.getElementById('status-badge');
  if (!el) return;
  el.innerHTML = state.backendAlive
    ? '<span class="status-dot online"></span>后台在线'
    : '<span class="status-dot offline"></span>后台离线';
}

function renderLoading() {
  const el = document.getElementById('loading-area');
  if (el) el.innerHTML = state.loading ? '<div style="padding:8px;color:var(--vscode-descriptionForeground)">加载中…</div>' : '';
}

function showError(msg) {
  const el = document.getElementById('error-area');
  if (el) el.innerHTML = '<div class="error-banner">⚠️ ' + escHtml(msg) + '</div>';
  setTimeout(() => { if (el) el.innerHTML = ''; }, 5000);
}

function search() {
  const keyword = document.getElementById('keyword').value.trim();
  vscode.postMessage({ command: 'querySessions', data: { page: 1, pageSize: state.pageSize, keyword } });
}

function resetSearch() {
  document.getElementById('keyword').value = '';
  vscode.postMessage({ command: 'querySessions', data: { page: 1, pageSize: state.pageSize } });
}

function goPage(page) {
  const totalPages = Math.ceil(state.total / state.pageSize);
  if (page < 1 || page > totalPages) return;
  const keyword = document.getElementById('keyword').value.trim();
  vscode.postMessage({ command: 'querySessions', data: { page, pageSize: state.pageSize, keyword } });
}

function viewSession(id) {
  vscode.postMessage({ command: 'querySessions', data: { page: 1, pageSize: 1, keyword: id } });
}

function deleteSession(id) {
  vscode.postMessage({ command: 'deleteSession', data: { sessionId: id } });
}

function exportReport(format) {
  vscode.postMessage({ command: 'exportAll', data: { format, language: 'zh' } });
}

function openSettings() {
  vscode.postMessage({ command: 'openSettings' });
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch { return iso; }
}

/**
 * AgentLog Dashboard — Webview 端脚本
 *
 * 运行在 VS Code Webview 沙箱内（浏览器环境）。
 * 通过 acquireVsCodeApi() 与 Extension Host 通信。
 *
 * 功能：
 *  - Trace 列表（任务目标 / 状态 / 创建时间）
 *  - 状态过滤（全部 / 运行中 / 已完成 / 失败 / 已暂停）
 *  - 查看 Trace 详情
 */

const vscode = acquireVsCodeApi();

// ─────────────────────────────────────────────
// 全局状态
// ─────────────────────────────────────────────

let state = {
  traces: [],
  total: 0,
  page: 1,
  pageSize: 50,
  backendAlive: false,
  loading: false,
  statusFilter: '',
};

// ─────────────────────────────────────────────
// Extension Host → Webview 消息处理
// ─────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'loadTraces':
      state.traces = msg.payload.traces;
      state.total    = msg.payload.total;
      state.page     = msg.payload.page;
      state.pageSize = msg.payload.pageSize;
      renderTable();
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

// 通知 Extension Host 页面已就绪
vscode.postMessage({ command: 'ready' });

// ─────────────────────────────────────────────
// 初始渲染
// ─────────────────────────────────────────────

function renderApp() {
  document.getElementById('app').innerHTML = `
    <div class="dashboard">

      <!-- ── 侧边栏 ── -->
      <div class="sidebar">
        <div style="margin-bottom:16px">
          <span id="status-badge"><span class="status-dot offline"></span>离线</span>
        </div>

        <div class="sidebar-section-title">导出</div>
        <button class="primary sidebar-btn" onclick="exportReport('weekly-report')">📝 导出周报</button>
        <button class="secondary sidebar-btn" onclick="exportReport('pr-description')">🔗 导出 PR 说明</button>

        <hr class="sidebar-divider">
        <button class="secondary sidebar-btn" onclick="openSettings()">⚙️ 设置</button>

        <hr class="sidebar-divider">

        <div class="sidebar-section-title">状态过滤</div>
        <button class="sidebar-btn status-filter-btn" data-status="" onclick="setStatusFilter('')">全部</button>
        <button class="sidebar-btn status-filter-btn" data-status="running" onclick="setStatusFilter('running')">🟢 运行中</button>
        <button class="sidebar-btn status-filter-btn" data-status="completed" onclick="setStatusFilter('completed')">✅ 已完成</button>
        <button class="sidebar-btn status-filter-btn" data-status="failed" onclick="setStatusFilter('failed')">❌ 失败</button>
        <button class="sidebar-btn status-filter-btn" data-status="paused" onclick="setStatusFilter('paused')">⏸ 已暂停</button>
      </div>

      <!-- ── 主内容区 ── -->
      <div class="main">

        <!-- 统计卡片 -->
        <div id="stats-area" class="stat-cards"></div>

        <!-- 搜索栏 -->
        <div class="search-panel">
          <div class="search-row">
            <div class="search-field" style="flex:2">
              <label class="search-label">关键字搜索</label>
              <input type="text" id="q-keyword" class="search-input"
                placeholder="搜索任务目标…"
                onkeydown="if(event.key==='Enter') applySearch()">
            </div>
            <div class="search-actions" style="align-self:flex-end">
              <button class="primary" onclick="applySearch()">搜索</button>
              <button class="secondary" onclick="resetSearch()">重置</button>
            </div>
          </div>
        </div>

        <!-- 错误提示 / 加载指示 -->
        <div id="error-area"></div>
        <div id="loading-area"></div>

        <!-- Trace 列表表格 -->
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>任务目标</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="traces-tbody"></tbody>
        </table>

      </div>
    </div>
  `;
}

renderApp();

// ─────────────────────────────────────────────
// 状态过滤
// ─────────────────────────────────────────────

function setStatusFilter(status) {
  state.statusFilter = status;
  document.querySelectorAll('.status-filter-btn').forEach(btn => {
    btn.style.fontWeight = btn.dataset.status === status ? '700' : '';
  });
  applySearch();
}

// ─────────────────────────────────────────────
// 搜索 / 过滤逻辑
// ─────────────────────────────────────────────

function applySearch() {
  const keyword = val('q-keyword');
  const status = state.statusFilter;
  const filter = {};
  if (keyword) filter.keyword = keyword;
  if (status) filter.status = status;

  vscode.postMessage({
    command: 'queryTraces',
    data: { page: 1, pageSize: state.pageSize, ...filter }
  });
}

function resetSearch() {
  setVal('q-keyword', '');
  state.statusFilter = '';
  document.querySelectorAll('.status-filter-btn').forEach(btn => {
    btn.style.fontWeight = btn.dataset.status === '' ? '700' : '';
  });
  vscode.postMessage({
    command: 'queryTraces',
    data: { page: 1, pageSize: state.pageSize }
  });
}

// ─────────────────────────────────────────────
// 渲染：统计卡片
// ─────────────────────────────────────────────

function renderStats() {
  const traces = state.traces || [];
  const total = state.total || 0;
  const running = traces.filter(t => t.status === 'running').length;
  const completed = traces.filter(t => t.status === 'completed').length;
  const failed = traces.filter(t => t.status === 'failed').length;
  const paused = traces.filter(t => t.status === 'paused').length;

  const el = document.getElementById('stats-area');
  if (!el) return;

  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${total}</div>
      <div class="stat-label">全部 Trace</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color:#1e8cff">${running}</div>
      <div class="stat-label">运行中</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color:#4caf50">${completed}</div>
      <div class="stat-label">已完成</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color:#f44336">${failed}</div>
      <div class="stat-label">失败</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color:#ff9800">${paused}</div>
      <div class="stat-label">已暂停</div>
    </div>
  `;
}

// ─────────────────────────────────────────────
// 渲染：Trace 列表表格
// ─────────────────────────────────────────────

function renderTable() {
  const tbody = document.getElementById('traces-tbody');
  if (!tbody) return;

  if (state.traces.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-cell">
          暂无 Trace 记录
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = state.traces.map(t => {
    const statusBadge = getStatusBadge(t.status);
    return `
      <tr>
        <td class="nowrap time-cell">
          ${escHtml(formatTime(t.createdAt))}
        </td>
        <td class="prompt-cell" onclick="viewTrace('${escHtml(t.id)}')"
            title="${escHtml(t.taskGoal)}">
          ${escHtml(t.taskGoal || '(无任务目标)')}
        </td>
        <td>${statusBadge}</td>
        <td class="action-cell">
          <button class="secondary btn-sm" onclick="viewTrace('${escHtml(t.id)}')">详情</button>
        </td>
      </tr>`;
  }).join('');
}

function getStatusBadge(status) {
  switch (status) {
    case 'running':
      return '<span class="badge" style="background:#1e8cff30;color:#1e8cff">● 运行中</span>';
    case 'completed':
      return '<span class="badge" style="background:#4caf5030;color:#4caf50">✓ 已完成</span>';
    case 'failed':
      return '<span class="badge" style="background:#f4433630;color:#f44336">✗ 失败</span>';
    case 'paused':
      return '<span class="badge" style="background:#ff980030;color:#ff9800">⏸ 已暂停</span>';
    default:
      return `<span class="badge">${escHtml(status)}</span>`;
  }
}

// ─────────────────────────────────────────────
// 渲染：状态徽标 / 加载 / 错误
// ─────────────────────────────────────────────

function renderStatusBadge() {
  const el = document.getElementById('status-badge');
  if (!el) return;
  el.innerHTML = state.backendAlive
    ? '<span class="status-dot online"></span>后台在线'
    : '<span class="status-dot offline"></span>后台离线';
}

function renderLoading() {
  const el = document.getElementById('loading-area');
  if (el) el.innerHTML = state.loading
    ? '<div class="loading-tip"><span class="spinner-sm"></span> 加载中…</div>'
    : '';
}

function showError(msg) {
  const el = document.getElementById('error-area');
  if (el) {
    el.innerHTML = `<div class="error-banner">⚠️ ${escHtml(msg)}</div>`;
    setTimeout(() => { if (el) el.innerHTML = ''; }, 6000);
  }
}

// ─────────────────────────────────────────────
// 用户操作
// ─────────────────────────────────────────────

function viewTrace(id) {
  vscode.postMessage({ command: 'viewTraceDetail', data: { traceId: id } });
}

function exportReport(format) {
  vscode.postMessage({ command: 'exportAll', data: { format } });
}

function openSettings() {
  vscode.postMessage({ command: 'openSettings' });
}

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v;
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
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return iso; }
}

/**
 * AgentLog Dashboard — Webview 端脚本
 *
 * 运行在 VS Code Webview 沙箱内（浏览器环境）。
 * 通过 acquireVsCodeApi() 与 Extension Host 通信。
 *
 * 功能：
 *  - 统计卡片（总数 / 已绑定 / 未绑定 / 平均耗时）
 *  - 高级搜索面板（关键字 / 文件名 / 时间范围 / provider / source / 未绑定过滤）
 *  - 会话列表表格（分页）
 *  - 导出操作（周报 / PR 说明 / JSONL / CSV）
 */

const vscode = acquireVsCodeApi();

// ─────────────────────────────────────────────
// 全局状态
// ─────────────────────────────────────────────

let state = {
  sessions: [],
  total: 0,
  page: 1,
  pageSize: 20,
  stats: {},
  backendAlive: false,
  loading: false,
  // 当前生效的搜索条件（由 applySearch() 写入，goPage() 复用）
  currentFilter: {}
};

// ─────────────────────────────────────────────
// Extension Host → Webview 消息处理
// ─────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'loadSessions':
      state.sessions = msg.payload.sessions;
      state.total    = msg.payload.total;
      state.page     = msg.payload.page;
      state.pageSize = msg.payload.pageSize;
      renderTable();
      renderPagination();
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
        <button class="secondary sidebar-btn" onclick="exportReport('jsonl')">💾 导出 JSONL</button>
        <button class="secondary sidebar-btn" onclick="exportReport('csv')">📊 导出 CSV</button>

        <hr class="sidebar-divider">
        <button class="secondary sidebar-btn" onclick="openSettings()">⚙️ 设置</button>
      </div>

      <!-- ── 主内容区 ── -->
      <div class="main">

        <!-- 统计卡片 -->
        <div id="stats-area" class="stat-cards"></div>

        <!-- 高级搜索面板 -->
        <div class="search-panel">
          <div class="search-panel-header" onclick="toggleSearchPanel()">
            <span class="search-panel-title">🔍 搜索 &amp; 过滤</span>
            <span id="search-panel-toggle" class="search-panel-chevron">▼</span>
          </div>
          <div id="search-panel-body" class="search-panel-body">

            <!-- 第一行：关键字 + 文件名 -->
            <div class="search-row">
              <div class="search-field">
                <label class="search-label">关键字</label>
                <input type="text" id="q-keyword" class="search-input"
                  placeholder="搜索 Prompt / 回复 / 备注…"
                  onkeydown="if(event.key==='Enter') applySearch()">
              </div>
              <div class="search-field">
                <label class="search-label">文件名</label>
                <input type="text" id="q-filename" class="search-input"
                  placeholder="如 logService.ts（模糊匹配涉及文件）"
                  onkeydown="if(event.key==='Enter') applySearch()">
              </div>
            </div>

            <!-- 第二行：时间范围 -->
            <div class="search-row">
              <div class="search-field">
                <label class="search-label">开始日期</label>
                <input type="date" id="q-start-date" class="search-input">
              </div>
              <div class="search-field">
                <label class="search-label">结束日期</label>
                <input type="date" id="q-end-date" class="search-input">
              </div>
            </div>

            <!-- 第三行：provider / source / 未绑定 -->
            <div class="search-row">
              <div class="search-field">
                <label class="search-label">模型提供商</label>
                <select id="q-provider" class="search-select">
                  <option value="">全部</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="openai">OpenAI (GPT)</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="qwen">通义千问 (Qwen)</option>
                  <option value="kimi">Kimi (月之暗面)</option>
                  <option value="doubao">豆包 (Doubao)</option>
                  <option value="zhipu">智谱 (GLM)</option>
                  <option value="minimax">MiniMax</option>
                  <option value="ollama">Ollama (本地)</option>
                </select>
              </div>
              <div class="search-field">
                <label class="search-label">Agent 来源</label>
                <select id="q-source" class="search-select">
                  <option value="">全部</option>
                  <option value="opencode">OpenCode</option>
                  <option value="cline">Cline / Roo Code</option>
                  <option value="cursor">Cursor</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="copilot">GitHub Copilot</option>
                  <option value="continue">Continue</option>
                  <option value="mcp-tool-call">MCP 工具调用</option>
                  <option value="direct-api">直接 API</option>
                </select>
              </div>
              <div class="search-field search-field-checkbox">
                <label class="search-checkbox-label">
                  <input type="checkbox" id="q-unbound-only">
                  <span>仅显示未绑定 Commit</span>
                </label>
              </div>
            </div>

            <!-- 操作按钮 -->
            <div class="search-actions">
              <button class="primary" onclick="applySearch()">搜索</button>
              <button class="secondary" onclick="resetSearch()">重置</button>
              <span id="search-result-hint" class="search-hint"></span>
            </div>
          </div>
        </div>

        <!-- 错误提示 / 加载指示 -->
        <div id="error-area"></div>
        <div id="loading-area"></div>

        <!-- 会话列表表格 -->
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>来源</th>
              <th>Prompt 预览</th>
              <th>涉及文件</th>
              <th>Commit</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="sessions-tbody"></tbody>
        </table>

        <!-- 分页控件 -->
        <div class="pagination" id="pagination"></div>

      </div>
    </div>
  `;
}

renderApp();

// ─────────────────────────────────────────────
// 搜索面板折叠 / 展开
// ─────────────────────────────────────────────

let _searchPanelOpen = true;

function toggleSearchPanel() {
  _searchPanelOpen = !_searchPanelOpen;
  const body   = document.getElementById('search-panel-body');
  const toggle = document.getElementById('search-panel-toggle');
  if (body)   body.style.display   = _searchPanelOpen ? '' : 'none';
  if (toggle) toggle.textContent   = _searchPanelOpen ? '▼' : '▶';
}

// ─────────────────────────────────────────────
// 搜索 / 过滤逻辑
// ─────────────────────────────────────────────

/**
 * 读取搜索面板所有字段，构建 filter 对象并发送查询请求。
 * 文件名过滤在此标记，由 Extension Host 处理后在 MCP 端客户端过滤。
 */
function applySearch() {
  const keyword       = val('q-keyword');
  const filename      = val('q-filename');
  const startDate     = val('q-start-date');
  const endDate       = val('q-end-date');
  const provider      = val('q-provider');
  const source        = val('q-source');
  const unboundOnly   = document.getElementById('q-unbound-only').checked;

  const filter = {};
  if (keyword)     filter.keyword           = keyword;
  if (filename)    filter.filename          = filename;
  if (startDate)   filter.startDate         = startDate;
  if (endDate)     filter.endDate           = endDate;
  if (provider)    filter.provider          = provider;
  if (source)      filter.source            = source;
  if (unboundOnly) filter.onlyBoundToCommit = false;   // false = 未绑定
  if (unboundOnly) filter.onlyUnbound       = true;

  state.currentFilter = filter;

  vscode.postMessage({
    command: 'querySessions',
    data: { page: 1, pageSize: state.pageSize, ...filter }
  });
}

function resetSearch() {
  setVal('q-keyword',     '');
  setVal('q-filename',    '');
  setVal('q-start-date',  '');
  setVal('q-end-date',    '');
  setVal('q-provider',    '');
  setVal('q-source',      '');
  document.getElementById('q-unbound-only').checked = false;

  state.currentFilter = {};

  const hint = document.getElementById('search-result-hint');
  if (hint) hint.textContent = '';

  vscode.postMessage({
    command: 'querySessions',
    data: { page: 1, pageSize: state.pageSize }
  });
}

// ─────────────────────────────────────────────
// 渲染：统计卡片
// ─────────────────────────────────────────────

function renderStats() {
  const s   = state.stats;
  const el  = document.getElementById('stats-area');
  if (!el) return;

  // 构建 provider 分布迷你列表（取前 3 名）
  const byProvider = s.byProvider || {};
  const topProviders = Object.entries(byProvider)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([p, c]) => `<span class="stat-tag">${escHtml(p)} ${c}</span>`)
    .join('');

  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${s.total || 0}</div>
      <div class="stat-label">总会话数</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color:var(--vscode-gitDecoration-addedResourceForeground)">${s.boundToCommit || 0}</div>
      <div class="stat-label">已绑定 Commit</div>
    </div>
    <div class="stat-card">
      <div class="stat-value" style="color:var(--vscode-editorWarning-foreground)">${s.unbound || 0}</div>
      <div class="stat-label">未绑定</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${Math.round((s.avgDurationMs || 0) / 1000)}s</div>
      <div class="stat-label">平均耗时</div>
    </div>
    ${topProviders ? `<div class="stat-card stat-card-wide">
      <div class="stat-label" style="margin-bottom:6px">模型分布</div>
      <div>${topProviders}</div>
    </div>` : ''}
  `;
}

// ─────────────────────────────────────────────
// 渲染：会话列表表格
// ─────────────────────────────────────────────

function renderTable() {
  const tbody = document.getElementById('sessions-tbody');
  if (!tbody) return;

  if (state.sessions.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-cell">
          ${Object.keys(state.currentFilter).length > 0
            ? '没有符合条件的记录，请调整过滤条件'
            : '暂无 AI 交互记录'}
        </td>
      </tr>`;
    updateSearchHint(0);
    return;
  }

  tbody.innerHTML = state.sessions.map(s => {
    const files = (s.affectedFiles || []);
    const filesCell = files.length > 0
      ? files.slice(0, 2).map(f => `<code class="file-badge">${escHtml(basename(f))}</code>`).join(' ')
        + (files.length > 2 ? `<span class="more-badge">+${files.length - 2}</span>` : '')
      : '<span class="muted">—</span>';

    const commitCell = s.commitHash
      ? `<span class="badge commit-badge" title="${escHtml(s.commitHash)}">${escHtml(s.commitHash.slice(0, 7))}</span>`
      : `<span class="muted">—</span>`;

    const tokenInfo = s.tokenUsage
      ? formatTokens(s.tokenUsage)
      : '';

    return `
      <tr>
        <td class="nowrap time-cell">
          <div>${escHtml(formatTime(s.createdAt))}</div>
          ${tokenInfo ? `<div class="token-hint">${tokenInfo}</div>` : ''}
        </td>
        <td>
          <span class="badge provider-badge provider-${escHtml(s.provider)}">${escHtml(s.model)}</span>
        </td>
        <td>
          <span class="badge source-badge">${escHtml(s.source)}</span>
        </td>
        <td class="prompt-cell" onclick="viewSession('${escHtml(s.id)}')"
            title="${escHtml(s.prompt)}">
          ${escHtml(s.prompt.slice(0, 70))}${s.prompt.length > 70 ? '…' : ''}
        </td>
        <td class="files-cell">${filesCell}</td>
        <td>${commitCell}</td>
        <td class="action-cell">
          <button class="secondary btn-sm" onclick="viewSession('${escHtml(s.id)}')">详情</button>
          <button class="secondary btn-sm btn-danger" onclick="deleteSession('${escHtml(s.id)}')">删除</button>
        </td>
      </tr>`;
  }).join('');

  updateSearchHint(state.total);
}

// ─────────────────────────────────────────────
// 渲染：分页
// ─────────────────────────────────────────────

function renderPagination() {
  const el = document.getElementById('pagination');
  if (!el) return;
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  el.innerHTML = `
    <button class="secondary" onclick="goPage(${state.page - 1})"
      ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="page-info">第 ${state.page} / ${totalPages} 页（共 ${state.total} 条）</span>
    <button class="secondary" onclick="goPage(${state.page + 1})"
      ${state.page >= totalPages ? 'disabled' : ''}>下一页</button>
  `;
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

function updateSearchHint(total) {
  const hint = document.getElementById('search-result-hint');
  if (!hint) return;
  const hasFilter = Object.keys(state.currentFilter).length > 0;
  hint.textContent = hasFilter ? `找到 ${total} 条记录` : '';
}

// ─────────────────────────────────────────────
// 用户操作
// ─────────────────────────────────────────────

function goPage(page) {
  const totalPages = Math.ceil(state.total / state.pageSize);
  if (page < 1 || page > totalPages) return;
  vscode.postMessage({
    command: 'querySessions',
    data: { page, pageSize: state.pageSize, ...state.currentFilter }
  });
}

function viewSession(id) {
  vscode.postMessage({ command: 'viewSessionDetail', data: { sessionId: id } });
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

function basename(filepath) {
  return filepath.split('/').pop() || filepath;
}

function formatTokens(u) {
  const total = (u.inputTokens || 0) + (u.outputTokens || 0)
    + (u.cacheCreationTokens || 0) + (u.cacheReadTokens || 0);
  if (total === 0) return '';
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tok`;
  if (total >= 1_000)     return `${(total / 1_000).toFixed(1)}K tok`;
  return `${total} tok`;
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

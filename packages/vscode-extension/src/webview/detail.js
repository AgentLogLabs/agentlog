// Webview script for session detail panel
// This file is loaded externally to avoid document.write() issues

const vscode = acquireVsCodeApi();
let currentSession = null;

function dbg(msg) {
  console.log("[DetailWebview]", msg);
  vscode.postMessage({
    command: "debug",
    data: { message: "[DetailWebview] " + msg },
  });
}

dbg("脚本开始执行");

// Handle messages from extension host
window.addEventListener("message", (event) => {
  const msg = event.data;
  dbg("收到消息 type=" + msg.type);

  switch (msg.type) {
    case "loadSession":
      currentSession = msg.payload;
      renderSession(msg.payload);
      break;
    case "updateSession":
      currentSession = msg.payload;
      renderSession(msg.payload);
      break;
    case "loading":
      if (msg.payload.loading) {
        dbg("显示 loading 遮罩");
        document.getElementById("app").innerHTML =
          '<div class="loading-screen"><div class="spinner"></div><p>加载中…</p></div>';
      }
      break;
    case "error":
      dbg("显示错误：" + msg.payload.message);
      document.getElementById("app").innerHTML =
        '<div class="error-banner">⚠️ ' +
        escHtml(msg.payload.message) +
        "</div>";
      break;
    case "exportResult":
      vscode.postMessage({
        command: "openInEditor",
        data: { content: msg.payload.content, language: "markdown" },
      });
      break;
    case "backendStatus":
      updateStatusIndicator(msg.payload.alive);
      break;
  }
});

// Signal ready
dbg("发送 ready 消息");
vscode.postMessage({ command: "ready" });
dbg("ready 消息已发送");

function renderSession(s) {
  const commitBadges = s.sessionCommits && s.sessionCommits.length > 0
    ? s.sessionCommits.map(sc => 
        '<span class="badge commit" title="绑定于 ' + escHtml(sc.createdAt) + '">✓ ' +
        escHtml(sc.commitHash.slice(0, 8)) +
        '</span>'
      ).join(' ')
    : s.commitHash
    ? '<span class="badge commit">✓ ' +
      escHtml(s.commitHash.slice(0, 8)) +
      "</span>"
    : '<span class="badge unbound">未绑定</span>';

  const tags = (s.tags || [])
    .map(
      (t) =>
        '<span class="tag">' +
        escHtml(t) +
        ' <span class="tag-remove" onclick="removeTag(\'' +
        escHtml(t) +
        "')\">×</span></span>",
    )
    .join(" ");

  const reasoningBlock = s.reasoning
    ? '<div class="section collapsed"><div class="section-header" onclick="toggleSection(this)"><h2>💡 推理过程 (' +
      s.reasoning.length +
      " 字符)</h2><span>▶</span></div>" +
      '<div class="section-body" style="display:none"><pre class="reasoning-block">' +
      escHtml(s.reasoning) +
      "</pre></div></div>"
    : "";

  // ── transcript block ──────────────────────────────────────────────────
  const transcriptBlock =
    s.transcript && s.transcript.length > 0
      ? '<div class="section"><div class="section-header" onclick="toggleSection(this)"><h2>📜 交互记录 (' +
        s.transcript.length +
        " 轮)</h2><span>▼</span></div>" +
        '<div class="section-body transcript-list">' +
        s.transcript
          .map((turn) => {
            const roleLabel =
              turn.role === "user"
                ? '<span class="turn-role role-user">User</span>'
                : turn.role === "assistant"
                  ? '<span class="turn-role role-assistant">Assistant</span>'
                  : '<span class="turn-role role-tool">' +
                    escHtml(turn.toolName ? "Tool:" + turn.toolName : "Tool") +
                    "</span>";
            const timestamp = turn.timestamp
              ? '<span class="turn-ts">' +
                escHtml(formatTime(turn.timestamp)) +
                "</span>"
              : "";
            const inputHint =
              turn.toolInput
                ? '<div class="turn-input"><span class="turn-input-label">Input</span><code>' +
                  escHtml(turn.toolInput.slice(0, 200)) +
                  (turn.toolInput.length > 200 ? "…" : "") +
                  "</code></div>"
                : "";
            // 推理过程：仅 assistant 且有 reasoning 时展示，默认折叠
            const reasoningHtml =
              turn.role === "assistant" && turn.reasoning && turn.reasoning.trim()
                ? '<div class="turn-reasoning">' +
                  '<div class="turn-reasoning-toggle" onclick="toggleTurnReasoning(this)">' +
                  "▶ 推理过程 (" + turn.reasoning.length + " 字符)" +
                  "</div>" +
                  '<pre class="turn-reasoning-body" style="display:none">' +
                  escHtml(turn.reasoning) +
                  "</pre></div>"
                : "";
            return (
              '<div class="turn-item turn-' +
              escHtml(turn.role) +
              '">' +
              '<div class="turn-meta">' + roleLabel + timestamp + "</div>" +
              inputHint +
              '<pre class="turn-content">' +
              escHtml(turn.content) +
              "</pre>" +
              reasoningHtml +
              "</div>"
            );
          })
          .join("") +
        "</div></div>"
      : "";

  // ── tokenUsage block ──────────────────────────────────────────────────
  const tokenUsageBlock = s.tokenUsage
    ? (function () {
        const u = s.tokenUsage;
        const total =
          (u.inputTokens || 0) +
          (u.outputTokens || 0) +
          (u.cacheCreationTokens || 0) +
          (u.cacheReadTokens || 0);
        const rows = [
          ["总计", total.toLocaleString()],
          ["输入", (u.inputTokens || 0).toLocaleString()],
          ["输出", (u.outputTokens || 0).toLocaleString()],
        ];
        if (u.cacheCreationTokens) {
          rows.push(["缓存写入", u.cacheCreationTokens.toLocaleString()]);
        }
        if (u.cacheReadTokens) {
          rows.push(["缓存命中", u.cacheReadTokens.toLocaleString()]);
        }
        if (u.apiCallCount) {
          rows.push(["API 调用", String(u.apiCallCount)]);
        }
        return (
          '<div class="section"><div class="section-header" onclick="toggleSection(this)"><h2>🪙 Token 用量</h2><span>▼</span></div>' +
          '<div class="section-body"><table class="token-table">' +
          rows
            .map(
              (r, i) =>
                '<tr' +
                (i === 0 ? ' class="token-total"' : "") +
                "><td>" +
                escHtml(r[0]) +
                "</td><td>" +
                escHtml(r[1]) +
                "</td></tr>",
            )
            .join("") +
          "</table></div></div>"
        );
      })()
    : "";

  const affectedFilesBlock =
    s.affectedFiles && s.affectedFiles.length > 0
      ? '<div class="section"><div class="section-header"><h2>📁 涉及文件</h2></div><div class="section-body">' +
        s.affectedFiles
          .map((f) => "<code>" + escHtml(f) + "</code>")
          .join("  ") +
        "</div></div>"
      : "";

  document.getElementById("app").innerHTML = `
    <div class="session-detail">
      <div class="header">
        <div class="header-left">
          <h1>${escHtml(s.model)} <span id="status-dot" class="status-dot"></span></h1>
          <div class="meta-row">
            <span class="badge provider-${escHtml(s.provider)}">${escHtml(s.provider)}</span>
            <span class="badge source-${escHtml(s.source)}">${escHtml(s.source)}</span>
            ${commitBadges}
            <span style="color:var(--vscode-descriptionForeground);font-size:11px">${escHtml(formatTime(s.createdAt))} · ${formatDuration(s.durationMs)}</span>
          </div>
          <div class="session-id-bar">
            <span class="session-id-label">Session ID</span>
            <code class="session-id-value" id="session-id-text" title="${escHtml(s.id)}">${escHtml(s.id)}</code>
            <button class="session-id-copy" id="session-id-copy-btn" onclick="copySessionId()" title="复制完整 Session ID">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4zm0 1h5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>
                <path d="M10 1h1a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-1v-1h1a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1h-1V1z"/>
              </svg>
              复制
            </button>
          </div>
        </div>
        <div class="header-actions">
          <button class="secondary" onclick="copyContent()">复制回复</button>
          <button class="secondary" onclick="openInEditor()">在编辑器打开</button>
          <button class="danger" onclick="deleteSession()">删除</button>
        </div>
      </div>

      <div class="section">
        <div class="section-header" onclick="toggleSection(this)"><h2>📝 Prompt</h2><span>▼</span></div>
        <div class="section-body"><pre>${escHtml(s.prompt)}</pre></div>
      </div>

      ${reasoningBlock}

      ${transcriptBlock}

      ${tokenUsageBlock}

      <div class="section">
        <div class="section-header" onclick="toggleSection(this)"><h2>🤖 AI 回复</h2><span>▼</span></div>
        <div class="section-body"><pre>${escHtml(s.response)}</pre></div>
      </div>

      <div class="section">
        <div class="section-header"><h2>🏷️ 标签 & 备注</h2></div>
        <div class="section-body">
          <div style="margin-bottom:10px">${tags || '<span style="color:var(--vscode-descriptionForeground)">暂无标签</span>'}</div>
          <div style="display:flex;gap:6px;margin-bottom:12px">
            <input type="text" id="tag-input" placeholder="输入标签后按 Enter" style="flex:1" onkeydown="addTagOnEnter(event)">
            <button class="secondary" onclick="addTag()">添加</button>
          </div>
          <textarea id="note-input" placeholder="添加备注说明…" onblur="saveNote()">${escHtml(s.note || "")}</textarea>
        </div>
      </div>

      <div class="section">
        <div class="section-header"><h2>🔗 Commit 绑定</h2></div>
        <div class="section-body" style="display:flex;gap:8px;align-items:center">
          <input type="text" id="commit-input" placeholder="输入 Git Commit Hash" value="${escHtml(s.commitHash || "")}" style="flex:1">
          <button class="primary" onclick="bindCommit()">绑定</button>
          ${s.commitHash ? '<button class="secondary" onclick="unbindCommit()">解绑</button>' : ""}
        </div>
      </div>

      ${affectedFilesBlock}
    </div>
  `;

  vscode.postMessage({ command: "checkBackend" });
  dbg("renderSession 完成");
}

function toggleSection(header) {
  const body = header.nextElementSibling;
  const arrow = header.querySelector("span:last-child");
  if (body) {
    if (body.style.display === "none") {
      body.style.display = "";
      if (arrow) arrow.textContent = "▼";
    } else {
      body.style.display = "none";
      if (arrow) arrow.textContent = "▶";
    }
  }
}

function addTag() {
  const input = document.getElementById("tag-input");
  const tag = (input.value || "").trim();
  if (!tag || !currentSession) return;
  const newTags = [...(currentSession.tags || [])];
  if (!newTags.includes(tag)) newTags.push(tag);
  input.value = "";
  vscode.postMessage({
    command: "updateTags",
    data: { sessionId: currentSession.id, tags: newTags },
  });
}

function addTagOnEnter(e) {
  if (e.key === "Enter") addTag();
}

function removeTag(tag) {
  if (!currentSession) return;
  const newTags = (currentSession.tags || []).filter((t) => t !== tag);
  vscode.postMessage({
    command: "updateTags",
    data: { sessionId: currentSession.id, tags: newTags },
  });
}

function saveNote() {
  const note = document.getElementById("note-input").value;
  if (!currentSession) return;
  vscode.postMessage({
    command: "updateNote",
    data: { sessionId: currentSession.id, note },
  });
}

function bindCommit() {
  const hash = document.getElementById("commit-input").value.trim();
  if (!hash || !currentSession) return;
  vscode.postMessage({
    command: "bindCommit",
    data: { sessionId: currentSession.id, commitHash: hash },
  });
}

function unbindCommit() {
  if (!currentSession) return;
  vscode.postMessage({
    command: "unbindCommit",
    data: { sessionId: currentSession.id },
  });
}

function deleteSession() {
  if (!currentSession) return;
  vscode.postMessage({
    command: "deleteSession",
    data: { sessionId: currentSession.id },
  });
}

function copySessionId() {
  if (!currentSession) return;
  vscode.postMessage({
    command: "copyToClipboard",
    data: { text: currentSession.id },
  });
  // 视觉反馈：按钮短暂变为"已复制"
  const btn = document.getElementById("session-id-copy-btn");
  if (btn) {
    const orig = btn.innerHTML;
    btn.textContent = "✓ 已复制";
    btn.classList.add("session-id-copy-ok");
    setTimeout(() => {
      btn.innerHTML = orig;
      btn.classList.remove("session-id-copy-ok");
    }, 1500);
  }
}

function copyContent() {
  if (!currentSession) return;
  vscode.postMessage({
    command: "copyToClipboard",
    data: { text: currentSession.response },
  });
}

function openInEditor() {
  if (!currentSession) return;
  vscode.postMessage({
    command: "openInEditor",
    data: { content: currentSession.response, language: "markdown" },
  });
}

function updateStatusIndicator(alive) {
  const dot = document.getElementById("status-dot");
  if (dot) {
    dot.className = "status-dot " + (alive ? "online" : "offline");
  }
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      "-" +
      p(d.getMonth() + 1) +
      "-" +
      p(d.getDate()) +
      " " +
      p(d.getHours()) +
      ":" +
      p(d.getMinutes())
    );
  } catch {
    return iso;
  }
}

function formatDuration(ms) {
  if (!ms) return "";
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}

function toggleTurnReasoning(toggle) {
  const body = toggle.nextElementSibling;
  if (!body) return;
  if (body.style.display === "none") {
    body.style.display = "";
    toggle.textContent = toggle.textContent.replace("▶", "▼");
  } else {
    body.style.display = "none";
    toggle.textContent = toggle.textContent.replace("▼", "▶");
  }
}

// Expose functions to global scope for onclick handlers
window.toggleSection = toggleSection;
window.toggleTurnReasoning = toggleTurnReasoning;
window.addTag = addTag;
window.addTagOnEnter = addTagOnEnter;
window.removeTag = removeTag;
window.saveNote = saveNote;
window.bindCommit = bindCommit;
window.unbindCommit = unbindCommit;
window.deleteSession = deleteSession;
window.copySessionId = copySessionId;
window.copyContent = copyContent;
window.openInEditor = openInEditor;

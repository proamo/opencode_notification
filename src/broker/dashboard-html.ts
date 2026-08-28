export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCode Commander | Live Dashboard</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220%22><text y=%2226%22 font-size=%2226%22>🤖</text></svg>">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(18, 24, 39, 0.85);
      --card-border: rgba(255, 255, 255, 0.08);
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --accent-glow: rgba(99, 102, 241, 0.3);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --green: #10b981;
      --green-glow: rgba(16, 185, 129, 0.25);
      --red: #ef4444;
      --red-glow: rgba(239, 68, 68, 0.25);
      --yellow: #f59e0b;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: var(--font); }
    body { background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
    
    /* Header */
    header {
      background: rgba(15, 23, 42, 0.8);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--card-border);
      padding: 16px 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo { font-size: 26px; }
    .brand-title { font-size: 20px; font-weight: 700; background: linear-gradient(135deg, #a5b4fc, #6366f1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .brand-badge { font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 9999px; background: rgba(99, 102, 241, 0.2); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.3); }

    .header-status { display: flex; align-items: center; gap: 20px; font-size: 13px; color: var(--text-muted); }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 10px var(--green); animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.1); } }

    /* Navigation Tabs */
    .tabs { display: flex; gap: 8px; padding: 16px 28px 0; border-bottom: 1px solid var(--card-border); background: rgba(15, 23, 42, 0.4); }
    .tab-btn {
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-muted);
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s;
    }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active { color: #818cf8; border-bottom-color: #818cf8; }

    /* Main Container */
    main { flex: 1; padding: 28px; max-width: 1400px; margin: 0 auto; width: 100%; }
    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeIn 0.25s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    /* Stats Grid */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px; margin-bottom: 24px; }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 20px;
      backdrop-filter: blur(10px);
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    }
    .stat-label { font-size: 13px; color: var(--text-muted); margin-bottom: 6px; font-weight: 500; }
    .stat-value { font-size: 28px; font-weight: 700; color: #fff; }
    .stat-sub { font-size: 12px; color: #6ee7b7; margin-top: 4px; }

    /* Machines & Projects Cards */
    .machine-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.25);
    }
    .machine-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--card-border); }
    .machine-title { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 700; color: #fff; }
    .machine-badge { font-size: 12px; padding: 4px 10px; border-radius: 8px; background: rgba(16, 185, 129, 0.15); color: #34d399; font-weight: 600; border: 1px solid rgba(16, 185, 129, 0.2); }
    
    .project-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
    .project-card {
      background: rgba(30, 41, 59, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      padding: 16px;
      transition: all 0.2s;
    }
    .project-card:hover { border-color: rgba(99, 102, 241, 0.4); transform: translateY(-2px); }
    .project-name { font-size: 15px; font-weight: 700; color: #e0e7ff; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
    .project-session { font-size: 12px; color: var(--text-muted); }
    .project-actions { margin-top: 12px; display: flex; gap: 8px; }

    /* Tables */
    .table-container { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
    th { background: rgba(30, 41, 59, 0.8); padding: 14px 18px; font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--card-border); }
    td { padding: 14px 18px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); color: var(--text); }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }

    /* Buttons & Forms */
    .btn {
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: var(--accent-hover); box-shadow: 0 0 12px var(--accent-glow); }
    .btn-secondary { background: rgba(255, 255, 255, 0.1); color: #e0e7ff; border: 1px solid var(--card-border); }
    .btn-secondary:hover { background: rgba(255, 255, 255, 0.18); }
    .btn-danger { background: rgba(239, 68, 68, 0.2); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }
    .btn-danger:hover { background: var(--red); color: #fff; box-shadow: 0 0 12px var(--red-glow); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .form-group { margin-bottom: 18px; }
    .form-label { display: block; font-size: 13px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; }
    .form-control {
      width: 100%;
      padding: 12px 16px;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      color: #fff;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    .form-control:focus { border-color: var(--accent); }
    textarea.form-control { resize: vertical; min-height: 100px; }

    .provider-box {
      background: rgba(30, 41, 59, 0.4);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 18px;
    }

    .test-result-box {
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
      margin-top: 12px;
      display: none;
    }
    .test-result-box.success { display: block; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; color: #34d399; }
    .test-result-box.error { display: block; background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; color: #f87171; }
    .test-result-box.testing { display: block; background: rgba(99, 102, 241, 0.15); border: 1px solid #6366f1; color: #a5b4fc; }

    /* Alert / Notification Toast */
    #toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 14px 22px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      background: #1f2937;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 8px 30px rgba(0,0,0,0.5);
      opacity: 0;
      transform: translateY(12px);
      transition: all 0.3s;
      z-index: 100;
      pointer-events: none;
    }
    #toast.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
    #toast.success { background: #065f46; border-color: #10b981; }
    #toast.error { background: #7f1d1d; border-color: #ef4444; }

    footer { padding: 20px 28px; text-align: center; font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--card-border); }

    /* RWD Media Queries for Mobile & Tablet */
    @media (max-width: 768px) {
      header {
        flex-direction: column;
        align-items: flex-start;
        gap: 12px;
        padding: 14px 18px;
      }
      .header-status {
        width: 100%;
        justify-content: space-between;
      }
      .tabs {
        padding: 10px 14px 0;
        overflow-x: auto;
        white-space: nowrap;
        -webkit-overflow-scrolling: touch;
      }
      .tab-btn {
        padding: 8px 14px;
        font-size: 13px;
      }
      main {
        padding: 16px;
      }
      .stats-grid {
        grid-template-columns: 1fr;
        gap: 12px;
      }
      .project-grid {
        grid-template-columns: 1fr;
      }
      .table-container {
        overflow-x: auto;
      }
      #toast {
        left: 16px;
        right: 16px;
        bottom: 16px;
        text-align: center;
      }
    }
  </style>
</head>
<body>

  <!-- Header -->
  <header>
    <div class="brand">
      <span class="brand-logo">🤖</span>
      <span class="brand-title">OpenCode Commander</span>
      <span class="brand-badge">V3.0 Gateway</span>
    </div>
    <div class="header-status">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="live-dot"></span>
        <span id="gateway-status-text">Gateway Online</span>
      </div>
      <span id="uptime-text">Uptime: 0m</span>
    </div>
  </header>

  <!-- Navigation Tabs -->
  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('nodes')">🖥️ 拓撲總覽 (Nodes)</button>
    <button class="tab-btn" onclick="switchTab('sessions')">📝 活躍工作 (Sessions)</button>
    <button class="tab-btn" onclick="switchTab('dispatch')">🚀 遠端派工 (Dispatch)</button>
    <button class="tab-btn" onclick="switchTab('settings')">⚙️ 系統設定 (Settings)</button>
  </div>

  <main>
    <!-- Stats Row -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">連線主機數 / Machines</div>
        <div class="stat-value" id="stat-machines">0</div>
        <div class="stat-sub">🟢 全部主機健康連線中</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">在線專案視窗 / Connections</div>
        <div class="stat-value" id="stat-connections">0</div>
        <div class="stat-sub">OpenCode 工作空間已就緒</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">進行中任務 / Active Sessions</div>
        <div class="stat-value" id="stat-sessions">0</div>
        <div class="stat-sub">即時雙向事件串流中</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">生效語音引擎 / Voice STT</div>
        <div class="stat-value" id="stat-voice" style="font-size: 18px; color: #a5b4fc;">檢測中...</div>
        <div class="stat-sub" id="stat-voice-sub">繁體中文極速轉譯就緒</div>
      </div>
    </div>

    <!-- TAB 1: NODES TOPOLOGY -->
    <div id="tab-nodes" class="tab-content active">
      <h2 style="font-size: 18px; margin-bottom: 16px; color: #fff;">🌐 已連線電腦與專案清單 (Cluster Topology)</h2>
      <div id="machines-container">
        <!-- Dynamic machine cards inserted here -->
      </div>
    </div>

    <!-- TAB 2: ACTIVE SESSIONS -->
    <div id="tab-sessions" class="tab-content">
      <h2 style="font-size: 18px; margin-bottom: 16px; color: #fff;">📝 進行中的工作階段 (Active Sessions)</h2>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>主機 (Host)</th>
              <th>專案 (Project)</th>
              <th>任務標題 (Session Title)</th>
              <th>Session ID</th>
              <th>操作 (Action)</th>
            </tr>
          </thead>
          <tbody id="sessions-tbody">
            <tr>
              <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">目前沒有任何執行中的工作階段。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- TAB 3: REMOTE DISPATCH CONSOLE -->
    <div id="tab-dispatch" class="tab-content">
      <h2 style="font-size: 18px; margin-bottom: 16px; color: #fff;">🚀 遠端派工控制台 (Proactive Remote Dispatch)</h2>
      <div class="stat-card" style="max-width: 800px;">
        <div class="form-group">
          <label class="form-label">🎯 目標主機與專案 (Target)</label>
          <select id="dispatch-target" class="form-control">
            <option value="">-- 自動偵測 / 唯一在線專案 --</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">📝 任務提示詞 / 指令 (Prompt)</label>
          <textarea id="dispatch-prompt" class="form-control" placeholder="請輸入欲指派給 OpenCode 執行的任務，例如：請檢查爬蟲日誌是否有錯誤並修復..."></textarea>
        </div>
        <button class="btn btn-primary" onclick="submitDispatch()" style="padding: 12px 24px; font-size: 15px;">
          🚀 立即發送派工 (Dispatch Task)
        </button>
      </div>
    </div>

    <!-- TAB 4: SETTINGS -->
    <div id="tab-settings" class="tab-content">
      <h2 style="font-size: 18px; margin-bottom: 16px; color: #fff;">⚙️ 系統與語音辨識設定 (Settings)</h2>
      <div class="stat-card" style="max-width: 800px;">
        
        <div class="form-group">
          <label class="form-label">🎙️ 選擇欲設定的語音辨識引擎 (STT Provider)</label>
          <select id="setting-provider" class="form-control" onchange="onProviderChange()">
            <option value="cloudflare">Cloudflare Workers AI (每日 10,000 次免費)</option>
            <option value="groq">Groq Whisper (每分鐘 20 次免費、極速推論)</option>
            <option value="openai">OpenAI Whisper (官方標準 API)</option>
            <option value="custom">自訂 / 本地相容端點 (Custom / Local Endpoint)</option>
          </select>
        </div>

        <!-- Provider Dynamic Form Container -->
        <div class="provider-box">
          <!-- Cloudflare Section -->
          <div id="section-cloudflare" class="provider-section">
            <div style="font-size: 13px; color: #a5b4fc; margin-bottom: 12px;">
              ☁️ <b>Cloudflare Workers AI</b>：提供每日 10,000 次超大免費額度，適合高頻率語音派工。
            </div>
            <div class="form-group">
              <label class="form-label">🏢 Cloudflare Account ID</label>
              <input type="text" id="cf-account-id" class="form-control" placeholder="例如: 2fa0dd0cbd72565d704fb330d85ad604">
            </div>
            <div class="form-group">
              <label class="form-label">🔑 Cloudflare API Token (需具備 Workers AI: Read 權限)</label>
              <input type="password" id="cf-api-token" class="form-control" placeholder="例如: cfut_...">
            </div>
          </div>

          <!-- Groq Section -->
          <div id="section-groq" class="provider-section" style="display: none;">
            <div style="font-size: 13px; color: #a5b4fc; margin-bottom: 12px;">
              ⚡ <b>Groq Whisper</b>：以 LPU 極速推論晶片運行，0.2 秒極速轉譯。
            </div>
            <div class="form-group">
              <label class="form-label">🔑 Groq API Key</label>
              <input type="password" id="groq-api-key" class="form-control" placeholder="例如: gsk_...">
            </div>
          </div>

          <!-- OpenAI Section -->
          <div id="section-openai" class="provider-section" style="display: none;">
            <div style="font-size: 13px; color: #a5b4fc; margin-bottom: 12px;">
              🪙 <b>OpenAI Whisper</b>：官方標準 Whisper API。
            </div>
            <div class="form-group">
              <label class="form-label">🔑 OpenAI API Key</label>
              <input type="password" id="openai-api-key" class="form-control" placeholder="例如: sk-...">
            </div>
          </div>

          <!-- Custom Section -->
          <div id="section-custom" class="provider-section" style="display: none;">
            <div style="font-size: 13px; color: #a5b4fc; margin-bottom: 12px;">
              💻 <b>自訂 / 本地端點</b>：適用自架 whisper.cpp、faster-whisper 或相容伺服器。
            </div>
            <div class="form-group">
              <label class="form-label">🌐 自訂端點 URL (Endpoint URL)</label>
              <input type="text" id="custom-endpoint" class="form-control" placeholder="http://127.0.0.1:8000/v1/audio/transcriptions">
            </div>
            <div class="form-group">
              <label class="form-label">🔑 自訂 API Key (選填)</label>
              <input type="password" id="custom-api-key" class="form-control" placeholder="自訂金鑰 (若無需金鑰可留空)">
            </div>
            <div class="form-group">
              <label class="form-label">🏷️ 模型名稱 (Model Name)</label>
              <input type="text" id="custom-model" class="form-control" value="whisper-large-v3-turbo">
            </div>
          </div>

          <!-- Test Connection Button & Result Box -->
          <div style="display: flex; align-items: center; gap: 12px; margin-top: 8px;">
            <button class="btn btn-secondary" type="button" onclick="testCurrentVoiceProvider()">
              🧪 測試連線與驗證金鑰 (Test Connection)
            </button>
          </div>
          <div id="test-voice-result" class="test-result-box"></div>
        </div>

        <!-- Global TTL Setting -->
        <div class="form-group">
          <label class="form-label">⏱️ Session 歷史回覆保存天數 (TTL)</label>
          <input type="number" id="setting-ttl" class="form-control" value="30" min="1" max="365">
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">
            預設 30 天內，隨時在 Telegram 回覆舊通知皆能直接接續交談。
          </div>
        </div>

        <button id="btn-save-settings" class="btn btn-primary" onclick="saveSettings()" style="padding: 12px 24px; font-size: 14px;">
          💾 儲存並套用設定 (Save Settings)
        </button>
      </div>
    </div>
  </main>

  <!-- Toast Notification -->
  <div id="toast"></div>

  <footer>
    OpenCode Telegram Link V3.0 • Privacy-first remote development and monitoring
  </footer>

  <script>
    let summaryData = null;
    let testedVerifiedProvider = null;

    function showToast(msg, type = 'info') {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'show ' + type;
      setTimeout(() => { t.className = ''; }, 3500);
    }

    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      const activeBtn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick').includes(tabId));
      if (activeBtn) activeBtn.classList.add('active');
      const targetContent = document.getElementById('tab-' + tabId);
      if (targetContent) targetContent.classList.add('active');
    }

    function onProviderChange() {
      const p = document.getElementById('setting-provider').value;
      document.getElementById('section-cloudflare').style.display = p === 'cloudflare' ? 'block' : 'none';
      document.getElementById('section-groq').style.display = p === 'groq' ? 'block' : 'none';
      document.getElementById('section-openai').style.display = p === 'openai' ? 'block' : 'none';
      document.getElementById('section-custom').style.display = p === 'custom' ? 'block' : 'none';

      // Reset test result box when switching provider
      const resBox = document.getElementById('test-voice-result');
      resBox.className = 'test-result-box';
      resBox.style.display = 'none';
      resBox.innerHTML = '';
    }

    async function fetchSummary() {
      try {
        const res = await fetch('/v1/api/dashboard/summary');
        if (!res.ok) return;
        const data = await res.json();
        summaryData = data;
        renderDashboard(data);
      } catch (err) {
        console.error('Fetch summary error:', err);
      }
    }

    function renderDashboard(data) {
      document.getElementById('stat-machines').textContent = data.machines ? data.machines.length : 0;
      document.getElementById('stat-connections').textContent = data.connectionsCount || 0;
      document.getElementById('stat-sessions').textContent = data.activeSessions ? data.activeSessions.length : 0;
      document.getElementById('uptime-text').textContent = 'Uptime: ' + (data.uptimeFormatted || '0m');

      // Render Active Voice Provider Badge & auto-populate settings
      if (data.voice) {
        const p = data.voice.provider;
        const activeP = data.voice.activeProvider || p;
        const statVoice = document.getElementById('stat-voice');
        const statVoiceSub = document.getElementById('stat-voice-sub');
        if (p === 'cloudflare') {
          statVoice.textContent = 'Cloudflare AI';
          statVoice.style.color = '#34d399';
          statVoiceSub.textContent = '🟢 每日 1 萬次額度已就緒';
        } else if (p === 'groq') {
          statVoice.textContent = 'Groq Whisper';
          statVoice.style.color = '#34d399';
          statVoiceSub.textContent = '🟢 0.2s 極速轉譯就緒';
        } else if (p === 'openai') {
          statVoice.textContent = 'OpenAI Whisper';
          statVoice.style.color = '#34d399';
          statVoiceSub.textContent = '🟢 官方 API 就緒';
        } else if (p === 'custom') {
          statVoice.textContent = '自訂語音端點';
          statVoice.style.color = '#34d399';
          statVoiceSub.textContent = '🟢 自訂端點就緒';
        } else {
          statVoice.textContent = '未啟用語音';
          statVoice.style.color = '#f87171';
          statVoiceSub.textContent = '🟡 請在設定頁填寫金鑰';
        }

        // On first summary load, populate form fields for ALL providers
        if (!window._settingsPopulated) {
          window._settingsPopulated = true;
          if (activeP && activeP !== 'none') {
            document.getElementById('setting-provider').value = activeP;
          }
          if (data.voice.cloudflare) {
            if (data.voice.cloudflare.accountId) {
              document.getElementById('cf-account-id').value = data.voice.cloudflare.accountId;
            }
            if (data.voice.cloudflare.apiToken) {
              document.getElementById('cf-api-token').value = data.voice.cloudflare.apiToken;
            }
          }
          if (data.voice.groq && data.voice.groq.apiKey) {
            document.getElementById('groq-api-key').value = data.voice.groq.apiKey;
          }
          if (data.voice.openai && data.voice.openai.apiKey) {
            document.getElementById('openai-api-key').value = data.voice.openai.apiKey;
          }
          if (data.voice.custom) {
            if (data.voice.custom.endpoint) {
              document.getElementById('custom-endpoint').value = data.voice.custom.endpoint;
            }
            if (data.voice.custom.apiKey) {
              document.getElementById('custom-api-key').value = data.voice.custom.apiKey;
            }
            if (data.voice.custom.model) {
              document.getElementById('custom-model').value = data.voice.custom.model;
            }
          }
          onProviderChange();
        }
      }

      // Render Machines & Projects
      const container = document.getElementById('machines-container');
      const targetSelect = document.getElementById('dispatch-target');
      
      if (data.machines && data.machines.length > 0) {
        container.innerHTML = data.machines.map(m => {
          const projectCards = (m.projects || []).map(p => {
            const hasSession = p.sessionId;
            return \`
              <div class="project-card">
                <div class="project-name">
                  <span>📂</span> \${p.projectLabel}
                </div>
                <div class="project-session">
                  \${hasSession ? '⚡ 正在執行：<b>' + (p.sessionLabel || p.sessionId) + '</b>' : '🟢 待命中 (0 活躍 Session)'}
                </div>
                <div class="project-actions">
                  <button class="btn btn-primary" onclick="quickDispatch('\${p.projectLabel}')" style="padding: 4px 10px; font-size: 12px;">
                    🚀 派工
                  </button>
                  \${hasSession ? \`<button class="btn btn-danger" onclick="cancelSession('\${p.sessionId}')" style="padding: 4px 10px; font-size: 12px;">🛑 中止</button>\` : ''}
                </div>
              </div>
            \`;
          }).join('');

          return \`
            <div class="machine-card">
              <div class="machine-header">
                <div class="machine-title">
                  <span>💻</span> \${m.hostLabel || 'codeCenter'}
                  <span style="font-size: 12px; font-weight: normal; color: var(--text-muted);">(\${m.machineId.slice(0, 8)}...)</span>
                </div>
                <span class="machine-badge">\${m.connectionsCount} 個專案連線中</span>
              </div>
              <div class="project-grid">
                \${projectCards || '<div style="color: var(--text-muted); font-size: 13px;">無專案</div>'}
              </div>
            </div>
          \`;
        }).join('');

        // Populate dispatch target dropdown
        const currentTarget = targetSelect.value;
        let options = '<option value="">-- 自動偵測 / 唯一在線專案 --</option>';
        data.machines.forEach(m => {
          (m.projects || []).forEach(p => {
            options += \`<option value="\${p.projectLabel}">[\${m.hostLabel || 'Host'}] \${p.projectLabel}</option>\`;
          });
        });
        targetSelect.innerHTML = options;
        if (currentTarget) targetSelect.value = currentTarget;
      } else {
        container.innerHTML = '<div style="color: var(--text-muted); padding: 24px; text-align: center;">目前沒有任何在線主機。</div>';
      }

      // Render Active Sessions Table
      const tbody = document.getElementById('sessions-tbody');
      if (data.activeSessions && data.activeSessions.length > 0) {
        tbody.innerHTML = data.activeSessions.map(s => \`
          <tr>
            <td><b>\${s.hostLabel || 'codeCenter'}</b></td>
            <td>📂 \${s.projectLabel}</td>
            <td>\${s.sessionLabel || '任務執行中'}</td>
            <td><code>\${s.route.sessionId}</code></td>
            <td>
              <button class="btn btn-danger" onclick="cancelSession('\${s.route.sessionId}')">
                🛑 中止 (Cancel)
              </button>
            </td>
          </tr>
        \`).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">目前沒有任何執行中的工作階段。</td></tr>';
      }
    }

    function quickDispatch(projectName) {
      switchTab('dispatch');
      document.getElementById('dispatch-target').value = projectName;
      document.getElementById('dispatch-prompt').focus();
    }

    async function submitDispatch() {
      const target = document.getElementById('dispatch-target').value.trim();
      const prompt = document.getElementById('dispatch-prompt').value.trim();

      if (!prompt) {
        showToast('請輸入任務提示詞！', 'error');
        return;
      }

      try {
        const res = await fetch('/v1/api/dashboard/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, prompt })
        });
        const data = await res.json();
        if (data.success) {
          showToast('🚀 任務已成功派發開工！', 'success');
          document.getElementById('dispatch-prompt').value = '';
          fetchSummary();
        } else {
          showToast('❌ 派發失敗：' + (data.reason || data.message || '未知錯誤'), 'error');
        }
      } catch (err) {
        showToast('派發請求失敗：' + err.message, 'error');
      }
    }

    async function cancelSession(sessionId) {
      if (!confirm('確定要中止此任務工作階段嗎 (' + sessionId + ')？')) return;
      try {
        const res = await fetch('/v1/api/dashboard/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });
        const data = await res.json();
        if (data.success) {
          showToast('🛑 任務已成功中止！', 'success');
          fetchSummary();
        } else {
          showToast('❌ 中止失敗：' + (data.reason || '未知錯誤'), 'error');
        }
      } catch (err) {
        showToast('中止請求失敗：' + err.message, 'error');
      }
    }

    async function testCurrentVoiceProvider() {
      const provider = document.getElementById('setting-provider').value;
      const resBox = document.getElementById('test-voice-result');
      const testBtn = event?.target || document.querySelector('#tab-settings .btn-secondary');
      
      let apiKey = '';
      let accountId = '';
      let endpoint = '';
      let model = '';

      if (provider === 'cloudflare') {
        accountId = document.getElementById('cf-account-id').value.trim();
        apiKey = document.getElementById('cf-api-token').value.trim();
        if (!accountId) {
          resBox.style.display = 'block';
          resBox.className = 'test-result-box error';
          resBox.textContent = '❌ 請填寫 Cloudflare Account ID！';
          showToast('請填寫 Cloudflare Account ID', 'error');
          return;
        }
      } else if (provider === 'groq') {
        apiKey = document.getElementById('groq-api-key').value.trim();
      } else if (provider === 'openai') {
        apiKey = document.getElementById('openai-api-key').value.trim();
      } else if (provider === 'custom') {
        endpoint = document.getElementById('custom-endpoint').value.trim();
        apiKey = document.getElementById('custom-api-key').value.trim();
        model = document.getElementById('custom-model').value.trim();
      }

      resBox.style.display = 'block';
      resBox.className = 'test-result-box testing';
      resBox.textContent = '🔄 正在向 ' + provider + ' 發送音訊進行真實連線與權限驗證...';
      showToast('🔄 正在連線驗證...', 'info');

      try {
        const res = await fetch('/v1/api/dashboard/test-voice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            apiKey: apiKey || undefined,
            accountId: accountId || undefined,
            endpoint: endpoint || undefined,
            model: model || undefined
          })
        });

        const data = await res.json();
        resBox.style.display = 'block';
        if (data.success) {
          testedVerifiedProvider = provider;
          resBox.className = 'test-result-box success';
          resBox.innerHTML = '✔ <b>連線測試成功！</b> (' + data.message + ')<br><span style="color: #fff; font-weight: bold;">👉 請務必點擊下方「💾 儲存並套用設定」按鈕以永久啟用此引擎！</span>';
          showToast('✔ 連線測試成功！請點擊儲存', 'success');
        } else {
          testedVerifiedProvider = null;
          resBox.className = 'test-result-box error';
          resBox.textContent = '❌ 驗證失敗：' + (data.error || '無法連線至語音服務');
          showToast('❌ 驗證失敗：' + (data.error || ''), 'error');
        }
      } catch (err) {
        testedVerifiedProvider = null;
        resBox.style.display = 'block';
        resBox.className = 'test-result-box error';
        resBox.textContent = '❌ 測試請求出錯：' + err.message;
        showToast('❌ 測試請求出錯：' + err.message, 'error');
      }
    }

    async function saveSettings() {
      const provider = document.getElementById('setting-provider').value;
      const ttlDays = parseInt(document.getElementById('setting-ttl').value) || 30;

      const cfAccountId = document.getElementById('cf-account-id').value.trim();
      const cfApiToken = document.getElementById('cf-api-token').value.trim();
      const groqApiKey = document.getElementById('groq-api-key').value.trim();
      const openaiApiKey = document.getElementById('openai-api-key').value.trim();
      const customEndpoint = document.getElementById('custom-endpoint').value.trim();
      const customApiKey = document.getElementById('custom-api-key').value.trim();
      const customModel = document.getElementById('custom-model').value.trim();

      let activeKey = '';
      if (provider === 'cloudflare') activeKey = cfApiToken;
      else if (provider === 'groq') activeKey = groqApiKey;
      else if (provider === 'openai') activeKey = openaiApiKey;
      else if (provider === 'custom') activeKey = customApiKey;

      if (activeKey && testedVerifiedProvider !== provider) {
        const proceed = confirm('此引擎尚未完成「🧪 測試連線驗證」，確定要直接儲存嗎？建議先點擊測試確認可用。');
        if (!proceed) return;
      }

      try {
        const res = await fetch('/v1/api/dashboard/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activeProvider: provider,
            cloudflare: { accountId: cfAccountId, apiToken: cfApiToken },
            groq: { apiKey: groqApiKey },
            openai: { apiKey: openaiApiKey },
            custom: { endpoint: customEndpoint, apiKey: customApiKey, model: customModel },
            sessionPromptTtlMinutes: ttlDays * 24 * 60
          })
        });
        const data = await res.json();
        if (data.success) {
          showToast('💾 設定已成功儲存並生效！', 'success');
          fetchSummary();
        } else {
          showToast('儲存失敗：' + data.message, 'error');
        }
      } catch (err) {
        showToast('儲存失敗：' + err.message, 'error');
      }
    }

    // Initialize provider fields
    onProviderChange();

    // Auto-refresh summary every 3 seconds
    fetchSummary();
    setInterval(fetchSummary, 3000);
  </script>
</body>
</html>`;
}

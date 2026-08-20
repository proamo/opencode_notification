# OpenCode Telegram Notifier — 未來架構與演進規格書 (V2 / V3 Roadmap Spec)

## 一、 背景與目標

在真實的開發場景中，開發團隊通常具備多樣化的工作模式：
1. **專用開發主機模式（Dedicated Dev Server）**：開發者將所有專案放在一台專屬主機，同時開啟多個 VSCode + OpenCode 視窗平行開發與除錯。
2. **遠端線上伺服器模式（Remote Live / Staging Host）**：維運或後端開發者直接在 VPS、測試機或線上主機上執行 OpenCode 進行修復。
3. **混合多端協同（Multi-Environment Coexistence）**：同一團隊或個人同時管理本機環境與多台遠端伺服器，希望由同一個 Telegram Bot 統一推播與精確回覆。

本規格書定義 OpenCode Telegram Notifier 從 **V1 (單機單 Bot)** 演進為 **V2 (多主機 Gateway 與極致互動)** 及 **V3 (全功能行動指揮中樞)** 的詳細架構、協定與實作規範。

---

## 二、 支援情境拓撲架構

```text
[ 情境 A: 專用開發主機 (多專案視窗) ]
  ├── OpenCode Window 1 (專案 A) ──┐
  ├── OpenCode Window 2 (專案 B) ──┼──► [本機 Agent / Broker] ──┐
  └── OpenCode Window 3 (專案 C) ──┘                           │
                                                               │  (TLS WebSocket / Loopback)
[ 情境 B: 遠端線上伺服器 (VPS / Live Server) ]                  │
  └── OpenCode Daemon (線上主機修復) ──► [遠端 Agent] ─────────┼──► [ Central Gateway Broker ] ──► Telegram Bot API
                                                               │    (可運行於 VPS/本機/Docker)           │
[ 情境 C: 個人筆電 / 遠端開發機 ]                                │                                         ▼
  └── OpenCode Desktop (隨身開發) ────► [行動 Agent] ──────────┘                               [ 開發者 Telegram App ]
```

---

## 三、 分期實作規格

### 階段一 (V1.5)：互動體驗升級（近期落地）

**目標**：在不改變單機架構的前提下，最大化 Telegram 原生互動能力，省去手動打字。

#### 1.1 Telegram Inline Keyboard（互動按鈕回覆）
- **需求**：
  - 當 OpenCode 提出包含固定選項的提問（如 `[1] Rebase [2] Merge [3] Cancel`）或確認詢問（如 `[Yes/No]`）時，Broker 必須自動解析選項並生成 Telegram `inline_keyboard` 按鈕。
  - 使用者點擊按鈕時，Broker 捕捉 `callback_query`，校驗 Route ID 與身分後直接將所選值送回該 OpenCode Session。
- **資料結構**：
  ```json
  {
    "routeId": "rt_9f8a7c6b",
    "type": "question",
    "question": "Choose migration strategy:",
    "options": [
      { "id": "opt_1", "label": "Run Migrations", "value": "migrate" },
      { "id": "opt_2", "label": "Skip for Now", "value": "skip" }
    ]
  }
  ```
- **Telegram 介面呈現**：
  ```text
  💬 OpenCode 需要您的回覆
  專案：AmoERP
  問題：請選擇資料庫遷移策略：
  [ 🚀 執行 Migration ]   [ ⏭️ 暫時略過 ]
  ```

#### 1.2 即時進度原地更新（Live Progress Streaming）
- **需求**：
  - 針對長時間任務（單元測試、多步驟 Agent 思考、Docker 建置），外掛定期回傳進度百分比與階段訊息。
  - Broker 使用 `editMessageText` 定時原地更新同一則訊息（限制更新頻率 $\ge 1.5$ 秒，避免觸發 Telegram Rate Limit）。
- **Telegram 介面呈現**：
  ```text
  ⏳ [██████░░░░] 60% 正在執行單元測試 (24/40)...
  專案：api-server | Session: Fix flaky test
  ```

#### 1.3 Git 變更統計與語法高亮 Diff 預覽
- **需求**：
  - Root Session 完成通知中，自動附帶 Git 變更摘要（如 `+28 -5 lines across 3 files`）。
  - 若有產生重要程式碼變更，於通知內摺疊附帶關鍵 Diff 區塊（使用 `<pre><code class="language-diff">` 格式化）。

#### 1.4 全域 Slash 控制指令
- **`/status`**：列出目前本機所有正在運行的 OpenCode 專案、視窗與任務清單。
- **`/cancel` (引用回覆)**：對正在運行的 Session 通知回覆 `/cancel`，強制中止該 OpenCode 任務。

---

### 階段二 (V2.0)：多主機 Gateway 拓撲與分級權限審批

**目標**：徹底打破單機限制，支援多台主機、多位協作者與遠端安全權限控制。

#### 2.1 Hub-and-Spoke Gateway 拓撲協定
- **核心架構**：
  - **Gateway Broker**：作為全域單一 Telegram 輪詢入口（可架設於 VPS 或主開發機），具備對外 WebSocket Server。
  - **Node Agent**：各開發機（專用開發主機、線上伺服器）安裝輕量 Agent，透過加密 WebSocket 反向連線至 Gateway。
- **主機身分前綴（Host Identification）**：
  - 所有通知頂部自動標註主機標籤與專案名稱：
    ```text
    🖥️ [主開發機] 📁 AmoERP (視窗 #2)
    ✅ 任務完成：已修復庫存同步衝突

    ☁️ [線上 VPS] 📁 live-backend
    ⚠️ 發生異常：Database Connection Timeout
    ```
- **精準雙向路由**：
  - 當使用者在手機回覆 `[線上 VPS]` 的通知時，Gateway 透過持久化的 `host_id + route_id` 自動將指令精準轉發至線上 VPS 的 OpenCode。

#### 2.2 分級遠端權限審批模型（Tiered Permission System）
- **分級原則**：
  - **Level 1（安全操作 / 1-Click Approve）**：
    - 範圍：讀取檔案、執行唯讀測試、靜態分析、`git status`。
    - 機制：Telegram 顯示 `[✅ 核准執行]` 按鈕，點擊即放行。
  - **Level 2（高危險操作 / Terminal Mandatory）**：
    - 範圍：`rm -rf`、`DROP TABLE`、`git push --force`、覆寫生產設定。
    - 機制：禁止 Telegram 遠端核准，強制使用者回到終端機處理，防止誤觸或帳號遭竊時產生災難。

#### 2.3 敏感資料防洩引擎（DLP Filter）
- **需求**：
  - 在通知送往 Telegram 之前，本地 Agent 自動過濾正則匹配：
    - `.env` 變數、API Keys、JWT Tokens、資料庫連線密碼、SSH 私鑰。
  - 自動遮蔽為 `sk-proj-****` 或 `[REDACTED_SECRET]`。

---

### 階段三 (V3.0)：多管道整合與 AI 多模態指揮

**目標**：擴展至其他團隊溝通工具，並支援語音控制與智慧彙整。

#### 3.1 Telegram 語音指派任務 (Voice-to-Code)
- **流程**：
  1. 開發者在外出時，向 Telegram Bot 發送語音訊息（或引用某個 Session 發送語音）。
  2. Gateway/Agent 整合本地 Whisper 或語音 API，將語音高精度轉譯為 Prompt。
  3. 自動喚醒指定主機的 OpenCode 繼續執行任務。

#### 3.2 多通訊平台適配器架構 (Multi-Channel Adapter)
- 抽象化通訊層介面：
  ```ts
  interface NotificationChannelAdapter {
    sendNotification(payload: NotificationPayload): Promise<string>;
    updateProgress(messageId: string, progress: ProgressPayload): Promise<void>;
    onReply(handler: (reply: UserReplyPayload) => Promise<void>): void;
  }
  ```
- 支援通訊管道：
  - Telegram Bot
  - Discord Webhook / Bot
  - Slack App (Bolt SDK)
  - LINE Messaging API

#### 3.3 每日開發摘要日報（Daily Dev Digest）
- 定時於每天晚上（如 22:00）彙整當天所有主機的開發歷程：
  - 處理了哪些 Session
  - 修改了多少檔案、新增/刪除行數
  - 任務成功率與錯誤統計
  - 自動生成簡潔的工作進度報告

---

## 四、 實作工作清單（Implementation Roadmap Checklist）

### 🚀 Milestone 1 (V1.5 體驗極致化)
- [ ] 在 `src/protocol` 擴充 `question` 事件中的 options 資料結構。
- [ ] 在 `src/broker/telegram.ts` 實作 Telegram Inline Keyboard 按鈕生成與 `callback_query` 事件監聽。
- [ ] 實作 `editMessageText` 防抖進度更新機制（Progress Streamer）。
- [ ] 整合 Git status/diff 輕量解析器，於完成通知中輸出變更統計。
- [ ] 支援 `/status` 與 `/cancel` 全域控制指令。

### 🌐 Milestone 2 (V2.0 Gateway 與多主機支援)
- [ ] 定義 Gateway-Agent WebSocket 雙向通訊協定（TLS + Token 雙向認證）。
- [ ] 實作 Gateway 路由分發引擎，支援 `HostId + InstanceId + RouteId` 複合索引。
- [ ] 開發獨立輕量 Agent，支援遠端主機無頭（Headless）掛載。
- [ ] 實作分級權限審批安全過濾器。
- [ ] 實作 DLP 敏感資訊過濾模組。

### 🤖 Milestone 3 (V3.0 多管道與多模態)
- [ ] 抽象化 `NotificationChannelAdapter` 介面。
- [ ] 實作 Discord 與 Slack 通訊外掛。
- [ ] 實作 Telegram 語音轉文字（Voice Prompting）處理管道。
- [ ] 實作定時開發日報生成引擎。

---

## 五、 結論

本規格書完整涵蓋了您目前的**「專用開發主機（多專案並行）」**與同伴的**「線上主機直接修改」**情境，透過漸進式的版本演進，確保專案既維持極致的隱私與穩定度，又能無縫擴展至現代全端團隊的真實工作流中。

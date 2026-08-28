# OpenCode Telegram Notifier & OpenCode Commander

OpenCode Telegram Notifier 是一個注重隱私、支援多主機集中控制與遠端主動派工的 OpenCode 外掛與控制中樞（Gateway）。它專為同時執行多個專案、多台電腦（開發主機、筆電、線上 VPS）的開發者設計，能將任務完成、錯誤、詢問等通知即時推送到 Telegram，並提供全新 **Web 控制台 (OpenCode Commander)**、**遠端主動派工**、**多核心語音辨識**、**一鍵權限審批**與**多主機標籤識別**，確保使用者無論在 Telegram 或是網頁看板上的每一次操作都能精準送回目標主機、專案與工作視窗。

> 目前版本：**v1.0.0-rc.1**（OpenCode Commander Web 控制台、遠端主動派工、多核心語音 STT、多主機 Hub-and-Spoke Gateway、節點 Agent、Telegram 互動按鈕與 AI 執行結論）。
> 目前狀態：Release Candidate 1，尚未發布 npm 公開版本。

[English Documentation](../README.md)

---

## 核心功能與特色 (v1.0.0-rc.1)

- 🖥️ **OpenCode Commander（Web 視覺化控制台）**：內建現代化毛玻璃質感網頁控制台（預設 `http://<gateway-ip>:42617/dashboard`），即時掌握叢集狀態與運行指標。
- 🌐 **叢集拓撲總覽 (Cluster Topology)**：1 對 1 精準對齊所有連線電腦與 VS Code 工作區視窗，即時呈現多任務進度與待命狀態。
- 🚀 **遠端主動派工 (Proactive Remote Dispatch)**：免回電腦開視窗！直接在網頁看板或 Telegram 傳送 Prompt / 語音，即刻喚醒指定電腦或待命視窗開啟新任務！
- 🎙️ **多核心語音極速轉譯 (Multi-Engine Voice STT)**：
  - **Cloudflare Workers AI**（`@cf/openai/whisper-large-v3-turbo`，每日 1 萬次免費額度）。
  - **Groq Whisper**（極速推論，支援 `whisper-large-v3-turbo`）。
  - **OpenAI Whisper**（經典 `whisper-1` 引擎）。
  - **自訂 / 自架 Whisper Endpoint**。
  - **多引擎金鑰獨立持久化保留**：切換語音核心絕不覆蓋或遺失其他家 Token。
  - **看板即時連線與驗證**：一鍵測試 API Key 連通性與轉譯測試。
- 📱 **手機與平板 RWD 響應式設計**：自動適應窄螢幕，導航橫向滑動、卡片單欄排列、表格橫向滾動，手機操作流暢直覺。
- 🛑 **即時任務中止 (Live Session Cancel)**：在網頁或 Telegram 按鈕上一鍵中止已失控或不需要的 Session。
- 🌐 **多主機 Hub-and-Spoke Gateway 拓撲**：打破單機限制！透過單一 Telegram Bot 統一掌控多台電腦（公司電腦、MacBook、線上 VPS），完全免除訊息搶奪與 `409 Conflict` 衝突。
- 🏷️ **主機身分標籤 (Host Tagging)**：推播頂部醒目標示來源主機（例如 `🖥️ [MacBook]` 或 `☁️ [Live-VPS]`），一目了然。
- 🔄 **跨主機精準逆向路由 (Cross-Host Routing)**：在手機點擊按鈕或回覆文字，Central Gateway 自動分發指令精準回到該主機與 Session。
- 🔘 **Telegram 互動式按鈕**：敏感操作（Bash 指令 / 檔案修改）觸發時，提供 `[ ✅ 允許本次 ]`、`[ ⚡ 總是允許 ]`、`[ ❌ 拒絕 ]` 一鍵遠端審批！
- 📝 **AI 執行結論摘要**：任務完成時自動生成簡明扼要的執行結論，不用回到電腦看螢幕就知道做了什麼。
- ⏰ **主機在地化時間**：通知時間直接採用安裝主機的本地時區（例如台北時間 UTC+8）。
- 🧹 **一鍵安全移除精靈 (`bun run uninstall`)**：提供乾淨的互動式移除工具，安全清理狀態資料庫、Token 與 `opencode.json` 外掛配置。
- 🌐 **繁體中文與英文雙語**：完整的繁體中文（`zh-TW`）與英文（`en`）介面與提示。

---

## 系統架構

```text
[ 節點 Agent 1 (MacBook) ] ──── (WebSocket) ──┐
                                              ▼
[ 節點 Agent 2 (線上 VPS) ] ─── (WebSocket) ──► [ Central Gateway Broker ] ──► Telegram Bot API
                                              ▲     (可運行於 VPS/本機)              │
[ 本地 OpenCode ] ────────────────────────────┘                                      ▼
                                                                           [ 開發者 Telegram App ]
```

- **Gateway 模式（預設）**：作為集中入口唯一擁有 Telegram Bot 輪詢，服務本機 OpenCode 並接收遠端節點連線。
- **Node Agent 模式**：第二台/第三台電腦使用的輕量連線模式，反向連線至 Central Gateway，共用同一個 Telegram Bot。

---

## 安全與隱私

- Central Gateway 與 Node Agent 之間透過加密 Token 進行安全握手驗證。
- 使用者使用自己建立的 Telegram Bot，無任何第三方託管中繼、帳號服務或遙測追蹤。
- 預設不傳送對話紀錄、原始程式碼、工具輸出、檔案路徑或秘密金鑰。
- 安裝時會固定授權的 Telegram User ID 與私人對話 Chat ID。
- 離線、過期、模稜兩可或未授權的操作一律安全拒絕（Fail Closed），且離線指令絕不排隊。

---

## 系統需求

- Bun `>=1.3.0`
- OpenCode 及 `@opencode-ai/plugin` `>=1.18.0 <2`
- 向 `@BotFather` 申請的 Telegram Bot Token（僅 Gateway 主機需要）

---

## 快速安裝與設定（新手 4 步到位）

在任何要啟用通知的主機（開發機或伺服器）上打開終端機，執行以下 4 行指令：

```sh
# 1. 複製專案倉庫
git clone https://github.com/proamo/opencode_notification.git
cd opencode_notification

# 2. 安裝依賴
bun install

# 3. 建置專案
bun run build

# 4. 啟動一鍵互動式安裝精靈
bun run setup
```

*(註：發布至 npm 後，可直接使用 `bunx opencode-telegram-link setup` 執行，免手動 git clone。)*

安裝精靈將全程在終端機引導您：
1. 🌐 **選擇語系**：繁體中文 (zh-TW) 或 English (en)。
2. ⚙️ **選擇部署模式**：
   - `1) 本機原生模式 (Native Mode)`：Broker 作為本機輕量背景程序，OpenCode 啟動時自動在背景接管。
   - `2) Docker 容器模式 (Docker Container)`：精靈會在設定完成後，**自動在背景執行 Docker Compose 建置並啟動容器**！
3. 🤖 **輸入 Bot Token**：輸入 `@BotFather` Token，即時連線 Telegram 驗證。
4. 🔗 **Telegram 帳號配對**：產生 Nonce 驗證短碼，在 Telegram 私聊中發送給 Bot 即自動綁定身分。
5. 📝 **自動寫入外掛設定**：自動偵測全域與專案的 `opencode.json` 一鍵注入配置（自動建立 `.bak` 備份）。
6. 🚀 **自動啟動 Broker**：選 Docker 模式時自動於背景啟動容器；選原生模式時完成配置。
7. 💬 **發送測試通知**：發送歡迎測試訊息到您的 Telegram，即刻驗收成果！

---

## 🖥️ OpenCode Commander（Web 視覺化控制台）

Gateway 啟動後，直接透過瀏覽器開啟：

```text
http://localhost:42617/dashboard
# 或在區域網路/手機瀏覽器開啟：
http://<gateway-ip>:42617/dashboard
```

### 看板四大功能分頁：
1. 🖥️ **拓撲總覽 (Nodes)**：
   - 1 對 1 精準顯示所有連線主機與 VS Code 工作區視窗。
   - 即時狀態呈現：活躍 Session、執行中子任務數量（Subagents），以及待命視窗標籤。
   - 點擊卡片旁的 **`🚀 派工`** 即可直接指派任務。
2. 📝 **活躍工作 (Sessions)**：
   - 全叢集即時任務流清單。
   - 支援一鍵點擊 **`🛑 中止`** 即刻取消正在進行的任務。
3. 🚀 **遠端派工 (Dispatch)**：
   - 自由挑選目標主機與工作視窗（支援自動偵測）。
   - 輸入 Prompt 並點擊 **`🚀 立即發送派工`**，即刻喚醒指定視窗執行任務。
4. ⚙️ **系統設定 (Settings)**：
   - 設定 **語音辨識核心 (Voice STT)**：支援 Cloudflare Workers AI、Groq Whisper、OpenAI Whisper 與自訂 Endpoint。
   - **多引擎金鑰獨立持久化儲存**：自由切換引擎，其他家 API Key / Token 絕不被覆蓋或遺失。
   - 內建 **`⚡ 測試連線與驗證金鑰`** 一鍵診斷測試區塊。
   - 熱重載機制：修改語音引擎即時生效，無需重啟 Gateway。

---

## 🎙️ Telegram 語音輸入操作

您可以直接在 Telegram 對 Bot 傳送語音訊息或音訊檔案！Gateway 將自動轉譯語音文字並執行指令：

1. **Cloudflare Workers AI（推薦首選）**：
   - 模型：`@cf/openai/whisper-large-v3-turbo`
   - 免費額度：**每日 1 萬次免費轉譯**。
   - 需填寫：Cloudflare Account ID 與 API Token。
2. **Groq Whisper**：
   - 模型：`whisper-large-v3-turbo` / `whisper-large-v3`
   - 極速推論反應時間。
   - 需填寫：Groq API Key (`gsk_...`)。
3. **OpenAI Whisper**：
   - 模型：`whisper-1`
   - 需填寫：OpenAI API Key (`sk-...`)。

---

## 多主機與第二台電腦連線設定 (Multi-Host & Node Agent)

若您有多台電腦（例如：**主機 A 作為 Central Gateway**、**主機 B/筆電 作為 Node Agent**），並希望**共用同一個 Telegram Bot**：

### 步驟 1：主機 A（Central Gateway 準備）
在主機 A 上執行 `bun run setup`，選擇 `1) 獨立 Gateway 模式` 並完成 Telegram Bot 配對。
確保主機 A 的 Broker 連接埠（預設 `42617`）可被主機 B 連線（例如透過區域網路 LAN、Tailscale VPN 內網 IP，或反向代理域名）。

### 步驟 2：主機 B（Node Agent 設定）
在主機 B（您的筆電或其他伺服器）上：
1. 執行 `bun run setup`（或 `bunx opencode-telegram-link setup`）。
2. 選擇 **`2) 節點 Agent 模式 (Node Agent Mode)`**。
3. 輸入主機標籤（例如 `MacBook` 或 `Live-VPS`）。
4. 輸入主機 A 的 Gateway WebSocket 位址（例如 `ws://192.168.1.100:42617`、`ws://100.x.x.x:42617` (Tailscale) 或 `wss://gateway.yourdomain.com`）。
5. 輸入 Gateway 連線金鑰（若無設定可直接按 Enter）。

### 主機 B 的 `opencode.json` 設定範例
```json
{
  "plugin": {
    "opencode-telegram-link": {
      "mode": "local",
      "role": "node",
      "hostLabel": "MacBook",
      "gateway": {
        "url": "ws://gateway-host-ip:42617",
        "secret": "your-secret-token"
      },
      "notifications": {
        "completion": true,
        "error": true,
        "question": true,
        "permission": true
      }
    }
  }
}
```

> 💡 **如何取得主機 A (Gateway) 的連線金鑰？**  
> 在主機 A 上執行以下指令即可查閱並複製金鑰：  
> `cat ~/.local/state/opencode-telegram-link/broker-secret`  
> （若主機 A 與主機 B 在安全的私有內網/Tailscale 且未設定密鑰，此欄位亦可為預設值）。

設定完成後，主機 B 發出的通知會在 Telegram 頂部標註 `🖥️ [MacBook]`，而您在 Telegram 手機端點擊按鈕或回覆時，指令會自動精準轉發回主機 B！

---

## 非互動 / 腳本化設定（CI 或自動化環境）

若需在無人值守或自訂腳本環境執行，可使用參數模式：

```sh
# 透過 Nonce 配對
OPENCODE_TELEGRAM_BOT_TOKEN='123456:REPLACE_WITH_BOTFATHER_TOKEN' \
  opencode-telegram-broker setup --pair --locale zh-TW

# 或直接指定已知 Telegram User ID 與 Chat ID
OPENCODE_TELEGRAM_BOT_TOKEN_FILE=~/.local/state/opencode-telegram-link/telegram-bot-token \
  opencode-telegram-broker setup --user-id 123456789 --chat-id 123456789 --locale zh-TW
```

---

## 外掛設定說明（Configuration）

OpenCode 同時支援 **「全域設定（Global Config）」** 與 **「專案獨立設定（Project Workspace Config）」**：

- **全域設定**：`~/.config/opencode/opencode.json`（對所有未自訂獨立設定的專案生效）。
- **專案獨立設定**：`<專案目錄>/.opencode/opencode.json` 或 `<專案目錄>/opencode.json`。

> ⚠️ **重要注意事項：專案設定會覆蓋全域外掛清單**
> 當某個專案目錄下存在自己的 `.opencode/opencode.json`（或 `opencode.json`）且定義了 `"plugin"` 陣列時，OpenCode 會優先採用該專案內的設定，**不會自動繼承全域的 `plugin` 清單**。
> 
> 因此，如果您的專案有自己的 `opencode.json`（例如設定了特定的模型、授權或外掛），**必須在該專案的 `opencode.json` 內也加入本外掛路徑**，通知功能才會在該專案生效。

---

### 如何為具有自訂 `opencode.json` 的專案設定外掛？

#### 方式 1：手動編輯專案設定檔（推薦）
打開該專案下的 `.opencode/opencode.json`（或 `opencode.json`），在 `"plugin"` 陣列中加入本外掛的絕對路徑：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "oc-codex-multi-auth@6.12.1",
    "/home/you/opencode_notification"
  ]
}
```

> 💡 **提示**：
> - **本地開發/原始碼安裝階段**：請填寫本倉庫的**本機絕對路徑**（如 `/home/amo/opencode_notification`）。
> - **套件發布至 npm 後**：直接填入套件名稱 `"opencode-telegram-link"` 即可。
> - 外掛啟動時會自動讀取安裝時已配對好的安全金鑰與 Telegram 綁定設定，專案內不需重複填寫 Token。

#### 方式 2：使用安裝精靈自動注入
切換到該專案目錄下，直接呼叫安裝精靈的一鍵配置：

```sh
cd /path/to/your/project
bun run --cwd /path/to/opencode_notification setup --config-only
```
精靈會自動偵測當前目錄的專案設定檔、建立 `.bak` 備份，並安全注入外掛路徑。

---

### 權限設定（免手動確認 Allow）

若希望 OpenCode 在執行指令時不需每次手動點擊 Allow，可在 `opencode.json` 或 `.opencode/agent/<agent-name>.md` 中將權限設為 `allow`：

```json
{
  "permission": {
    "edit": "allow",
    "bash": "allow",
    "webfetch": "allow",
    "task": "allow",
    "external_directory": "allow"
  }
}
```

---

## 常用 Broker 指令

啟動或重用本機原生 Broker：
```sh
opencode-telegram-broker start
```

檢查就緒狀態與診斷報告：
```sh
opencode-telegram-broker status
opencode-telegram-broker doctor
```

發送測試通知（不建立可路由的 Session 動作）：
```sh
OPENCODE_TELEGRAM_BOT_TOKEN_FILE=~/.local/state/opencode-telegram-link/telegram-bot-token \
  opencode-telegram-broker test-notification --chat-id 123456789 --locale zh-TW
```

停止 Broker（不會終止正在執行的 OpenCode 任務）：
```sh
opencode-telegram-broker stop
```

清除 SQLite 運作路由與去重狀態（需在 Broker 停止後執行）：
```sh
opencode-telegram-broker purge-state
```

在 BotFather 更換 Token 後輪換金鑰檔案：
```sh
OPENCODE_TELEGRAM_BOT_TOKEN='123456:NEW_TOKEN' \
  opencode-telegram-broker rotate-credential --token-file ~/.local/state/opencode-telegram-link/telegram-bot-token
opencode-telegram-broker stop
opencode-telegram-broker start
```

---

## 通知與互動範例

### 1. 任務完成通知（包含 AI 執行結論與在地化時間）
```text
任務已完成
專案: api-server
Session: Fix flaky checkout test
時間: 2026-08-26 09:30:15

📝 執行結論：
已在 Stripe webhook 處理程序中加入資料庫交易鎖，解決並發條件問題，並已新增對應的單元測試。

回覆此訊息可繼續此 Session。
```

### 2. 敏感權限確認通知（V1.5 互動式按鈕）
```text
需要權限確認
專案: api-server
Session: Fix flaky checkout test
時間: 2026-08-26 09:32:00
操作：執行 Bash 指令 `npm run test:e2e`

[ ✅ 允許本次 ]   [ ⚡ 總是允許 ]   [ ❌ 拒絕 ]
```

### 3. 提問等待回答通知（V1.5 選項按鈕）
```text
需要提供資訊
專案: api-server
問題: 請選擇要採用的遷移策略？
時間: 2026-08-26 09:35:10

[ 藍綠部署 ]   [ 金絲雀部署 ]   [ 就地升級 ]
```

通知內容預設經過嚴格最小化與隱私過濾，不包含原始碼、工具詳細輸出、檔案路徑或任何敏感金鑰。

---

## 互動與回覆行為

- **一鍵遠端審批權限**：直接點擊 Telegram 權限訊息下方的 `[ ✅ 允許本次 ]`、`[ ⚡ 總是允許 ]` 或 `[ ❌ 拒絕 ]`，Broker 會驗證單次安全 Token 並立即通知 OpenCode 解除等待狀態！
- **選擇題快速作答**：直接點擊選項按鈕即自動送出答案，免去打字麻煩。
- **接續對話**：對 24 小時內完成的通知直接**引用回覆**輸入下一道指令，即可直接向該 Session 下達新任務。

過期、離線、重複、未授權或被拒絕的回覆皆會得到本地化的錯誤反饋，且離線指令不排隊。

---

## 🤖 Telegram 指令選單 (行動指揮官)

你可以直接在 Telegram 輸入以下指令管理跨主機叢集與任務：

| 指令 | 說明 | 範例 |
| :--- | :--- | :--- |
| `/help` | 顯示行動指揮官說明選單 | `/help` |
| `/status` | 查看 Gateway 系統健康度、運行時間、記憶體與版本 | `/status` |
| `/nodes` | 列出目前所有連線中的電腦主機與專案狀態 | `/nodes` |
| `/sessions` | 列出所有主機上進行中的工作階段與任務 | `/sessions` |
| `/run <目標> <任務>` | 向指定主機、專案派發新任務，或接續歷史工作階段 | `/run openclaw 檢查測試日誌`<br>`/run ses_abc123 繼續除錯` |
| `/cancel <session_id>` | 安全中止指定任務（具備重名與前綴碰撞保護） | `/cancel ses_abc123` |

---

## Docker 容器模式（Docker Broker）

推薦使用本機原生模式。若您偏好容器隔離，Broker 亦支援以單一 Docker 容器執行：

### 使用 Docker Compose 一鍵啟動（推薦）

```sh
docker compose up -d --build
```

停止容器：
```sh
docker compose down
```

### 手動 Docker 指令

```sh
bun run build
docker build -f container/broker.Dockerfile -t opencode-telegram-broker:local .

docker run -d --rm \
  --name opencode-telegram-broker \
  -p 127.0.0.1:42617:42617 \
  -v opencode-telegram-state:/state \
  -v "$HOME/.local/state/opencode-telegram-link/telegram-bot-token:/run/secrets/telegram-bot-token:ro" \
  -e OPENCODE_TELEGRAM_BOT_TOKEN_FILE=/run/secrets/telegram-bot-token \
  opencode-telegram-broker:local start
```

> [!IMPORTANT]
> Port 發布務必包含 `127.0.0.1`（即 `-p 127.0.0.1:42617:42617`），避免 Docker 將 Broker 暴露至公開網路。同一個 Bot Token 不可同時在原生模式與 Docker 模式下運行。

---

## 系統診斷（Diagnostics）

當設定失敗或收不到通知時，請先執行 `opencode-telegram-broker doctor`。它會全面檢查設定有效性、Token 權限、Broker 連線、Singleton 衝突、Telegram API 連通性、授權身分與 OpenCode 相容性，輸出內容會自動遮蔽金鑰與敏感資訊。

常見結果：
- `ready: true`：設定正常可用。
- `warning`：可運作但有操作限制（例如尚未有活躍的外掛連線）。
- `failure`：請依提示修復問題。
- Telegram `409 Conflict`：同一個 Bot 正被其他程式輪詢，請關閉其他程式或更換 Bot。

---

## 更新

1. 更新套件或重新建置原始碼。
2. 重啟 Broker：`opencode-telegram-broker stop` 接著 `opencode-telegram-broker start`。
3. 若 doctor 報告協定版本不相容，請重啟 OpenCode 程序。
4. 執行 `opencode-telegram-broker doctor` 與測試通知確認。

---

## 一鍵解除安裝（Uninstall）

若日後需要移除本套件，只需執行一鍵移除精靈：

```sh
bun run uninstall
# 或
opencode-telegram-broker uninstall
```

移除精靈會安全自動：
1. 停止執行中的本機 Broker 程序或 Docker 容器。
2. 搜尋並從 `opencode.json` 清除外掛配置（保留 `.bak` 備份）。
3. 清除 SQLite 資料庫與訊息路由狀態。
4. 詢問並刪除 Token 金鑰檔案與狀態目錄。

---

## 規格文件

- [提案](../openspec/changes/design-telegram-notifier/proposal.md)
- [技術設計](../openspec/changes/design-telegram-notifier/design.md)
- [Telegram 通知規格](../openspec/changes/design-telegram-notifier/specs/telegram-notifications/spec.md)
- [本機實例路由規格](../openspec/changes/design-telegram-notifier/specs/local-instance-routing/spec.md)
- [Telegram 互動規格](../openspec/changes/design-telegram-notifier/specs/telegram-session-interaction/spec.md)
- [安裝與診斷規格](../openspec/changes/design-telegram-notifier/specs/setup-and-diagnostics/spec.md)
- [實作工作清單](../openspec/changes/design-telegram-notifier/tasks.md)
- [未來架構與演進規格書 (V2/V3 Roadmap)](future-architecture-spec.md)
- [相容性政策](compatibility.md)
- [本機狀態管理](state-management.md)
- [威脅模型 (Threat Model)](threat-model.md)
- [本機 Broker 協定 (Protocol)](protocol.md)
- [資料保存政策 (Data Retention)](data-retention.md)
- [貢獻指南 (Contributing)](contributing.md)

---

## 技術棧

- TypeScript 與 Bun
- `@opencode-ai/plugin` 與 OpenCode SDK
- Telegram Bot API (Long Polling)
- 具備身分驗證的 Loopback WebSocket 協定
- SQLite 輕量狀態與去重儲存

本專案採用 **MIT License** 開源授權。

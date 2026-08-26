# OpenCode Telegram Notifier

OpenCode Telegram Notifier 是一個注重隱私與多專案精確路由的 OpenCode 外掛。它專為同時執行多個 OpenCode 專案的開發者設計，能將任務完成、錯誤、詢問等通知即時推送到 Telegram，並支援**手機端即時權限審批按鈕**、**選擇題按鈕點擊**與**AI 執行結論摘要**，確保使用者從 Telegram 做的每一則互動都能精準送回當初發出通知的那個專案與工作階段（Session）。

> 目前版本：**v1.5.0**（支援 Telegram 互動按鈕、遠端權限審批、選擇題快速點擊與 AI 執行結論）。
> 目前狀態：pre-release implementation，尚未發布 npm 公開版本。

[English Documentation](../README.md)

---

## V1.5 核心功能與特色

V1.5 適用於「單台電腦」，支援：

- 🔘 **Telegram 互動式按鈕**：敏感操作（Bash 指令 / 檔案修改）觸發時，提供 `[ ✅ 允許本次 ]`、`[ ⚡ 總是允許 ]`、`[ ❌ 拒絕 ]` 一鍵遠端審批！
- 📝 **AI 執行結論摘要**：任務完成時自動生成簡明扼要的執行結論，不用回到電腦看螢幕就知道做了什麼。
- ⏰ **主機在地化時間**：通知時間直接採用安裝主機的本地時區（例如台北時間 UTC+8）。
- 🔄 **Session-level 熱轉發**：支援跨夜排程回覆，即使 OpenCode 程序重新連線也能自動路由至最新活躍實例。
- 🤖 **單一使用者 Bot & 本機 Broker**：多個 OpenCode 程序共用單一 loopback Broker，絕不搶奪或遺漏 Telegram 訊息。
- 🛡️ **多專案與多 Session 精確隔離**：依據硬體身分碼、專案路徑 Hash 與 Session 唯一碼精準路由，絕不跨專案誤發。
- 🌐 **繁體中文與英文雙語**：完整的繁體中文（`zh-TW`）與英文（`en`）介面與提示。

---

## 系統架構

```text
OpenCode: 專案 A ─┐
OpenCode: 專案 B ─┼── 本機 Broker ── Telegram Bot API
OpenCode: 專案 C ─┘
```

本機上的所有 OpenCode 外掛皆連接至同一個僅監聽 loopback (`127.0.0.1`) 的 Broker。Broker 是唯一向 Telegram 進行 Long Polling 輪詢的程序，因此多個 OpenCode 程序同時執行也不會發生衝突。

Broker 亦支援以單一 Docker 容器方式運行。主機上的 OpenCode 透過發布在 `127.0.0.1` 的連接埠與容器通訊，狀態目錄則掛載為持久化 Volume。預設推薦使用本機原生模式。

每則可互動訊息皆綁定一組不透明的路由識別碼（包含電腦 ID、程序 ID、專案 ID、Session ID 與世代版本）。Telegram 回覆時**必須引用原始訊息**；系統絕不依靠專案顯示名稱或使用者文字來猜測目的地。

---

## 安全與隱私

- Broker 僅監聽本機 loopback (`127.0.0.1`)，並使用目前使用者專屬的密鑰進行外掛驗證。
- 使用者使用自己建立的 Telegram Bot，無任何第三方託管中繼、帳號服務或遙測追蹤。
- 預設不傳送對話紀錄、原始程式碼、工具輸出、檔案路徑或秘密金鑰。
- 安裝時會固定授權的 Telegram User ID 與私人對話 Chat ID。
- 離線、過期、模稜兩可或未授權的操作一律安全拒絕（Fail Closed），且離線指令絕不排隊。
- 啟用 Telegram 通知代表選定的通知與回覆內容會經由 Telegram 官方伺服器傳輸。

---

## 重要限制

V1 不支援將同一個 Telegram Bot 同時用於多台電腦。Telegram Long Polling 限制單一消費者；多台電腦共用同一個 Bot 會互相搶走訊息或產生 `409 Conflict` 衝突。

未來版本可能會提供獨立設計的 Remote Broker 模式。V1 內絕不包含任何未經稽核的區域網路監聽或遠端存取通道。

---

## 系統需求

- Bun `>=1.3.0`
- OpenCode 及 `@opencode-ai/plugin` `>=1.18.0 <2`
- 向 `@BotFather` 申請的 Telegram Bot Token
- 一個 Bot Token 對應一台電腦

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

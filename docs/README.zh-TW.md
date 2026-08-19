# OpenCode Telegram Notifier 繁體中文總覽

OpenCode Telegram Notifier 是一個以隱私與精確路由為優先的 OpenCode Telegram 外掛。它讓同時執行多個專案的使用者可以離開終端機，並在工作完成、發生異常、需要回答問題或需要介入時收到通知。

> 目前狀態：pre-release implementation，尚未發布 npm 公開版本。正式安裝與操作細節以英文 `README.md` 為準。

## V1 範圍

第一版支援「單台電腦、多專案、多個 OpenCode」：

- 一個使用者自行透過 BotFather 建立的 Telegram Bot。
- 一個只監聽本機 loopback 的 Broker。
- 多個同時執行的 OpenCode process。
- 每個 process 下的多個專案與 session。
- 繁體中文及英文通知。

支援的通知包含：

- Root session 完成。
- Root session 發生異常。
- OpenCode 提出問題，等待使用者回答。
- OpenCode 要求權限，需要使用者回到終端機處理。

V1 可以從 Telegram 回覆已完成的工作，讓原本的 session 繼續執行，也可以回答指定的 OpenCode question。V1 不允許從 Telegram 批准或拒絕權限。

## 多專案精確路由

```text
專案 A 的 OpenCode ─┐
專案 B 的 OpenCode ─┼── 本機 Broker ── Telegram Bot API
專案 C 的 OpenCode ─┘
```

Broker 是唯一會讀取 Telegram updates 的 process。每一則可回覆通知都會記錄不透明的路由資料：

```text
machine + OpenCode instance + project + session + route generation
```

使用者必須直接回覆原本的 Bot 訊息。系統不會根據專案顯示名稱、session 標題或使用者輸入的 ID 猜測目的地，因此同名專案與同時執行的多個 OpenCode 不會互相混淆。

## 單一 Docker 部署

除了預設的本機執行模式，Broker 也提供單一 Docker container。OpenCode 與外掛仍在 host 執行，container 只負責 Telegram、SQLite 與路由。

- Broker state 使用持久化 volume。
- Token 與 secret 在執行時掛載，不寫入 image。
- Port 必須使用 `127.0.0.1:42617:42617` 形式發布。
- 不允許省略 host IP，避免 Docker 將 Broker 公開到 `0.0.0.0`。
- 同一份 state 與 Bot 不可同時啟動 native Broker 和 Docker Broker。

## 安裝與設定摘要

目前套件尚未發布到 npm；從原始碼使用時先執行：

```sh
bun install
bun run build
```

透過 BotFather 建立自己的 Telegram Bot，將 token 放入只有目前使用者可讀的檔案，然後執行 guided setup：

```sh
OPENCODE_TELEGRAM_BOT_TOKEN_FILE=~/.local/state/opencode-telegram-link/telegram-bot-token \
  opencode-telegram-broker setup --pair --locale zh-TW
```

Setup 會要求你把一次性短碼傳給 Bot，並在本機終端機輸入 `YES` 確認。完成後，將輸出的 `userId`、`chatId` 與 `tokenFile` 放入 OpenCode plugin options。建議使用 `tokenFile`，不要直接把 bot token 寫進設定檔。

常用 Broker 指令：

```sh
opencode-telegram-broker start
opencode-telegram-broker status
opencode-telegram-broker doctor
opencode-telegram-broker test-notification --chat-id 123456789 --locale zh-TW
opencode-telegram-broker stop
```

`doctor` 會檢查設定、token file 權限、Broker singleton、loopback 綁定、Telegram API、授權身分、catalog 與 OpenCode 相容性，輸出應已遮蔽敏感資訊。

## 回覆行為

必須直接回覆原本的 Bot 訊息。Broker 只使用持久化的 Telegram message binding 與不透明 route ID 進行路由，不會根據專案名稱、session 標題或使用者輸入的 ID 猜測目的地。

支援的 Telegram 回覆：

- 回覆可互動的 root session 完成通知，讓同一個 OpenCode session 繼續執行。
- 回覆待回答問題通知，送出該問題允許的答案。
- 回覆權限通知時只會得到「回到終端機處理」提示；V1 不支援 Telegram 權限核准或拒絕。

過期、離線、重複、未授權、無法路由或被 OpenCode 拒絕的回覆都會 fail closed，且離線指令不排隊。

## 更新與移除摘要

更新時先更新套件或重新 build，重啟 Broker，必要時重啟 OpenCode processes，最後執行 `doctor` 與 `test-notification`。若出現 protocol 或 OpenCode compatibility mismatch，必須重啟相關 OpenCode processes，不會自動降級協定。

移除時先刪除 OpenCode plugin 設定，再執行 `opencode-telegram-broker stop`。如需移除路由與 delivery 狀態，可在 Broker 停止後執行 `opencode-telegram-broker purge-state`；如需完全移除，再刪除 state directory 與 token file。若 token 可能外洩，請到 BotFather revoke 或 rotate token。

## 安全與隱私

- Broker 只接受本機連線，並使用目前作業系統使用者專屬的密鑰驗證外掛。
- 使用者使用自己的 Telegram Bot，不經過本專案提供的中央伺服器。
- 預設不傳送完整對話、原始碼、工具輸出、檔案路徑或秘密資訊。
- 安裝時固定允許的 Telegram user ID 與私人 chat ID。
- 過期、離線、重複、無法確認或未授權的回覆一律拒絕。
- 離線指令不排隊，避免 OpenCode 重新啟動後執行過時要求。
- 啟用 Telegram 通知代表選定的通知與回覆內容會由 Telegram 服務處理。

## 語言選擇

通知語言依序採用：

1. 使用者明確指定的語言。
2. OpenCode 提供且本外掛支援的語言。
3. 作業系統語言。
4. 英文預設值。

V1 內建 `zh-TW` 與 `en`，不會將使用者內容傳到外部翻譯或語言偵測服務。

## 多電腦限制

V1 不支援同一個 Telegram Bot 同時連接多台電腦。Telegram long polling 只有一個有效消費者；多台電腦同時 polling 可能讀走彼此的訊息，或出現 `409 Conflict`。

如需在多台電腦使用 V1，必須為每台電腦建立不同 Bot，或只在其中一台啟用通知。未來可另外設計安裝時選擇的 Remote Broker 模式，但 V1 不會預先開放 LAN 或網際網路監聽。

## 規格文件

- [提案](../openspec/changes/design-telegram-notifier/proposal.md)
- [技術架構](../openspec/changes/design-telegram-notifier/design.md)
- [實作工作清單](../openspec/changes/design-telegram-notifier/tasks.md)
- [Threat model](threat-model.md)
- [Local broker protocol](protocol.md)
- [Data retention](data-retention.md)
- [Contributor guide](contributing.md)

需求、行為與安全邊界以英文 OpenSpec 文件為準；本頁必須與正式規格保持一致。

# OpenCode Telegram Notifier 繁體中文總覽

OpenCode Telegram Notifier 是一個以隱私與精確路由為優先的 OpenCode Telegram 外掛。它讓同時執行多個專案的使用者可以離開終端機，並在工作完成、發生異常、需要回答問題或需要介入時收到通知。

> 目前狀態：規格與架構設計階段，尚未提供可安裝版本。英文 OpenSpec 文件為正式規格。

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

除了預設的本機執行模式，Broker 也會提供單一 Docker container。OpenCode 與外掛仍在 host 執行，container 只負責 Telegram、SQLite 與路由。

- Broker state 使用持久化 volume。
- Token 與 secret 在執行時掛載，不寫入 image。
- Port 必須使用 `127.0.0.1:42617:42617` 形式發布。
- 不允許省略 host IP，避免 Docker 將 Broker 公開到 `0.0.0.0`。
- 同一份 state 與 Bot 不可同時啟動 native Broker 和 Docker Broker。

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

需求、行為與安全邊界以英文 OpenSpec 文件為準；本頁必須與正式規格保持一致。

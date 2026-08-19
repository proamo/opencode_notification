export const en = {
  "event.completed": "Task completed",
  "event.error": "Session error",
  "event.question": "Your answer is required",
  "event.permission": "Terminal intervention is required",
  "field.project": "Project",
  "field.session": "Session",
  "interaction.accepted": "Your response was delivered.",
  "interaction.alreadyHandled": "This response was already handled.",
  "interaction.expired": "This notification has expired. Wait for a new notification.",
  "interaction.indeterminate":
    "OpenCode did not confirm the result. Check the terminal before retrying.",
  "interaction.invalid": "This response is not valid for the pending question.",
  "interaction.offline": "The OpenCode instance is offline. Return to the terminal.",
  "interaction.rejected": "This response was rejected.",
  "interaction.replyRequired": "Reply directly to an actionable notification.",
  "interaction.stale": "This notification is no longer active. Wait for a new notification.",
  "interaction.terminalOnly": "This action must be handled in the OpenCode terminal.",
  "test.message": "OpenCode Telegram Link test notification",
} as const;

export type MessageKey = keyof typeof en;

export const zhTW = {
  "event.completed": "工作已完成",
  "event.error": "Session 發生錯誤",
  "event.question": "需要你的回答",
  "event.permission": "需要回到終端機介入",
  "field.project": "專案",
  "field.session": "Session",
  "interaction.accepted": "你的回覆已送達。",
  "interaction.alreadyHandled": "此回覆已處理過。",
  "interaction.expired": "此通知已過期，請等待新的通知。",
  "interaction.indeterminate": "OpenCode 尚未確認結果，請回到終端機檢查後再重試。",
  "interaction.invalid": "此回覆不符合目前問題的要求。",
  "interaction.offline": "OpenCode 目前離線，請回到終端機。",
  "interaction.rejected": "此回覆已被拒絕。",
  "interaction.replyRequired": "請直接回覆可操作的通知。",
  "interaction.stale": "此通知已不再有效，請等待新的通知。",
  "interaction.terminalOnly": "此操作必須在 OpenCode 終端機中處理。",
  "test.message": "OpenCode Telegram Link 測試通知",
} as const satisfies Record<MessageKey, string>;

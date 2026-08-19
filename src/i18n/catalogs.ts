export const en = {
  "event.completed": "Task completed",
  "event.error": "Session error",
  "event.question": "Your answer is required",
  "event.permission": "Terminal intervention is required",
  "field.project": "Project",
  "field.session": "Session",
  "interaction.accepted": "Your response was delivered.",
  "interaction.expired": "This notification has expired. Wait for a new notification.",
  "interaction.invalid": "This response is not valid for the pending question.",
  "interaction.offline": "The OpenCode instance is offline. Return to the terminal.",
  "interaction.replyRequired": "Reply directly to an actionable notification.",
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
  "interaction.expired": "此通知已過期，請等待新的通知。",
  "interaction.invalid": "此回覆不符合目前問題的要求。",
  "interaction.offline": "OpenCode 目前離線，請回到終端機。",
  "interaction.replyRequired": "請直接回覆可操作的通知。",
  "interaction.terminalOnly": "此操作必須在 OpenCode 終端機中處理。",
  "test.message": "OpenCode Telegram Link 測試通知",
} as const satisfies Record<MessageKey, string>;

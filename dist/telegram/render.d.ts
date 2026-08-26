export type TelegramRenderOptions = {
    maxLength?: number;
    redactionPatterns?: RegExp[];
};
export type RenderedTelegramPayload = {
    text: string;
    parseMode?: "HTML";
};
export declare class TelegramRenderError extends Error {
    constructor(message: string);
}
export declare function renderTelegramNotification(input: unknown, options?: TelegramRenderOptions): RenderedTelegramPayload;
export declare function sanitizeTelegramText(text: string, options?: TelegramRenderOptions): string;
export declare function formatLocalTime(isoString: string): string;
export declare function redactText(value: string, patterns?: RegExp[]): string;
//# sourceMappingURL=render.d.ts.map
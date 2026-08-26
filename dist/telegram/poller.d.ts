import type { StateDatabase } from "../state";
import { type TelegramBotApi, type TelegramUpdate } from "./api";
export type UpdateDisposition = {
    disposition: "rejected" | "acknowledged" | "failed";
    actionId?: string;
    payloadHash?: string;
};
export type TelegramPollerOptions = {
    api: TelegramBotApi;
    database: StateDatabase;
    handleUpdate: (update: TelegramUpdate) => UpdateDisposition | Promise<UpdateDisposition>;
    longPollSeconds?: number;
    maxConsecutiveFailures?: number;
    retryMinDelayMs?: number;
    retryMaxDelayMs?: number;
    random?: () => number;
    now?: () => number;
};
export declare class TelegramPoller {
    #private;
    constructor(options: TelegramPollerOptions);
    get finished(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=poller.d.ts.map
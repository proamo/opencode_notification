declare const TelegramLinkPlugin: ({ client, directory }: import("@opencode-ai/plugin").PluginInput, options: import("@opencode-ai/plugin").PluginOptions | undefined) => Promise<{
    event?: never;
    dispose?: never;
} | {
    event: ({ event }: {
        event: import("@opencode-ai/sdk").Event;
    }) => Promise<void>;
    dispose: () => Promise<void>;
}>;
export default TelegramLinkPlugin;
//# sourceMappingURL=plugin.d.ts.map
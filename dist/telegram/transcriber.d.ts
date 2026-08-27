export type VoiceTranscriberOptions = {
    apiKey: string;
    provider?: "groq" | "openai" | "custom" | undefined;
    model?: string | undefined;
    endpoint?: string | undefined;
    language?: string | undefined;
    fetchFn?: typeof fetch | undefined;
};
export declare class VoiceTranscriber {
    #private;
    constructor(options: VoiceTranscriberOptions);
    transcribe(audioBuffer: Uint8Array, options?: {
        mimeType?: string | undefined;
        fileName?: string | undefined;
        promptHint?: string | undefined;
        signal?: AbortSignal | undefined;
    }): Promise<string>;
}
//# sourceMappingURL=transcriber.d.ts.map
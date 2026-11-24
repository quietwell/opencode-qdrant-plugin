import { resolveConfig } from "./config.js";
import { readEmbeddingSettings } from "./embedding-settings.js";
import { appendErrorLog } from "./error-log.js";
import { IndexManager } from "./index-manager.js";
import { readStoredOpenRouterApiKey } from "./opencode-auth.js";
import { embeddingProfileFromConfig } from "./profiles.js";
import { readStatusFile, writeStatusFile } from "./status-file.js";
import { registerTools } from "./tools.js";
import { startFileWatcher } from "./watcher.js";
export async function setup(ctx) {
    let credentialLoadedFromOpenCode = false;
    const refreshStoredOpenRouterKey = async () => {
        if (!credentialLoadedFromOpenCode && process.env.OPENROUTER_API_KEY?.trim())
            return;
        const storedApiKey = await readStoredOpenRouterApiKey();
        if (storedApiKey) {
            process.env.OPENROUTER_API_KEY = storedApiKey;
            credentialLoadedFromOpenCode = true;
        }
    };
    await refreshStoredOpenRouterKey();
    const options = resolveConfig(ctx.options);
    const dir = ctx.location.directory;
    const settings = await readEmbeddingSettings(dir);
    const desiredProfile = settings?.desiredProfile ?? embeddingProfileFromConfig(options);
    // V2 has no central app.log API like V1's input.client.app.log. Fall back
    // to stderr; warn/error still write to the persistent error log file.
    const log = async (level, message, extra) => {
        const line = `[opencode-qdrant] ${level.toUpperCase()} ${message}${extra ? " " + JSON.stringify(extra) : ""}`;
        if (level === "error")
            console.error(line);
        else if (level === "warn")
            console.warn(line);
        else if (level === "debug")
            console.debug(line);
        else
            console.log(line);
        if (level === "warn" || level === "error") {
            await appendErrorLog({
                level,
                source: "opencode-qdrant",
                message,
                projectDirectory: dir,
                details: extra,
            }).catch(() => { });
        }
    };
    let lastReportedStatus = null;
    const persisted = await readStatusFile(dir);
    const manager = new IndexManager(dir, options, desiredProfile, persisted, async (state) => {
        await writeStatusFile(dir, state);
        if (state.status !== lastReportedStatus) {
            lastReportedStatus = state.status;
            await log("info", `index state: ${state.status}`, {
                totalFiles: state.totalFiles,
                processedFiles: state.processedFiles,
                errorCount: state.errorCount,
                collectionPointCount: state.collectionPointCount,
            });
        }
    }, log, settings?.fallbackToLocalOnRateLimit ?? false);
    let fileWatcher = null;
    const ensureWatcher = () => {
        if (fileWatcher || !options.watchFiles || !manager.hasActiveIndex())
            return;
        fileWatcher = startFileWatcher({
            rootDirectory: dir,
            debounceMs: options.watchDebounceMs,
            onChange: async (paths) => {
                if (!(await manager.healthCheck()))
                    return;
                await log("info", `Reindex triggered by file watcher (${paths.length} changed)`);
                manager.startIncremental();
            },
        });
    };
    const healthy = await manager.initialize();
    if (healthy) {
        const active = manager.getActiveInfo();
        await log("info", `Initialized Qdrant index ${active.collectionName}`);
        ensureWatcher();
        if (options.indexOnStart && !manager.isRunning() && manager.hasActiveIndex()) {
            manager.startIncremental();
        }
    }
    else {
        await log("warn", `Qdrant unavailable at ${options.qdrantUrl}. Plugin loaded in degraded mode.`);
    }
    const toolReg = await ctx.tool.transform((editor) => {
        registerTools(editor, manager, options, log);
    });
    const eventController = new AbortController();
    void (async () => {
        try {
            for await (const event of ctx.event.subscribe({
                types: ["session.created"],
                signal: eventController.signal,
            })) {
                if (event.type === "session.created") {
                    if (await manager.initialize())
                        ensureWatcher();
                    if (options.indexOnStart &&
                        !manager.isRunning() &&
                        manager.hasActiveIndex()) {
                        manager.startIncremental();
                    }
                }
            }
        }
        catch (err) {
            if (err?.name !== "AbortError") {
                await log("warn", "event subscription ended with error", {
                    error: String(err),
                });
            }
        }
    })();
    return async () => {
        eventController.abort();
        fileWatcher?.close();
        await manager.dispose();
        await toolReg.dispose();
    };
}

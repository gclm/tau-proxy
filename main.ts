// ========================================================================
// 【修复版】Deno 代理脚本 (main.ts) - 请将此完整代码块复制到您的 main.ts 文件中
// ========================================================================

/**
 * Deno script to proxy OpenAI chat completion requests to a Tau API.
 * Handles request/response format translation, including streaming and
 * mapping Tau's 'g:' chunks to OpenAI's 'reasoning_content'.
 * Also supports the /v1/models endpoint.
 * Includes fix for model placement, configurable API key, explicit semicolons,
 * quote cleaning, and debug logging to confirm newline escaping in JSON.
 */

// --- Constants ---
const TAU_API_URL = "https://tau-api.fly.dev/v1/chat";
const DEFAULT_TAU_MODEL = "anthropic-claude-4-opus"; // Default if client model isn't found or mapped
const ALLOWED_TAU_MODELS = [
    "google-gemini-2.5-pro",
    "anthropic-claude-4-sonnet-thinking",
    "anthropic-claude-4-opus",
    "anthropic-claude-4-sonnet",
    "openai-gpt-4.1",
    "openai-gpt-o1",
    "openai-gpt-4o"
];

// Simple mapping for common OpenAI names to Tau names if needed
const MODEL_MAP: Record<string, string> = {
    "gpt-4o": "openai-gpt-4o",
    "gpt-4": "openai-gpt-4.1", // Example mapping based on Tau's listed names
    "gpt-3.5-turbo": "openai-gpt-o1", // Example mapping
    "claude-3-opus-20240229": "anthropic-claude-4-opus",
    "claude-3-sonnet-20240229": "anthropic-claude-4-sonnet",
};

// Read Tau API Key from environment variable
const TAU_API_KEY = Deno.env.get("TAU_API_KEY");
if (!TAU_API_KEY) {
    console.warn("TAU_API_KEY environment variable is not set. Requests to Tau API might fail if authentication is required.");
}


// --- Helper Functions ---

/** Generates a UUID with a prefix for OpenAI-like IDs */
function generateId(prefix: string = ""): string {
    return `${prefix}${crypto.randomUUID().replace(/-/g, '')}`;
}

/** Generates a current timestamp in seconds */
function getCurrentTimestamp(): number {
    return Math.floor(Date.now() / 1000);
}

/** Parses a Tau API stream line, cleaning content from 0: and g: prefixes. */
function parseTauStreamLine(line: string): { prefix: string | null, content: string } {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
        return { prefix: null, content: line };
    }
    const prefix = line.substring(0, colonIndex);
    let content = line.substring(colonIndex + 1);

    if (prefix === '0' || prefix === 'g') {
        if (content.startsWith('"') && content.endsWith('"')) {
            content = content.substring(1, content.length - 1);
        }
        content = content.replace(/""/g, '"');
    }
    return { prefix, content };
}

/** Converts Tau API stream line to OpenAI SSE chunk */
function tauLineToOpenAIChunk(
    line: string,
    completionId: string,
    createdAt: number,
    model: string
): { sse: string | null, isDone: boolean } {
    const { prefix, content } = parseTauStreamLine(line);

    let delta: any = {};
    let finishReason: string | null = null;
    let isDone = false;

    if (prefix === '0') {
        delta.content = content;
    } else if (prefix === 'g') {
        delta.reasoning_content = content;
    } else if (prefix === 'e' || prefix === 'd') {
        try {
            const data = JSON.parse(content);
            if (data.finishReason) {
                finishReason = data.finishReason;
                isDone = true;
            }
        } catch (e) {
            console.error("Failed to parse JSON from e/d prefix:", content, e);
        }
    } else if (['8', '9', 'a', 'b', 'f', '3'].includes(prefix || '') || prefix === null) {
        // Ignore known but unhandled prefixes and null prefixes
        return { sse: null, isDone: false };
    } else {
        console.warn("Received unknown Tau stream prefix:", prefix);
        return { sse: null, isDone: false };
    }

    if (Object.keys(delta).length === 0 && !finishReason) {
         return { sse: null, isDone: false };
    }

    const chunk: any = {
        id: completionId,
        object: "chat.completion.chunk",
        created: createdAt,
        model: model,
        choices: [{
            index: 0,
            delta: delta,
            logprobs: null,
            finish_reason: finishReason
        }]
    };

    const sseData = JSON.stringify(chunk);
    const sseString = `data: ${sseData}\n\n`;

    return { sse: sseString, isDone: isDone };
}

// --- Endpoint Handlers ---

function handleListModels(): Response {
    const models = ALLOWED_TAU_MODELS.map(modelName => ({
        id: modelName,
        object: "model",
        created: getCurrentTimestamp()
    }));

    const responseBody = {
        object: "list",
        data: models,
    };

    return new Response(JSON.stringify(responseBody, null, 2), {
        headers: { "Content-Type": "application/json" },
        status: 200,
    });
}

async function handleChatCompletions(request: Request): Promise<Response> {
    let reqBody: any;
    try {
        reqBody = await request.json();
    } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
    }

    const clientRequestedModel = reqBody.model;
    const stream = reqBody.stream === true;

    let tauModel = DEFAULT_TAU_MODEL;
    if (clientRequestedModel) {
        const mappedModel = MODEL_MAP[clientRequestedModel];
        if (mappedModel && ALLOWED_TAU_MODELS.includes(mappedModel)) {
             tauModel = mappedModel;
        } else if (ALLOWED_TAU_MODELS.includes(clientRequestedModel)) {
             tauModel = clientRequestedModel;
        }
    }

    let modelAdded = false;
    // ================== FIX STARTS HERE ==================
    const tauRequestMessages = reqBody.messages.map((msg: any) => {
        const baseMessage = {
            id: generateId("msg_"),
            role: msg.role,
            metadata: {},
            createdAt: new Date().toISOString(),
        };

        if (msg.role === 'assistant') {
            // Assistant message format
            return {
                ...baseMessage,
                content: msg.content || "", // Use the actual content from history
                parts: [], // Assistant messages should have empty parts
            };
        } else {
            // User (and other roles) message format
            const userMessage: any = {
                ...baseMessage,
                content: "", // User messages have empty content
                parts: (typeof msg.content === 'string') ? [{ type: "text", text: msg.content }] : [],
            };
            if (!modelAdded && msg.role === 'user') {
                userMessage.model = tauModel;
                modelAdded = true;
            }
            return userMessage;
        }
    });
    // ================== FIX ENDS HERE ==================

    const tauRequestBody = {
        id: generateId("bld_"),
        messages: tauRequestMessages,
    };

    const headers: HeadersInit = { "Content-Type": "application/json" };
    if (TAU_API_KEY) {
        headers["Authorization"] = `Bearer ${TAU_API_KEY}`;
    }

    const tauResponse = await fetch(TAU_API_URL, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(tauRequestBody),
    });

    if (!tauResponse.ok) {
        const errorBody = await tauResponse.text();
        return new Response(JSON.stringify({ error: `Upstream API error: ${errorBody}` }), { status: 502 });
    }

    const completionId = generateId("chatcmpl-");
    const createdAt = getCurrentTimestamp();

    if (stream) {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        (async () => {
            const reader = tauResponse.body!.getReader();
            let buffer = "";
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let newlineIndex;
                    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.substring(0, newlineIndex);
                        buffer = buffer.substring(newlineIndex + 1);
                        if (line.trim() === "") continue;
                        const { sse, isDone } = tauLineToOpenAIChunk(line, completionId, createdAt, tauModel);
                        if (sse) await writer.write(encoder.encode(sse));
                        if (isDone) break;
                    }
                }
            } catch (error) {
                console.error("Stream processing error:", error);
            } finally {
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
            }
        })();

        return new Response(readable, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
    } else {
        return new Response(JSON.stringify({ error: "Non-streaming not implemented in this version" }), { status: 400 });
    }
}

// --- Main Request Handler Dispatcher with CORS ---
async function handler(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
        });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    let response: Response;

    if (method === "GET" && path === "/v1/models") {
        response = handleListModels();
    } else if (method === "POST" && path === "/v1/chat/completions") {
        response = await handleChatCompletions(request);
    } else {
        response = new Response("Not Found", { status: 404 });
    }

    const newHeaders = new Headers(response.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
    });
}

// --- Start Server ---
const PORT = 8000;
console.log(`Listening on http://localhost:${PORT}/`);
Deno.serve({ port: PORT }, handler);

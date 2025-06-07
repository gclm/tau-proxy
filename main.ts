// file: openai_tau_proxy_confirm_newlines.ts

/**

Deno script to proxy OpenAI chat completion requests to a Tau API.

Handles request/response format translation, including streaming and

mapping Tau's 'g:' chunks to OpenAI's 'reasoning_content'.

Also supports the /v1/models endpoint.

Includes fix for model placement, configurable API key, explicit semicolons,

quote cleaning, and debug logging to confirm newline escaping in JSON.
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
// Add more mappings if clients use different names
};

// Read Tau API Key from environment variable
const TAU_API_KEY = Deno.env.get("TAU_API_KEY");
if (!TAU_API_KEY) {
console.warn("TAU_API_KEY environment variable is not set. Requests to Tau API might fail if authentication is required.");
}

// --- Helper Functions ---

/** Generates a UUID with a prefix for OpenAI-like IDs */
function generateId(prefix: string = ""): string {
return ${prefix}${crypto.randomUUID().replace(/-/g, '')};
}

/** Generates a current timestamp in seconds */
function getCurrentTimestamp(): number {
return Math.floor(Date.now() / 1000);
}

/** Parses a Tau API stream line, cleaning content from 0: and g: prefixes. */
function parseTauStreamLine(line: string): { prefix: string | null, content: string } {
console.debug(Raw stream line received: "${line.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}");

const colonIndex = line.indexOf(':');
if (colonIndex === -1) {
     console.warn("Stream line missing prefix colon:", line);
    return { prefix: null, content: line };
}
const prefix = line.substring(0, colonIndex);
let content = line.substring(colonIndex + 1);

// --- Cleaning Logic for 0: and g: content ---
if (prefix === '0' || prefix === 'g') {
    // Check if content is wrapped in an extra pair of quotes, as observed
    if (content.startsWith('"') && content.endsWith('"')) {
        content = content.substring(1, content.length - 1);
    }
    // Replace any occurrences of double double quotes ("") with a single quote (")
    content = content.replace(/""/g, '"');
    // The content string *now* contains literal \n characters where they were in the Tau stream.
}
// --- End Cleaning Logic ---

console.debug(`Parsed line: Prefix: "${prefix}", Cleaned Content string (contains actual newlines): "${content.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);

return { prefix, content };


}

/** Converts Tau API stream line to OpenAI SSE chunk */
function tauLineToOpenAIChunk(
line: string,
completionId: string,
createdAt: number,
model: string
): { sse: string | null, isDone: boolean, finishReason: string | null, usage: any | null } {
const { prefix, content } = parseTauStreamLine(line);

let delta: any = {};
let finishReason: string | null = null;
let isDone = false;
let usage: any | null = null;

if (prefix === '0') {
    delta.content = content; // This is the cleaned string with actual \n characters
    console.debug(`SSE Chunk (0:): Content string being put into delta: "${content.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);
} else if (prefix === 'g') {
    delta.reasoning_content = content; // This is the cleaned string with actual \n characters
     console.debug(`SSE Chunk (g:): Reasoning string being put into delta: "${content.replace(/\n/g, "\\n").replace(/\r{/g, "\\r")}"`);
} else if (prefix === 'e' || prefix === 'd') {
    try {
        const data = JSON.parse(content);
        if (data.finishReason) {
            finishReason = data.finishReason;
            isDone = true;
            console.debug(`SSE Chunk (e/d:): Found finish reason: ${finishReason}`);
        }
        if (data.usage) {
             usage = {
                 prompt_tokens: data.usage.inputTokens || 0,
                 completion_tokens: data.usage.outputTokens || 0,
                 total_tokens: (data.usage.inputTokens || 0) + (data.usage.outputTokens || 0),
             };
             console.debug(`SSE Chunk (e/d:): Found usage: ${JSON.stringify(usage)}`);
        }
    } catch (e) {
        console.error("Failed to parse JSON from e/d prefix:", content, e);
    }
} else if (prefix === '8') {
     try {
          const data = JSON.parse(content);
          if (data.usageCost && data.usageTokens) {
              usage = {
                  prompt_tokens: data.usageTokens.inputTokens || 0,
                  completion_tokens: data.usageTokens.outputTokens || 0,
                  total_tokens: (data.usageTokens.inputTokens || 0) + (data.usageTokens.outputTokens || 0),
              };
              console.debug(`SSE Chunk (8:): Found usage: ${JSON.stringify(usage)}`);
          }
     } catch (e) {
        console.error("Failed to parse JSON from 8 prefix:", content, e);
     }
} else if (prefix === null) {
     return { sse: null, isDone: false, finishReason: null, usage: null };
} else {
    console.warn("Received unknown Tau stream prefix:", prefix, "content:", content);
    return { sse: null, isDone: false, finishReason: null, usage: null };
}

if (Object.keys(delta).length === 0 && !finishReason && !usage) {
     return { sse: null, isDone: false, finishReason: null, usage: null };
}

const chunk: any = {
    id: completionId,
    object: "chat.completion.chunk",
    created: createdAt,
    model: model,
    choices: [{
        index: 0,
        delta: delta, // delta now contains the cleaned string with actual newlines
        logprobs: null,
        finish_reason: finishReason
    }]
};

// JSON.stringify will automatically escape the actual newlines (\n) in delta strings to \\n
const sseData = JSON.stringify(chunk);
const sseString = `data: ${sseData}\n\n`;

// Log the final SSE string *exactly* as it's being sent over the wire
console.debug(`SSE Chunk: Final data line being sent: "${sseString.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);


return { sse: sseString, isDone: isDone, finishReason: finishReason, usage: usage };
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

// --- Endpoint Handlers ---

function handleListModels(): Response {
const models = ALLOWED_TAU_MODELS.map(modelName => ({
id: modelName,
object: "model",
created: getCurrentTimestamp(),
owned_by: "tau-proxy",
}));

const responseBody = {
    object: "list",
    data: models,
};

return new Response(JSON.stringify(responseBody, null, 2), {
    headers: { "Content-Type": "application/json" },
    status: 200,
});
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

async function handleChatCompletions(request: Request): Promise<Response> {
let reqBody: any;
try {
reqBody = await request.json();
} catch (error) {
console.error("Failed to parse request body:", error);;
return new Response(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }), {
status: 400,
headers: { "Content-Type": "application/json" },
});;
}

if (!Array.isArray(reqBody.messages) || reqBody.messages.length === 0) {
    return new Response(JSON.stringify({ error: { message: "Request body must contain a non-empty 'messages' array", type: "invalid_request_error" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
    });;
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
    } else {
        console.warn(`Client requested model "${clientRequestedModel}" not found in mapping or allowed Tau models. Using default: "${DEFAULT_TAU_MODEL}"`);
    }
} else {
    console.log(`No model specified by client. Using default: "${DEFAULT_TAU_MODEL}"`);
}


let modelAdded = false;
const tauRequestMessages = reqBody.messages.map((msg: any) => {
    const messageId = generateId("msg_");
    const createdAt = new Date().toISOString();
    const role = msg.role;

    let parts: any[] = [];
    if (typeof msg.content === 'string' && msg.content.length > 0) {
        parts.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
        parts = msg.content.filter((part: any) => part.type === 'text' && part.text && part.text.length > 0).map((part: any) => ({ type: "text", text: part.text }));
         if (parts.length === 0 && msg.content.length > 0) {
             console.warn("Unsupported non-text multimodal content in message:", msg.content);
         }
    }

    const tauMessage: any = {
        id: messageId,
        content: "", // As per example
        role: role,
        parts: parts,
        metadata: {}, // As per example
        createdAt: createdAt,
    };

    if (!modelAdded && role === 'user') {
         tauMessage.model = tauModel;
         modelAdded = true;
         console.log(`Added model ${tauModel} to the first user message.`);
    } else if (role === 'assistant') {
        tauMessage.content = typeof msg.content === 'string' ? msg.content : '';
        tauMessage.parts = [];
         if (typeof msg.content !== 'string' && msg.content != null) {
              console.warn(`Assistant message content is not a string and cannot be mapped to Tau's content field: ${typeof msg.content}`);
         }
    }

    return tauMessage;
});

const tauRequestId = generateId("bld_");

const tauRequestBody = {
    id: tauRequestId,
    messages: tauRequestMessages,
};

console.log("Sending request to Tau API:", JSON.stringify(tauRequestBody, null, 2));

const headers: HeadersInit = {
    "Content-Type": "application/json",
};
if (TAU_API_KEY) {
    headers["Authorization"] = `Bearer ${TAU_API_KEY}`;
}


let tauResponse: Response;
try {
    tauResponse = await fetch(TAU_API_URL, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(tauRequestBody),
    });
} catch (error) {
    console.error("Failed to connect to Tau API:", error);;
    return new Response(JSON.stringify({ error: { message: `Failed to connect to upstream API: ${error.message}`, type: "upstream_error" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
    });;
}

if (!tauResponse.ok) {
    const errorBody = await tauResponse.text();
    console.error(`Tau API returned status ${tauResponse.status}: ${errorBody}`);;
    let errorJson = null;
    try {
        errorJson = JSON.parse(errorBody);
    } catch (e) { /* Not JSON */ }

    return new Response(JSON.stringify({
        error: {
            message: `Upstream API error: ${tauResponse.status} - ${errorBody}`,
            type: "upstream_error",
            details: errorJson
        }
    }), {
        status: tauResponse.status >= 400 && tauResponse.status < 500 ? 400 : 502,
        headers: { "Content-Type": "application/json" },
    });;
}

// --- Handle Tau API Response ---

const completionId = generateId("chatcmpl-");
const createdAt = getCurrentTimestamp();

if (stream) {
    // --- Streaming Response ---
    const reader = tauResponse.body!.getReader();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    async function processStream() {
        let buffer = "";
        let finished = false;

        try {
            while (!finished) {
                const { done, value } = await reader.read();

                if (done) {
                    finished = true;
                } else {
                    buffer += decoder.decode(value, { stream: true });
                }

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex);
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.trim() === "") continue;
                    // parseTauStreamLine logs raw line and cleaned content

                    const { sse, isDone, finishReason, usage } = tauLineToOpenAIChunk(line, completionId, createdAt, tauModel);

                    if (sse) {
                       await writer.write(encoder.encode(sse));
                    }

                    if (isDone) {
                         finished = true;
                     }
                }

                if (finished && buffer.length > 0) {
                    console.warn("Processing leftover buffer after stream end:", buffer);;
                     const { sse, isDone: lastIsDone, finishReason: lastFinishReason, usage: lastChunkUsage } = tauLineToOpenAIChunk(buffer, completionId, createdAt, tauModel);
                     if (sse) {
                        await writer.write(encoder.encode(sse));
                     }
                     finished = finished || lastIsDone;
                     buffer = "";
                }
            }
        } catch (error) {
            console.error("Stream processing error:", error);;
            try {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ error: { message: `Stream error: ${error.message}`, type: "stream_error" } })}\n\n`));
            } catch (writeError) { console.error("Failed to write error message:", writeError);; }
        } finally {
             try {
                 await writer.write(encoder.encode("data: [DONE]\n\n"));
                 await writer.close();
             } catch (closeError) { console.error("Failed to send DONE or close stream:", closeError);; }
        }
    }

    processStream();

    return new Response(readable, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    });;

} else {
    // --- Non-Streaming Response ---
    let buffer = "";
    const reader = tauResponse.body!.getReader();
    const decoder = new TextDecoder();

    let combinedContent = "";
    let combinedReasoningContent = "";
    let finishReason: string | null = null;
    let usageData: any | null = null;

    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });

            if (done) {
                break;
            }

            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.substring(0, newlineIndex);
                buffer = buffer.substring(newlineIndex + 1);

                if (line.trim() === "") continue;
                // parseTauStreamLine logs raw line and cleaned content

                const { prefix, content } = parseTauStreamLine(line);

                if (prefix === '0') {
                     combinedContent += content; // Use the cleaned content
                     console.debug(`Non-stream: Appended to combinedContent string: "${content.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);
                } else if (prefix === 'g') {
                     combinedReasoningContent += content; // Use the cleaned content
                     console.debug(`Non-stream: Appended to combinedReasoningContent string: "${content.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);
                } else if (prefix === 'e' || prefix === 'd') {
                    try {
                         const data = JSON.parse(content);
                         if (data.finishReason) {
                             finishReason = data.finishReason;
                             console.debug(`Non-stream: Found finish reason: ${finishReason}`);
                         }
                         if (data.usage) {
                            usageData = {
                                prompt_tokens: data.usage.inputTokens || 0,
                                completion_tokens: data.usage.outputTokens || 0,
                                total_tokens: (data.usage.inputTokens || 0) + (data.usage.outputTokens || 0),
                            };
                            console.debug(`Non-stream: Found usage (e/d): ${JSON.stringify(usageData)}`);
                         }
                    } catch (e) {
                        console.error("Failed to parse JSON from e/d prefix (non-stream):", content, e);;
                    }
                } else if (prefix === '8') {
                     try {
                          const data = JSON.parse(content);
                          if (data.usageCost && data.usageTokens) {
                              usageData = {
                                  prompt_tokens: data.usageTokens.inputTokens || 0,
                                  completion_tokens: data.usageTokens.outputTokens || 0,
                                  total_tokens: (data.usageTokens.inputTokens || 0) + (data.usageTokens.outputTokens || 0),
                              };
                               console.debug(`Non-stream: Found usage (8): ${JSON.stringify(usageData)}`);
                          }
                     } catch (e) {
                        console.error("Failed to parse JSON from 8 prefix (non-stream):", content, e);;
                     }
                } else if (prefix === null) {
                     console.warn("Ignoring non-stream line with no prefix:", line);
                } else {
                    console.warn("Received unknown Tau non-stream prefix:", prefix, "content:", content);
                }
            }
        }
    } catch (error) {
        console.error("Error reading Tau API response (non-stream):", error);;
        return new Response(JSON.stringify({ error: { message: `Error processing upstream response: ${error.message}`, type: "upstream_error" } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });;
    }

     // Process any remaining buffer after the loop
    if (buffer.length > 0) {
         console.warn("Non-stream buffer leftover:", buffer);;
         const lines = buffer.split('\n');
         for(const line of lines) {
            if (line.trim() === "") continue;
             const { prefix, content } = parseTauStreamLine(line);
             if (prefix === '0') {
                 combinedContent += content; // Use the cleaned content
                  console.debug(`Non-stream: Appended leftover to combinedContent string: "${content.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);
             } else if (prefix === 'g') {
                 combinedReasoningContent += content; // Use the cleaned content
                  console.debug(`Non-stream: Appended leftover to combinedReasoningContent string: "${content.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);
             } else if (prefix === 'e' || prefix === 'd') {
                  try {
                     const data = JSON.parse(content);
                     if (data.finishReason) finishReason = data.finishReason;
                     if (data.usage) usageData = { prompt_tokens: data.usage.inputTokens || 0, completion_tokens: data.usage.completionTokens || 0, total_tokens: (data.usage.inputTokens || 0) + (data.usage.completionTokens || 0) };
                      console.debug(`Non-stream: Found leftover usage/finish (e/d): ${JSON.stringify(usageData || { finishReason })}`);
                  } catch (e) { console.warn("Failed to parse leftover e/d:", buffer);; }
             } else if (prefix === '8') {
                  try {
                       const data = JSON.parse(content);
                       if (data.usageCost && data.usageTokens) { usageData = { prompt_tokens: data.usageTokens.inputTokens || 0, completion_tokens: data.usageTokens.outputTokens || 0, total_tokens: (data.usageTokens.inputTokens || 0) + (data.usageTokens.outputTokens || 0) }; }
                        console.debug(`Non-stream: Found leftover usage (8): ${JSON.stringify(usageData)}`);
                  } catch (e) { console.warn("Failed to parse leftover 8:", buffer);; }
             } else if (prefix === null) {
                  console.warn("Ignoring leftover non-stream line with no prefix:", line);
             } else {
                  console.warn("Received unknown Tau non-stream leftover prefix:", prefix, "content:", content);
             }
         }
    }

    // Log the final combined string content *before* it's JSON.stringify-ed
    console.debug("Non-Stream: Final combinedContent string before JSON.stringify:", `"${combinedContent.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);
    console.debug("Non-Stream: Final combinedReasoningContent string before JSON.stringify:", `"${combinedReasoningContent.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);


    const responseJson: any = {
        id: completionId,
        object: "chat.completion",
        created: createdAt,
        model: tauModel,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: combinedContent, // Use the combined, cleaned string
            },
            logprobs: null,
            finish_reason: finishReason,
        }],
        usage: usageData ? {
             prompt_tokens: usageData.prompt_tokens,
             completion_tokens: usageData.completion_tokens,
             total_tokens: usageData.prompt_tokens + usageData.completion_tokens,
        } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        system_fingerprint: "tau_api_proxy",
    };;

    console.debug("Final Non-Stream Response Body (after JSON.stringify):", JSON.stringify(responseJson, null, 2));

    return new Response(JSON.stringify(responseJson, null, 2), {
        headers: { "Content-Type": "application/json" },
    });;
}
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

// --- Main Request Handler Dispatcher ---

async function handler(request: Request): Promise<Response> {
const url = new URL(request.url);
const path = url.pathname;
const method = request.method;

console.log(`Received request: ${method} ${path}`);;

if (method === "GET" && path === "/v1/models") {
    return handleListModels();;
} else if (method === "POST" && path === "/v1/chat/completions") {
    return handleChatCompletions(request);;
} else {
    return new Response("Not Found", { status: 404 });;
}
IGNORE_WHEN_COPYING_START
content_copy
download
Use code with caution.
IGNORE_WHEN_COPYING_END

}

// --- Start Server ---
const PORT = 8000;
console.log(Listening on http://localhost:${PORT}/);;
Deno.serve({ port: PORT }, handler);;

/**
 * Antigravity Transformer Plugin
 * 
 * Transforms requests/responses between unified format and Antigravity API format.
 * Uses Google OAuth for authentication (mandatory).
 * 
 * Usage in config.json:
 * {
 *   "transformers": [
 *     {
 *       "path": "/path/to/plugins/antigravity.transformer.js",
 *       "options": {
 *         "project": "your-project-id",
 *         "userAgent": "antigravity"
 *       }
 *     }
 *   ]
 * }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// Configuration
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude-code-router', 'google_credentials.json');
const OAUTH_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

/**
 * Read stored credentials from file
 */
function readCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const data = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[antigravity] Error reading credentials:', error.message);
  }
  return null;
}

/**
 * Save credentials to file
 */
function saveCredentials(credentials) {
  try {
    const dir = path.dirname(CREDENTIALS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
  } catch (error) {
    console.error('[antigravity] Error saving credentials:', error.message);
  }
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken(credentials) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
      grant_type: 'refresh_token'
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      port: 443,
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.access_token) {
            // Update stored credentials with new access token
            credentials.access_token = response.access_token;
            credentials.token_expiry = Date.now() + (response.expires_in * 1000);
            saveCredentials(credentials);
            resolve(response.access_token);
          } else {
            reject(new Error(response.error_description || 'Failed to refresh token'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Get a fresh access token (refresh if needed)
 */
async function getFreshAccessToken() {
  const credentials = readCredentials();
  
  if (!credentials) {
    throw new Error(
      '[antigravity] No Google credentials found. Please authenticate via the web UI at http://localhost:3456/google-auth'
    );
  }

  if (!credentials.refresh_token) {
    throw new Error(
      '[antigravity] No refresh token found. Please re-authenticate via the web UI at http://localhost:3456/google-auth'
    );
  }

  // Check if token is expired or about to expire (5 min buffer)
  const now = Date.now();
  const expiryThreshold = 5 * 60 * 1000; // 5 minutes
  
  if (credentials.access_token && credentials.token_expiry && (credentials.token_expiry - now) > expiryThreshold) {
    return credentials.access_token;
  }

  // Refresh the token
  console.log('[antigravity] Refreshing access token...');
  return await refreshAccessToken(credentials);
}

/**
 * Clean parameters object by removing unsupported fields and fixing schema compatibility
 * for Gemini/Vertex API which requires JSON Schema draft 2020-12 format
 * Recursively processes nested objects
 * Also converts lowercase types to uppercase (object -> OBJECT, string -> STRING, etc.)
 */
function cleanParameters(params) {
  if (!params || typeof params !== 'object') {
    return params;
  }
  
  if (Array.isArray(params)) {
    return params.map(cleanParameters);
  }
  
  const cleaned = {};
  for (const [key, value] of Object.entries(params)) {
    // Skip unsupported fields for Gemini/Vertex
    if (key === '$schema' || key === '$id' || key === '$ref' || key === '$defs' || 
        key === 'definitions' || key === '$comment' || key === 'examples' ||
        key === 'default' || key === 'additionalProperties' || //key === 'enum'
        key === 'minimum' || key === 'maximum' || key === 'minLength' || key === 'maxLength' ||
        key === 'minItems' || key === 'maxItems' || key === 'uniqueItems' ||
        key === 'pattern' || key === 'format' || key === 'nullable' || key === 'oneOf' ||
        key === 'anyOf' || key === 'allOf' || key === 'not') {
      continue;
    }
    
    // Skip empty required arrays (they can cause schema validation errors)
    if (key === 'required' && Array.isArray(value) && value.length === 0) {
      continue;
    }
    
    // Skip empty properties objects
    if (key === 'properties' && typeof value === 'object' && Object.keys(value).length === 0) {
      continue;
    }
    
    // Handle items - if it's an empty object or has unsupported fields, simplify it
    if (key === 'items' && typeof value === 'object') {
      const cleanedItems = cleanParameters(value);
      // If items is empty object after cleaning, use a simple string type
      if (Object.keys(cleanedItems).length === 0) {
        cleaned[key] = { type: 'string' };
      } else {
        cleaned[key] = cleanedItems;
      }
      continue;
    }
    
    cleaned[key] = cleanParameters(value);
  }
  
  // If we have 'required' but no 'properties', remove required
  if (cleaned.required && !cleaned.properties) {
    delete cleaned.required;
  }
  
  return cleaned;
}


/**
 * Antigravity Transformer class
 */
class AntigravityTransformer {
  constructor(options = {}) {
    this.name = 'antigravity';
    
    // Default model mappings: Claude Code model -> Antigravity model
    const defaultModelMapping = {
      // Opus variants
      'claude-opus-4-5-20251101': 'claude-opus-4-5-thinking',
      'claude-opus-4-20250514': 'claude-opus-4-5-thinking',
      // Sonnet variants
      'claude-sonnet-4-5-20250514': 'claude-sonnet-4-5-thinking',
      'claude-sonnet-4-20250514': 'claude-sonnet-4-5-thinking',
      // Haiku variants -> gemini3-pro-high
      'claude-haiku-4-5-20251001': 'gemini3-pro-high',
      'claude-3-5-haiku-20241022': 'gemini3-pro-high'
    };
    
    this.options = {
      project: options.project || 'default-project',
      userAgent: options.userAgent || 'antigravity',
      requestType: options.requestType || 'agent',
      defaultModel: options.defaultModel || 'claude-sonnet-4-5-20250514',
      modelMapping: { ...defaultModelMapping, ...options.modelMapping },
      ...options
    };
    
    // Build reverse mapping for response transformation
    this.reverseModelMapping = {};
    for (const [claudeModel, antigravityModel] of Object.entries(this.options.modelMapping)) {
      this.reverseModelMapping[antigravityModel] = claudeModel;
    }
  }

  /**
   * Transform unified request to Antigravity format
   * Called when sending request TO the API
   */
  async transformRequestIn(request, provider, context) {
    // Log to file
    const logPath = path.join(os.homedir(), '.claude-code-router', 'logs', 'antigravity.log');
    const timestamp = new Date().toISOString();

    // Get OAuth access token (mandatory)
    const accessToken = await getFreshAccessToken();
    
    // Generate request ID
    const requestId = `agent-${crypto.randomUUID()}`;
    
    // Build contents array from messages
    const contents = [];
    const toolResponses = request.messages.filter(m => m.role === 'tool');
    
    for (const message of request.messages.filter(m => m.role !== 'tool')) {
      let role;
      if (message.role === 'assistant') {
        role = 'model';
      } else if (message.role === 'system') {
        // System messages go to systemInstruction, not contents
        continue;
      } else {
        role = 'user';
      }

      const parts = [];

      // Handle text content - only add if content is non-empty
      if (typeof message.content === 'string' && message.content) {
        const part = { text: message.content };
        if (message.thinking?.signature) {
          part.thoughtSignature = message.thinking.signature;
        }
        parts.push(part);
      } else if (Array.isArray(message.content)) {
        for (const content of message.content) {
          if (content.type === 'text' && content.text) {
            parts.push({ text: content.text });
          } else if (content.type === 'image_url') {
            if (content.image_url.url.startsWith('http')) {
              parts.push({
                file_data: {
                  mime_type: content.media_type,
                  file_uri: content.image_url.url
                }
              });
            } else {
              parts.push({
                inlineData: {
                  mime_type: content.media_type,
                  data: content.image_url.url.split(',').pop() || content.image_url.url
                }
              });
            }
          }
        }
      }

      // Handle tool calls
      if (Array.isArray(message.tool_calls)) {
        for (let i = 0; i < message.tool_calls.length; i++) {
          const toolCall = message.tool_calls[i];
          const part = {
            functionCall: {
              id: toolCall.id || `tool_${Math.random().toString(36).substring(2, 15)}`,
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments || '{}')
            }
          };
          if (i === 0 && message.thinking?.signature) {
            part.thoughtSignature = message.thinking.signature;
          }
          parts.push(part);
        }
      }

      // Only push message if there are actual parts
      if (parts.length > 0) {
        contents.push({ role, parts });
      }

      // Add function responses after model messages with tool calls
      if (role === 'model' && message.tool_calls) {
        const functionResponses = message.tool_calls.map(tool => {
          const response = toolResponses.find(item => item.tool_call_id === tool.id);
          return {
            functionResponse: {
              id: tool.id,
              name: tool.function?.name,
              response: { output: response?.content }
            }
          };
        });
        if (functionResponses.length > 0) {
          contents.push({ role: 'user', parts: functionResponses });
        }
      }
    }

    // Build system instruction from system content
    // Anthropic format has "system" as a top-level array, not in messages
    let systemInstruction = null;
    
    // Check for top-level system array (Anthropic format)
    if (request.system && Array.isArray(request.system) && request.system.length > 0) {
      const systemParts = request.system
        .filter(c => c.type === 'text' && c.text)
        .map(c => ({ text: c.text }));
      
      if (systemParts.length > 0) {
        systemInstruction = {
          role: 'user',
          parts: systemParts
        };
      }
    }
    // Also check for system messages in the messages array (fallback)
    else {
      const systemMessages = request.messages.filter(m => m.role === 'system');
      if (systemMessages.length > 0) {
        const systemParts = [];
        for (const m of systemMessages) {
          if (typeof m.content === 'string') {
            systemParts.push({ text: m.content });
          } else if (Array.isArray(m.content)) {
            // Handle array of content objects
            for (const c of m.content) {
              if (c.type === 'text' && c.text) {
                systemParts.push({ text: c.text });
              }
            }
          }
        }
        
        if (systemParts.length > 0) {
          systemInstruction = {
            role: 'user',
            parts: systemParts
          };
        }
      }
    }

    // Build tools array
    // Handle both Anthropic format (name, input_schema) and OpenAI format (function.name, function.parameters)
    // Use a single functionDeclarations array for all tools
    let tools = null;
    
    if (request.tools && request.tools.length > 0) {
      const functionDeclarations = [];
      
      for (const tool of request.tools) {
        // Skip web_search tool (handled by separate rerouting)
        if (tool.type === 'web_search_20250305') {
          continue;
        }
        
        const toolName = tool.name || tool.function?.name;
        
        let functionDeclaration;
        const emptyParams = { type: 'object', properties: {} };
        
        // Handle Anthropic format (name + input_schema)
        if (tool.name && tool.input_schema) {
          const cleanedParams = cleanParameters(tool.input_schema);
          functionDeclaration = {
            name: tool.name,
            description: tool.description || '',
            // Always include parameters - use cleaned or default empty
            parameters: (cleanedParams && Object.keys(cleanedParams).length > 0) ? cleanedParams : emptyParams
          };
        }
        // Handle tool with direct parameters (name + parameters)
        else if (tool.name && tool.parameters) {
          const cleanedParams = cleanParameters(tool.parameters);
          functionDeclaration = {
            name: tool.name,
            description: tool.description || '',
            parameters: (cleanedParams && Object.keys(cleanedParams).length > 0) ? cleanedParams : emptyParams
          };
        }
        // Handle OpenAI format (function wrapper)
        else if (tool.function) {
          const func = tool.function;
          const cleanedParams = cleanParameters(func.parameters);
          functionDeclaration = {
            name: func.name,
            description: func.description || '',
            parameters: (cleanedParams && Object.keys(cleanedParams).length > 0) ? cleanedParams : emptyParams
          };
        }
        // Handle tools with just name (no input_schema or parameters)
        else if (tool.name) {
          functionDeclaration = {
            name: tool.name,
            description: tool.description || '',
            parameters: emptyParams
          };
        }
        
        // Add the tool if we have a declaration
        if (functionDeclaration) {
          functionDeclarations.push(functionDeclaration);
        } else {
          console.warn(`[antigravity] Unknown tool format, skipping:`, JSON.stringify(tool).slice(0, 100));
        }
      }

      // Build tools array with single functionDeclarations entry
      tools = [];
      if (functionDeclarations.length > 0) {
        tools.push({ functionDeclarations: functionDeclarations });
      }
      
      // If no tools after filtering, set to null
      if (tools.length === 0) {
        tools = null;
      }
    }

    // Build tool config - default to VALIDATED when tools are present
    let toolConfig = null;
    if (tools && tools.length > 0) {
      toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
      if (request.tool_choice === 'auto') {
        toolConfig.functionCallingConfig.mode = 'AUTO';
      } else if (request.tool_choice === 'none') {
        toolConfig.functionCallingConfig.mode = 'NONE';
      } else if (request.tool_choice === 'required') {
        toolConfig.functionCallingConfig.mode = 'ANY';
      } else if (request.tool_choice?.function?.name) {
        toolConfig.functionCallingConfig.mode = 'ANY';
        toolConfig.functionCallingConfig.allowedFunctionNames = [request.tool_choice.function.name];
      }
    }

    // Build generation config
    const generationConfig = {};
    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature;
    }
    if (request.max_tokens !== undefined) {
      generationConfig.maxOutputTokens = request.max_tokens;
    }
    if (request.top_p !== undefined) {
      generationConfig.topP = request.top_p;
    }

    // Add thinking config if reasoning is enabled
    if (request.reasoning && request.reasoning.effort && request.reasoning.effort !== 'none') {
      generationConfig.thinkingConfig = {
        includeThoughts: true
      };
      if (request.reasoning.max_tokens) {
        generationConfig.thinkingConfig.thinkingBudget = request.reasoning.max_tokens;
      }
    }

    // Generate a session ID (negative number as seen in working example)
    const sessionId = `-${Date.now().toString().slice(-19)}`;

    // Map the Claude model to Antigravity model using configurable mapping
    // request.originalModel is set by router.ts before overwriting body.model
    const requestedModel = request.originalModel || context?.originalModel || request.model || '';
    let antigravityModel = this.options.modelMapping[requestedModel];
    if (!antigravityModel) {
      // Fallback: check if model name contains known patterns
      const modelLower = requestedModel.toLowerCase();
      if (modelLower.includes('opus')) {
        antigravityModel = this.options.modelMapping['claude-opus-4-5-20251101'] || 'claude-opus-4-5-thinking';
      } else if (modelLower.includes('haiku')) {
        antigravityModel = this.options.modelMapping['claude-haiku-4-5-20251001'] || 'gemini3-pro-high';
      } else {
        // Default to Sonnet mapping
        antigravityModel = this.options.modelMapping['claude-sonnet-4-5-20250514'] || 'claude-sonnet-4-5-thinking';
      }
      console.log(`[antigravity] Model "${requestedModel}" (fallback) mapped to "${antigravityModel}"`);
    } else {
      console.log(`[antigravity] Model "${requestedModel}" mapped to "${antigravityModel}"`);
    }

    // Build the Antigravity request envelope
    const antigravityRequest = {
      project: this.options.project,
      requestId: requestId,
      request: {
        contents,
        ...(systemInstruction && { systemInstruction }),
        ...(tools && { tools }),
        ...(toolConfig && { toolConfig }),
        ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
        sessionId: sessionId
      },
      model: antigravityModel,
      userAgent: this.options.userAgent,
      requestType: this.options.requestType
    };

    // Log full request for debugging
    fs.appendFileSync(logPath, `[${timestamp}] FULL REQUEST:\n${JSON.stringify(antigravityRequest, null, 2)}\n\n`);

    return {
      body: antigravityRequest,
      config: {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/ windows/amd64'
        }
      },
      // Pass the requested model to response transformer for dynamic model switching
      requestModel: request.model,
      // Pass access token for WebSearch execution
      accessToken: accessToken
    };
  }
  /**
   * Transform Antigravity response to unified format
   * Called when receiving response FROM the API
   * 
   * Antigravity API returns Gemini-style SSE format that needs to be
   * converted to OpenAI-style streaming format.
   */
  async transformResponseOut(response, context) {
    const contentType = response.headers.get('Content-Type') || '';
    
    // Get requested model from context (set by transformRequestIn via router)
    const requestedModel = context?.requestModel || this.options.defaultModel;
    
    // Handle web search response - convert non-streaming JSON to SSE stream
    if (context?.isWebSearch && contentType.includes('application/json')) {
      console.log(`[antigravity] Web search response - converting JSON to SSE stream`);
      const result = await response.json();
      return this.transformWebSearchResponse(result, { model: requestedModel });
    }
    
    // Streaming SSE response - transform from Gemini to Anthropic format
    if (contentType.includes('text/event-stream') || contentType.includes('stream')) {
      return this.transformStreamResponse(response, requestedModel);
    }
    
    if (contentType.includes('application/json')) {
      // Non-streaming response - may need transformation
      return this.transformJsonResponse(response, requestedModel);
    }
    
    return response;
  }

  /**
   * Transform web search JSON response to Claude-compatible SSE stream
   */
  transformWebSearchResponse(result, originalRequest) {
    const encoder = new TextEncoder();
    
    const candidate = result.response?.candidates?.[0];
    if (!candidate) {
      throw new Error('No candidate in web search response');
    }
    
    // Extract text content from response
    const textContent = (candidate.content?.parts || [])
      .filter(p => p.text && !p.thought)
      .map(p => p.text)
      .join('');
    
    // Extract grounding metadata for search results
    const groundingChunks = candidate.groundingMetadata?.groundingChunks || [];
    const searchQuery = (candidate.groundingMetadata?.webSearchQueries || [])[0] || '';
    
    // Build web search results
    const webSearchResults = groundingChunks
      .filter(chunk => chunk.web)
      .map((chunk, index) => {
        const contentData = `${chunk.web.uri}:${index}:${Date.now()}`;
        const encrypted_content = Buffer.from(contentData).toString('base64');
        return {
          type: 'web_search_result',
          title: chunk.web.title || chunk.web.domain,
          url: chunk.web.uri,
          encrypted_content: encrypted_content,
          page_age: null
        };
      });
    
    // Create SSE stream
    const stream = new ReadableStream({
      start(controller) {
        const sendEvent = (eventType, data) => {
          controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        
        const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').substring(0, 24)}`;
        const searchToolId = `srvtoolu_${Math.random().toString(36).substring(2, 15)}`;
        const modelName = originalRequest.model || 'claude-sonnet-4-5-20250514';
        
        let blockIndex = -1;
        
        // message_start
        sendEvent('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: modelName,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        });
        
        // server_tool_use block for web search
        blockIndex++;
        sendEvent('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'server_tool_use',
            id: searchToolId,
            name: 'web_search',
            input: { query: searchQuery }
          }
        });
        sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        
        // web_search_tool_result block
        blockIndex++;
        sendEvent('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: searchToolId,
            content: webSearchResults
          }
        });
        sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        
        // text block with the actual response
        if (textContent) {
          blockIndex++;
          sendEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' }
          });
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: textContent }
          });
          sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        }
        
        // message_delta with stop reason
        sendEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: {
            output_tokens: result.response?.usageMetadata?.candidatesTokenCount || 0
          }
        });
        
        // message_stop
        sendEvent('message_stop', { type: 'message_stop' });
        
        console.log(`[antigravity] Emitted ${webSearchResults.length} web search results from transformWebSearchResponse`);
        controller.close();
      }
    });
    
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  }

  /**
   * Transform non-streaming JSON response
   */
  async transformJsonResponse(response, requestedModel) {
    const data = await response.json();
    
    // Use requested model or fall back to configured default
    const modelToUse = requestedModel || this.options.defaultModel;
    
    if (!data.response || !data.response.candidates || !data.response.candidates[0]) {
      return response;
    }

    const candidate = data.response.candidates[0];
    const parts = candidate.content?.parts || [];

    // Extract thinking content
    let thinkingContent = '';
    let thinkingSignature = '';
    const nonThinkingParts = [];

    for (const part of parts) {
      if (part.text && part.thought === true) {
        thinkingContent += part.text;
      } else {
        nonThinkingParts.push(part);
      }
    }

    // Get thought signature
    thinkingSignature = parts.find(p => p.thoughtSignature)?.thoughtSignature;

    // Extract tool calls
    const toolCalls = nonThinkingParts
      .filter(part => part.functionCall)
      .map(part => ({
        id: part.functionCall.id || `tool_${Math.random().toString(36).substring(2, 15)}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {})
        }
      }));

    // Extract text content
    const textContent = nonThinkingParts
      .filter(part => part.text && !part.thought)
      .map(part => part.text)
      .join('\n');

    // Build unified response
    const unifiedResponse = {
      id: data.response.responseId,
      choices: [{
        finish_reason: (candidate.finishReason || 'stop').toLowerCase(),
        index: 0,
        message: {
          content: textContent,
          role: 'assistant',
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
          ...(thinkingSignature && {
            thinking: {
              content: thinkingContent || '(no content)',
              signature: thinkingSignature
            }
          })
        }
      }],
      created: Math.floor(Date.now() / 1000),
      model: modelToUse,  // Use requested model for dynamic switching
      object: 'chat.completion',
      usage: {
        completion_tokens: data.response.usageMetadata?.candidatesTokenCount || 0,
        prompt_tokens: data.response.usageMetadata?.promptTokenCount || 0,
        total_tokens: data.response.usageMetadata?.totalTokenCount || 0
      }
    };

    return new Response(JSON.stringify(unifiedResponse), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  /**
   * Transform streaming SSE response from Gemini to Anthropic format
   * Claude CLI expects Anthropic SSE events, not OpenAI format
   */
  transformStreamResponse(response, requestedModel) {
    if (!response.body) {
      return response;
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    
    // Use requested model or fall back to configured default
    const modelToUse = requestedModel || this.options.defaultModel;
    
    // State tracking
    let messageStartSent = false;
    let thinkingBlockStarted = false;
    let thinkingBlockIndex = -1;
    let textBlockStarted = false;
    let textBlockIndex = -1;
    let currentBlockIndex = -1;
    let signatureSent = false;
    let hasThinkingContent = false;
    let lastUsageMetadata = null; // Track usage from Gemini response
    let webSearchResultsSent = false; // Track if web search results have been emitted

    const transformer = this;

    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body.getReader();
        let buffer = '';

        // Helper to send SSE event
        const sendEvent = (eventType, data) => {
          controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const chunkStr = line.slice(6).trim();
                if (!chunkStr) continue;

                try {
                  const chunk = JSON.parse(chunkStr);
                  
                  // Handle both wrapped {"response": {...}} and unwrapped {...} formats
                  const responseData = chunk.response || chunk;
                  
                  if (!responseData.candidates?.[0]) continue;

                  const candidate = responseData.candidates[0];
                  const parts = candidate.content?.parts || [];
                  const responseId = responseData.responseId || `msg_${Date.now()}`;
                  // Use requested model for dynamic model switching
                  const normalizedModel = modelToUse;

                  // Track usage metadata from Gemini response
                  if (responseData.usageMetadata) {
                    lastUsageMetadata = responseData.usageMetadata;
                  }

                  // Send message_start if not sent yet
                  if (!messageStartSent) {
                    sendEvent('message_start', {
                      type: 'message_start',
                      message: {
                        id: responseId,
                        type: 'message',
                        role: 'assistant',
                        content: [],
                        model: normalizedModel,
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: 0, output_tokens: 0 }
                      }
                    });
                    messageStartSent = true;
                  }

                  // Process thinking parts FIRST
                  const thinkingParts = parts.filter(p => p.text && p.thought === true);
                  for (const part of thinkingParts) {
                    hasThinkingContent = true;
                    
                    // Start thinking block if not started
                    if (!thinkingBlockStarted) {
                      currentBlockIndex++;
                      thinkingBlockIndex = currentBlockIndex;
                      sendEvent('content_block_start', {
                        type: 'content_block_start',
                        index: thinkingBlockIndex,
                        content_block: { type: 'thinking', thinking: '' }
                      });
                      thinkingBlockStarted = true;
                    }

                    // Send thinking delta
                    sendEvent('content_block_delta', {
                      type: 'content_block_delta',
                      index: thinkingBlockIndex,
                      delta: { type: 'thinking_delta', thinking: part.text }
                    });
                  }

                  // Handle thought signature - close thinking block
                  const signature = parts.find(p => p.thoughtSignature)?.thoughtSignature;
                  if (signature && !signatureSent) {
                    // Start thinking block if we have signature but no thinking content
                    if (!thinkingBlockStarted) {
                      currentBlockIndex++;
                      thinkingBlockIndex = currentBlockIndex;
                      sendEvent('content_block_start', {
                        type: 'content_block_start',
                        index: thinkingBlockIndex,
                        content_block: { type: 'thinking', thinking: '' }
                      });
                      thinkingBlockStarted = true;
                    }

                    // Send signature delta
                    sendEvent('content_block_delta', {
                      type: 'content_block_delta',
                      index: thinkingBlockIndex,
                      delta: { type: 'signature_delta', signature: signature }
                    });
                    
                    // Close thinking block
                    sendEvent('content_block_stop', {
                      type: 'content_block_stop',
                      index: thinkingBlockIndex
                    });
                    
                    signatureSent = true;
                    thinkingBlockStarted = false; // Marked as closed
                  }

                  // Process text content (non-thinking)
                  const textParts = parts.filter(p => p.text && p.thought !== true);
                  for (const part of textParts) {
                    // Close thinking block if still open and starting text
                    if (thinkingBlockStarted && !signatureSent) {
                      sendEvent('content_block_stop', {
                        type: 'content_block_stop',
                        index: thinkingBlockIndex
                      });
                      thinkingBlockStarted = false;
                    }

                    // Start text block if not started
                    if (!textBlockStarted) {
                      currentBlockIndex++;
                      textBlockIndex = currentBlockIndex;
                      sendEvent('content_block_start', {
                        type: 'content_block_start',
                        index: textBlockIndex,
                        content_block: { type: 'text', text: '' }
                      });
                      textBlockStarted = true;
                    }

                    // Send text delta
                    sendEvent('content_block_delta', {
                      type: 'content_block_delta',
                      index: textBlockIndex,
                      delta: { type: 'text_delta', text: part.text }
                    });
                  }

                  // Process tool calls
                  const toolCallParts = parts.filter(p => p.functionCall);
                  for (const part of toolCallParts) {

                    // Regular tool call - emit as tool_use
                    currentBlockIndex++;
                    const toolBlockIndex = currentBlockIndex;
                    const toolId = part.functionCall.id || `toolu_${Math.random().toString(36).substring(2, 15)}`;
                    
                    sendEvent('content_block_start', {
                      type: 'content_block_start',
                      index: toolBlockIndex,
                      content_block: {
                        type: 'tool_use',
                        id: toolId,
                        name: part.functionCall.name,
                        input: {}
                      }
                    });

                    // Send tool input as delta
                    sendEvent('content_block_delta', {
                      type: 'content_block_delta',
                      index: toolBlockIndex,
                      delta: {
                        type: 'input_json_delta',
                        partial_json: JSON.stringify(part.functionCall.args || {})
                      }
                    });

                    // Close tool block
                    sendEvent('content_block_stop', {
                      type: 'content_block_stop',
                      index: toolBlockIndex
                    });
                  }

                  // Handle groundingMetadata from googleSearch tool
                  // Transform Gemini's search results to Claude's web_search_tool_result format
                  if (candidate.groundingMetadata && candidate.groundingMetadata.groundingChunks && !webSearchResultsSent) {
                    const groundingChunks = candidate.groundingMetadata.groundingChunks;
                    
                    if (groundingChunks.length > 0) {
                      // Close text block if open before emitting search results
                      if (textBlockStarted) {
                        sendEvent('content_block_stop', {
                          type: 'content_block_stop',
                          index: textBlockIndex
                        });
                        textBlockStarted = false;
                      }

                      // Generate a tool use ID for the search
                      const searchToolId = `srvtoolu_${Math.random().toString(36).substring(2, 15)}`;
                      const searchQuery = (candidate.groundingMetadata.webSearchQueries || [])[0] || '';
                      
                      // Emit server_tool_use block
                      currentBlockIndex++;
                      const serverToolUseIndex = currentBlockIndex;
                      sendEvent('content_block_start', {
                        type: 'content_block_start',
                        index: serverToolUseIndex,
                        content_block: {
                          type: 'server_tool_use',
                          id: searchToolId,
                          name: 'web_search',
                          input: { query: searchQuery }
                        }
                      });
                      sendEvent('content_block_stop', {
                        type: 'content_block_stop',
                        index: serverToolUseIndex
                      });

                      // Build web_search_tool_result from groundingChunks
                      const webSearchResults = groundingChunks
                        .filter(chunk => chunk.web)
                        .map((chunk, index) => {
                          // Generate encrypted_content placeholder
                          const contentData = `${chunk.web.uri}:${index}:${Date.now()}`;
                          const encrypted_content = Buffer.from(contentData).toString('base64');
                          
                          return {
                            type: 'web_search_result',
                            title: chunk.web.title || chunk.web.domain,
                            url: chunk.web.uri,
                            encrypted_content: encrypted_content,
                            page_age: null
                          };
                        });

                      // Emit web_search_tool_result block
                      currentBlockIndex++;
                      const searchResultIndex = currentBlockIndex;
                      sendEvent('content_block_start', {
                        type: 'content_block_start',
                        index: searchResultIndex,
                        content_block: {
                          type: 'web_search_tool_result',
                          tool_use_id: searchToolId,
                          content: webSearchResults
                        }
                      });
                      sendEvent('content_block_stop', {
                        type: 'content_block_stop',
                        index: searchResultIndex
                      });

                      console.log(`[antigravity] Emitted ${webSearchResults.length} web search results`);
                    }
                  }

                  // Handle finish reason
                  if (candidate.finishReason) {
                    // Close any open blocks
                    if (thinkingBlockStarted) {
                      sendEvent('content_block_stop', {
                        type: 'content_block_stop',
                        index: thinkingBlockIndex
                      });
                      thinkingBlockStarted = false;
                    }
                    if (textBlockStarted) {
                      sendEvent('content_block_stop', {
                        type: 'content_block_stop',
                        index: textBlockIndex
                      });
                      textBlockStarted = false;
                    }

                    // Send message_delta with stop reason and actual usage
                    const inputTokens = lastUsageMetadata?.promptTokenCount || 0;
                    const outputTokens = lastUsageMetadata?.candidatesTokenCount || 0;
                    sendEvent('message_delta', {
                      type: 'message_delta',
                      delta: {
                        stop_reason: 'end_turn',
                        stop_sequence: null
                      },
                      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: 0 }
                    });

                    // Send message_stop
                    sendEvent('message_stop', {
                      type: 'message_stop'
                    });
                  }
                } catch (error) {
                  console.error('[antigravity] Error parsing SSE chunk:', error.message);
                }
              }
            }
          }

          // Close any remaining open blocks
          if (thinkingBlockStarted) {
            sendEvent('content_block_stop', { type: 'content_block_stop', index: thinkingBlockIndex });
          }
          if (textBlockStarted) {
            sendEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
          }

          // Ensure message is properly closed if not already
          if (messageStartSent) {
            const inputTokens = lastUsageMetadata?.promptTokenCount || 0;
            const outputTokens = lastUsageMetadata?.candidatesTokenCount || 0;
            sendEvent('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: 0 }
            });
            sendEvent('message_stop', { type: 'message_stop' });
          }

          controller.close();
        } catch (error) {
          console.error('[antigravity] Stream error:', error);
          controller.error(error);
        }
      }
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Skip-Response-Transform': 'true'  // Skip Anthropic transformResponseIn since we output Anthropic format directly
      })
    });
  }
}

// Export for use as a plugin
module.exports = AntigravityTransformer;
module.exports.default = AntigravityTransformer;

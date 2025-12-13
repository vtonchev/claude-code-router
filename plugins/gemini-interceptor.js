/**
 * Gemini Interceptor Plugin - Pure API Implementation
 * 
 * This plugin intercepts requests after the Gemini transformer has processed them
 * and modifies responses before they return through the transformer chain.
 * 
 * Uses only pure HTTP APIs for OAuth - no external libraries.
 * 
 * Features:
 * - OAuth2 authentication with Google (pure API)
 * - Thinking budget configuration
 * - Tool validation mode
 * - Request envelope wrapping
 * - Response streaming transformation
 */

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude-code-router', 'google_credentials.json');

// Cache for the access token
let cachedAccessToken = null;
let tokenExpiryTime = 0;

/**
 * Loads credentials from persistent storage
 */
function loadCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[gemini_interceptor] Error loading credentials:', e.message);
  }
  return null;
}

/**
 * Saves credentials to persistent storage
 */
function saveCredentials(credentials) {
  try {
    const dir = path.dirname(CREDENTIALS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
  } catch (e) {
    console.error('[gemini_interceptor] Error saving credentials:', e.message);
  }
}

/**
 * Makes an HTTPS POST request (pure Node.js, no libraries)
 */
function httpsPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = typeof data === 'string' ? data : new URLSearchParams(data).toString();
    
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(body);
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Refreshes the access token using refresh_token (pure API)
 * Google OAuth2 Token Endpoint: https://oauth2.googleapis.com/token
 */
async function refreshAccessToken(credentials) {
  const response = await httpsPost('https://oauth2.googleapis.com/token', {
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    refresh_token: credentials.refresh_token,
    grant_type: 'refresh_token'
  });
  
  if (response.error) {
    throw new Error(response.error_description || response.error);
  }
  
  return {
    access_token: response.access_token,
    expires_in: response.expires_in,
    token_type: response.token_type
  };
}

/**
 * Retrieves a fresh OAuth2 access token
 * Uses the UI to get refresh token if not present
 */
async function getFreshAccessToken() {
  // Check cached token (with 5 min buffer)
  const now = Date.now();
  if (cachedAccessToken && tokenExpiryTime > now + 5 * 60 * 1000) {
    return cachedAccessToken;
  }
  
  const credentials = loadCredentials();
  
  // If no credentials or no refresh token, return null
  // User must use the UI to authenticate
  if (!credentials?.refresh_token) {
    console.error('[gemini_interceptor] No refresh token found. Please use the UI (ccr ui) to authenticate with Google.');
    return null;
  }
  
  try {
    const tokens = await refreshAccessToken(credentials);
    
    // Cache the token
    cachedAccessToken = tokens.access_token;
    tokenExpiryTime = now + (tokens.expires_in * 1000);
    
    // Update stored credentials
    credentials.access_token = tokens.access_token;
    credentials.expiry_date = tokenExpiryTime;
    saveCredentials(credentials);
    
    return tokens.access_token;
  } catch (error) {
    console.error('[gemini_interceptor] Token refresh failed:', error.message);
    
    // If token is invalid, clear cached token
    if (error.message.includes('invalid_grant') || error.message.includes('revoked')) {
      console.error('[gemini_interceptor] Refresh token is invalid. Please re-authenticate via UI (ccr ui).');
      cachedAccessToken = null;
      tokenExpiryTime = 0;
    }
    
    return null;
  }
}


/**
 * GeminiInterceptor class - implements the Transformer interface
 */
class GeminiInterceptor {
  name = "gemini_interceptor";
  
  constructor(options = {}) {
    this.options = options;
    this.logger = null;
  }

  /**
   * Intercept request AFTER Gemini transformer has processed it
   * request incoming ====== transformRequestIn ======> Google antigravity 
   */
   
  async transformRequestIn(request, provider, context) {
    // Log transformer input
    if (this.logger) {
      this.logger.info({
        type: 'transformer_incoming_request',
        transformer: this.name,
        body: request,
        url: context?.url || provider?.baseUrl || provider?.api_base_url || 'unknown',
        headers: context?.headers || request?.headers || {}
      }, `[${this.name}] Transformer input`);
    }

    const config = {};
    
    // --- 1. OAUTH AUTHENTICATION ---
    const token = await getFreshAccessToken();
    
    if (token) {
      config.headers = {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "antigravity/ windows/amd64",
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip"
      };
      
      if (this.logger) {
        this.logger.info(`[${this.name}] Using OAuth authentication`);
      }
    }

    // --- 2. CUSTOM ENDPOINT HANDLING ---
    const baseUrl = provider.baseUrl || provider.api_base_url;
    if (baseUrl && (baseUrl.includes(':streamGenerateContent') || baseUrl.includes(':generateContent') || baseUrl.includes('v1internal'))) {
      config.url = new URL(baseUrl);
      
      if (this.logger) {
        this.logger.info(`[${this.name}] Using custom endpoint: ${baseUrl}`);
      }
    }

    // // --- 3. THINKING BUDGET DETECTION ---
    // if (!request.generationConfig) {
    //   request.generationConfig = {};
    // }

    // let thinkingBudget = null;

    // if (request.generationConfig.thinkingConfig) {
    //   thinkingBudget = request.generationConfig.thinkingConfig.thinkingBudget;
    // } else if (request.generationConfig.thinking_budget) {
    //   thinkingBudget = request.generationConfig.thinking_budget;
    //   delete request.generationConfig.thinking_budget;
    // } else if (request.thinking && request.thinking.budget_tokens) {
    //   thinkingBudget = request.thinking.budget_tokens;
    //   delete request.thinking;
    // }

    // // --- 4. APPLY THINKING CONFIGURATION ---
    // if (thinkingBudget) {
    //   request.generationConfig.thinkingConfig = {
    //     includeThoughts: true,
    //     thinkingBudget: parseInt(thinkingBudget)
    //   };
    // } else {
    //   const configBudget = this.options.thinking_budget || this.options.thinkingBudget;
    //   request.generationConfig.thinkingConfig = {
    //     includeThoughts: true,
    //     thinkingBudget: configBudget ? parseInt(configBudget) : 1024
    //   };
    // }

    // // --- 5. TOOL VALIDATION MODE ---
    // if (request.tools && request.tools.length > 0) {
    //   if (!request.toolConfig) {
    //     request.toolConfig = {};
    //   }
    //   if (!request.toolConfig.functionCallingConfig) {
    //     request.toolConfig.functionCallingConfig = {};
    //   }
    //   request.toolConfig.functionCallingConfig.mode = "VALIDATED";
    // }

    // --- 6. ENVELOPE WRAPPING ---
    // const sessionId = `session-${uuidv4()}`;
    // const requestId = `req-${uuidv4()}`;
    
    const wrappedBody = {
      // requestId: requestId,
      model: this.options.model,
      userAgent: this.options.userAgent,
      requestType: this.options.requestType,
      // sessionId: sessionId,
      request: request
    };

    // Log transformer output
    if (this.logger) {
      this.logger.info({
        type: 'transformer_outgoing_request',
        transformer: this.name,
        body: wrappedBody,
        url: config.url ? config.url.toString() : 'unknown',
        headers: config.headers || {}
      }, `[${this.name}] Transformer output`);
    }

    return {
      body: wrappedBody,
      config
    };
  }

  /**
   * Intercept response BEFORE it goes back through the transformer chain
   */
  async transformResponseOut(response, context) {
    // Log transformer response input
    if (this.logger) {
      const headers = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      
      this.logger.info({
        type: 'transformer_incoming_response',
        transformer: this.name,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: headers
      }, `[${this.name}] Transformer response input`);

      // Async body logging (full content)
      // Cloned so we don't consume the main response body
      try {
        const clone = response.clone();
        clone.text().then(text => {
          let body = text;
          try {
            // Try to parse as JSON first (common for non-stream blocks)
            // For streams, this might be a long string of "data: ..." lines
            if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
              body = JSON.parse(text);
            }
          } catch (e) {
            // Keep as text if not valid JSON
          }

          this.logger.info({
            type: 'transformer_incoming_response',
            transformer: this.name,
            body: body,
            url: response.url,
             // Add a distinct message to differentiate in logs if needed, 
             // though the "body" field presence usually distinguishes it in the viewer
            isFullContent: true 
          }, `[${this.name}] Transformer response input (Full Content)`);
        }).catch(err => {
          this.logger.error({ err }, `[${this.name}] Failed to read cloned response body`);
        });
      } catch (e) {
        this.logger.error({ err: e }, `[${this.name}] Failed to clone response for logging`);
      }
    }

    if (!response.ok) {
      // Log pass-through for error responses
      if (this.logger) {
        this.logger.info({
          type: 'transformer_outgoing_response',
          transformer: this.name,
          status: response.status,
          statusText: response.statusText,
          body: "Error response passed through" // We can't easily read the body here without consuming it or waiting for clone
        }, `[${this.name}] Transformer response output (error pass-through)`);
      }
      return response;
    }

    const contentType = response.headers.get('content-type') || "";
    
    // Non-streaming response
    if (!contentType.includes('text/event-stream')) {
      try {
        const json = await response.json();
        const payload = json.response ? json.response : json;
        
        // Log transformer output
        if (this.logger) {
          const resHeaders = {};
          if (response.headers && response.headers.forEach) {
            response.headers.forEach((v, k) => resHeaders[k] = v);
          }
          this.logger.info({
            type: 'transformer_outgoing_response',
            transformer: this.name,
            body: payload,
            url: response.url,
            headers: resHeaders
          }, `[${this.name}] Transformer response output`);
        }
        
        return new Response(JSON.stringify(payload), {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText
        });
      } catch (e) {
        return response;
      }
    }

    // Streaming response
    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let isThinking = false;
    const self = this;

    // Log transformer output (streaming start)
    if (this.logger) {
      const resHeaders = {};
      if (response.headers && response.headers.forEach) {
         response.headers.forEach((v, k) => resHeaders[k] = v);
      }
      this.logger.info({
        type: 'transformer_outgoing_response',
        transformer: this.name,
        stream: true,
        message: "Streaming response started",
        url: response.url,
        headers: resHeaders
      }, `[${this.name}] Transformer response output (stream)`);
    }
    
    const newStream = new ReadableStream({
      async start(controller) {
        let buffer = "";
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
              if (buffer.trim()) {
                controller.enqueue(encoder.encode(buffer + "\n"));
              }
              break;
            }
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const dataStr = line.substring(6).trim();
                
                if (dataStr === "[DONE]") {
                  controller.enqueue(encoder.encode(line + "\n"));
                  continue;
                }

                try {
                  const json = JSON.parse(dataStr);
                  const payload = json.response ? json.response : json;
                  const parts = payload.candidates?.[0]?.content?.parts || [];
                  
                  if (parts.length > 0) {
                    const part = parts[0];
                    
                    if (part.thought) {
                      if (!isThinking) {
                        isThinking = true;
                      }
                    } else if (isThinking && !part.thought && part.text) {
                      part.text = "\n\n" + part.text;
                      isThinking = false;
                    }
                  }

                  const chunkPayload = `data: ${JSON.stringify(payload)}\n`;
                  controller.enqueue(encoder.encode(chunkPayload));

                  // Log outgoing chunk
                  if (self.logger) {
                     self.logger.info({
                       type: 'transformer_outgoing_response',
                       transformer: self.name,
                       body: payload,
                       chunk: true
                     }, `[${self.name}] Transformer response output (chunk)`);
                  }
                } catch (e) {
                  controller.enqueue(encoder.encode(line + "\n"));
                }
              } else {
                controller.enqueue(encoder.encode(line + "\n"));
              }
            }
          }
        } catch (error) {
          if (self.logger) {
            self.logger.error('[gemini_interceptor] Stream processing error:', error);
          }
          controller.error(error);
        } finally {
          controller.close();
        }
      }
    });

    return new Response(newStream, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText
    });
  }
}

module.exports = GeminiInterceptor;

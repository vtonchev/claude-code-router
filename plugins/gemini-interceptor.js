/**
 * Gemini Interceptor Plugin
 * 
 * This plugin intercepts requests after the Gemini transformer has processed them
 * and modifies responses before they return through the transformer chain.
 * 
 * Features:
 * - OAuth2 authentication with Google credentials
 * - Thinking budget configuration
 * - Tool validation mode
 * - Request envelope wrapping
 * - Response streaming transformation
 * 
 * Usage in config.json:
 * {
 *   "transformers": [
 *     {
 *       "path": "/path/to/plugins/gemini-interceptor.js",
 *       "options": {
 *         "project": "your-project-id",
 *         "thinking_budget": 8192
 *       }
 *     }
 *   ],
 *   "Providers": [
 *     {
 *       "name": "gemini",
 *       "transformer": {
 *         "use": ["gemini", "gemini_interceptor"]
 *       }
 *     }
 *   ]
 * }
 */

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const url = require('url');
const readline = require('readline');

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude-code-router', 'google_credentials.json');
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language.retriever'
];
const REDIRECT_PORT = 3333;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

// Cache for the access token to avoid refreshing on every request
let cachedAccessToken = null;
let tokenExpiryTime = 0;

/**
 * Prompts user for input via terminal
 */
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Opens a URL in the default browser
 */
function openBrowser(urlToOpen) {
  const { exec } = require('child_process');
  const platform = process.platform;
  
  let command;
  if (platform === 'darwin') {
    command = `open "${urlToOpen}"`;
  } else if (platform === 'win32') {
    command = `start "" "${urlToOpen}"`;
  } else {
    command = `xdg-open "${urlToOpen}"`;
  }
  
  exec(command, (error) => {
    if (error) {
      console.log('\n⚠️  Could not open browser automatically.');
      console.log('Please open this URL manually:\n');
      console.log(urlToOpen);
    }
  });
}

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
 * Runs the interactive OAuth login flow
 */
async function runLoginFlow() {
  console.log('\n' + '═'.repeat(60));
  console.log('  🔐 Google OAuth Login Required');
  console.log('═'.repeat(60) + '\n');
  
  // Check for existing client credentials
  const existing = loadCredentials();
  let clientId = process.env.GOOGLE_CLIENT_ID;
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  
  if (existing?.client_id && existing?.client_secret) {
    console.log('📁 Found existing Client ID/Secret.');
    const reuse = await prompt('Use existing credentials? (Y/n): ');
    if (reuse.toLowerCase() !== 'n') {
      clientId = existing.client_id;
      clientSecret = existing.client_secret;
    }
  }
  
  if (!clientId) {
    console.log('\n📋 To get OAuth credentials:');
    console.log('   1. Go to https://console.cloud.google.com/apis/credentials');
    console.log('   2. Create OAuth 2.0 Client ID (Desktop app)');
    console.log(`   3. Add ${REDIRECT_URI} to Authorized redirect URIs\n`);
    clientId = await prompt('Enter Google Client ID: ');
  }
  
  if (!clientSecret) {
    clientSecret = await prompt('Enter Google Client Secret: ');
  }
  
  if (!clientId || !clientSecret) {
    console.error('\n❌ Client ID and Secret required.');
    return null;
  }
  
  // Create OAuth2 client
  const { OAuth2Client } = require('google-auth-library');
  const oAuth2Client = new OAuth2Client(clientId, clientSecret, REDIRECT_URI);
  
  // Generate auth URL
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  
  console.log('\n🌐 Opening browser for authentication...');
  openBrowser(authUrl);
  
  // Wait for OAuth callback
  const tokens = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const queryParams = url.parse(req.url, true).query;
      
      if (queryParams.error) {
        res.writeHead(400);
        res.end('Authentication failed: ' + queryParams.error);
        server.close();
        reject(new Error(queryParams.error));
        return;
      }
      
      if (queryParams.code) {
        try {
          const { tokens } = await oAuth2Client.getToken(queryParams.code);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#1a1a2e;color:#eee"><div style="text-align:center"><h1 style="color:#4ade80">✅ Success!</h1><p>You can close this window.</p></div></body></html>');
          server.close();
          resolve(tokens);
        } catch (err) {
          res.writeHead(500);
          res.end('Token exchange failed');
          server.close();
          reject(err);
        }
      }
    });
    
    server.listen(REDIRECT_PORT, () => {
      console.log(`\n🔐 Waiting for OAuth callback on port ${REDIRECT_PORT}...`);
    });
    
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${REDIRECT_PORT} in use`));
      } else {
        reject(err);
      }
    });
    
    setTimeout(() => {
      server.close();
      reject(new Error('Login timed out'));
    }, 5 * 60 * 1000);
  });
  
  if (!tokens.refresh_token) {
    console.error('\n❌ No refresh token received. Revoke access at https://myaccount.google.com/permissions and retry.');
    return null;
  }
  
  // Save credentials
  const credentials = {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expiry_date: tokens.expiry_date,
    token_type: 'Bearer'
  };
  saveCredentials(credentials);
  
  console.log('\n✅ Login successful!\n');
  return credentials;
}

/**
 * Retrieves a fresh OAuth2 access token
 * Automatically triggers login if no valid refresh token exists
 */
async function getFreshAccessToken() {
  // Check cached token
  const now = Date.now();
  if (cachedAccessToken && tokenExpiryTime > now + 5 * 60 * 1000) {
    return cachedAccessToken;
  }
  
  let credentials = loadCredentials();
  
  // If no credentials or no refresh token, run login
  if (!credentials?.refresh_token) {
    credentials = await runLoginFlow();
    if (!credentials?.refresh_token) return null;
  }
  
  try {
    const { UserRefreshClient } = require('google-auth-library');
    const client = new UserRefreshClient(
      credentials.client_id,
      credentials.client_secret,
      credentials.refresh_token
    );
    
    const { token, res } = await client.getAccessToken();
    
    if (!token) {
      console.error('[gemini_interceptor] Token refresh failed, re-authenticating...');
      credentials = await runLoginFlow();
      if (!credentials) return null;
      return getFreshAccessToken();
    }
    
    // Cache token
    cachedAccessToken = token;
    tokenExpiryTime = res?.data?.expiry_date || (now + 3600 * 1000);
    
    // Update stored credentials
    credentials.access_token = token;
    credentials.expiry_date = tokenExpiryTime;
    saveCredentials(credentials);
    
    return token;
  } catch (error) {
    console.error('[gemini_interceptor] OAuth error:', error.message);
    
    if (error.message.includes('invalid_grant') || error.message.includes('revoked')) {
      console.error('[gemini_interceptor] Token invalid, re-authenticating...');
      credentials = await runLoginFlow();
      if (!credentials) return null;
      return getFreshAccessToken();
    }
    
    return null;
  }
}


/**
 * GeminiInterceptor class - implements the Transformer interface
 */
class GeminiInterceptor {
  name = "gemini_interceptor";
  
  // No endPoint - this runs as a provider transformer in the chain
  
  constructor(options = {}) {
    this.options = options;
    this.logger = null; // Will be set by TransformerService
  }

  /**
   * Intercept request AFTER Gemini transformer has processed it
   * Called as part of the provider.transformer.use chain
   * 
   * @param {object} request - The Gemini-formatted request body
   * @param {object} provider - The provider configuration
   * @param {object} context - Request context containing req object
   * @returns {object} Modified request with optional config
   */
  async transformRequestIn(request, provider, context) {
    const config = {};
    
    // --- 1. OAUTH AUTHENTICATION ---
    const token = await getFreshAccessToken();
    
    if (token) {
      config.headers = {
        'Authorization': `Bearer ${token}`,
        // 'x-goog-api-key': undefined // Remove API key when using OAuth
      };
      
      if (this.logger) {
        this.logger.info('[gemini_interceptor] Using OAuth authentication');
      }
    }

    // --- 2. CUSTOM ENDPOINT HANDLING ---
    // If the provider's base URL is a complete endpoint (contains :streamGenerateContent or :generateContent),
    // use it directly instead of constructing the URL from model name
    const baseUrl = provider.baseUrl || provider.api_base_url;
    if (baseUrl && (baseUrl.includes(':streamGenerateContent') || baseUrl.includes(':generateContent') || baseUrl.includes('v1internal'))) {
      config.url = new URL(baseUrl);
      
      if (this.logger) {
        this.logger.info(`[gemini_interceptor] Using custom endpoint: ${baseUrl}`);
      }
    }

    // --- 2. THINKING BUDGET DETECTION ---
    if (!request.generationConfig) {
      request.generationConfig = {};
    }

    let thinkingBudget = null;
    let includeThoughts = true;

    // Check A: Standard Google 'thinkingConfig' (if upstream transformer handled it)
    if (request.generationConfig.thinkingConfig) {
      thinkingBudget = request.generationConfig.thinkingConfig.thinkingBudget;
      if (this.logger) {
        this.logger.debug('[gemini_interceptor] Found thinkingConfig:', thinkingBudget);
      }
    } 
    // Check B: Flat 'thinking_budget' (Common in some SDKs)
    else if (request.generationConfig.thinking_budget) {
      thinkingBudget = request.generationConfig.thinking_budget;
      delete request.generationConfig.thinking_budget; // Clean up
    }
    // Check C: Anthropic 'thinking' format (if passed through raw)
    // Claude sends: { thinking: { type: "enabled", budget_tokens: 16000 } }
    else if (request.thinking && request.thinking.budget_tokens) {
      thinkingBudget = request.thinking.budget_tokens;
      delete request.thinking; // Clean up Anthropic field
    }

    // --- 3. APPLY THINKING CONFIGURATION ---
    if (thinkingBudget) {
      // Use the value from the API request
      request.generationConfig.thinkingConfig = {
        includeThoughts: includeThoughts,
        thinkingBudget: parseInt(thinkingBudget)
      };
    } else {
      // Fallback: Check options from config.json
      const configBudget = this.options.thinking_budget || this.options.thinkingBudget;
      request.generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: configBudget ? parseInt(configBudget) : 1024
      };
    }

    // --- 4. TOOL VALIDATION MODE ---
    if (request.tools && request.tools.length > 0) {
      if (!request.toolConfig) {
        request.toolConfig = {};
      }
      if (!request.toolConfig.functionCallingConfig) {
        request.toolConfig.functionCallingConfig = {};
      }
      request.toolConfig.functionCallingConfig.mode = "VALIDATED";
      
      if (this.logger) {
        this.logger.debug('[gemini_interceptor] Enabled VALIDATED tool mode');
      }
    }

    // --- 5. ENVELOPE WRAPPING ---
    const sessionId = `session-${uuidv4()}`;
    const requestId = `req-${uuidv4()}`;
    
    const wrappedBody = {
      project: this.options.project || "majestic-spot-nc5ww",
      requestId: requestId,
      model: this.options.model || "claude-opus-4-5-thinking",
      userAgent: this.options.userAgent || "antigravity",
      requestType: this.options.requestType || "agent",
      sessionId: sessionId,
      request: request
    };

    if (this.logger) {
      this.logger.info(`[gemini_interceptor] Wrapped request with sessionId: ${sessionId}`);
    }

    return {
      body: wrappedBody,
      config
    };
  }

  /**
   * Intercept response BEFORE it goes back through the transformer chain
   * 
   * @param {Response} response - The fetch Response object
   * @param {object} context - Response context
   * @returns {Response} Modified response
   */
  async transformResponseOut(response, context) {
    // Pass through error responses unchanged
    if (!response.ok) {
      return response;
    }

    const contentType = response.headers.get('content-type') || "";
    
    // Only transform streaming responses
    if (!contentType.includes('text/event-stream')) {
      // For non-streaming, try to unwrap the envelope
      try {
        const json = await response.json();
        const payload = json.response ? json.response : json;
        
        return new Response(JSON.stringify(payload), {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText
        });
      } catch (e) {
        return response;
      }
    }

    // Transform streaming response
    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let isThinking = false;

    const self = this;
    
    const newStream = new ReadableStream({
      async start(controller) {
        let buffer = "";
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
              // Process any remaining buffer
              if (buffer.trim()) {
                controller.enqueue(encoder.encode(buffer + "\n"));
              }
              break;
            }
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // Keep incomplete line in buffer

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const dataStr = line.substring(6).trim();
                
                // Pass through [DONE] marker
                if (dataStr === "[DONE]") {
                  controller.enqueue(encoder.encode(line + "\n"));
                  continue;
                }

                try {
                  const json = JSON.parse(dataStr);
                  
                  // Unwrap the envelope if present
                  const payload = json.response ? json.response : json;
                  const parts = payload.candidates?.[0]?.content?.parts || [];
                  
                  // Handle thinking block formatting
                  if (parts.length > 0) {
                    const part = parts[0];
                    
                    if (part.thought) {
                      // Entering thinking mode
                      if (!isThinking) {
                        isThinking = true;
                      }
                    } else if (isThinking && !part.thought && part.text) {
                      // Exiting thinking mode - add spacing
                      part.text = "\n\n" + part.text;
                      isThinking = false;
                    }
                  }

                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n`));
                } catch (e) {
                  // JSON parse error - pass through original line
                  controller.enqueue(encoder.encode(line + "\n"));
                }
              } else {
                // Non-data lines (event:, etc.) - pass through
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

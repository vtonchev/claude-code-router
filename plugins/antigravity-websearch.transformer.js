/**
 * Antigravity Web Search Transformer
 * 
 * Dedicated transformer for web search requests using Antigravity's 
 * non-streaming googleSearch API endpoint.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude-code-router', 'google_credentials.json');

function readCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const data = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[antigravity-websearch] Error reading credentials:', error.message);
  }
  return null;
}

function saveCredentials(credentials) {
  try {
    const dir = path.dirname(CREDENTIALS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
  } catch (error) {
    console.error('[antigravity-websearch] Error saving credentials:', error.message);
  }
}

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

async function getFreshAccessToken() {
  const credentials = readCredentials();
  
  if (!credentials) {
    throw new Error('[antigravity-websearch] No Google credentials found');
  }

  if (!credentials.refresh_token) {
    throw new Error('[antigravity-websearch] No refresh token found');
  }

  const now = Date.now();
  const expiryThreshold = 5 * 60 * 1000;
  
  if (credentials.access_token && credentials.token_expiry && (credentials.token_expiry - now) > expiryThreshold) {
    return credentials.access_token;
  }

  console.log('[antigravity-websearch] Refreshing access token...');
  return await refreshAccessToken(credentials);
}

class AntigravityWebSearchTransformer {
  constructor(options = {}) {
    this.name = 'antigravity-websearch';
    this.options = {
      project: options.project || 'your-project-id',
      ...options
    };
  }

  /**
   * Extract the search query from the request
   */
  extractSearchQuery(request) {
    const messages = request.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
          const textPart = msg.content.find(c => c.type === 'text');
          if (textPart) return textPart.text;
        }
      }
    }
    return 'web search query';
  }

  /**
   * Transform Claude request to Antigravity web search format
   */
  async transformRequestIn(request, provider, context) {
    console.log(`[antigravity-websearch] Transforming request for web search`);
    
    const accessToken = await getFreshAccessToken();
    const query = this.extractSearchQuery(request);
    
    // Build contents from last user message only (simple query)
    const contents = [{
      role: 'user',
      parts: [{ text: query }]
    }];
    
    // Build the Antigravity web search request
    const webSearchBody = {
      project: this.options.project,
      request: {
        contents: contents,
        systemInstruction: {
          role: 'user',
          parts: [{
            text: 'You are a search engine bot. You will be given a query from a user. Your task is to search the web for relevant information that will help the user. You MUST perform a web search. Do not respond or interact with the user, please respond as if they typed the query into a search bar.'
          }]
        },
        tools: [{
          googleSearch: {
            enhancedContent: {
              imageSearch: { maxResultCount: 5 }
            }
          }
        }],
        generationConfig: {
          candidateCount: 1
        }
      },
      model: 'gemini-2.5-flash',
      requestType: 'web_search'
    };
    
    console.log(`[antigravity-websearch] Request body prepared for query: "${query}"`);
    
    return {
      body: webSearchBody,
      config: {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'antigravity/ windows/amd64'
        }
      }
    };
  }

  /**
   * Transform Antigravity web search response to Claude-compatible SSE stream
   */
  async transformResponseOut(response, context) {
    const contentType = response.headers.get('Content-Type') || '';
    console.log(`[antigravity-websearch] Transforming response, contentType: ${contentType}`);
    
    // Handle JSON response (non-streaming endpoint)
    if (contentType.includes('application/json')) {
      const result = await response.json();
      return this.transformWebSearchResponse(result, context);
    }
    
    // Handle SSE streaming response - collect all chunks and then transform
    if (contentType.includes('text/event-stream') || contentType.includes('stream')) {
      console.log(`[antigravity-websearch] Handling SSE stream response`);
      return this.transformStreamToWebSearch(response, context);
    }
    
    // Fallback - pass through
    return response;
  }

  /**
   * Transform SSE stream response to web search format
   * Collects all stream chunks and extracts grounding metadata
   */
  async transformStreamToWebSearch(response, context) {
    if (!response.body) {
      return response;
    }
    
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    
    // Collect all text content and grounding metadata from stream
    let allTextContent = '';
    let groundingMetadata = null;
    let usageMetadata = null;
    let responseId = '';
    
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
              const candidate = chunk.candidates?.[0];
              
              if (candidate) {
                // Collect text content
                const parts = candidate.content?.parts || [];
                for (const part of parts) {
                  if (part.text) {
                    allTextContent += part.text;
                  }
                }
                
                // Capture grounding metadata (usually in final chunk)
                if (candidate.groundingMetadata) {
                  groundingMetadata = candidate.groundingMetadata;
                }
              }
              
              if (chunk.usageMetadata) {
                usageMetadata = chunk.usageMetadata;
              }
              if (chunk.responseId) {
                responseId = chunk.responseId;
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }
    } catch (error) {
      console.error(`[antigravity-websearch] Error reading stream:`, error);
    }
    
    console.log(`[antigravity-websearch] Collected text length: ${allTextContent.length}, hasGroundingMetadata: ${!!groundingMetadata}`);
    
    // Build a fake result object that matches the expected format
    const result = {
      response: {
        candidates: [{
          content: {
            role: 'model',
            parts: [{ text: allTextContent }]
          },
          groundingMetadata: groundingMetadata
        }],
        usageMetadata: usageMetadata,
        responseId: responseId
      }
    };
    
    return this.transformWebSearchResponse(result, context);
  }

  /**
   * Convert Antigravity web search JSON response to Claude SSE format
   */
  transformWebSearchResponse(result, context) {
    const encoder = new TextEncoder();
    const transformer = this;
    
    const stream = new ReadableStream({
      start(controller) {
        const sendEvent = (event, data) => {
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        };
        
        try {
          const messageId = `msg_ws_${Date.now()}`;
          const model = context?.requestModel || 'gemini-2.5-flash';
          
          // Debug: Log response structure
          console.log(`[antigravity-websearch] Response structure: ${JSON.stringify(result).slice(0, 500)}`);
          console.log(`[antigravity-websearch] Has response.candidates: ${!!result.response?.candidates}`);
          console.log(`[antigravity-websearch] Has direct candidates: ${!!result.candidates}`);
          
          // message_start
          sendEvent('message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: model,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 }
            }
          });
          
          let blockIndex = 0;
          // Try both response.candidates and direct candidates
          const candidate = result.response?.candidates?.[0] || result.candidates?.[0];
          const groundingMetadata = candidate?.groundingMetadata;
          const searchQuery = (groundingMetadata?.webSearchQueries || [])[0] || context?.query || '';
          const searchResultsCount = groundingMetadata?.groundingChunks?.length || 0;
          
          console.log(`[antigravity-websearch] Candidate found: ${!!candidate}, groundingMetadata: ${!!groundingMetadata}, searchResultsCount: ${searchResultsCount}`);
          
          // Emit server_tool_use for web_search
          const toolId = `srvtoolu_ws_${Date.now()}`;
          sendEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'server_tool_use',
              id: toolId,
              name: 'web_search',
              input: {}
            }
          });
          
          // Stream the query as input_json_delta chunks
          const queryJson = JSON.stringify({ query: searchQuery });
          // Stream in chunks of ~5-8 chars to simulate streaming
          const chunkSize = 6;
          for (let i = 0; i < queryJson.length; i += chunkSize) {
            const chunk = queryJson.slice(i, i + chunkSize);
            sendEvent('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: chunk }
            });
          }
          
          sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          blockIndex++;
          
          console.log(`[antigravity-websearch] Web search completed: ${searchResultsCount} results for query: "${searchQuery}"`);
          
          // Emit web_search_tool_result with search results
          if (groundingMetadata?.groundingChunks) {
            const searchResults = groundingMetadata.groundingChunks.map((chunk, i) => ({
              type: 'web_search_result',
              url: chunk.web?.uri || '',
              title: chunk.web?.title || chunk.web?.domain || '',
              encrypted_content: Buffer.from(JSON.stringify({
                index: i,
                domain: chunk.web?.domain,
                timestamp: Date.now()
              })).toString('base64'),
              page_age: null
            }));
            
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'web_search_tool_result',
                tool_use_id: toolId,  // Same ID as server_tool_use
                content: searchResults
              }
            });
            sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            blockIndex++;
          }
          
          // Emit text content
          const textContent = candidate?.content?.parts
            ?.filter(p => p.text)
            ?.map(p => p.text)
            ?.join('') || '';
          
          if (textContent) {
            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' }
            });
            
            // Send text delta
            sendEvent('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: textContent }
            });
            
            // Emit citations if available
            if (groundingMetadata?.groundingSupports && groundingMetadata?.groundingChunks) {
              for (const support of groundingMetadata.groundingSupports) {
                if (support.groundingChunkIndices) {
                  for (const chunkIndex of support.groundingChunkIndices) {
                    const chunk = groundingMetadata.groundingChunks[chunkIndex];
                    if (chunk?.web) {
                      sendEvent('content_block_delta', {
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: {
                          type: 'citations_delta',
                          citation: {
                            type: 'web_search_result_location',
                            url: chunk.web.uri,
                            title: chunk.web.title || chunk.web.domain,
                            cited_text: support.segment?.text || '',
                            encrypted_index: Buffer.from(JSON.stringify({
                              chunkIndex: chunkIndex,
                              uri: chunk.web.uri,
                              segmentStart: support.segment?.startIndex,
                              segmentEnd: support.segment?.endIndex,
                              timestamp: Date.now()
                            })).toString('base64')
                          }
                        }
                      });
                    }
                  }
                }
              }
            }
            
            sendEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          }
          
          // message_delta and message_stop
          sendEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { 
              output_tokens: textContent.length,
              server_tool_use: {
                web_search_requests: 1  // One search request was made
              }
            }
          });
          
          sendEvent('message_stop', { type: 'message_stop' });
          
          controller.close();
        } catch (error) {
          console.error(`[antigravity-websearch] Error transforming response:`, error);
          controller.error(error);
        }
      }
    });
    
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Skip-Response-Transform': 'true'
      }
    });
  }
}

module.exports = AntigravityWebSearchTransformer;

import Server from "@musistudio/llms";
import { readConfigFile, writeConfigFile, backupConfigFile } from "./utils";
import { checkForUpdates, performUpdate } from "./utils";
import { join } from "path";
import fastifyStatic from "@fastify/static";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { homedir } from "os";
import { calculateTokenCount } from "./utils/router";
import diagnostics_channel from "diagnostics_channel";
import { Agent, setGlobalDispatcher, Dispatcher } from "undici";

// Global logger bridged to Fastify logger
let appLogger: any = console;

// Create a custom dispatcher that intercepts responses
class LoggingDispatcher extends Agent {
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    const originalOnHeaders = handler.onHeaders;
    const originalOnData = handler.onData;

    // Wrap onHeaders to log response status
    handler.onHeaders = (statusCode: any, headers: any, resume: any, statusText: any) => {
      appLogger.info({
        type: 'incoming_response',
        status: statusCode,
        statusText: statusText || '',
        headers: headers,
        url: typeof options.origin === 'string' && typeof options.path === 'string' ? `${options.origin}${options.path}` : (options.origin ? String(options.origin) : '')
      }, 'Incoming Response (external API)');
      return originalOnHeaders!.call(handler, statusCode, headers, resume, statusText);
    };

    // Wrap onData to log response body chunks
    handler.onData = (chunk: any) => {
      try {
        let text = Buffer.from(chunk).toString('utf8');

        // Patch for Gemini wrapped responses
        // Check if this looks like a SSE data line with a wrapped response
        if (text.includes('data: {"response":')) {
          const lines = text.split('\n');
          const fixedLines = lines.map(line => {
            if (line.trim().startsWith('data: {"response":')) {
              try {
                const jsonStr = line.trim().substring(6); // Remove 'data: '
                const json = JSON.parse(jsonStr);
                if (json.response) {
                  // Unwrap the response object
                  return `data: ${JSON.stringify(json.response)}`;
                }
              } catch (e) {
                // If parsing fails, return original line
              }
            }
            return line;
          });

          const newText = fixedLines.join('\n');
          if (newText !== text) {
            text = newText;
            chunk = Buffer.from(text, 'utf8');
          }
        }

        if (text.trim()) {
          appLogger.info({
            type: 'incoming_response_body',
            body: text,
            url: typeof options.origin === 'string' && typeof options.path === 'string' ? `${options.origin}${options.path}` : (options.origin ? String(options.origin) : '')
          }, 'Incoming Response Body Chunk');
        }
      } catch (e) { /* ignore */ }
      return originalOnData!.call(handler, chunk);
    };

    return super.dispatch(options, handler);
  }
}



export const createServer = (config: any): Server => {
  const server = new Server(config);

  // Bridge the server logger to our global logger for Undici/Dispatcher
  if (server.logger) {
    appLogger = server.logger;
  }

  // Set the global dispatcher AFTER logger is bridged so external API logs go to file
  setGlobalDispatcher(new LoggingDispatcher());

  server.app.post("/v1/messages/count_tokens", async (req, reply) => {
    const { messages, tools, system } = req.body;
    const tokenCount = calculateTokenCount(messages, system, tools);
    return { "input_tokens": tokenCount }
  });

  // Add endpoint to read config.json with access control
  server.app.get("/api/config", async (req, reply) => {
    return await readConfigFile();
  });

  server.app.get("/api/transformers", async () => {
    const transformers =
      server.app._server!.transformerService.getAllTransformers();
    const transformerList = Array.from(transformers.entries()).map(
      ([name, transformer]: any) => ({
        name,
        endpoint: transformer.endPoint || null,
      })
    );
    return { transformers: transformerList };
  });

  // Add endpoint to save config.json with access control
  server.app.post("/api/config", async (req, reply) => {
    const newConfig = req.body;

    // Backup existing config file if it exists
    const backupPath = await backupConfigFile();
    if (backupPath) {
      console.log(`Backed up existing configuration file to ${backupPath}`);
    }

    await writeConfigFile(newConfig);
    return { success: true, message: "Config saved successfully" };
  });

  // Add endpoint to restart the service with access control
  server.app.post("/api/restart", async (req, reply) => {
    reply.send({ success: true, message: "Service restart initiated" });

    // Restart the service after a short delay to allow response to be sent
    setTimeout(() => {
      const { spawn } = require("child_process");
      spawn(process.execPath, [process.argv[1], "restart"], {
        detached: true,
        stdio: "ignore",
      });
    }, 1000);
  });

  // Register static file serving with caching
  server.app.register(fastifyStatic, {
    root: join(__dirname, "..", "dist"),
    prefix: "/ui/",
    maxAge: "1h",
  });

  // Redirect /ui to /ui/ for proper static file serving
  server.app.get("/ui", async (_, reply) => {
    return reply.redirect("/ui/");
  });

  // 版本检查端点
  server.app.get("/api/update/check", async (req, reply) => {
    try {
      // 获取当前版本
      const currentVersion = require("../package.json").version;
      const { hasUpdate, latestVersion, changelog } = await checkForUpdates(currentVersion);

      return {
        hasUpdate,
        latestVersion: hasUpdate ? latestVersion : undefined,
        changelog: hasUpdate ? changelog : undefined
      };
    } catch (error) {
      console.error("Failed to check for updates:", error);
      reply.status(500).send({ error: "Failed to check for updates" });
    }
  });

  // 执行更新端点
  server.app.post("/api/update/perform", async (req, reply) => {
    try {
      // 只允许完全访问权限的用户执行更新
      const accessLevel = (req as any).accessLevel || "restricted";
      if (accessLevel !== "full") {
        reply.status(403).send("Full access required to perform updates");
        return;
      }

      // 执行更新逻辑
      const result = await performUpdate();

      return result;
    } catch (error) {
      console.error("Failed to perform update:", error);
      reply.status(500).send({ error: "Failed to perform update" });
    }
  });

  // 获取日志文件列表端点
  server.app.get("/api/logs/files", async (req, reply) => {
    try {
      const logDir = join(homedir(), ".claude-code-router", "logs");
      const logFiles: Array<{ name: string; path: string; size: number; lastModified: string }> = [];

      if (existsSync(logDir)) {
        const files = readdirSync(logDir);

        for (const file of files) {
          if (file.endsWith('.log')) {
            const filePath = join(logDir, file);
            const stats = statSync(filePath);

            logFiles.push({
              name: file,
              path: filePath,
              size: stats.size,
              lastModified: stats.mtime.toISOString()
            });
          }
        }

        // 按修改时间倒序排列
        logFiles.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      }

      return logFiles;
    } catch (error) {
      console.error("Failed to get log files:", error);
      reply.status(500).send({ error: "Failed to get log files" });
    }
  });

  // 获取日志内容端点 (Streaming implementation)
  server.app.get("/api/logs", async (req, reply) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        // 如果指定了文件路径，使用指定的路径
        logFilePath = filePath;
      } else {
        // 如果没有指定文件路径，使用默认的日志文件路径
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (!existsSync(logFilePath)) {
        return [];
      }

      // Stream the file instead of reading into memory
      const { createReadStream } = require('fs');
      const stream = createReadStream(logFilePath, 'utf8');

      reply.header('Content-Type', 'text/plain');
      return reply.send(stream);
    } catch (error) {
      console.error("Failed to get logs:", error);
      reply.status(500).send({ error: "Failed to get logs" });
    }
  });

  // 清除日志内容端点
  server.app.delete("/api/logs", async (req, reply) => {
    try {
      const filePath = (req.query as any).file as string;
      const deleteAll = (req.query as any).all === 'true';
      const logDir = join(homedir(), ".claude-code-router", "logs");

      if (deleteAll) {
        if (existsSync(logDir)) {
          const files = readdirSync(logDir);
          for (const file of files) {
            if (file.endsWith('.log')) {
              const fullPath = join(logDir, file);
              // Actually delete the file
              unlinkSync(fullPath);
            }
          }
        }
        return { success: true, message: "All log files deleted successfully" };
      }

      let logFilePath: string;

      if (filePath) {
        // 如果指定了文件路径，使用指定的路径
        logFilePath = filePath;
      } else {
        // 如果没有指定文件路径，使用默认的日志文件路径
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (existsSync(logFilePath)) {
        writeFileSync(logFilePath, '', 'utf8');
      }

      return { success: true, message: "Logs cleared successfully" };
    } catch (error) {
      console.error("Failed to clear logs:", error);
      reply.status(500).send({ error: "Failed to clear logs" });
    }
  });

  // ============= Google OAuth API Endpoints (Antigravity) =============

  const GOOGLE_CREDENTIALS_PATH = join(homedir(), ".claude-code-router", "google_credentials.json");
  const OAUTH_SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform"
  ];

  // Check if Google credentials exist
  server.app.get("/api/google-auth/status", async (req, reply) => {
    try {
      if (existsSync(GOOGLE_CREDENTIALS_PATH)) {
        const creds = JSON.parse(readFileSync(GOOGLE_CREDENTIALS_PATH, 'utf8'));
        return {
          hasCredentials: true,
          hasRefreshToken: !!creds.refresh_token,
          hasClientId: !!creds.client_id,
          clientId: creds.client_id || undefined,
          clientSecret: creds.client_secret || undefined,
          redirectUri: creds.redirect_uri || undefined
        };
      }
      return { hasCredentials: false, hasRefreshToken: false, hasClientId: false, clientId: undefined, clientSecret: undefined, redirectUri: undefined };
    } catch (error) {
      console.error("Failed to check Google auth status:", error);
      return { hasCredentials: false, hasRefreshToken: false, hasClientId: false, clientId: undefined, clientSecret: undefined, redirectUri: undefined };
    }
  });

  // Save Google client credentials
  server.app.post("/api/google-auth/credentials", async (req, reply) => {
    try {
      const { client_id, client_secret, redirect_uri } = req.body as { client_id: string; client_secret: string; redirect_uri?: string };

      if (!client_id || !client_secret) {
        reply.status(400).send({ error: "client_id and client_secret are required" });
        return;
      }

      const credDir = join(homedir(), ".claude-code-router");
      if (!existsSync(credDir)) {
        require('fs').mkdirSync(credDir, { recursive: true });
      }

      let creds: any = {};
      if (existsSync(GOOGLE_CREDENTIALS_PATH)) {
        try {
          creds = JSON.parse(readFileSync(GOOGLE_CREDENTIALS_PATH, 'utf8'));
        } catch (e) { }
      }

      creds.client_id = client_id;
      creds.client_secret = client_secret;
      creds.redirect_uri = redirect_uri;

      writeFileSync(GOOGLE_CREDENTIALS_PATH, JSON.stringify(creds, null, 2));

      return { success: true, message: "Credentials saved" };
    } catch (error) {
      console.error("Failed to save Google credentials:", error);
      reply.status(500).send({ error: "Failed to save credentials" });
    }
  });

  // Start OAuth flow - creates local server for callback
  server.app.get("/api/google-auth/start", async (req, reply) => {
    try {
      // Load user credentials
      if (!existsSync(GOOGLE_CREDENTIALS_PATH)) {
        reply.status(400).send({ error: "Please save credentials first" });
        return;
      }

      const savedCreds = JSON.parse(readFileSync(GOOGLE_CREDENTIALS_PATH, 'utf8'));
      if (!savedCreds.client_id || !savedCreds.client_secret) {
        reply.status(400).send({ error: "Client ID and Secret are required" });
        return;
      }

      if (!savedCreds.redirect_uri) {
        reply.status(400).send({ error: "Callback URL is required. Please save credentials with a callback URL." });
        return;
      }

      // Use user-provided redirect_uri
      const customRedirectUri = savedCreds.redirect_uri;
      const redirectUrl = new URL(customRedirectUri);
      const redirectPort = parseInt(redirectUrl.port) || 80;
      const redirectPath = redirectUrl.pathname;

      const http = require('http');
      const https = require('https');

      // Create promise to wait for OAuth callback
      const authPromise = new Promise<{ success: boolean; error?: string }>((resolve) => {
        let serverClosed = false;
        let timeoutId: ReturnType<typeof setTimeout>;

        const closeServer = () => {
          if (!serverClosed) {
            serverClosed = true;
            clearTimeout(timeoutId);
            callbackServer.close();
          }
        };

        const callbackServer = http.createServer(async (cbReq: any, cbRes: any) => {
          const urlObj = new URL(cbReq.url, redirectUrl.origin);

          if (urlObj.pathname === redirectPath) {
            const code = urlObj.searchParams.get('code');
            const error = urlObj.searchParams.get('error');

            if (error) {
              cbRes.writeHead(200, { 'Content-Type': 'text/html' });
              cbRes.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#1a1a2e;color:#eee">
                <div style="text-align:center"><h1 style="color:#ef4444">❌ Error</h1><p>${error}</p></div>
              </body></html>`);
              closeServer();
              resolve({ success: false, error });
              return;
            }

            if (!code) {
              cbRes.writeHead(200, { 'Content-Type': 'text/html' });
              cbRes.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#1a1a2e;color:#eee">
                <div style="text-align:center"><h1 style="color:#ef4444">❌ Error</h1><p>No code received</p></div>
              </body></html>`);
              closeServer();
              resolve({ success: false, error: 'No code received' });
              return;
            }

            // Exchange code for tokens
            try {
              const tokenData = new URLSearchParams({
                code: code,
                client_id: savedCreds.client_id,
                client_secret: savedCreds.client_secret,
                redirect_uri: customRedirectUri,
                grant_type: 'authorization_code'
              }).toString();

              const tokens = await new Promise<any>((resolveToken, rejectToken) => {
                const tokenReq = https.request({
                  hostname: 'oauth2.googleapis.com',
                  path: '/token',
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(tokenData)
                  }
                }, (res: any) => {
                  let body = '';
                  res.on('data', (chunk: any) => body += chunk);
                  res.on('end', () => {
                    try { resolveToken(JSON.parse(body)); }
                    catch (e) { rejectToken(new Error('Failed to parse token response')); }
                  });
                });
                tokenReq.on('error', rejectToken);
                tokenReq.write(tokenData);
                tokenReq.end();
              });

              if (tokens.error) {
                cbRes.writeHead(200, { 'Content-Type': 'text/html' });
                cbRes.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#1a1a2e;color:#eee">
                  <div style="text-align:center"><h1 style="color:#ef4444">❌ Token Error</h1><p>${tokens.error_description || tokens.error}</p></div>
                </body></html>`);
                closeServer();
                resolve({ success: false, error: tokens.error_description || tokens.error });
                return;
              }

              if (!tokens.refresh_token) {
                cbRes.writeHead(200, { 'Content-Type': 'text/html' });
                cbRes.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#1a1a2e;color:#eee">
                  <div style="text-align:center"><h1 style="color:#f59e0b">⚠️ Warning</h1>
                  <p>No refresh token. Revoke at <a href="https://myaccount.google.com/permissions" style="color:#60a5fa">Google Permissions</a></p></div>
                </body></html>`);
                closeServer();
                resolve({ success: false, error: 'No refresh token received' });
                return;
              }

              // Save credentials
              const creds = {
                client_id: savedCreds.client_id,
                client_secret: savedCreds.client_secret,
                redirect_uri: customRedirectUri,
                refresh_token: tokens.refresh_token,
                access_token: tokens.access_token,
                expiry_date: Date.now() + (tokens.expires_in * 1000),
                token_type: 'Bearer'
              };

              const credDir = join(homedir(), ".claude-code-router");
              if (!existsSync(credDir)) {
                require('fs').mkdirSync(credDir, { recursive: true });
              }
              writeFileSync(GOOGLE_CREDENTIALS_PATH, JSON.stringify(creds, null, 2));

              cbRes.writeHead(200, { 'Content-Type': 'text/html' });
              cbRes.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#1a1a2e;color:#eee">
                <div style="text-align:center">
                  <h1 style="color:#4ade80">✅ Success!</h1>
                  <p>Authentication complete. You can close this window.</p>
                  <script>setTimeout(() => window.close(), 2000);</script>
                </div>
              </body></html>`);
              console.log('[OAuth] Callback server closing (authentication successful)');
              closeServer();
              resolve({ success: true });

            } catch (err: any) {
              cbRes.writeHead(200, { 'Content-Type': 'text/html' });
              cbRes.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#1a1a2e;color:#eee">
                <div style="text-align:center"><h1 style="color:#ef4444">❌ Error</h1><p>${err.message}</p></div>
              </body></html>`);
              closeServer();
              resolve({ success: false, error: err.message });
            }
          }
        });

        callbackServer.listen(redirectPort, () => {
          console.log(`[OAuth] Callback server listening on port ${redirectPort}`);
        });

        callbackServer.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            closeServer();
            resolve({ success: false, error: `Port ${redirectPort} is in use` });
          } else {
            closeServer();
            resolve({ success: false, error: err.message });
          }
        });

        // Timeout after 1 minute
        timeoutId = setTimeout(() => {
          if (!serverClosed) {
            console.log('[OAuth] Callback server closing (1 minute timeout)');
            closeServer();
            resolve({ success: false, error: 'Authentication timed out (1 minute)' });
          }
        }, 60 * 1000);
      });

      // Build OAuth URL
      const params = new URLSearchParams({
        client_id: savedCreds.client_id,
        redirect_uri: customRedirectUri,
        response_type: 'code',
        scope: OAUTH_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent'
      });

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

      // Handle auth result in background (don't await - we return URL immediately)
      authPromise.then((result) => {
        if (result.success) {
          console.log('[OAuth] Authentication completed successfully');
        } else {
          console.log('[OAuth] Authentication failed:', result.error);
        }
      }).catch((err) => {
        console.error('[OAuth] Unexpected error:', err);
      });

      // Return URL immediately, auth result comes async
      return { authUrl, redirectUri: customRedirectUri };

    } catch (error) {
      console.error("Failed to start OAuth:", error);
      reply.status(500).send({ error: "Failed to start OAuth: " + (error as Error).message });
    }
  });

  // ===================== INCOMING TRAFFIC LOGGING =====================

  // Log Incoming Request (use preHandler to ensure body is parsed if available)
  server.app.addHook("preHandler", async (req: any, reply: any) => {
    try {
      req.log.info({
        type: 'incoming_request',
        method: req.method,
        url: req.url,
        body: req.body,
        headers: req.headers
      }, `Incoming Request: ${req.method} ${req.url}`);
    } catch (err) {
      server.logger.error("Error logging incoming request:", err);
    }
  });

  // Log Outgoing Response (Server -> Client)
  server.app.addHook("onSend", (req: any, reply: any, payload: any, done: any) => {
    try {
      // SKIP logging for log/UI endpoints to prevent recursion/noise
      if (req.url.startsWith('/api/logs') || req.url.startsWith('/ui/') || req.url.startsWith('/favicon.ico')) {
        done(null, payload);
        return;
      }

      let bodyStr = '';
      if (typeof payload === 'string' && payload.trim()) {
        bodyStr = payload;
      } else if (Buffer.isBuffer(payload)) {
        bodyStr = payload.toString('utf8');
      }

      if (bodyStr.trim()) {
        req.log.info({
          type: 'outgoing_response',
          body: bodyStr,
          url: req.url,
          headers: req.headers
        }, `Outgoing Response`);
      }
    } catch (err) {
      // ignore
    }
    done(null, payload);
  });

  // ===================== OUTGOING TRAFFIC LOGGING (Undici) =====================

  diagnostics_channel.subscribe("undici:request:create", (message) => {
    const { request }: any = message;
    try {
      appLogger.info({
        type: 'outgoing_request',
        method: request.method,
        url: `${request.origin}${request.path}`,
        headers: request.headers
      }, `Outgoing Request: ${request.method} ${request.origin}${request.path}`);

      // Log Body
      if (request.body) {
        // Check if body is a string or buffer we can print
        if (typeof request.body === 'string') {
          appLogger.info({
            type: 'outgoing_request_body',
            body: request.body,
            url: `${request.origin}${request.path}`,
            headers: request.headers
          }, 'Outgoing Request Body');
        } else if (Buffer.isBuffer(request.body)) {
          const bodyStr = request.body.toString('utf8');
          appLogger.info({
            type: 'outgoing_request_body',
            body: bodyStr,
            url: `${request.origin}${request.path}`,
            headers: request.headers
          }, 'Outgoing Request Body');
        } else if (
          request.body &&
          (Symbol.asyncIterator in request.body || Symbol.iterator in request.body)
        ) {
          appLogger.info({}, "Outgoing Request Body (Stream detected - intercepting chunks...)");

          // Wrap the body stream to log chunks
          const originalBody = request.body;
          request.body = (async function* () {
            for await (const chunk of originalBody) {
              try {
                let stringChunk;
                if (typeof chunk === 'string') {
                  stringChunk = chunk;
                } else {
                  stringChunk = Buffer.from(chunk).toString('utf8');
                }
                if (stringChunk.trim()) {
                  appLogger.info({
                    type: 'outgoing_request_body',
                    headers: request.headers,
                    body: stringChunk,
                    url: `${request.origin}${request.path}`
                  }, 'Outgoing Request Body Chunk');
                }
              } catch (e) { /* ignore logging errors */ }
              yield chunk;
            }
          })();
        } else {
          appLogger.info({
            type: 'outgoing_request_body',
            headers: request.headers,
            body: request.body,
            url: `${request.origin}${request.path}`
          }, 'Outgoing Request Body (Complex Object)');
        }
      }
    } catch (err) {
      appLogger.error("Error logging request:", err);
    }
  });

  return server;
};

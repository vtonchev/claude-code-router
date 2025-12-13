/**
 * Custom Router for Antigravity Provider
 * 
 * This router properly handles model switching for the Antigravity provider.
 * It maps Claude Code models to the appropriate Antigravity models while
 * preserving the original model for the transformer to use.
 * 
 * Model mappings:
 * - claude-opus-4-5-* → claude-opus-4-5-thinking
 * - claude-sonnet-4-* → claude-sonnet-4-5-thinking  
 * - claude-haiku-* → gemini3-pro-high
 * 
 * Web Search:
 * - Requests with web_search_20250305 tool → antigravity-websearch,gemini-2.5-flash
 * 
 * @param {object} req - The request object from Claude Code
 * @param {object} config - The application's config object
 * @param {object} context - Additional context including event info
 * @returns {Promise<string|null>} - "provider,model" string or null for default router
 */
module.exports = async function router(req, config, context) {
  // Check for web search tool - route to dedicated web search provider
  const tools = req.body.tools || [];
  const toolTypes = tools.map(t => t.type || t.name || 'unknown');
  console.log(`[custom-router] Incoming request, tools: ${JSON.stringify(toolTypes)}`);
  
  const hasWebSearch = tools.some(tool => tool.type === 'web_search_20250305');
  
  if (hasWebSearch) {
    console.log(`[custom-router] Web search detected → antigravity-websearch,gemini-2.5-flash`);
    // Store flag on request body so transformer can detect it after transformRequestOut
    req.body.__isWebSearch = true;
    return 'antigravity-websearch,gemini-2.5-flash';
  }
  
  // Get the original model from Claude Code
  const originalModel = req.body.model || '';
  
  // Store the original model for the transformer to use for its own mapping
  req.body.originalModel = originalModel;
  
  // Determine the Antigravity model based on the Claude Code model
  let antigravityModel;
  const modelLower = originalModel.toLowerCase();
  
  if (modelLower.includes('opus')) {
    antigravityModel = 'claude-opus-4-5-thinking';
  } else if (modelLower.includes('haiku')) {
    antigravityModel = 'gemini3-pro-high';
  } else if (modelLower.includes('sonnet')) {
    antigravityModel = 'claude-sonnet-4-5-thinking';
  } else {
    // Check for thinking mode
    if (req.body.thinking) {
      antigravityModel = 'claude-opus-4-5-thinking';
    } else {
      antigravityModel = 'claude-sonnet-4-5-thinking';
    }
  }
  
  // Log the routing decision
  console.log(`[custom-router] Model "${originalModel}" → antigravity,${antigravityModel}`);
  
  return `antigravity,${antigravityModel}`;
};

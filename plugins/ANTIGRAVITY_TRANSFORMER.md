# Antigravity Transformer - Complete Documentation

The Antigravity Transformer converts requests and responses between **Anthropic (Claude Code)** format and **Antigravity/Gemini** format. This enables Claude Code CLI to work with Google's Gemini API via the Antigravity endpoint.

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Configuration](#configuration)
4. [Model Mapping](#model-mapping)
5. [Request Transformation (transformRequestIn)](#request-transformation)
   - [System Instructions](#system-instructions)
   - [Messages & Contents](#messages--contents)
   - [Tool Calls & Function Responses](#tool-calls--function-responses)
   - [Tools Schema](#tools-schema)
   - [Generation Config](#generation-config)
6. [Response Transformation (transformResponseOut)](#response-transformation)
   - [Streaming SSE](#streaming-sse)
   - [Non-Streaming JSON](#non-streaming-json)
7. [cleanParameters Helper](#cleanparameters-helper)
8. [Token Usage](#token-usage)

---

## Overview

```
┌─────────────┐    transformRequestIn    ┌──────────────────┐
│ Claude Code │  ─────────────────────►  │ Antigravity API  │
│ (Anthropic) │                          │ (Gemini-style)   │
│             │  ◄─────────────────────  │                  │
└─────────────┘   transformResponseOut   └──────────────────┘
```

---

## Authentication

Uses OAuth 2.0 with Google Cloud. Credentials stored at:
```
~/.claude-code-router/google_credentials.json
```

Token refresh happens automatically when expired (5-minute buffer).

---

## Configuration

Add the transformer to your `config.json`:

```json
{
  "transformers": [{
    "path": "./plugins/antigravity.transformer.js",
    "options": {
      "project": "your-gcp-project-id",
      "userAgent": "antigravity",
      "requestType": "agent",
      "defaultModel": "claude-sonnet-4-5-20250514",
      "modelMapping": {
        "claude-opus-4-5-20251101": "claude-opus-4-5-thinking",
        "claude-sonnet-4-5-20250514": "claude-sonnet-4-5-thinking",
        "claude-haiku-4-5-20251001": "gemini3-pro-high"
      }
    }
  }]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `project` | `"default-project"` | Your GCP project ID |
| `userAgent` | `"antigravity"` | User agent string |
| `requestType` | `"agent"` | Request type |
| `defaultModel` | `"claude-sonnet-4-5-20250514"` | Fallback model for responses |
| `modelMapping` | *(see below)* | Map Claude models to Antigravity models |

---

## Model Mapping

When you use `/model` in Claude Code, the transformer maps the model to the Antigravity equivalent.

**Default Mappings:**

| Claude Code Model | Antigravity Model |
|-------------------|-------------------|
| `claude-opus-4-5-20251101` | `claude-opus-4-5-thinking` |
| `claude-opus-4-20250514` | `claude-opus-4-5-thinking` |
| `claude-sonnet-4-5-20250514` | `claude-sonnet-4-5-thinking` |
| `claude-sonnet-4-20250514` | `claude-sonnet-4-5-thinking` |
| `claude-haiku-4-5-20251001` | `gemini3-pro-high` |
| `claude-3-5-haiku-20241022` | `gemini3-pro-high` |

**Fallback Logic:**
- Model contains `opus` → uses Opus mapping
- Model contains `haiku` → uses Haiku mapping
- Any other model → uses Sonnet mapping

**Custom Mapping:**
```json
{
  "modelMapping": {
    "my-custom-model": "gemini3-pro-ultra"
  }
}
```

## Request Transformation

### System Instructions

**Anthropic Input:**
```json
{
  "system": [
    { "type": "text", "text": "You are Claude Code...", "cache_control": {...} },
    { "type": "text", "text": "You are a software architect...", "cache_control": {...} }
  ],
  "messages": [...]
}
```

**Antigravity Output:**
```json
{
  "systemInstruction": {
    "role": "user",
    "parts": [
      { "text": "You are Claude Code..." },
      { "text": "You are a software architect..." }
    ]
  }
}
```

> **Note:** `cache_control` is stripped (not supported by Gemini).

---

### Messages & Contents

**Anthropic Input:**
```json
{
  "messages": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi there!" }
  ]
}
```

**Antigravity Output:**
```json
{
  "contents": [
    { "role": "user", "parts": [{ "text": "Hello" }] },
    { "role": "model", "parts": [{ "text": "Hi there!" }] }
  ]
}
```

**Role Mapping:**
| Anthropic | Antigravity |
|-----------|-------------|
| `user`    | `user`      |
| `assistant` | `model`   |
| `system`  | *(goes to systemInstruction)* |
| `tool`    | *(merged into functionResponse)* |

---

### Tool Calls & Function Responses

When the assistant calls a tool:

**Anthropic Input (assistant message with tool_calls):**
```json
{
  "role": "assistant",
  "content": "Let me search for that...",
  "tool_calls": [{
    "id": "toolu_123",
    "type": "function",
    "function": {
      "name": "grep_search",
      "arguments": "{\"Query\": \"hello\", \"SearchPath\": \"/home\"}"
    }
  }]
}
```

**Antigravity Output:**
```json
{
  "role": "model",
  "parts": [
    { "text": "Let me search for that..." },
    {
      "functionCall": {
        "id": "toolu_123",
        "name": "grep_search",
        "args": { "Query": "hello", "SearchPath": "/home" }
      }
    }
  ]
}
```

**Tool Response (Anthropic):**
```json
{
  "role": "tool",
  "tool_call_id": "toolu_123",
  "content": "Found 3 matches..."
}
```

**Function Response (Antigravity):**
```json
{
  "role": "user",
  "parts": [{
    "functionResponse": {
      "id": "toolu_123",
      "name": "grep_search",
      "response": { "output": "Found 3 matches..." }
    }
  }]
}
```

---

### Tools Schema

Each tool is wrapped in its own `functionDeclarations` array. Types are converted to UPPERCASE.

**Anthropic Input:**
```json
{
  "tools": [
    {
      "name": "grep_search",
      "description": "Search for text...",
      "input_schema": {
        "type": "object",
        "properties": {
          "Query": { "type": "string", "description": "Search term" },
          "CaseInsensitive": { "type": "boolean" }
        },
        "required": ["Query"],
        "additionalProperties": false,
        "$schema": "http://json-schema.org/draft-07/schema#"
      }
    }
  ]
}
```

**Antigravity Output:**
```json
{
  "tools": [
    {
      "functionDeclarations": [{
        "name": "grep_search",
        "description": "Search for text...",
        "parameters": {
          "type": "OBJECT",
          "properties": {
            "Query": { "type": "STRING", "description": "Search term" },
            "CaseInsensitive": { "type": "BOOLEAN" }
          },
          "required": ["Query"]
        }
      }]
    }
  ]
}
```

**Key Transformations:**
- `input_schema` → `parameters`
- `"type": "object"` → `"type": "OBJECT"` (all types uppercased)
- `additionalProperties`, `$schema`, `$ref`, `default`, etc. → **removed**
- Each tool wrapped in `{ functionDeclarations: [tool] }`
- `web_search` tool → `{ googleSearch: {} }`

---

### Generation Config

**Anthropic Input:**
```json
{
  "temperature": 0.7,
  "max_tokens": 4096,
  "top_p": 0.9
}
```

**Antigravity Output:**
```json
{
  "generationConfig": {
    "temperature": 0.7,
    "maxOutputTokens": 4096,
    "topP": 0.9
  }
}
```

**Thinking/Reasoning:**
```json
// Anthropic
{ "reasoning": { "effort": "high", "max_tokens": 10000 } }

// Antigravity
{ "generationConfig": { 
    "thinkingConfig": { 
      "includeThoughts": true, 
      "thinkingBudget": 10000 
    } 
  }
}
```

---

### Tool Choice / Tool Config

**Anthropic → Antigravity:**
| Anthropic `tool_choice` | Antigravity `functionCallingConfig.mode` |
|-------------------------|------------------------------------------|
| `"auto"`                | `"AUTO"`                                 |
| `"none"`                | `"NONE"`                                 |
| `"required"`            | `"ANY"`                                  |
| `{ function: { name } }`| `"ANY"` + `allowedFunctionNames: [name]` |
| *(default)*             | `"VALIDATED"`                            |

---

## Response Transformation

### Streaming SSE

Converts Gemini SSE events to Anthropic SSE format.

**Antigravity SSE Input:**
```
data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello!"}]}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":50}}}
```

**Anthropic SSE Output:**
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"gemini-3-pro-low","stop_reason":null}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":100,"output_tokens":50}}

event: message_stop
data: {"type":"message_stop"}
```

**Event Types Generated:**
- `message_start` - Initial message envelope
- `content_block_start` - Start of text/thinking/tool_use block
- `content_block_delta` - Content chunks (text_delta, thinking_delta, input_json_delta)
- `content_block_stop` - End of content block
- `message_delta` - Stop reason and usage stats
- `message_stop` - Stream complete

---

### Non-Streaming JSON

**Antigravity Input:**
```json
{
  "response": {
    "responseId": "resp_123",
    "modelVersion": "gemini-3-pro-low",
    "candidates": [{
      "content": {
        "parts": [
          { "text": "Hello!", "thought": true },
          { "text": "The answer is 42" },
          { "thoughtSignature": "sig_abc" }
        ]
      },
      "finishReason": "STOP"
    }],
    "usageMetadata": {
      "promptTokenCount": 100,
      "candidatesTokenCount": 50,
      "totalTokenCount": 150
    }
  }
}
```

**Anthropic Output:**
```json
{
  "id": "resp_123",
  "object": "chat.completion",
  "model": "gemini-3-pro-low",
  "choices": [{
    "index": 0,
    "finish_reason": "stop",
    "message": {
      "role": "assistant",
      "content": "The answer is 42",
      "thinking": {
        "content": "Hello!",
        "signature": "sig_abc"
      }
    }
  }],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150
  }
}
```

---

## cleanParameters Helper

Recursively cleans JSON Schema for Gemini compatibility:

```javascript
cleanParameters(schema)
```

**Removes:**
- `$schema`, `$id`, `$ref`, `$defs`, `$comment`
- `definitions`, `examples`, `default`
- `additionalProperties`
- Empty `required` arrays

**Converts:**
- `"type": "object"` → `"type": "OBJECT"`
- `"type": "string"` → `"type": "STRING"`
- `"type": "array"` → `"type": "ARRAY"`
- `"type": "boolean"` → `"type": "BOOLEAN"`
- `"type": "number"` → `"type": "NUMBER"`
- `"type": "integer"` → `"type": "INTEGER"`

---

## Token Usage

**Antigravity Response:**
```json
{
  "usageMetadata": {
    "promptTokenCount": 100,
    "candidatesTokenCount": 50,
    "totalTokenCount": 150
  }
}
```

**Anthropic Output (in message_delta):**
```json
{
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50
  }
}
```

This is displayed in Claude Code's status bar as token count.

---

## Final Request Envelope

The complete Antigravity request structure:

```json
{
  "project": "your-project-id",
  "requestId": "agent-uuid-here",
  "model": "claude-sonnet-4-20250514",
  "userAgent": "antigravity",
  "requestType": "agent",
  "request": {
    "contents": [...],
    "systemInstruction": {...},
    "tools": [...],
    "toolConfig": {...},
    "generationConfig": {...},
    "sessionId": "-1702425600000"
  }
}
```

**Headers:**
```
Authorization: Bearer <oauth_access_token>
Content-Type: application/json
User-Agent: antigravity/ windows/amd64
```

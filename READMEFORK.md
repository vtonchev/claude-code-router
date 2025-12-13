We are buildinf a fork of Claude Code Server to add support for Transformer that handles 
Google anigravity LLM server -> https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse

The main difference is that we are using a different LLM server and we are using a different authentication method.
=================================

Claude Code -----> Gemini Transformer ---> Custom Transformer -----> Google Anigravity LLM Server ----->  Custom Transformer  -----> Gemini Transformer -----> Claude Code

=================================

Do not write tests for this project.
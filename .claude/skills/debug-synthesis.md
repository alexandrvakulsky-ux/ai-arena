---
name: debug-synthesis
description: Trace the full 3-round P→C→R synthesis protocol and find where it breaks. Use when synthesis output is malformed, scores are missing/wrong, or the synthesized answer section is absent.
tools: Bash, Read
---

# Debug Synthesis

## Goal
Pinpoint exactly which round (propose/challenge/revise) is failing and why.

## Process

1. **Server check**
   - Confirm `http://localhost:3000` is running before anything else

2. **Round 1 — Propose**
   - POST `/api/ask` with `{"question":"What is the capital of France?","models":["claude","openai","gemini"]}`
   - Confirm all 3 providers return non-empty answers
   - Note any that error, timeout, or return truncated text

3. **Round 2+3 — Full synthesis**
   - POST `/api/synthesize` with the same question
   - Capture full raw response body
   - Check for required format:
     - Contains `Scores: Claude=X/10, ChatGPT=X/10, Gemini=X/10`
     - Contains `## ✨ Synthesized Answer`
   - If format is wrong: show the raw response exactly as received

4. **Inspect synthesis handler**
   - Read the `/api/synthesize` route in `server.js`
   - Check: scoring regex, token limits per round, timeout values
   - Look for any truncation or parsing logic that could corrupt the output

5. **Check for common issues**
   - Gemini truncation: does Gemini's response get cut off mid-sentence?
   - Score parsing: does the regex match actual model response format?
   - Challenge round: are anonymized labels (A/B/C) mapping back correctly?

6. **Report**
   - Which round failed
   - Exact raw output vs expected format
   - Root cause + fix

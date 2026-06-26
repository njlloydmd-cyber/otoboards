import { Difficulty, Question, Subspecialty } from '../types';

// Without this, a stalled request (Render's free tier waking from sleep, a slow Claude
// response, a network hiccup) would leave fetch() pending indefinitely — the UI would just
// sit there with no error and nothing to retry. This guarantees every call eventually fails
// clearly if it doesn't complete in time, so the existing error/retry UI can take over.
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error: any) {
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s. The server may be waking up from sleep (free-tier services do this) or experiencing high demand — please try again.`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

// Generous timeout for calls that may involve a large document or a large requested question
// count (output scales with count — 30 questions can need ~35,000 output tokens, which can
// legitimately take several minutes to generate). Short timeout for trivial calls.
const LONG_TIMEOUT_MS = 240_000;
const SHORT_TIMEOUT_MS = 30_000;

async function safeFetch<T>(url: string, body: any, timeoutMs: number = LONG_TIMEOUT_MS): Promise<T> {
    const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }, timeoutMs);

    const responseText = await response.text();

    if (!response.ok) {
        let errorMessage = `Server returned ${response.status}`;
        try {
            const data = JSON.parse(responseText);
            errorMessage = data.error || errorMessage;
        } catch (e) {
            if (responseText.includes("<title>")) {
                const match = responseText.match(/<title>([\s\S]*?)<\/title>/i);
                if (match && match[1]) {
                    errorMessage += ` (${match[1].trim()})`;
                }
            } else {
                errorMessage += ` (${responseText.substring(0, 200).trim()})`;
            }
        }
        throw new Error(errorMessage);
    }

    try {
        return JSON.parse(responseText) as T;
    } catch (error: any) {
        console.error(`Failed to parse response from ${url} as JSON. Raw response content:`, responseText.substring(0, 1000));
        let detail = "Invalid JSON response from server.";
        if (responseText.includes("<!DOCTYPE html>") || responseText.includes("<html")) {
            const titleMatch = responseText.match(/<title>([\s\S]*?)<\/title>/i);
            if (titleMatch && titleMatch[1]) {
                detail = `Server returned an HTML page: "${titleMatch[1].trim()}"`;
            } else {
                detail = "Server returned an HTML/Vite preview fallback instead of JSON.";
            }
        }
        throw new Error(`${detail} (Check console logs for details)`);
    }
}

export const nameDocument = async (documentText: string): Promise<string> => {
    try {
        const data = await safeFetch<{ title: string }>("/api/claude/name-document", { documentText }, SHORT_TIMEOUT_MS);
        return data.title;
    } catch (error: any) {
        console.error("Error generating document name client side:", error);
        throw error;
    }
};

export const generateQuestions = async (
  count: number,
  difficulty: Difficulty,
  subspecialty: Subspecialty,
  sourceOptions: {
      sourceMode: 'textbooks' | 'documents' | 'both' | 'bank';
      documents?: { aiName: string, text: string }[];
  },
  excludeQuestions: string[] = []
): Promise<Question[]> => {
    try {
        const data = await safeFetch<{ questions: Question[] }>("/api/claude/generate-questions", { count, difficulty, subspecialty, sourceOptions, excludeQuestions });
        return data.questions;
    } catch (error: any) {
        console.error("Error generating questions client side:", error);
        throw error;
    }
};

export const askFollowUpQuestion = async (
  question: Question,
  userQuery: string
): Promise<string> => {
    try {
        const data = await safeFetch<{ answer: string }>("/api/claude/ask-followup", { question, userQuery }, SHORT_TIMEOUT_MS);
        return data.answer;
    } catch (error: any) {
        console.error("Error asking follow-up question client side:", error);
        throw error;
    }
};

export const reportQuestionError = async (
  question: Question,
  userFeedback: string
): Promise<string> => {
    try {
        const data = await safeFetch<{ answer: string }>("/api/claude/report-error", { question, userFeedback }, SHORT_TIMEOUT_MS);
        return data.answer;
    } catch (error: any) {
        console.error("Error reporting question error client side:", error);
        throw error;
    }
};

// Replaces the old extractTextMultimodal. The server picks the right extraction strategy
// (native PDF understanding, deterministic .docx parsing, or image OCR) based on the file
// type, so the client just hands over the bytes.
export const extractDocument = async (
  base64Data: string,
  mimeType: string,
  fileName: string
): Promise<{ text: string; method: string }> => {
    try {
        return await safeFetch<{ text: string; method: string }>("/api/claude/extract-document", { base64Data, mimeType, fileName });
    } catch (error: any) {
        console.error("Error extracting text from document client side:", error);
        throw error;
    }
};

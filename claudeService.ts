import { Difficulty, Question, Subspecialty } from '../types';

async function safeFetch<T>(url: string, body: any): Promise<T> {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

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
        const data = await safeFetch<{ title: string }>("/api/claude/name-document", { documentText });
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
        const data = await safeFetch<{ answer: string }>("/api/claude/ask-followup", { question, userQuery });
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
        const data = await safeFetch<{ answer: string }>("/api/claude/report-error", { question, userFeedback });
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

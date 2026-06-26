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
            errorMessage += ` (${responseText.substring(0, 200).trim()})`;
        }
        throw new Error(errorMessage);
    }

    return JSON.parse(responseText) as T;
}

// Adds a question to the shared Question Bank. Idempotent — adding the same question text twice
// (by the same person, or two different people) is a no-op the second time, signaled by
// `alreadyExisted: true` rather than an error.
export const addQuestionToBank = async (question: Question): Promise<{ added: boolean; alreadyExisted: boolean }> => {
    try {
        return await safeFetch<{ added: boolean; alreadyExisted: boolean }>("/api/bank/add", { question });
    } catch (error: any) {
        console.error("Error adding question to the bank:", error);
        throw error;
    }
};

export const getQuestionBankCount = async (): Promise<number> => {
    try {
        const response = await fetch("/api/bank/count");
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `Server returned ${response.status}`);
        }
        const data = await response.json();
        return data.count ?? 0;
    } catch (error: any) {
        console.error("Error reading question bank count:", error);
        throw error;
    }
};

// Pulls questions straight from the curated bank — no AI call, no token cost. Used for the
// "Question Bank" source mode.
export const sampleFromQuestionBank = async (
    count: number,
    difficulty: Difficulty,
    subspecialty: Subspecialty
): Promise<{ questions: Question[]; totalMatched: number; requestedCount: number }> => {
    try {
        return await safeFetch<{ questions: Question[]; totalMatched: number; requestedCount: number }>("/api/bank/sample", { count, difficulty, subspecialty });
    } catch (error: any) {
        console.error("Error sampling the question bank:", error);
        throw error;
    }
};

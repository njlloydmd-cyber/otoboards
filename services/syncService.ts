import { TestSession } from '../types';
import { getCurrentIdToken } from './firebaseClient';

export interface SyncPayload {
    sessions: TestSession[];
    incompleteSessions: Record<string, TestSession>;
}

async function authedFetch<T>(url: string, method: 'GET' | 'POST', body?: any): Promise<T> {
    const idToken = await getCurrentIdToken();
    if (!idToken) throw new Error('Not signed in.');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
        response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`,
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
    } catch (error: any) {
        if (error.name === 'AbortError') {
            throw new Error('Sync request timed out after 30s.');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    const responseText = await response.text();
    if (!response.ok) {
        let errorMessage = `Server returned ${response.status}`;
        try {
            const data = JSON.parse(responseText);
            errorMessage = data.error || errorMessage;
        } catch {
            errorMessage += ` (${responseText.substring(0, 200).trim()})`;
        }
        throw new Error(errorMessage);
    }
    return JSON.parse(responseText) as T;
}

// Pushes the current local sessions/incompleteSessions to the signed-in user's cloud record.
// This is the source of truth going forward — each call overwrites the previous cloud state
// with the caller's current full set (the caller is responsible for merging first, e.g. via
// downloadSyncData, if there might be data from another device to reconcile).
export const uploadSyncData = async (payload: SyncPayload): Promise<void> => {
    await authedFetch<{ success: boolean }>('/api/sync/upload', 'POST', payload);
};

// Fetches whatever's currently stored for the signed-in user. Returns null if this user has
// never synced before (first-ever sign-in, nothing in the cloud yet) rather than empty arrays,
// so the caller can distinguish "nothing to merge" from "merge with an empty set".
export const downloadSyncData = async (): Promise<SyncPayload | null> => {
    return await authedFetch<SyncPayload | null>('/api/sync/download', 'GET');
};

// Merges two sets of sessions/incompleteSessions, deduplicating by session id. Used when
// signing in on a device that already has local data, against cloud data from another device.
export const mergeSyncPayloads = (local: SyncPayload, cloud: SyncPayload): SyncPayload => {
    const sessionsById = new Map<string, TestSession>();
    [...cloud.sessions, ...local.sessions].forEach(s => sessionsById.set(s.id, s));
    // Local wins on conflict for sessions with the same id (shouldn't normally happen, since
    // ids are timestamp-based, but local-last keeps the most recently-active device's version).

    const incompleteById: Record<string, TestSession> = { ...cloud.incompleteSessions, ...local.incompleteSessions };

    return {
        sessions: Array.from(sessionsById.values()).sort((a, b) => a.date - b.date),
        incompleteSessions: incompleteById,
    };
};

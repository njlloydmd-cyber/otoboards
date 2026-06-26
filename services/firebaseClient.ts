import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged as firebaseOnAuthStateChanged,
    type Auth,
    type User,
} from 'firebase/auth';

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Cross-device sync is an optional feature — if these aren't configured, the app should keep
// working entirely locally rather than crash. isSyncConfigured lets the UI hide the sign-in
// button cleanly instead of offering something that can't work.
export const isSyncConfigured = Boolean(
    firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId
);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

if (isSyncConfigured) {
    try {
        app = initializeApp(firebaseConfig);
        auth = getAuth(app);
    } catch (e) {
        console.warn('Firebase client initialization failed; cross-device sync will be unavailable.', e);
    }
}

export const signInWithGoogle = async (): Promise<User> => {
    if (!auth) throw new Error('Cross-device sync is not configured on this deployment.');
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    return result.user;
};

export const signOutUser = async (): Promise<void> => {
    if (!auth) return;
    await signOut(auth);
};

export const onAuthStateChanged = (callback: (user: User | null) => void): (() => void) => {
    if (!auth) {
        callback(null);
        return () => {};
    }
    return firebaseOnAuthStateChanged(auth, callback);
};

export const getCurrentIdToken = async (): Promise<string | null> => {
    if (!auth || !auth.currentUser) return null;
    return auth.currentUser.getIdToken();
};

export type { User };

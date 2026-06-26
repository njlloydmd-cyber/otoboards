import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Difficulty,
  Subspecialty,
  TestMode,
  Question,
  TestSession,
  UserAnswer,
  UploadedDocument,
  FollowUpConversation,
} from './types';
import { ALL_DIFFICULTIES, ALL_SUBSPECIALTIES, ALL_TEST_MODES, MODE_DESCRIPTIONS } from './constants';
import { generateQuestions, askFollowUpQuestion, reportQuestionError, nameDocument, extractDocument } from './services/claudeService';
import { addQuestionToBank, getQuestionBankCount, sampleFromQuestionBank } from './services/questionBankService';
import { isSyncConfigured, signInWithGoogle, signOutUser, onAuthStateChanged, type User } from './services/firebaseClient';
import { uploadSyncData, downloadSyncData, mergeSyncPayloads, uploadDocumentToSync, deleteDocumentFromSync, downloadSyncedDocuments, mergeDocuments } from './services/syncService';
import { getFilteredCuratedQuestions } from './curatedQuestions';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar } from 'recharts';
import { ArrowPathIcon, BookOpenIcon, BookmarkIcon, ChartBarIcon, CheckCircleIcon, PaperAirplaneIcon, SparklesIcon, XCircleIcon, FlagIcon, DocumentArrowUpIcon, TrashIcon, StarIcon, CircleStackIcon, UserCircleIcon } from './components/icons';

// --- Helper Components ---

// FIX: Added onClick prop to Card to handle clicks, and ensured className handles undefined safely.
const Card: React.FC<{ children: React.ReactNode; className?: string, style?: React.CSSProperties, onClick?: React.MouseEventHandler<HTMLDivElement> }> = ({ children, className, style, onClick }) => (
  <div className={`bg-white shadow-lg rounded-xl p-6 sm:p-8 ${className || ''}`} style={style} onClick={onClick}>
    {children}
  </div>
);

// Builds a compact list of previously-seen question stems so generation prompts can ask Claude
// to avoid repeating them. Bounded on two axes — total count and per-stem length — so this stays
// cheap even after months of regular use, instead of growing unbounded with question history.
const MAX_EXCLUDED_QUESTIONS = 250;
const MAX_STEM_LENGTH = 220;
function getRecentQuestionStems(sessions: TestSession[], incompleteSessions: Record<string, TestSession>): string[] {
    const seenIds = new Set<string>();
    const stems: string[] = [];

    const allSessions = [...sessions, ...Object.values(incompleteSessions)];
    // Most recent sessions first, so if we hit the cap we keep the freshest questions rather than
    // the oldest ones (the ones the person is most likely to remember and be annoyed to see again).
    const sortedByRecency = allSessions.sort((a, b) => b.date - a.date);

    outer: for (const session of sortedByRecency) {
        for (const q of session.questions) {
            if (seenIds.has(q.id)) continue;
            seenIds.add(q.id);
            stems.push(q.question.length > MAX_STEM_LENGTH ? `${q.question.slice(0, MAX_STEM_LENGTH)}…` : q.question);
            if (stems.length >= MAX_EXCLUDED_QUESTIONS) break outer;
        }
    }
    return stems;
}


// --- Main Application ---

type View = 'dashboard' | 'setup' | 'test' | 'results' | 'repeat';
type RepeatFilter = 'all' | 'incorrect' | 'marked' | Subspecialty | Difficulty;

interface SourceOptions {
  sourceMode: 'textbooks' | 'documents' | 'both' | 'bank';
  documents: UploadedDocument[];
}

const App: React.FC = () => {
  const [view, setView] = useState<View>('dashboard');
  const [sessions, setSessions] = useState<TestSession[]>([]);
  const [currentTest, setCurrentTest] = useState<TestSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isQuotaExceeded, setIsQuotaExceeded] = useState<boolean>(false);
  const [incompleteSessions, setIncompleteSessions] = useState<Record<string, TestSession>>({});
  const [allUploadedDocuments, setAllUploadedDocuments] = useState<UploadedDocument[]>([]);
  const [sessionToDiscard, setSessionToDiscard] = useState<string | null>(null);
  const [isViewingHistoricalSession, setIsViewingHistoricalSession] = useState(false);

  // --- Optional cross-device sync (Google sign-in) ---
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'signing-in' | 'syncing' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  // True while the initial post-sign-in download/merge is in flight, so the auto-upload effects
  // don't race it by uploading stale local data before the merge has happened.
  const isMergingRef = useRef(false);
  // Tracks which document ids are currently believed to be correctly reflected in the cloud,
  // so the diffing effect below only uploads genuinely new documents, not everything every time.
  const syncedDocIdsRef = useRef<Set<string>>(new Set());
  // Tracks the full set of local document ids as of the last diff, so a document disappearing
  // from this set (the trash button) can be detected and mirrored as a cloud deletion.
  const prevDocIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    return onAuthStateChanged((user) => {
      setCurrentUser(user);
    });
  }, []);

  // When someone signs in, reconcile local data with whatever's already in the cloud for that
  // account (if anything), rather than just blindly overwriting one with the other.
  useEffect(() => {
    if (!currentUser) return;

    let cancelled = false;
    (async () => {
      isMergingRef.current = true;
      setSyncStatus('syncing');
      try {
        const [cloudData, cloudDocuments] = await Promise.all([
          downloadSyncData(),
          downloadSyncedDocuments().catch((e) => {
            console.warn('Failed to download synced documents (continuing without them):', e);
            return [] as UploadedDocument[];
          }),
        ]);
        if (cancelled) return;

        const localData = { sessions, incompleteSessions };
        const cloudDocIds = new Set(cloudDocuments.map(d => d.id));
        const localOnlyDocuments = allUploadedDocuments.filter(d => d.status === 'ready' && !cloudDocIds.has(d.id));
        const mergedDocuments = mergeDocuments(allUploadedDocuments, cloudDocuments);

        let sessionMessage: string;
        if (cloudData === null) {
          // First time this account has ever synced — upload local data as-is.
          await uploadSyncData(localData);
          sessionMessage = sessions.length > 0 ? `Backed up ${sessions.length} session(s)` : '';
        } else {
          const merged = mergeSyncPayloads(localData, cloudData);
          const newlyAdded = merged.sessions.length - sessions.length;
          setSessions(merged.sessions);
          setIncompleteSessions(merged.incompleteSessions);
          await uploadSyncData(merged); // keep the cloud consistent with the merged result
          sessionMessage = newlyAdded > 0 ? `Synced ${newlyAdded} session(s) from your other device(s)` : '';
        }

        setAllUploadedDocuments(mergedDocuments);
        // Push up any documents that existed locally but weren't in the cloud yet.
        await Promise.all(localOnlyDocuments.map(d => uploadDocumentToSync(d).catch((e) => {
          console.warn(`Failed to sync document "${d.fileName}" during initial merge:`, e);
        })));

        // Everything now reflected in mergedDocuments is considered in sync from here on —
        // the diffing effect below only needs to react to changes from this point forward.
        syncedDocIdsRef.current = new Set(mergedDocuments.map(d => d.id));
        prevDocIdsRef.current = new Set(mergedDocuments.map(d => d.id));

        const docMessage = cloudDocuments.length > 0 ? `${cloudDocuments.length} document(s) from your other device(s)` : '';
        const parts = [sessionMessage, docMessage].filter(Boolean);
        setSyncMessage(parts.length > 0 ? `Synced: ${parts.join(', ')}.` : 'Synced — all caught up.');
        setSyncStatus('idle');
      } catch (e: any) {
        console.error('Initial sync failed:', e);
        if (!cancelled) {
          setSyncStatus('error');
          setSyncMessage(`Sync failed: ${e.message || 'unknown error'}`);
        }
      } finally {
        isMergingRef.current = false;
      }
    })();

    return () => { cancelled = true; };
    // Intentionally only re-runs when the signed-in user changes, not on every session/document
    // change (the separate effects below handle ongoing syncing after this initial merge).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  // After the initial merge, keep the cloud up to date as sessions change locally.
  useEffect(() => {
    if (!currentUser || isMergingRef.current) return;
    uploadSyncData({ sessions, incompleteSessions }).catch((e) => {
      console.warn('Background sync upload failed (will retry on next change):', e);
    });
  }, [currentUser, sessions, incompleteSessions]);

  // Documents sync individually (not as one big blob, since extracted text can be large) — this
  // diffs the current local document list against what we last knew, uploading anything new and
  // ready, and mirroring any local deletion to the cloud.
  useEffect(() => {
    if (!currentUser || isMergingRef.current) return;

    const allCurrentIds = new Set(allUploadedDocuments.map(d => d.id));
    const toUpload = allUploadedDocuments.filter(d => d.status === 'ready' && !syncedDocIdsRef.current.has(d.id));
    const toDelete: string[] = [...prevDocIdsRef.current].filter((id: string) => !allCurrentIds.has(id) && syncedDocIdsRef.current.has(id));

    toUpload.forEach((doc) => {
      uploadDocumentToSync(doc)
        .then(() => syncedDocIdsRef.current.add(doc.id))
        .catch((e) => console.warn(`Failed to sync document "${doc.fileName}":`, e));
    });
    toDelete.forEach((id) => {
      deleteDocumentFromSync(id)
        .then(() => syncedDocIdsRef.current.delete(id))
        .catch((e) => console.warn(`Failed to remove synced document ${id}:`, e));
    });

    prevDocIdsRef.current = allCurrentIds;
  }, [currentUser, allUploadedDocuments]);

  const handleSignIn = async () => {
    setSyncStatus('signing-in');
    setSyncMessage(null);
    try {
      await signInWithGoogle();
      // onAuthStateChanged + the merge effect above take it from here.
    } catch (e: any) {
      console.error('Sign-in failed:', e);
      setSyncStatus('error');
      setSyncMessage(`Sign-in failed: ${e.message || 'unknown error'}`);
    }
  };

  const handleSignOut = async () => {
    await signOutUser();
    setSyncMessage(null);
    setSyncStatus('idle');
    // Local data is left exactly as-is — signing out never deletes anything on this device.
  };

  useEffect(() => {
    try {
      const savedSessionsJSON = localStorage.getItem('completedTestSessions');
      if (savedSessionsJSON) setSessions(JSON.parse(savedSessionsJSON));

      const savedIncompleteJSON = localStorage.getItem('incompleteTestSessions');
      if (savedIncompleteJSON) setIncompleteSessions(JSON.parse(savedIncompleteJSON));
        
      const savedDocumentsJSON = localStorage.getItem('userUploadedDocuments');
      if (savedDocumentsJSON) setAllUploadedDocuments(JSON.parse(savedDocumentsJSON));

    } catch (e) {
      console.error("Failed to load sessions from localStorage", e);
    }
  }, []);

  useEffect(() => {
    try {
        localStorage.setItem('completedTestSessions', JSON.stringify(sessions));
    } catch (e) {
        console.error("Failed to save sessions to localStorage", e);
    }
  }, [sessions]);

  useEffect(() => {
      try {
          localStorage.setItem('incompleteTestSessions', JSON.stringify(incompleteSessions));
      } catch (e) {
          console.error("Failed to save incomplete sessions to localStorage", e);
      }
  }, [incompleteSessions]);
  
  useEffect(() => {
      try {
          localStorage.setItem('userUploadedDocuments', JSON.stringify(allUploadedDocuments));
      } catch (e) {
          console.error("Failed to save documents to localStorage", e);
      }
  }, [allUploadedDocuments]);


  // --- Core Logic ---

  const startTest = useCallback(async (
    count: number,
    difficulty: Difficulty,
    subspecialty: Subspecialty,
    mode: TestMode,
    preloadedQuestions: Question[] | null = null,
    sourceOptions: SourceOptions = { sourceMode: 'textbooks', documents: [] }
  ) => {
    setError(null);
    
    if (preloadedQuestions) {
        const newSession: TestSession = {
            id: `session-${Date.now()}`,
            date: Date.now(),
            mode,
            questions: preloadedQuestions,
            userAnswers: preloadedQuestions.map(q => ({
                questionId: q.id,
                selectedOptionIndex: null,
                isCorrect: null,
                attempts: [],
                marked: false,
            })),
            score: 0,
            currentQuestionIndex: 0,
            questionCount: preloadedQuestions.length,
            difficulty: Difficulty.Mixed,
            subspecialty: Subspecialty.Mixed,
            status: 'ready',
        };
        setCurrentTest(newSession);
        setView('test');
        return;
    }

    const sessionSource = sourceOptions.sourceMode === 'both' ? 'Mixed' :
                          sourceOptions.sourceMode === 'documents' ? 'Documents' :
                          sourceOptions.sourceMode === 'bank' ? 'Question Bank' : 'Textbooks';

    const generatingSession: TestSession = {
        id: `session-${Date.now()}`,
        date: Date.now(),
        mode,
        questions: [],
        userAnswers: [],
        score: 0,
        currentQuestionIndex: 0,
        questionCount: count,
        difficulty,
        subspecialty,
        status: 'generating',
        source: sessionSource,
    };
    
    setCurrentTest(generatingSession);
    setView('test');

    try {
        let questions: Question[];

        if (sourceOptions.sourceMode === 'bank') {
            // Pulled straight from the curated bank — no Claude call, no token cost.
            const bankResult = await sampleFromQuestionBank(count, difficulty, subspecialty);
            questions = bankResult.questions;
            if (questions.length === 0) {
                throw new Error("No matching questions were found in the Question Bank. Try different filters, or add more questions to the bank from your test results first.");
            }
            if (questions.length < count) {
                console.warn(`Question Bank only had ${questions.length} of the ${count} requested questions matching these filters.`);
            }
        } else {
            const excludeQuestions = getRecentQuestionStems(sessions, incompleteSessions);
            questions = await generateQuestions(count, difficulty, subspecialty, sourceOptions, excludeQuestions);
            if (questions.length === 0) {
                throw new Error("The AI model did not return any questions. Please try different parameters.");
            }
        }
        
        const readySession: TestSession = {
            ...generatingSession,
            status: 'ready',
            questions,
            questionCount: questions.length,
            userAnswers: questions.map(q => ({
                questionId: q.id,
                selectedOptionIndex: null,
                isCorrect: null,
                attempts: [],
                marked: false,
            })),
        };
        setCurrentTest(readySession);

    } catch (e: any) {
        const errMsg = e.message || "An unknown error occurred.";
        setError(errMsg);
        
        const isQuotaError = errMsg.toLowerCase().includes("quota") || 
                             errMsg.toLowerCase().includes("rate limit") || 
                             errMsg.toLowerCase().includes("rate-limited") ||
                             errMsg.toLowerCase().includes("429") || 
                             errMsg.toLowerCase().includes("overloaded") ||
                             errMsg.toLowerCase().includes("high demand") ||
                             errMsg.toLowerCase().includes("credit balance");
        if (isQuotaError) {
            setIsQuotaExceeded(true);
        }
        setView('dashboard');
    }
  }, [sessions, incompleteSessions]);

  const finishTest = (finalSession: TestSession) => {
    let correctCount = 0;
    const gradedAnswers = finalSession.userAnswers.map(ua => {
        const question = finalSession.questions.find(q => q.id === ua.questionId);
        // FIX: Add a guard to prevent a crash if a question is missing for an answer.
        if (!question) {
            console.warn(`Could not find question with ID ${ua.questionId} during grading.`);
            return { ...ua, isCorrect: false }; // Grade as incorrect if question is missing
        }
        
        let finalAnswerIndex: number | null = null;
        if (finalSession.mode === TestMode.Tutor) {
            finalAnswerIndex = ua.firstAttemptIndex ?? null;
        } else { // Study and Test mode are graded on the last answer
            finalAnswerIndex = ua.selectedOptionIndex;
        }
        
        const isCorrect = finalAnswerIndex !== null ? question.options[finalAnswerIndex].isCorrect : false;
        if (isCorrect) correctCount++;
        
        return { ...ua, isCorrect };
    });

    const finalScore = (correctCount / finalSession.questions.length) * 100;
    const completedSession = { ...finalSession, userAnswers: gradedAnswers, score: finalScore };

    setSessions(prev => [...prev, completedSession]);
    setCurrentTest(completedSession);
    setIsViewingHistoricalSession(false);
    setView('results');

    setIncompleteSessions(prev => {
        const newIncomplete = { ...prev };
        delete newIncomplete[completedSession.id];
        return newIncomplete;
    });
  };

  const navigateToDashboard = () => {
    setCurrentTest(null);
    try {
        const savedIncompleteJSON = localStorage.getItem('incompleteTestSessions');
        if (savedIncompleteJSON) {
            setIncompleteSessions(JSON.parse(savedIncompleteJSON));
        } else {
            setIncompleteSessions({});
        }
    } catch (e) {
        console.error("Failed to reload incomplete sessions", e);
    }
    setView('dashboard');
  };
  
  const saveAndExit = () => {
    navigateToDashboard();
  };

  const handleResume = (sessionId: string) => {
    const sessionToResume = incompleteSessions[sessionId];
    if (sessionToResume) {
        setCurrentTest(sessionToResume);
        setView('test');
    }
  };

  const handleDiscard = (sessionId: string) => {
      setSessionToDiscard(sessionId);
  };

  const handleViewSession = (sessionId: string) => {
      const sessionToView = sessions.find(s => s.id === sessionId);
      if (sessionToView) {
          setIsViewingHistoricalSession(true);
          setCurrentTest(sessionToView);
          setView('results');
      }
  };

  const confirmDiscard = () => {
      if (!sessionToDiscard) return;
      setIncompleteSessions(prev => {
          const newIncomplete = { ...prev };
          delete newIncomplete[sessionToDiscard];
          return newIncomplete;
      });
      setSessionToDiscard(null);
  };

  // --- View Rendering ---

  const renderView = () => {
    switch (view) {
      case 'dashboard':
        return <DashboardScreen 
                    sessions={sessions} 
                    onStartNew={() => setView('setup')} 
                    onRepeat={() => setView('repeat')}
                    incompleteSessions={Object.values(incompleteSessions)}
                    onResume={handleResume}
                    onDiscard={handleDiscard}
                    onViewSession={handleViewSession}
                />;
      case 'setup':
        return <SetupScreen 
                    onStartTest={startTest} 
                    onBack={navigateToDashboard}
                    allUploadedDocuments={allUploadedDocuments}
                    setAllUploadedDocuments={setAllUploadedDocuments}
                />;
      case 'repeat':
        return <RepeatScreen sessions={sessions} onStartTest={startTest} onBack={navigateToDashboard} />;
      case 'test':
        return currentTest && <TestScreen session={currentTest} onFinishTest={finishTest} onSaveProgress={setIncompleteSessions} />;
      case 'results':
        return currentTest && <ResultsScreen session={currentTest} onDashboard={navigateToDashboard} onRepeat={() => setView('repeat')} isReviewingPastSession={isViewingHistoricalSession} />;
      default:
        return <DashboardScreen 
                    sessions={sessions} 
                    onStartNew={() => setView('setup')} 
                    onRepeat={() => setView('repeat')}
                    incompleteSessions={Object.values(incompleteSessions)}
                    onResume={handleResume}
                    onDiscard={handleDiscard}
                    onViewSession={handleViewSession}
                />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 font-sans">
      <header className="bg-primary text-white shadow-md">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <SparklesIcon className="w-8 h-8"/>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Oto Boards Prep AI</h1>
          </div>
          <div className="flex items-center gap-3">
            {isSyncConfigured && (
              currentUser ? (
                <div className="flex items-center gap-2 text-sm">
                  {currentUser.photoURL ? (
                    <img src={currentUser.photoURL} alt="" className="w-6 h-6 rounded-full" referrerPolicy="no-referrer" />
                  ) : (
                    <UserCircleIcon className="w-6 h-6" />
                  )}
                  <span className="hidden sm:inline max-w-[140px] truncate">{currentUser.displayName || currentUser.email}</span>
                  <button onClick={handleSignOut} className="text-xs font-semibold underline hover:text-white/80">Sign out</button>
                </div>
              ) : (
                <button
                  onClick={handleSignIn}
                  disabled={syncStatus === 'signing-in'}
                  className="flex items-center gap-2 text-sm font-semibold bg-white/10 hover:bg-white/20 px-3 py-2 rounded-md transition-colors disabled:opacity-50"
                  title="Sign in to sync your sessions across devices"
                >
                  <UserCircleIcon className="w-5 h-5" />
                  <span>{syncStatus === 'signing-in' ? 'Signing in…' : 'Sign in to sync'}</span>
                </button>
              )
            )}
            {view !== 'dashboard' && (
              <button
                onClick={view === 'test' ? saveAndExit : navigateToDashboard}
                className="flex items-center space-x-2 text-sm font-semibold hover:bg-white/20 px-3 py-2 rounded-md transition-colors"
              >
                <ChartBarIcon className="w-5 h-5" />
                <span>{view === 'test' ? 'Save & Exit' : 'Dashboard'}</span>
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="container mx-auto p-4 sm:p-6 lg:p-8">
        {syncMessage && (
          <div className={`mb-6 p-3 rounded-lg text-sm flex items-center justify-between gap-3 ${syncStatus === 'error' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>
            <span>{syncMessage}</span>
            <button onClick={() => setSyncMessage(null)} className="text-current opacity-60 hover:opacity-100 font-bold px-1">&times;</button>
          </div>
        )}
        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 text-red-800 p-5 rounded-xl mb-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4" role="alert">
            <div className="space-y-1 max-w-3xl">
              <p className="font-bold text-red-900">System Information Alert</p>
              <p className="text-sm leading-relaxed">{error}</p>
            </div>
            {(error.toLowerCase().includes("quota") || 
              error.toLowerCase().includes("rate limit") || 
              error.toLowerCase().includes("rate-limited") || 
              error.toLowerCase().includes("429") || 
              error.toLowerCase().includes("overloaded") ||
              error.toLowerCase().includes("high demand") ||
              error.toLowerCase().includes("credit balance") ||
              isQuotaExceeded) && (
              <button
                onClick={() => {
                  setError(null);
                  const count = 10;
                  const preloaded = getFilteredCuratedQuestions(count, Difficulty.Mixed, Subspecialty.Mixed);
                  startTest(count, Difficulty.Mixed, Subspecialty.Mixed, TestMode.Study, preloaded);
                }}
                className="shrink-0 bg-red-600 hover:bg-red-700 hover:scale-[1.02] active:scale-[0.98] text-white font-bold py-2.5 px-5 rounded-lg text-sm shadow-md transition-all duration-200 flex items-center justify-center gap-2"
              >
                <SparklesIcon className="w-5 h-5 animate-pulse" />
                <span>Play Curated Offline Session</span>
              </button>
            )}
          </div>
        )}
        {renderView()}
      </main>
      <ConfirmModal
        isOpen={sessionToDiscard !== null}
        onClose={() => setSessionToDiscard(null)}
        onConfirm={confirmDiscard}
        title="Discard Practice Session?"
        message="Are you sure you want to discard this practice session? Your progress will be permanently lost and this cannot be undone."
        confirmText="Discard Session"
        cancelText="Keep Session"
        type="danger"
      />
    </div>
  );
};


// --- Screen Components ---
// NOTE: Defined outside the main App component to prevent re-renders.

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'danger' | 'warning' | 'info';
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  type = "info"
}) => {
  if (!isOpen) return null;

  const colorClasses = {
    danger: {
      bg: "bg-red-50 text-red-600",
      btn: "bg-red-600 hover:bg-red-700 focus:ring-red-500",
      border: "border-red-200",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      )
    },
    warning: {
      bg: "bg-amber-100 text-amber-600",
      btn: "bg-amber-600 hover:bg-amber-700 focus:ring-amber-500",
      border: "border-amber-200",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      )
    },
    info: {
      bg: "bg-blue-100 text-blue-600",
      btn: "bg-primary hover:bg-accent focus:ring-primary",
      border: "border-blue-200",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    }
  };

  const colors = colorClasses[type] || colorClasses.info;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose} id="confirm-modal-backdrop">
      <Card className="w-full max-w-sm" onClick={e => e.stopPropagation()} id="confirm-modal-card">
        <div className="flex items-start gap-4 mb-5">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${colors.bg}`} id="confirm-modal-icon">
            {colors.icon}
          </div>
          <div className="space-y-1">
            <h3 className="text-lg font-bold text-slate-900" id="confirm-modal-title">{title}</h3>
            <p className="text-sm text-slate-500 whitespace-pre-line" id="confirm-modal-message">{message}</p>
          </div>
        </div>

        <div className="flex justify-end gap-3" id="confirm-modal-actions">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            id="btn-confirm-cancel"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`px-5 py-2 text-white rounded-lg text-sm font-semibold transition-all hover:scale-105 shadow-md ${colors.btn}`}
            id="btn-confirm-proceed"
          >
            {confirmText}
          </button>
        </div>
      </Card>
    </div>
  );
};

interface SubmitConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  unansweredCount: number;
  totalQuestions: number;
}

const SubmitConfirmModal: React.FC<SubmitConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  unansweredCount,
  totalQuestions
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose} id="submit-confirm-backdrop">
      <Card className="w-full max-w-md" onClick={e => e.stopPropagation()} id="submit-confirm-card">
        <div className="flex items-center gap-3 mb-4 text-slate-800">
          <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center text-amber-600 shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-900" id="submit-confirm-title">Submit and Finish Test?</h3>
            <p className="text-sm text-slate-500 mt-1" id="submit-confirm-desc">Are you sure you want to grade your exam now?</p>
          </div>
        </div>

        {unansweredCount > 0 ? (
          <div className="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-sm mb-6" id="submit-unanswered-warning">
            <p className="font-semibold">⚠️ Unanswered Questions Checklist</p>
            <p className="mt-1">
              You have <strong>{unansweredCount}</strong> question{unansweredCount > 1 ? 's' : ''} left unanswered out of {totalQuestions} total questions.
            </p>
          </div>
        ) : (
          <div className="p-3 bg-green-50 border border-green-200 text-green-800 rounded-lg text-sm mb-6" id="submit-all-answered">
            <p className="font-semibold">✓ Completed Checklist</p>
            <p className="mt-1">
              All <strong>{totalQuestions}</strong> questions have been answered. You are fully ready to submit!
            </p>
          </div>
        )}

        <div className="flex justify-end gap-3" id="submit-confirm-actions">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            id="btn-cancel-submit"
          >
            Cancel and Review
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="px-5 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition-all hover:scale-105 shadow-md flex items-center gap-1"
            id="btn-confirm-submit"
          >
            Yes, Submit Test
          </button>
        </div>
      </Card>
    </div>
  );
};

const ReportErrorModal: React.FC<{ question: Question | null; onClose: () => void; }> = ({ question, onClose }) => {
    const [feedback, setFeedback] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [aiResponse, setAiResponse] = useState<string | null>(null);

    useEffect(() => {
        // Reset state when a new question is passed in or when modal is closed
        if (question) {
            setFeedback('');
            setIsLoading(false);
            setError(null);
            setAiResponse(null);
        }
    }, [question]);

    if (!question) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!feedback.trim() || isLoading) return;

        setIsLoading(true);
        setError(null);
        setAiResponse(null);

        try {
            const response = await reportQuestionError(question, feedback);
            setAiResponse(response);
        } catch (e: any) {
            setError(e.message || "An unknown error occurred.");
        } finally {
            setIsLoading(false);
        }
    };
    
    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
            <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold text-primary flex items-center gap-2">
                        <FlagIcon className="w-6 h-6" />
                        Report an Issue
                    </h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-2xl font-bold">&times;</button>
                </div>

                <div className="p-4 bg-slate-100 rounded-lg mb-4 text-sm">
                    <p className="font-semibold text-slate-700">Question:</p>
                    <p className="text-slate-600">{question.question}</p>
                </div>

                {aiResponse ? (
                    <div>
                        <p className="font-semibold mb-2 text-slate-700">Your Feedback:</p>
                        <p className="p-3 bg-blue-50 rounded-lg text-slate-600 text-sm mb-4">{feedback}</p>

                        <p className="font-semibold mb-2 text-primary">AI Review:</p>
                         <div className="p-4 bg-slate-100 rounded-lg space-y-2 text-slate-800 text-sm whitespace-pre-wrap">
                            {aiResponse}
                        </div>
                        <button onClick={onClose} className="mt-6 w-full bg-primary text-white font-bold py-2 px-4 rounded-lg hover:bg-accent transition-colors">
                            Close
                        </button>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit}>
                        <label htmlFor="feedback-textarea" className="block text-sm font-medium text-slate-700 mb-2">
                            Please describe the issue you found. (e.g., typo, factual error, ambiguous choice)
                        </label>
                        <textarea
                            id="feedback-textarea"
                            rows={5}
                            value={feedback}
                            onChange={e => setFeedback(e.target.value)}
                            placeholder="The explanation seems to contradict the latest guidelines regarding..."
                            className="w-full p-2 border-2 border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition"
                            disabled={isLoading}
                        />
                        {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
                        <div className="flex justify-end items-center gap-4 mt-4">
                            <button type="button" onClick={onClose} className="text-sm font-semibold text-slate-600 hover:text-primary">Cancel</button>
                            <button 
                                type="submit" 
                                className="flex items-center justify-center gap-2 bg-primary text-white font-bold py-2 px-4 rounded-lg hover:bg-accent disabled:bg-slate-400"
                                disabled={isLoading || !feedback.trim()}
                            >
                                {isLoading ? (
                                    <>
                                        <div className="w-5 h-5 border-2 border-white/50 border-t-white rounded-full animate-spinner"></div>
                                        Submitting...
                                    </>
                                ) : (
                                    <>
                                        <PaperAirplaneIcon className="w-5 h-5" />
                                        Submit Feedback
                                    </>
                                )}
                            </button>
                        </div>
                    </form>
                )}
            </Card>
        </div>
    );
}

interface FollowUpQueryProps {
  question: Question;
  conversation: FollowUpConversation[];
  onNewFollowUp?: (newEntry: FollowUpConversation) => void;
  isReadOnly?: boolean;
}

const FollowUpQuery: React.FC<FollowUpQueryProps> = ({ question, conversation, onNewFollowUp, isReadOnly = false }) => {
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || isLoading || !onNewFollowUp) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await askFollowUpQuestion(question, query);
      onNewFollowUp({ userQuery: query, aiResponse: response });
      setQuery(''); // Clear input after successful submission
    } catch (e: any) {
      setError(e.message || "An unknown error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mt-6 border-t-2 border-slate-200 pt-6">
      <h4 className="font-bold mb-3 text-primary flex items-center gap-2">
        <SparklesIcon className="w-5 h-5" />
        Learn More
      </h4>
      {conversation.length > 0 && (
        <div className="space-y-4 mb-4">
          {conversation.map((chat, index) => (
            <div key={index}>
              <p className="font-semibold text-slate-700">{chat.userQuery}</p>
              <div className="mt-2 p-3 bg-primary/10 rounded-lg text-slate-800 text-sm">
                <p>{chat.aiResponse}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {!isReadOnly && (
        <form onSubmit={handleSubmit} className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask a follow-up question..."
            className="w-full pl-3 pr-12 py-2 border-2 border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition"
            disabled={isLoading}
          />
          <button
            type="submit"
            className="absolute inset-y-0 right-0 flex items-center justify-center w-10 text-slate-500 hover:text-primary disabled:text-slate-300 disabled:cursor-not-allowed"
            disabled={isLoading || !query.trim()}
            aria-label="Submit follow-up question"
          >
            {isLoading ? (
              <div className="w-5 h-5 border-2 border-slate-200 border-t-primary rounded-full animate-spinner"></div>
            ) : (
              <PaperAirplaneIcon className="w-5 h-5" />
            )}
          </button>
        </form>
      )}
      {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
    </div>
  );
};

// A self-contained "Add to Question Bank" control. Used in both the live test feedback view and
// the (live or historical) Results review — each instance tracks its own idle/loading/added state
// since a question can be curated from either screen independently.
const AddToBankButton: React.FC<{ question: Question }> = ({ question }) => {
    const [status, setStatus] = useState<'idle' | 'loading' | 'added' | 'error'>('idle');
    const [alreadyExisted, setAlreadyExisted] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const handleClick = async () => {
        if (status === 'loading' || status === 'added') return;
        setStatus('loading');
        setErrorMsg(null);
        try {
            const result = await addQuestionToBank(question);
            setAlreadyExisted(result.alreadyExisted);
            setStatus('added');
        } catch (e: any) {
            setStatus('error');
            setErrorMsg(e.message || 'Failed to add to the bank.');
        }
    };

    if (status === 'added') {
        return (
            <span className="flex items-center gap-1 text-sm font-semibold text-amber-600" title={alreadyExisted ? "This question was already in the shared Question Bank" : "Added to the shared Question Bank"}>
                <StarIcon className="w-5 h-5" filled />
                {alreadyExisted ? 'Already in Bank' : 'Added to Bank'}
            </span>
        );
    }

    return (
        <div className="flex items-center gap-2">
            <button
                type="button"
                onClick={handleClick}
                disabled={status === 'loading'}
                title="Add this question to the shared Question Bank, so it can be reused in future zero-AI-cost test sessions"
                className="flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-amber-600 transition-colors disabled:opacity-50"
            >
                {status === 'loading' ? (
                    <div className="w-4 h-4 border-2 border-slate-300 border-t-amber-500 rounded-full animate-spinner" />
                ) : (
                    <StarIcon className="w-5 h-5" />
                )}
                Add to Bank
            </button>
            {status === 'error' && <span className="text-xs text-red-600">{errorMsg}</span>}
        </div>
    );
};

interface DashboardScreenProps {
  sessions: TestSession[];
  onStartNew: () => void;
  onRepeat: () => void;
  incompleteSessions: TestSession[];
  onResume: (sessionId: string) => void;
  onDiscard: (sessionId: string) => void;
  onViewSession: (sessionId: string) => void;
}

const DashboardScreen: React.FC<DashboardScreenProps> = ({ sessions, onStartNew, onRepeat, incompleteSessions, onResume, onDiscard, onViewSession }) => {
    // State to track dark mode for chart rendering
    const [isDarkMode, setIsDarkMode] = useState(() =>
      window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false
    );

    // Effect to listen for OS theme changes and update chart colors
    useEffect(() => {
      if (!window.matchMedia) return;
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (e: MediaQueryListEvent) => setIsDarkMode(e.matches);
      
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }, []);

    const chartTextColor = isDarkMode ? '#94a3b8' : '#475569'; // Muted text
    const chartTooltipBg = isDarkMode ? '#1e293b' : '#ffffff'; // Card BG
    const chartTooltipBorder = isDarkMode ? '#334155' : '#cbd5e1'; // Border
    const chartTooltipLabel = isDarkMode ? '#e2e8f0' : '#1e293b'; // Default text

    const performanceData = useMemo(() => {
        if (sessions.length === 0) return [];
        
        const perfBySubspecialty = sessions
            .flatMap(s => s.questions.map((q, i) => ({ ...q, answer: s.userAnswers[i] })))
            .reduce((acc, q) => {
                if (!acc[q.subspecialty]) {
                    acc[q.subspecialty] = { name: q.subspecialty, correct: 0, total: 0 };
                }
                acc[q.subspecialty].total++;
                if (q.answer.isCorrect) {
                    acc[q.subspecialty].correct++;
                }
                return acc;
            }, {} as Record<string, { name: string; correct: number; total: number }>);
            
        return Object.values(perfBySubspecialty).map(item => ({
            ...item,
            percentage: Math.round((item.correct / item.total) * 100),
        }));
    }, [sessions]);

    const totalQuestions = sessions.reduce((sum, s) => sum + s.questions.length, 0);
    const overallCorrect = sessions.reduce((sum, s) => {
        return sum + s.userAnswers.filter(a => a.isCorrect).length;
    }, 0);
    const overallPercentage = totalQuestions > 0 ? Math.round((overallCorrect / totalQuestions) * 100) : 0;

    return (
        <div className="space-y-8">
            {incompleteSessions.length > 0 && (
                <Card>
                    <h2 className="text-xl font-bold text-primary mb-4">Incomplete Sessions</h2>
                    <div className="space-y-4">
                        {incompleteSessions.map(session => (
                            <div key={session.id} className="p-4 bg-slate-100 rounded-lg flex flex-col sm:flex-row justify-between items-center gap-4">
                                <div>
                                    <p className="font-semibold text-slate-700">
                                        {session.questionCount}-Question {session.mode} Test
                                    </p>
                                    <p className="text-sm text-slate-500">
                                        Started on {new Date(session.date).toLocaleDateString()} &bull; Progress: {session.currentQuestionIndex + 1} / {session.questionCount}
                                    </p>
                                </div>
                                <div className="flex shrink-0 gap-4">
                                    <button onClick={() => onDiscard(session.id)} className="font-semibold text-slate-600 hover:text-primary px-4 py-2 rounded-md">
                                        Discard
                                    </button>
                                    <button onClick={() => onResume(session.id)} className="font-bold bg-primary text-white px-6 py-2 rounded-lg hover:bg-accent transition-colors">
                                        Resume
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </Card>
            )}

            <Card className="text-center">
                <h2 className="text-2xl font-bold text-primary mb-4">Welcome to Your Study Dashboard</h2>
                <p className="text-slate-600 mb-6 max-w-2xl mx-auto">
                    Start a new AI-generated practice test or review past questions to hone your knowledge for the Otolaryngology boards.
                </p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                    <button onClick={onStartNew} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-primary text-white font-bold py-3 px-6 rounded-lg hover:bg-accent transition-transform hover:scale-105 shadow-lg">
                        <SparklesIcon className="w-5 h-5" />
                        Start New AI Test
                    </button>
                    <button onClick={onRepeat} disabled={sessions.length === 0} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-slate-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-slate-700 transition-transform hover:scale-105 shadow-lg disabled:bg-slate-300 disabled:cursor-not-allowed disabled:transform-none">
                        <ArrowPathIcon className="w-5 h-5" />
                        Repeat Questions
                    </button>
                </div>
            </Card>

            {sessions.length > 0 ? (
                <Card>
                    <h3 className="text-xl font-bold text-primary mb-2">Overall Performance</h3>
                    <div className="flex items-baseline space-x-2">
                        <p className="text-4xl font-bold">{overallPercentage}%</p>
                        <p className="text-slate-500">({overallCorrect} / {totalQuestions} correct)</p>
                    </div>
                    <div className="mt-6">
                        <h4 className="font-semibold mb-4 text-slate-700">Performance by Subspecialty</h4>
                        <div style={{ width: '100%', height: 300 }}>
                            <ResponsiveContainer>
                                <BarChart data={performanceData} margin={{ top: 5, right: 20, left: -10, bottom: 5 }}>
                                    <XAxis dataKey="name" tick={{ fontSize: 12, fill: chartTextColor }} angle={-25} textAnchor="end" height={60} />
                                    <YAxis unit="%" tick={{ fill: chartTextColor }} />
                                    <Tooltip
                                        contentStyle={{
                                            backgroundColor: chartTooltipBg,
                                            borderColor: chartTooltipBorder,
                                            borderRadius: '0.5rem',
                                        }}
                                        labelStyle={{ color: chartTooltipLabel, fontWeight: 'bold' }}
                                        itemStyle={{ color: chartTextColor }}
                                    />
                                    <Legend wrapperStyle={{ color: chartTextColor, paddingTop: '20px' }}/>
                                    <Bar dataKey="percentage" fill="var(--color-primary)" name="Correct %" />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </Card>
            ) : (
                <Card className="text-center border-2 border-dashed border-slate-300">
                  <ChartBarIcon className="w-12 h-12 mx-auto text-slate-400 mb-4"/>
                  <h3 className="text-lg font-semibold text-slate-700">No Data Yet</h3>
                  <p className="text-slate-500 mt-2">Complete your first test session to see your performance analytics here.</p>
                </Card>
            )}

            {sessions.length > 0 && (
                <Card>
                    <h3 className="text-xl font-bold text-primary mb-4">Past Sessions</h3>
                    <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
                        {[...sessions].sort((a, b) => b.date - a.date).map(session => (
                            <button
                                key={session.id}
                                onClick={() => onViewSession(session.id)}
                                className="w-full p-4 bg-slate-100 hover:bg-blue-50 hover:border-primary rounded-lg flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 text-left transition-colors border-2 border-transparent"
                            >
                                <div>
                                    <p className="font-semibold text-slate-700">
                                        {session.questionCount}-Question {session.mode} Test
                                        {session.source && <span className="text-slate-400 font-normal"> &bull; {session.source}</span>}
                                    </p>
                                    <p className="text-sm text-slate-500">
                                        {new Date(session.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                        {session.id.startsWith('session-') && session.questions.some(q => q.id.startsWith('fallback-')) && ' \u00b7 Offline'}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <span className={`text-lg font-bold ${session.score >= 70 ? 'text-green-600' : session.score >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                                        {session.score.toFixed(0)}%
                                    </span>
                                    <span className="text-sm text-slate-400">
                                        ({session.userAnswers.filter(a => a.isCorrect).length}/{session.questions.length})
                                    </span>
                                </div>
                            </button>
                        ))}
                    </div>
                </Card>
            )}
        </div>
    );
};

interface SetupScreenProps {
  onStartTest: (count: number, difficulty: Difficulty, subspecialty: Subspecialty, mode: TestMode, preloadedQuestions: null, sourceOptions: SourceOptions) => void;
  onBack: () => void;
  allUploadedDocuments: UploadedDocument[];
  setAllUploadedDocuments: React.Dispatch<React.SetStateAction<UploadedDocument[]>>;
}
const MAX_FILE_SIZE_BYTES = 32 * 1024 * 1024; // 32MB — comfortably under Claude's request payload limit

function prettifyFileName(fileName: string): string {
    const nameWithoutExt = fileName.replace(/\.[^/.]+$/, "");
    return nameWithoutExt
        .replace(/[_-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, word => word.toUpperCase()) || "Untitled Document";
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SetupScreen: React.FC<SetupScreenProps> = ({ onStartTest, onBack, allUploadedDocuments, setAllUploadedDocuments }) => {
    const [count, setCount] = useState(10);
    const [difficulty, setDifficulty] = useState<Difficulty>(Difficulty.Mixed);
    const [subspecialty, setSubspecialty] = useState<Subspecialty>(Subspecialty.Mixed);
    const [mode, setMode] = useState<TestMode>(TestMode.Study);
    
    // Document source states
    const [includeTextbooks, setIncludeTextbooks] = useState(true);
    const [useDocuments, setUseDocuments] = useState(false);
    const [useBankOnly, setUseBankOnly] = useState(false);
    const [bankCount, setBankCount] = useState<number | null>(null);
    const [bankCountError, setBankCountError] = useState<string | null>(null);
    const [documentScope, setDocumentScope] = useState<'all' | 'selected'>('all');
    const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
    const [processingDocs, setProcessingDocs] = useState<UploadedDocument[]>([]);
    const [fileToDelete, setFileToDelete] = useState<string | null>(null);
    const [expandedPreviewIds, setExpandedPreviewIds] = useState<Set<string>>(new Set());
    const [isDragActive, setIsDragActive] = useState(false);

    useEffect(() => {
        getQuestionBankCount()
            .then(setBankCount)
            .catch((e: any) => setBankCountError(e.message || "Couldn't reach the Question Bank."));
    }, []);

    // Keeps the original File objects around (outside of serializable state) so a failed
    // upload can be retried without asking the user to re-select the file from disk.
    const fileRefMap = useRef<Map<string, File>>(new Map());

    const getBase64 = (file: File): Promise<string> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => {
                const resStr = reader.result as string;
                const base64 = resStr.includes(",") ? resStr.split(",")[1] : resStr;
                resolve(base64);
            };
            reader.onerror = error => reject(error);
        });
    };

    // Runs the full pipeline for a single document: extract text (native PDF understanding,
    // deterministic .docx parsing, or a direct text-file read), then ask Claude for a clean
    // title. Used for both the initial upload and a manual retry.
    const processDocument = useCallback(async (docId: string, fileName: string) => {
        const file = fileRefMap.current.get(docId);
        if (!file) {
            setProcessingDocs(prev => prev.map(d => d.id === docId ? { ...d, status: 'error' as const, error: "The original file is no longer available. Please re-upload it." } : d));
            return;
        }

        const setPhase = (aiName: string) => setProcessingDocs(prev => prev.map(d => d.id === docId ? { ...d, aiName, status: 'parsing' as const, error: undefined } : d));

        try {
            const isTextFile = /\.(txt|md|csv|json)$/i.test(fileName) || file.type.startsWith('text/');
            const isPdf = /\.pdf$/i.test(fileName) || file.type === 'application/pdf';
            let text = "";

            if (isTextFile) {
                setPhase('Reading text file…');
                text = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsText(file);
                });
            } else {
                setPhase(isPdf ? 'Reading PDF (Claude reads the full layout in one pass)…' : 'Extracting Word document text…');
                const base64Data = await getBase64(file);
                let mimeType = file.type;
                if (!mimeType) {
                    if (/\.docx$/i.test(fileName)) mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                    else if (/\.doc$/i.test(fileName)) mimeType = 'application/msword';
                    else if (isPdf) mimeType = 'application/pdf';
                    else mimeType = 'application/octet-stream';
                }
                const result = await extractDocument(base64Data, mimeType, fileName);
                text = result.text;
            }

            if (!text || text.trim().length === 0) {
                throw new Error("No readable text could be found in this document.");
            }

            // Give the document a clean, descriptive title. If the naming call fails for any
            // reason, fall back to a prettified version of the filename rather than failing
            // the whole upload over a cosmetic step.
            setPhase('Naming document…');
            let aiName = prettifyFileName(fileName);
            try {
                const suggestedTitle = await nameDocument(text);
                if (suggestedTitle && suggestedTitle.trim()) aiName = suggestedTitle.trim();
            } catch (namingError) {
                console.warn('AI document naming failed; using filename instead.', namingError);
            }

            const finalDoc: UploadedDocument = { id: docId, fileName, aiName, text, status: 'ready' };
            setAllUploadedDocuments(prev => [...prev, finalDoc]);
            setProcessingDocs(prev => prev.filter(d => d.id !== docId));
        } catch (error: any) {
            console.error('Failed to process file:', fileName, error);
            setProcessingDocs(prev => prev.map(d => d.id === docId ? { ...d, status: 'error' as const, error: error.message || 'Failed to process file.' } : d));
        }
    }, [setAllUploadedDocuments]);

    const handleFiles = (files: FileList | File[]) => {
        const fileArray = Array.from(files);
        if (fileArray.length === 0) return;

        const newDocs: UploadedDocument[] = fileArray.map(file => {
            const id = `doc-${Date.now()}-${Math.random()}`;
            fileRefMap.current.set(id, file);

            if (file.size > MAX_FILE_SIZE_BYTES) {
                return {
                    id,
                    fileName: file.name,
                    aiName: prettifyFileName(file.name),
                    text: '',
                    status: 'error' as const,
                    error: `This file is ${formatBytes(file.size)}, which is over the ${formatBytes(MAX_FILE_SIZE_BYTES)} limit. Try splitting it into smaller files.`,
                };
            }
            return { id, fileName: file.name, aiName: 'Waiting to process…', text: '', status: 'parsing' as const };
        });

        setProcessingDocs(prev => [...prev, ...newDocs]);
        if (!useDocuments) setUseDocuments(true);

        newDocs.forEach(doc => {
            if (doc.status === 'parsing') processDocument(doc.id, doc.fileName);
        });
    };

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files) handleFiles(event.target.files);
        event.target.value = ''; // allow re-selecting the same file after a failure
    };

    const handleDrop = (event: React.DragEvent<HTMLLabelElement>) => {
        event.preventDefault();
        setIsDragActive(false);
        if (event.dataTransfer.files) handleFiles(event.dataTransfer.files);
    };

    const handleRetry = (id: string, fileName: string) => {
        processDocument(id, fileName);
    };

    const handleRemoveFile = (id: string) => {
        setFileToDelete(id);
    };

    const confirmRemoveFile = () => {
        if (!fileToDelete) return;
        setAllUploadedDocuments(prev => prev.filter(doc => doc.id !== fileToDelete));
        setProcessingDocs(prev => prev.filter(doc => doc.id !== fileToDelete));
        setSelectedDocIds(prev => {
            const newSet = new Set(prev);
            newSet.delete(fileToDelete);
            return newSet;
        });
        fileRefMap.current.delete(fileToDelete);
        setFileToDelete(null);
    };

    const toggleDocSelection = (id: string) => {
      setSelectedDocIds(prev => {
        const newSet = new Set(prev);
        if (newSet.has(id)) {
          newSet.delete(id);
        } else {
          newSet.add(id);
        }
        return newSet;
      });
    }

    const togglePreview = (id: string) => {
        setExpandedPreviewIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(id)) newSet.delete(id);
            else newSet.add(id);
            return newSet;
        });
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        if (useBankOnly) {
            onStartTest(count, difficulty, subspecialty, mode, null, { sourceMode: 'bank', documents: [] });
            return;
        }
        
        let sourceMode: SourceOptions['sourceMode'];
        let documentsToUse: UploadedDocument[] = [];

        if (includeTextbooks && useDocuments) sourceMode = 'both';
        else if (useDocuments) sourceMode = 'documents';
        else sourceMode = 'textbooks';

        if (useDocuments) {
            if (documentScope === 'all') {
                documentsToUse = allUploadedDocuments;
            } else {
                documentsToUse = allUploadedDocuments.filter(d => selectedDocIds.has(d.id));
            }
        }
        
        onStartTest(count, difficulty, subspecialty, mode, null, { sourceMode, documents: documentsToUse });
    };

    const isStillProcessing = !useBankOnly && processingDocs.some(d => d.status === 'parsing');

    // Tracks how long the current batch of document processing has been running, so a slow
    // (but working) large PDF can show a reassuring "this is normal" note instead of just
    // looking stuck with no sense of elapsed time.
    const [processingSeconds, setProcessingSeconds] = useState(0);
    useEffect(() => {
        if (!isStillProcessing) {
            setProcessingSeconds(0);
            return;
        }
        const interval = setInterval(() => setProcessingSeconds(s => s + 1), 1000);
        return () => clearInterval(interval);
    }, [isStillProcessing]);
    const hasOnlyFailedDocs = !useBankOnly && useDocuments && allUploadedDocuments.length === 0 && processingDocs.length > 0 && processingDocs.every(d => d.status === 'error');

    const isSubmitDisabled = useBankOnly
        ? (bankCount !== null && bankCount === 0)
        : (!includeTextbooks && !useDocuments) || 
          isStillProcessing ||
          (useDocuments && (
              (allUploadedDocuments.length === 0 && !includeTextbooks) ||
              (documentScope === 'selected' && selectedDocIds.size === 0)
          ));

    // A plain-language reason the submit button is disabled, shown right under it so the
    // person doesn't have to guess what's missing.
    const disabledReason = (() => {
        if (!isSubmitDisabled) return null;
        if (useBankOnly) return "The Question Bank is empty right now — add some questions to it from your test results first.";
        if (!includeTextbooks && !useDocuments) return "Select at least one question source (Core Textbooks or your documents) to continue.";
        if (isStillProcessing) return "Hang tight — still processing your uploaded document(s).";
        if (useDocuments && allUploadedDocuments.length === 0 && !includeTextbooks) return "Upload at least one document, or also enable Core Textbooks.";
        if (useDocuments && documentScope === 'selected' && selectedDocIds.size === 0) return "Select at least one document to use, or switch to \"Use All\".";
        return null;
    })();

    return (
        <Card>
            <h2 className="text-2xl font-bold text-primary mb-6">Create a New Test</h2>
            <form onSubmit={handleSubmit} className="space-y-6">
                
                {/* --- Question Source --- */}
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Question Source</label>
                    <div className="space-y-4 p-4 border border-slate-300 rounded-lg">
                        <label className={`flex items-center space-x-3 cursor-pointer ${useBankOnly ? 'opacity-50' : ''}`}>
                            <input type="checkbox" checked={includeTextbooks} disabled={useBankOnly} onChange={() => setIncludeTextbooks(p => !p)} className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary" />
                            <span className="text-sm font-medium text-slate-700">Core Textbooks</span>
                        </label>
                        <label className={`flex items-center space-x-3 cursor-pointer ${useBankOnly ? 'opacity-50' : ''}`}>
                            <input type="checkbox" checked={useDocuments} disabled={useBankOnly} onChange={() => setUseDocuments(p => !p)} className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary" />
                            <span className="text-sm font-medium text-slate-700">My Uploaded Documents</span>
                        </label>
                        <div className="border-t border-slate-200 pt-4">
                            <label className="flex items-center space-x-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={useBankOnly}
                                    onChange={() => setUseBankOnly(p => {
                                        const next = !p;
                                        if (next) { setIncludeTextbooks(false); setUseDocuments(false); }
                                        return next;
                                    })}
                                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                                />
                                <span className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
                                    <CircleStackIcon className="w-4 h-4 text-amber-600" />
                                    Question Bank Only <span className="text-slate-400 font-normal">(curated, zero AI cost)</span>
                                </span>
                            </label>
                            <p className="text-xs text-slate-500 mt-1.5 ml-7">
                                {bankCountError ? (
                                    <span className="text-amber-600">{bankCountError}</span>
                                ) : bankCount === null ? (
                                    'Checking bank size…'
                                ) : (
                                    `${bankCount.toLocaleString()} question${bankCount === 1 ? '' : 's'} currently in the shared bank, curated from past test results.`
                                )}
                            </p>
                        </div>
                    </div>
                </div>

                {/* --- Document Management --- */}
                {!useBankOnly && useDocuments && (
                    <div className="p-4 border border-slate-300 rounded-lg space-y-4">
                        <h3 className="font-semibold text-slate-800">My Study Documents</h3>
                        {hasOnlyFailedDocs && (
                            <div className="bg-red-50 border-l-4 border-red-400 text-red-800 p-3 rounded-md text-sm">
                                None of your uploads could be processed. Check the errors below, then retry or upload a different file.
                            </div>
                        )}
                        {allUploadedDocuments.length > 0 && (
                            <div className="flex space-x-4">
                                <label className="flex items-center space-x-2 cursor-pointer">
                                    <input type="radio" name="doc-scope" value="all" checked={documentScope === 'all'} onChange={() => setDocumentScope('all')} className="h-4 w-4 text-primary focus:ring-primary" />
                                    <span>Use All ({allUploadedDocuments.length})</span>
                                </label>
                                <label className="flex items-center space-x-2 cursor-pointer">
                                    <input type="radio" name="doc-scope" value="selected" checked={documentScope === 'selected'} onChange={() => setDocumentScope('selected')} className="h-4 w-4 text-primary focus:ring-primary" />
                                    <span>Select...</span>
                                </label>
                            </div>
                        )}

                        <div className="max-h-80 overflow-y-auto space-y-2 pr-2">
                          {[...allUploadedDocuments, ...processingDocs].map(doc => {
                            const isExpanded = expandedPreviewIds.has(doc.id);
                            const wordCount = doc.text ? doc.text.trim().split(/\s+/).filter(Boolean).length : 0;
                            return (
                              <div key={doc.id} className="p-3 bg-slate-100 rounded-lg space-y-2">
                                <div className="flex items-center justify-between gap-4">
                                    <div className="flex items-center gap-3 overflow-hidden">
                                        {documentScope === 'selected' && doc.status === 'ready' && <input type="checkbox" checked={selectedDocIds.has(doc.id)} onChange={() => toggleDocSelection(doc.id)} className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary flex-shrink-0" />}
                                        {doc.status === 'parsing' && <div className="w-5 h-5 border-2 border-slate-300 border-t-primary rounded-full animate-spinner flex-shrink-0" />}
                                        {doc.status === 'ready' && <CheckCircleIcon className="w-5 h-5 text-green-600 flex-shrink-0" />}
                                        {doc.status === 'error' && <XCircleIcon className="w-5 h-5 text-red-500 flex-shrink-0" />}
                                        <div className="overflow-hidden">
                                            <p className={`text-sm font-semibold truncate ${doc.status === 'ready' ? 'text-slate-700' : 'text-slate-500'}`}>{doc.aiName}</p>
                                            <p className="text-xs text-slate-500 truncate">
                                                {doc.fileName}
                                                {doc.status === 'ready' && <span> · {wordCount.toLocaleString()} words</span>}
                                            </p>
                                            {doc.status === 'error' && <p className="text-xs text-red-600 mt-0.5">{doc.error}</p>}
                                            {doc.status === 'parsing' && processingSeconds > 20 && (
                                                <p className="text-xs text-slate-400 mt-0.5">
                                                    {processingSeconds > 90
                                                        ? `Still working (${processingSeconds}s) — large or scanned multi-page PDFs are processed in stages and can take several minutes. Not stuck.`
                                                        : `Still working (${processingSeconds}s) — larger PDFs and scanned documents take longer. Not stuck.`}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        {doc.status === 'ready' && (
                                            <button type="button" onClick={() => togglePreview(doc.id)} className="text-xs font-semibold text-primary hover:underline px-1">
                                                {isExpanded ? 'Hide text' : 'Preview text'}
                                            </button>
                                        )}
                                        {doc.status === 'error' && (
                                            <button type="button" onClick={() => handleRetry(doc.id, doc.fileName)} title="Retry" className="p-1 text-slate-500 hover:text-primary rounded-full">
                                                <ArrowPathIcon className="w-5 h-5" />
                                            </button>
                                        )}
                                        <button type="button" onClick={() => handleRemoveFile(doc.id)} title="Remove" className="p-1 text-slate-500 hover:text-red-600 rounded-full">
                                            <TrashIcon className="w-5 h-5" />
                                        </button>
                                    </div>
                                </div>
                                {isExpanded && doc.status === 'ready' && (
                                    <div className="bg-white border border-slate-200 rounded-md p-3 text-xs text-slate-600 max-h-48 overflow-y-auto whitespace-pre-wrap">
                                        {doc.text.length > 4000 ? `${doc.text.slice(0, 4000)}\n\n… (${(doc.text.length - 4000).toLocaleString()} more characters not shown)` : doc.text}
                                    </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        
                        <label
                            htmlFor="file-upload"
                            onDragOver={(e) => { e.preventDefault(); setIsDragActive(true); }}
                            onDragLeave={() => setIsDragActive(false)}
                            onDrop={handleDrop}
                            className={`relative cursor-pointer bg-white border-2 border-dashed rounded-lg p-6 flex flex-col items-center justify-center text-center transition-colors ${isDragActive ? 'border-primary bg-blue-50' : 'border-slate-300 hover:border-primary'}`}
                        >
                            <DocumentArrowUpIcon className="w-10 h-10 mx-auto text-slate-400 mb-2"/>
                            <span className="font-semibold text-primary">{isDragActive ? 'Drop to upload' : 'Upload New Document(s)'}</span>
                            <span className="text-xs text-slate-500 mt-1">Drag & drop or click. Supports PDF, Word (.docx), and plain text (.txt, .md). Up to {formatBytes(MAX_FILE_SIZE_BYTES)} each.</span>
                            <input id="file-upload" name="file-upload" type="file" accept=".pdf,.docx,.txt,.md" className="sr-only" onChange={handleFileChange} multiple />
                        </label>
                    </div>
                )}


                {/* Number of Questions */}
                <div>
                    <label htmlFor="question-count" className="block text-sm font-medium text-slate-700">Number of Questions: <span className="font-bold text-primary">{count}</span></label>
                    <input id="question-count" type="range" min="5" max="50" step="5" value={count} onChange={(e) => setCount(Number(e.target.value))} className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary"/>
                </div>

                {/* Test Mode */}
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Test Mode</label>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {ALL_TEST_MODES.map(m => (
                            <button type="button" key={m} onClick={() => setMode(m)} className={`p-3 border-2 rounded-lg text-left transition-all ${mode === m ? 'border-primary bg-blue-50 ring-2 ring-primary' : 'border-slate-300 hover:border-primary'}`}>
                                <p className="font-semibold">{m}</p>
                            </button>
                        ))}
                    </div>
                    <p className="mt-3 text-sm text-slate-500 bg-slate-100 p-3 rounded-md">{MODE_DESCRIPTIONS[mode]}</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Difficulty */}
                  <div>
                      <label htmlFor="difficulty" className="block text-sm font-medium text-slate-700">Difficulty</label>
                      <select id="difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)} className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-slate-300 focus:outline-none focus:ring-primary focus:border-primary sm:text-sm rounded-md">
                          {ALL_DIFFICULTIES.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                  </div>

                  {/* Subspecialty */}
                  <div>
                      <label htmlFor="subspecialty" className="block text-sm font-medium text-slate-700">Subspecialty Focus</label>
                      <select id="subspecialty" value={subspecialty} onChange={(e) => setSubspecialty(e.target.value as Subspecialty)} className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-slate-300 focus:outline-none focus:ring-primary focus:border-primary sm:text-sm rounded-md">
                          {ALL_SUBSPECIALTIES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                  </div>
                </div>

                 <div className="bg-blue-50 border-l-4 border-primary p-4 rounded-md" role="alert">
                    <p className="font-bold text-primary">AI Content Notice</p>
                    <p className="text-sm text-slate-700 mt-1">
                        Questions, explanations, and citations are AI-generated. Please verify critical information against primary source materials.
                    </p>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-3 pt-4">
                    <button type="button" onClick={onBack} className="text-sm font-semibold text-slate-600 hover:text-primary mr-auto">Cancel</button>
                    <button
                        type="button"
                        onClick={() => {
                            const preloaded = getFilteredCuratedQuestions(count, difficulty, subspecialty);
                            onStartTest(count, difficulty, subspecialty, mode, preloaded);
                        }}
                        className="flex items-center justify-center gap-2 bg-slate-600 hover:bg-slate-700 text-white font-semibold py-3 px-5 rounded-lg transition-colors shadow-md text-sm"
                    >
                        <span>Start Curated Test (Offline)</span>
                    </button>
                    <button 
                        type="submit" 
                        className="flex items-center justify-center gap-2 bg-primary text-white font-bold py-3 px-6 rounded-lg hover:bg-accent transition-transform hover:scale-105 shadow-lg disabled:bg-slate-400 disabled:cursor-not-allowed disabled:hover:scale-100"
                        disabled={isSubmitDisabled}
                    >
                        {isStillProcessing ? (
                             <>
                                <div className="w-5 h-5 border-2 border-white/50 border-t-white rounded-full animate-spinner"></div>
                                Processing Docs...
                            </>
                        ) : (
                             <>
                                <SparklesIcon className="w-5 h-5" />
                                Generate Test
                            </>
                        )}
                    </button>
                </div>
                {disabledReason && (
                    <p className="text-right text-sm text-slate-500 -mt-2">{disabledReason}</p>
                )}
            </form>
            <ConfirmModal
                isOpen={fileToDelete !== null}
                onClose={() => setFileToDelete(null)}
                onConfirm={confirmRemoveFile}
                title="Delete Study Source?"
                message="Are you sure you want to permanently delete this document from your study reference repository?"
                confirmText="Delete"
                cancelText="Keep"
                type="danger"
            />
        </Card>
    );
};

const GeneratingTestScreen: React.FC<{ session: TestSession }> = ({ session }) => {
    const messages = useMemo(() => [
        "Consulting leading textbooks for high-yield facts...",
        "Crafting challenging board-style questions...",
        "Ensuring clinical relevance for each question...",
        "Preparing detailed explanations and references...",
        "Good luck with your studies!",
        "Focusing on the latest AAO-HNS guidelines...",
    ], []);
    const [messageIndex, setMessageIndex] = useState(0);
    const [secondsElapsed, setSecondsElapsed] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setMessageIndex(prev => (prev + 1) % messages.length);
        }, 3000); // Change message every 3 seconds
        return () => clearInterval(interval);
    }, [messages.length]);

    useEffect(() => {
        const interval = setInterval(() => setSecondsElapsed(s => s + 1), 1000);
        return () => clearInterval(interval);
    }, []);

    // Larger requests produce proportionally more output, which genuinely takes longer to
    // generate — set a real expectation instead of leaving the person to wonder if it's stuck.
    const expectedSeconds = Math.round(30 + session.questionCount * 4);

    return (
        <div className="max-w-4xl mx-auto">
            <div className="mb-6">
                <p className="text-center text-sm font-semibold text-primary">
                    Preparing Your {session.questionCount}-Question {session.mode} Test
                </p>
                <div className="mt-2 w-full bg-slate-200 rounded-full h-2.5">
                    <div className="bg-primary h-2.5 rounded-full animate-pulse"></div>
                </div>
            </div>

            <Card className="text-center flex flex-col items-center justify-center" style={{ minHeight: '50vh' }}>
                <div className="w-16 h-16 border-4 border-slate-200 border-t-primary rounded-full animate-spinner mb-6"></div>
                <h2 className="text-xl font-bold text-primary mb-4">Generating Your Questions</h2>
                <p className="text-slate-500 animate-pulse transition-opacity duration-500">{messages[messageIndex]}</p>
                <p className="text-xs text-slate-400 mt-4">{secondsElapsed}s elapsed</p>
                {secondsElapsed > 20 && (
                    <p className="text-xs text-slate-400 mt-2 max-w-sm">
                        {session.questionCount > 15
                            ? `Larger sets take longer to write — ${session.questionCount} questions typically takes around ${expectedSeconds}s. This is normal, not stuck.`
                            : "This usually finishes within a minute. Still working — not stuck."}
                    </p>
                )}
            </Card>
        </div>
    );
};


interface TestScreenProps {
  session: TestSession;
  onFinishTest: (session: TestSession) => void;
  onSaveProgress: React.Dispatch<React.SetStateAction<Record<string, TestSession>>>;
}
const TestScreen: React.FC<TestScreenProps> = ({ session, onFinishTest, onSaveProgress }) => {
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(session.currentQuestionIndex || 0);
    const [userAnswers, setUserAnswers] = useState<UserAnswer[]>(session.userAnswers);
    const [showFeedback, setShowFeedback] = useState<boolean>(false);
    const [questionToReport, setQuestionToReport] = useState<Question | null>(null);
    const [showSubmitModal, setShowSubmitModal] = useState<boolean>(false);

    // FIX: Synchronize internal state with prop changes. When the session transitions from
    // 'generating' to 'ready', the props update, but the internal state (useState) doesn't
    // automatically. This effect correctly updates the internal state, preventing a crash
    // from trying to access an empty `userAnswers` array.
    useEffect(() => {
        if (session.status === 'ready') {
            setCurrentQuestionIndex(session.currentQuestionIndex || 0);
            setUserAnswers(session.userAnswers || []);
        }
    }, [session.id, session.status, session.userAnswers, session.currentQuestionIndex]);

    useEffect(() => {
        // Guard against saving an empty/generating session.
        if (session.status !== 'ready' || !userAnswers || userAnswers.length === 0) return;

        const sessionToSave = {
            ...session,
            userAnswers,
            currentQuestionIndex,
        };
        
        onSaveProgress(prev => ({
            ...prev,
            [session.id]: sessionToSave,
        }));

    }, [userAnswers, currentQuestionIndex, session, onSaveProgress]);
    
    if (session.status === 'generating') {
        return <GeneratingTestScreen session={session} />;
    }

    // FIX: Add a guard to prevent rendering before the state synchronization effect has run.
    // This stops the app from crashing by trying to access `userAnswers[0]` when `userAnswers` is still an empty array.
    if (!userAnswers || userAnswers.length === 0 || userAnswers.length !== session.questions.length) {
      return (
        <div className="max-w-4xl mx-auto">
          <Card className="text-center flex flex-col items-center justify-center" style={{ minHeight: '50vh' }}>
              <div className="w-16 h-16 border-4 border-slate-200 border-t-primary rounded-full animate-spinner mb-6"></div>
              <h2 className="text-xl font-bold text-primary">Preparing Test...</h2>
          </Card>
        </div>
      );
    }

    const question = session.questions[currentQuestionIndex];
    const userAnswer = userAnswers[currentQuestionIndex];

    const handleSelectOption = (optionIndex: number) => {
        const isTutorModeLocked = session.mode === TestMode.Tutor && userAnswer.firstAttemptIndex !== undefined;
        if (isTutorModeLocked) return;
        
        const newAnswers = userAnswers.map((answer, index) => {
            if (index === currentQuestionIndex) {
                return {
                    ...answer,
                    selectedOptionIndex: optionIndex,
                    attempts: [...answer.attempts, optionIndex],
                    firstAttemptIndex: answer.firstAttemptIndex === undefined ? optionIndex : answer.firstAttemptIndex,
                };
            }
            return answer;
        });

        setUserAnswers(newAnswers);

        if (session.mode === TestMode.Study || session.mode === TestMode.Tutor) {
            setShowFeedback(true);
        }
    };

    const handleMarkQuestion = () => {
        const newAnswers = userAnswers.map((answer, index) => {
            if (index === currentQuestionIndex) {
                return { ...answer, marked: !answer.marked };
            }
            return answer;
        });
        setUserAnswers(newAnswers);
    };

    const goToQuestion = (index: number) => {
      if (index >= 0 && index < session.questions.length) {
        setCurrentQuestionIndex(index);
        setShowFeedback(false);
      }
    };
    
    const handleSubmit = () => {
        setShowSubmitModal(true);
    };

    const handleConfirmSubmit = () => {
        onFinishTest({ ...session, userAnswers, currentQuestionIndex });
    };

    const handleNewFollowUp = (newEntry: FollowUpConversation) => {
      const newAnswers = userAnswers.map((answer, index) => {
        if (index === currentQuestionIndex) {
          const existingConversation = answer.followUpConversation || [];
          return {
            ...answer,
            followUpConversation: [...existingConversation, newEntry],
          };
        }
        return answer;
      });
      setUserAnswers(newAnswers);
    };

    const getOptionClass = (optionIndex: number) => {
        const baseClass = "w-full text-left p-4 border-2 rounded-lg transition-all flex items-start space-x-4 cursor-pointer";
        const isSelected = userAnswer.selectedOptionIndex === optionIndex;

        if (showFeedback && isSelected) {
            return question.options[optionIndex].isCorrect
                ? `${baseClass} bg-green-50 border-green-500 ring-2 ring-green-500`
                : `${baseClass} bg-red-50 border-red-500 ring-2 ring-red-500`;
        }
        if (showFeedback && question.options[optionIndex].isCorrect) {
          return `${baseClass} bg-green-50 border-green-500`;
        }

        if (isSelected) {
            return `${baseClass} border-primary bg-blue-50 ring-2 ring-primary`;
        }
        
        return `${baseClass} border-slate-300 hover:border-primary hover:bg-blue-50`;
    };

    const isOfflineFallback = session.questions.some(q => q.id && q.id.startsWith("fallback-"));

    return (
        <div className="max-w-4xl mx-auto">
            {/* Progress Bar and Header */}
            <div className="mb-6">
                {isOfflineFallback && (
                    <div className="mb-4 bg-slate-50 border-l-4 border-slate-400 text-slate-800 p-3 rounded-lg shadow-sm text-xs flex items-center gap-2">
                        <SparklesIcon className="w-4 h-4 text-slate-500 shrink-0" />
                        <span><strong>Note:</strong> We are currently serving top Otolaryngology board questions from our preloaded high-yield offline repository to ensure your study session continues uninterrupted.</span>
                    </div>
                )}
                <div className="flex justify-between items-center mb-2">
                    <p className="text-sm font-semibold text-primary">{session.mode} Mode</p>
                    <p className="text-sm font-semibold text-slate-600">Question {currentQuestionIndex + 1} of {session.questions.length}</p>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-2.5">
                    <div className="bg-primary h-2.5 rounded-full" style={{ width: `${((currentQuestionIndex + 1) / session.questions.length) * 100}%` }}></div>
                </div>
            </div>

            {/* Question Card */}
            <Card>
                <div className="flex justify-between items-start mb-4">
                    <div>
                        <span className="inline-block bg-primary/10 text-primary text-xs font-semibold mr-2 px-2.5 py-0.5 rounded-full">{question.subspecialty}</span>
                        <span className="inline-block bg-slate-200 text-slate-600 text-xs font-semibold px-2.5 py-0.5 rounded-full">{question.difficulty}</span>
                    </div>
                     <div className="flex items-center gap-4">
                        <button onClick={() => setQuestionToReport(question)} title="Report an issue with this question">
                            <FlagIcon className="w-6 h-6 text-slate-400 hover:text-red-500 transition-colors" />
                        </button>
                        <button onClick={handleMarkQuestion} title={userAnswer.marked ? "Unmark question" : "Mark question for review"}>
                            <BookmarkIcon className={`w-6 h-6 ${userAnswer.marked ? 'text-yellow-500' : 'text-slate-400 hover:text-yellow-500'}`} filled={userAnswer.marked} />
                        </button>
                    </div>
                </div>

                <p className="text-lg font-medium mb-6 text-slate-800">{question.question}</p>

                <div className="space-y-4">
                    {question.options.map((option, index) => (
                        <button key={index} onClick={() => handleSelectOption(index)} className={getOptionClass(index)} disabled={session.mode === TestMode.Tutor && userAnswer.firstAttemptIndex !== undefined}>
                            <div className="flex-shrink-0 font-bold text-primary mt-1">{String.fromCharCode(65 + index)}</div>
                            <div className="flex-grow text-slate-700">{option.text}</div>
                        </button>
                    ))}
                </div>

                {showFeedback && (
                    <div className="mt-6 p-4 bg-slate-100 rounded-lg">
                        <div className="flex justify-between items-start mb-2">
                            <h4 className="font-bold text-slate-800">Explanation</h4>
                            <AddToBankButton question={question} />
                        </div>
                        <p className="text-slate-700">{question.explanation}</p>
                        {question.references && question.references.length > 0 && (
                            <div className="mt-4 border-t border-slate-300 pt-4">
                                <h5 className="font-semibold text-sm mb-2 text-slate-700">References:</h5>
                                <ul className="space-y-3 text-sm">
                                    {question.references.map((ref, i) => (
                                        <li key={i} className="pl-4 border-l-2 border-primary/50">
                                            {ref.quote && (
                                                <blockquote className="italic text-slate-600 mb-1">"{ref.quote}"</blockquote>
                                            )}
                                            <cite className="block not-italic text-slate-500">
                                                &mdash; {ref.source}
                                                {ref.chapter && `, Ch. ${ref.chapter}`}
                                                {ref.page && `, p. ${ref.page}`}
                                            </cite>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        <FollowUpQuery 
                            question={question} 
                            conversation={userAnswer.followUpConversation || []}
                            onNewFollowUp={handleNewFollowUp}
                        />
                    </div>
                )}
            </Card>

            {/* Navigation */}
            <div className="flex justify-between mt-8">
                <button onClick={() => goToQuestion(currentQuestionIndex - 1)} disabled={currentQuestionIndex === 0} className="font-bold py-2 px-4 rounded-lg bg-white border-2 border-slate-300 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed">
                    Previous
                </button>
                {currentQuestionIndex === session.questions.length - 1 ? (
                    <button onClick={handleSubmit} className="font-bold py-2 px-6 rounded-lg bg-green-600 text-white hover:bg-green-700 transition-transform hover:scale-105 shadow-lg">
                        Submit Test
                    </button>
                ) : (
                    <button onClick={() => goToQuestion(currentQuestionIndex + 1)} className="font-bold py-2 px-4 rounded-lg bg-primary text-white hover:bg-accent">
                        Next
                    </button>
                )}
            </div>
            <ReportErrorModal question={questionToReport} onClose={() => setQuestionToReport(null)} />
            <SubmitConfirmModal 
                isOpen={showSubmitModal} 
                onClose={() => setShowSubmitModal(false)} 
                onConfirm={handleConfirmSubmit} 
                unansweredCount={userAnswers.filter(a => a.selectedOptionIndex === undefined).length} 
                totalQuestions={session.questions.length} 
            />
        </div>
    );
};

interface ResultsScreenProps {
  session: TestSession;
  onDashboard: () => void;
  onRepeat: () => void;
  isReviewingPastSession?: boolean;
}
const ResultsScreen: React.FC<ResultsScreenProps> = ({ session, onDashboard, onRepeat, isReviewingPastSession = false }) => {
    const [questionToReport, setQuestionToReport] = useState<Question | null>(null);

    return (
        <div className="space-y-8">
            <Card>
                <div className="text-center">
                    {isReviewingPastSession ? (
                        <>
                            <h2 className="text-2xl font-bold text-primary mb-2">Past Session</h2>
                            <p className="text-slate-600">{session.questionCount}-Question {session.mode} Test &bull; {new Date(session.date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                        </>
                    ) : (
                        <>
                            <h2 className="text-2xl font-bold text-primary mb-2">Test Complete!</h2>
                            <p className="text-slate-600">Here's how you performed.</p>
                        </>
                    )}
                    <div className="my-6">
                        <p className="text-6xl font-bold text-primary">{session.score.toFixed(0)}%</p>
                        <p className="text-slate-500 mt-1">
                            {session.userAnswers.filter(a => a.isCorrect).length} out of {session.questions.length} correct
                        </p>
                    </div>
                     <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                        <button onClick={onDashboard} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-primary text-white font-bold py-3 px-6 rounded-lg hover:bg-accent transition-transform hover:scale-105 shadow-lg">
                            <ChartBarIcon className="w-5 h-5" />
                            Return to Dashboard
                        </button>
                        <button onClick={onRepeat} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-slate-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-slate-700 transition-transform hover:scale-105 shadow-lg">
                            <ArrowPathIcon className="w-5 h-5" />
                            Repeat Questions
                        </button>
                    </div>
                </div>
            </Card>

            <div>
                <h3 className="text-xl font-bold mb-4 text-slate-800">Question Review</h3>
                <div className="space-y-4">
                    {session.questions.map((q, index) => {
                        const ua = session.userAnswers[index];
                        const selectedOption = ua.selectedOptionIndex !== null ? q.options[ua.selectedOptionIndex] : null;
                        const correctOptionIndex = q.options.findIndex(opt => opt.isCorrect);

                        return (
                            <Card key={q.id}>
                                <div className="flex justify-between items-start mb-2">
                                    <p className="font-bold text-slate-800">Question {index + 1}</p>
                                    <div className="flex items-center gap-4">
                                        {ua.isCorrect ? 
                                          <span className="flex items-center gap-1 text-sm font-semibold text-green-600"><CheckCircleIcon className="w-5 h-5"/> Correct</span> :
                                          <span className="flex items-center gap-1 text-sm font-semibold text-red-600"><XCircleIcon className="w-5 h-5"/> Incorrect</span>
                                        }
                                        <button onClick={() => setQuestionToReport(q)} title="Report an issue with this question">
                                            <FlagIcon className="w-6 h-6 text-slate-400 hover:text-red-500 transition-colors" />
                                        </button>
                                    </div>
                                </div>

                                <p className="mb-4 text-slate-700">{q.question}</p>
                                <div className="space-y-2 text-sm">
                                    {q.options.map((opt, i) => (
                                        <div key={i} className={`p-3 rounded-md flex gap-3 ${i === correctOptionIndex ? 'bg-green-100' : ''} ${i === ua.selectedOptionIndex && !ua.isCorrect ? 'bg-red-100' : ''}`}>
                                            <span className="font-bold text-slate-800">{String.fromCharCode(65 + i)}:</span>
                                            <span className="text-slate-700">{opt.text}</span>
                                        </div>
                                    ))}
                                </div>
                                <div className="mt-4 p-3 bg-slate-100 rounded-lg text-sm">
                                    <div className="flex justify-between items-start mb-1">
                                        <p className="font-bold text-slate-800">Explanation:</p>
                                        <AddToBankButton question={q} />
                                    </div>
                                    <p className="text-slate-700">{q.explanation}</p>
                                    {q.references && q.references.length > 0 && (
                                        <div className="mt-3 border-t border-slate-200 pt-3">
                                            <h5 className="font-semibold mb-2 text-slate-800">References:</h5>
                                            <ul className="space-y-3">
                                                {q.references.map((ref, i) => (
                                                    <li key={i} className="pl-3 border-l-2 border-primary/50">
                                                        {ref.quote && (
                                                            <blockquote className="italic text-slate-600 mb-1">"{ref.quote}"</blockquote>
                                                        )}
                                                        <cite className="block not-italic text-slate-500">
                                                            &mdash; {ref.source}
                                                            {ref.chapter && `, Ch. ${ref.chapter}`}
                                                            {ref.page && `, p. ${ref.page}`}
                                                        </cite>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                    <FollowUpQuery 
                                        question={q} 
                                        conversation={ua.followUpConversation || []}
                                        isReadOnly={true}
                                    />
                                </div>
                            </Card>
                        );
                    })}
                </div>
            </div>
            <ReportErrorModal question={questionToReport} onClose={() => setQuestionToReport(null)} />
        </div>
    );
};


interface RepeatScreenProps {
  sessions: TestSession[];
  onStartTest: (count: number, difficulty: Difficulty, subspecialty: Subspecialty, mode: TestMode, preloadedQuestions: Question[], sourceOptions: SourceOptions) => void;
  onBack: () => void;
}
const RepeatScreen: React.FC<RepeatScreenProps> = ({ sessions, onStartTest, onBack }) => {
    const [filter, setFilter] = useState<RepeatFilter>('all');
    const [mode, setMode] = useState<TestMode>(TestMode.Study);

    const allQuestions = useMemo(() => {
        const questionMap = new Map<string, Question>();
        sessions.forEach(s => s.questions.forEach(q => questionMap.set(q.id, q)));
        return Array.from(questionMap.values());
    }, [sessions]);

    const filteredQuestions = useMemo(() => {
        if (filter === 'all') return allQuestions;
        if (filter === 'incorrect') {
            const incorrectIds = new Set(sessions.flatMap(s => s.userAnswers.filter(ua => !ua.isCorrect).map(ua => ua.questionId)));
            return allQuestions.filter(q => incorrectIds.has(q.id));
        }
        if (filter === 'marked') {
            const markedIds = new Set(sessions.flatMap(s => s.userAnswers.filter(ua => ua.marked).map(ua => ua.questionId)));
            return allQuestions.filter(q => markedIds.has(q.id));
        }
        // Subspecialty or Difficulty
        return allQuestions.filter(q => q.subspecialty === filter || q.difficulty === filter);

    }, [filter, allQuestions, sessions]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (filteredQuestions.length === 0) {
            alert("No questions match the selected criteria.");
            return;
        }
        onStartTest(filteredQuestions.length, Difficulty.Mixed, Subspecialty.Mixed, mode, filteredQuestions, { sourceMode: 'textbooks', documents: [] });
    }
    
    return (
        <Card>
            <h2 className="text-2xl font-bold text-primary mb-6">Repeat Questions</h2>
            <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                    <label htmlFor="filter" className="block text-sm font-medium text-slate-700">Repeat which questions?</label>
                    <select id="filter" value={filter} onChange={e => setFilter(e.target.value as RepeatFilter)} className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-slate-300 focus:outline-none focus:ring-primary focus:border-primary sm:text-sm rounded-md">
                        <option value="all">All Previously Seen</option>
                        <option value="incorrect">Incorrectly Answered</option>
                        <option value="marked">Marked for Review</option>
                        <optgroup label="By Subspecialty">
                          {ALL_SUBSPECIALTIES.filter(s => s !== Subspecialty.Mixed).map(s => <option key={s} value={s}>{s}</option>)}
                        </optgroup>
                         <optgroup label="By Difficulty">
                          {ALL_DIFFICULTIES.filter(d => d !== Difficulty.Mixed).map(d => <option key={d} value={d}>{d}</option>)}
                        </optgroup>
                    </select>
                     <p className="mt-2 text-sm text-slate-600">{filteredQuestions.length} questions selected.</p>
                </div>
                 <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Test Mode</label>
                    <select value={mode} onChange={e => setMode(e.target.value as TestMode)} className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-slate-300 focus:outline-none focus:ring-primary focus:border-primary sm:text-sm rounded-md">
                        {ALL_TEST_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                </div>
                <div className="flex items-center justify-end gap-4 pt-4">
                    <button type="button" onClick={onBack} className="text-sm font-semibold text-slate-600 hover:text-primary">Cancel</button>
                    <button type="submit" disabled={filteredQuestions.length === 0} className="flex items-center justify-center gap-2 bg-primary text-white font-bold py-3 px-6 rounded-lg hover:bg-accent transition-transform hover:scale-105 shadow-lg disabled:bg-slate-400 disabled:transform-none disabled:cursor-not-allowed">
                        <BookOpenIcon className="w-5 h-5" />
                        Start Review Session
                    </button>
                </div>
            </form>
        </Card>
    );
};

export default App;

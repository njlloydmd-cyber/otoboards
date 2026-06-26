
// FIX: Removed self-import of enums from this file to resolve declaration conflicts.
export enum Difficulty {
  Easy = "Easy",
  Medium = "Medium",
  Hard = "Hard",
  Mixed = "Mixed"
}

export enum Subspecialty {
  Otology = "Otology",
  Rhinology = "Rhinology",
  Laryngology = "Laryngology",
  HeadAndNeck = "Head & Neck Surgery",
  PediatricOtolaryngology = "Pediatric Otolaryngology",
  FacialPlastics = "Facial Plastics & Reconstructive Surgery",
  General = "General Otolaryngology",
  Mixed = "Mixed"
}

export enum TestMode {
  Study = "Study",
  Tutor = "Tutor",
  Test = "Test",
  Adaptive = "Adaptive"
}

export interface QuestionOption {
  text: string;
  isCorrect: boolean;
}

export interface Reference {
  source: string;
  quote?: string;
  chapter?: string;
  page?: string;
}

export interface Question {
  id: string;
  question: string;
  options: QuestionOption[];
  explanation: string;
  references?: Reference[];
  subspecialty: string; // Keep as string for flexibility from AI
  difficulty: Difficulty;
}

export interface UserAnswer {
  questionId: string;
  selectedOptionIndex: number | null;
  isCorrect: boolean | null;
  firstAttemptIndex?: number;
  attempts: number[];
  marked: boolean;
  followUpConversation?: FollowUpConversation[];
}

export interface TestSession {
  id: string;
  date: number;
  mode: TestMode;
  questions: Question[];
  userAnswers: UserAnswer[];
  score: number;
  currentQuestionIndex: number;
  // Add these for generation screen & context
  questionCount: number;
  difficulty: Difficulty;
  subspecialty: Subspecialty;
  status: 'generating' | 'ready';
  source?: 'Textbooks' | 'Documents' | 'Mixed' | 'Question Bank';
}

export interface FollowUpConversation {
  userQuery: string;
  aiResponse: string;
}

export interface UploadedDocument {
  id: string;
  fileName: string;
  aiName: string;
  text: string;
  status: 'parsing' | 'naming' | 'ready' | 'error';
  error?: string;
}
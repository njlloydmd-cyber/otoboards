
import { Difficulty, Subspecialty, TestMode } from './types';

export const ALL_DIFFICULTIES = Object.values(Difficulty);
export const ALL_SUBSPECIALTIES = Object.values(Subspecialty);
export const ALL_TEST_MODES = Object.values(TestMode);

export const MODE_DESCRIPTIONS: Record<TestMode, string> = {
  [TestMode.Study]: "Get instant feedback. You can change your answer; only the last one is graded.",
  [TestMode.Tutor]: "Get instant feedback. Your first answer is final and graded.",
  [TestMode.Test]: "No feedback until the end. Answer freely and submit when finished.",
  [TestMode.Adaptive]: "Test mode where question difficulty adjusts based on your performance.",
};

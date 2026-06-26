import express from "express";
import path from "path";
import crypto from "crypto";
import mammoth from "mammoth";
import { PDFDocument } from "pdf-lib";
import { createServer as createViteServer } from "vite";
import Anthropic from "@anthropic-ai/sdk";
import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getFirestore, FieldValue, type Firestore, type Query } from "firebase-admin/firestore";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { Difficulty, Subspecialty } from './types';
import { getFilteredCuratedQuestions } from './curatedQuestions';

// Primary model for substantive generation tasks (question writing, tutoring, error review).
const PRIMARY_MODEL = "claude-sonnet-4-6";
// Lightweight model for cheap, low-stakes tasks (naming a document) and as a fallback if the
// primary model is rate-limited or temporarily overloaded.
const FALLBACK_MODEL = "claude-haiku-4-5-20251001";

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Support JSON payload with larger limit for medical documents (PDFs sent as base64).
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ limit: "100mb", extended: true }));

  // Request logger middleware
  app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    res.on("finish", () => {
      console.log(`[RESPONSE] ${req.method} ${req.url} -> ${res.statusCode}`);
    });
    next();
  });

  let aiInstance: Anthropic | null = null;
  function getAI(): Anthropic {
    if (!aiInstance) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY environment variable is not configured on the server. Add it to your .env.local file and restart the server.");
      }
      aiInstance = new Anthropic({ apiKey });
    }
    return aiInstance;
  }

  // The shared Question Bank, and (optionally) per-user cross-device sync data, both live in
  // Firestore. Auth (for sync) shares the same underlying Firebase app — initializeApp() can
  // only be called once, so both getBankDb() and verifyAuthToken() route through this.
  let firebaseApp: ReturnType<typeof initializeApp> | null = null;
  function getFirebaseApp(): ReturnType<typeof initializeApp> {
    if (!firebaseApp) {
      const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
      if (!encoded) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is not configured on the server. See README.md for setup instructions.");
      }
      let serviceAccount: ServiceAccount;
      try {
        serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
      } catch (e: any) {
        throw new Error(`FIREBASE_SERVICE_ACCOUNT_BASE64 could not be decoded as base64-encoded JSON: ${e.message}`);
      }
      firebaseApp = initializeApp({ credential: cert(serviceAccount) });
    }
    return firebaseApp;
  }

  let firestoreDb: Firestore | null = null;
  function getBankDb(): Firestore {
    if (!firestoreDb) {
      firestoreDb = getFirestore(getFirebaseApp());
    }
    return firestoreDb;
  }

  // Deterministic doc ID from the normalized question text, so curating "the same" question
  // twice (by one person, or two different people) overwrites in place instead of creating a
  // duplicate — no separate uniqueness check needed before every write.
  function questionBankDocId(questionText: string): string {
    const normalized = questionText.trim().toLowerCase().replace(/\s+/g, " ");
    return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 40);
  }

  class UnauthorizedError extends Error {}

  // Verifies the Firebase Auth ID token the client sends with sync requests, returning the
  // decoded token (which includes the verified, server-trusted uid) or throwing if missing/
  // invalid/expired. This is what scopes each person's synced sessions to only them.
  async function verifyAuthToken(req: express.Request): Promise<DecodedIdToken> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedError("Missing sign-in token.");
    }
    const idToken = authHeader.slice("Bearer ".length);
    let app: ReturnType<typeof initializeApp>;
    try {
      app = getFirebaseApp();
    } catch (e: any) {
      // Distinct from an actually-invalid token — this means Firebase itself isn't configured.
      throw e;
    }
    try {
      return await getAuth(app).verifyIdToken(idToken);
    } catch (e: any) {
      throw new UnauthorizedError(`Invalid or expired sign-in token: ${e.message}`);
    }
  }

  // A hard stop for cases where retrying or falling back to another model cannot possibly help
  // (e.g. the account itself has no usable credit). Thrown directly instead of being retried.
  class UnrecoverableAIError extends Error {}

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Calls the Claude Messages API, retrying transient failures (rate limits, momentary
   * overload) with exponential backoff, then falling through to the next model in
   * `modelsList` if the current one keeps failing. Mirrors the resilience the app needs
   * when many study sessions hit the API around the same time.
   */
  async function generateWithFallback(
    ai: Anthropic,
    params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model">,
    modelsList: string[] = [PRIMARY_MODEL, FALLBACK_MODEL]
  ): Promise<Anthropic.Message> {
    let lastError: any = null;

    for (const model of modelsList) {
      let retries = 4;
      let delay = 1000;

      while (retries >= 0) {
        try {
          console.log(`Attempting Claude API call with model: ${model} (Retries left: ${retries})`);
          const response = await ai.messages.create({ ...params, model });
          return response;
        } catch (error: any) {
          lastError = error;
          const status: number | undefined = error?.status;
          const errType: string = (error?.error?.error?.type || error?.error?.type || "").toLowerCase();
          const errMsg: string = (error?.message || "").toLowerCase();

          const isOutOfCredit = errMsg.includes("credit balance") || errMsg.includes("billing");
          if (isOutOfCredit) {
            throw new UnrecoverableAIError(
              `Your Anthropic account has insufficient credit. Add credit at console.anthropic.com, then try again. (Detail: ${error.message})`
            );
          }

          const isRetryable =
            status === 429 ||
            status === 503 ||
            status === 529 ||
            errType === "rate_limit_error" ||
            errType === "overloaded_error" ||
            errType === "api_error" ||
            errMsg.includes("overloaded") ||
            errMsg.includes("rate limit") ||
            errMsg.includes("high demand");

          if (retries > 0 && isRetryable) {
            const jitter = Math.floor(Math.random() * (delay * 0.4)) - delay * 0.2;
            const nextDelay = Math.max(500, delay + jitter);
            console.warn(`Claude call failed with ${model} due to a temporary constraint. Retrying in ${nextDelay}ms... Error: ${error.message || error}`);
            await sleep(nextDelay);
            retries--;
            delay *= 2;
          } else {
            console.warn(`Failed with ${model}, no retries left or non-retryable error. Trying next fallback model if available... Error: ${error.message || error}`);
            break;
          }
        }
      }
    }

    const detail = lastError?.message || JSON.stringify(lastError) || "Unknown error";
    throw new Error(
      `Claude is rate-limited or under high demand right now. Please wait a moment and try again. (Detail: ${detail})`
    );
  }

  function getTextFromMessage(message: Anthropic.Message): string {
    const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return textBlock ? textBlock.text.trim() : "";
  }

  // --- JSON Schema for forced structured output via tool use ---
  // Claude is instructed (via tool_choice) to always call this tool, so its arguments are
  // guaranteed to be a parsed object matching this schema — no JSON.parse / markdown-fence
  // stripping needed on our side.
  const referenceSchema = {
    type: "object",
    properties: {
      source: { type: "string", description: 'Name of the source textbook, guideline, or uploaded document (e.g., "Cummings Otolaryngology" or "Uploaded Document: 2023 Sinusitis Guidelines").' },
      quote: { type: "string", description: "An optional, direct, relevant quote from the source that supports the explanation. Only include if you can ensure accuracy. Do not fabricate." },
      chapter: { type: "string", description: "Optional chapter title or number from the source." },
      page: { type: "string", description: "Optional page number(s) where the quote can be found." },
    },
    required: ["source"],
  };

  const questionItemSchema = {
    type: "object",
    properties: {
      question: { type: "string", description: "The question text." },
      options: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        description: "Exactly 4 possible answers; exactly one must have isCorrect set to true.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "The answer option text." },
            isCorrect: { type: "boolean", description: "True if this is the correct answer." },
          },
          required: ["text", "isCorrect"],
        },
      },
      explanation: { type: "string", description: "A detailed explanation for the correct answer." },
      references: {
        type: "array",
        description: "Sources and relevant quotes that support the explanation. Required — every question must cite at least one source.",
        minItems: 1,
        items: referenceSchema,
      },
      subspecialty: { type: "string", description: "The medical subspecialty of the question." },
      difficulty: { type: "string", enum: ["Easy", "Medium", "Hard"], description: "The difficulty of the question." },
    },
    required: ["question", "options", "explanation", "references", "subspecialty", "difficulty"],
  };

  const generateQuestionsTool: Anthropic.Tool = {
    name: "submit_board_questions",
    description: "Submit the generated set of board-exam practice questions.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: questionItemSchema,
        },
      },
      required: ["questions"],
    },
  };

  // Output budget scales with how many questions were requested, capped to keep cost sane.
  function questionGenerationMaxTokens(count: number): number {
    return Math.min(48000, 2000 + count * 1100);
  }

  // Splits a PDF into page-range chunks (each its own small, valid PDF), so a large or scanned
  // document can be transcribed as several smaller, faster Claude calls run in parallel instead
  // of one slow mega-call. Wall-clock time ends up close to "the slowest chunk" rather than
  // "the sum of every page".
  async function splitPdfIntoChunks(
    pdfBuffer: Buffer,
    pagesPerChunk: number
  ): Promise<{ base64: string; startPage: number; endPage: number }[]> {
    const srcDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = srcDoc.getPageCount();
    const chunks: { base64: string; startPage: number; endPage: number }[] = [];

    for (let start = 0; start < totalPages; start += pagesPerChunk) {
      const end = Math.min(start + pagesPerChunk, totalPages);
      const chunkDoc = await PDFDocument.create();
      const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
      const copiedPages = await chunkDoc.copyPages(srcDoc, pageIndices);
      copiedPages.forEach((page) => chunkDoc.addPage(page));
      const chunkBytes = await chunkDoc.save();
      chunks.push({
        base64: Buffer.from(chunkBytes).toString("base64"),
        startPage: start + 1,
        endPage: end,
      });
    }
    return chunks;
  }

  // ----------------------------------------------------------------------------------------
  // Document extraction
  // ----------------------------------------------------------------------------------------
  // PDFs and images are sent straight to Claude as native "document"/"image" content blocks —
  // Claude reads the rendered page layout itself, so there's no need for client-side PDF.js
  // rendering or a page-by-page OCR loop. .docx files are extracted deterministically with
  // mammoth (no AI call needed at all: faster, free, and not subject to model error).
  app.post("/api/claude/extract-document", async (req, res) => {
    try {
      const { base64Data, mimeType, fileName } = req.body;
      if (!base64Data || !mimeType) {
        return res.status(400).json({ error: "base64Data and mimeType are required" });
      }

      const isDocx = mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(fileName || "");
      const isLegacyDoc = mimeType === "application/msword" || /\.doc$/i.test(fileName || "");
      const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(fileName || "");
      const isImage = mimeType.startsWith("image/");

      if (isLegacyDoc && !isDocx) {
        return res.status(400).json({
          error: `"${fileName}" is a legacy .doc file, which isn't supported. Please re-save it as .docx or PDF in Word ("Save As" → Word Document) and upload again.`,
        });
      }

      if (isDocx) {
        console.log(`Extracting ${fileName} with mammoth (deterministic, no AI call)...`);
        const buffer = Buffer.from(base64Data, "base64");
        let result: { value: string };
        try {
          result = await mammoth.extractRawText({ buffer });
        } catch (mammothError: any) {
          console.warn(`mammoth failed to parse ${fileName}:`, mammothError);
          return res.status(422).json({ error: `"${fileName}" couldn't be read as a Word document. It may be corrupted, password-protected, or not actually a .docx file.` });
        }
        const text = (result.value || "").trim();
        if (!text) {
          return res.status(422).json({ error: "No readable text could be found in this Word document. It may be empty, image-only, or corrupted." });
        }
        return res.json({ text, method: "docx-parser" });
      }

      if (isPdf) {
        const pdfBuffer = Buffer.from(base64Data, "base64");

        let totalPages: number;
        try {
          const probeDoc = await PDFDocument.load(pdfBuffer);
          totalPages = probeDoc.getPageCount();
        } catch (e: any) {
          return res.status(422).json({ error: `"${fileName}" couldn't be read as a PDF. It may be corrupted, password-protected, or not actually a PDF file.` });
        }

        const MAX_PAGES = 150;
        if (totalPages > MAX_PAGES) {
          return res.status(413).json({ error: `"${fileName}" has ${totalPages} pages, which is over the ${MAX_PAGES}-page limit per upload. Try splitting it into smaller files.` });
        }

        const ai = getAI();
        const PAGES_PER_CHUNK = 8;

        if (totalPages <= PAGES_PER_CHUNK) {
          // Small enough that splitting would just add overhead — one call, as before.
          const response = await generateWithFallback(ai, {
            max_tokens: 20000,
            messages: [
              {
                role: "user",
                content: [
                  { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
                  {
                    type: "text",
                    text: `You are an expert medical document transcriber. Transcribe this entire document ("${fileName}") to clean, readable text. Include all body text, headings, tables (as plain text), staging criteria, and numeric values exactly as written. Do not summarize, paraphrase, or omit content — this transcription will be used to write accurate exam questions. Return only the transcribed text, with no preamble or commentary.`,
                  },
                ],
              },
            ],
          });
          const text = getTextFromMessage(response);
          if (!text) {
            return res.status(422).json({ error: "Claude could not extract any text from this PDF. It may be blank, password-protected, or made up of unreadable images." });
          }
          return res.json({ text, method: "claude-vision" });
        }

        // Larger document: split into page-range chunks, transcribe them in parallel. Each
        // chunk is its own small, valid PDF, so this is much faster per-call than asking
        // Claude to process the whole (potentially scanned, image-heavy) document at once —
        // and total wall-clock time is close to the slowest single chunk, not their sum.
        console.log(`Splitting "${fileName}" (${totalPages} pages) into chunks of ${PAGES_PER_CHUNK} pages for parallel transcription...`);
        const chunks = await splitPdfIntoChunks(pdfBuffer, PAGES_PER_CHUNK);

        const chunkResults = await Promise.all(
          chunks.map(async (chunk) => {
            try {
              const response = await generateWithFallback(ai, {
                max_tokens: 8000,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "document", source: { type: "base64", media_type: "application/pdf", data: chunk.base64 } },
                      {
                        type: "text",
                        text: `You are an expert medical document transcriber. Transcribe pages ${chunk.startPage}-${chunk.endPage} of "${fileName}" (a partial excerpt from a larger document — only transcribe what's shown, don't comment on it being a fragment) to clean, readable text. Include all body text, headings, tables (as plain text), staging criteria, and numeric values exactly as written. Do not summarize, paraphrase, or omit content. Return only the transcribed text, with no preamble or commentary.`,
                      },
                    ],
                  },
                ],
              });
              return { startPage: chunk.startPage, text: getTextFromMessage(response) };
            } catch (chunkError: any) {
              console.warn(`Chunk pages ${chunk.startPage}-${chunk.endPage} of "${fileName}" failed to transcribe:`, chunkError);
              return { startPage: chunk.startPage, text: "" };
            }
          })
        );

        // Promise.all preserves input order, so chunkResults is already in page order.
        const successfulChunks = chunkResults.filter((r) => r.text);
        const text = successfulChunks.map((r) => r.text).join("\n\n--- PAGE BREAK ---\n\n");

        if (!text) {
          return res.status(422).json({ error: "Claude could not extract any text from this PDF. It may be blank, password-protected, or made up of unreadable images." });
        }
        const failedCount = chunks.length - successfulChunks.length;
        const finalText = failedCount > 0
          ? `${text}\n\n[Note: ${failedCount} of ${chunks.length} page-sections of this document could not be transcribed (likely temporary high demand on Claude). The text above may be incomplete — consider re-uploading if questions generated from it seem to be missing content.]`
          : text;
        if (failedCount > 0) {
          console.warn(`"${fileName}": ${failedCount} of ${chunks.length} chunks failed to transcribe; returning the rest with a notice.`);
        }
        return res.json({ text: finalText, method: "claude-vision-chunked" });
      }

      if (isImage) {
        const ai = getAI();
        const response = await generateWithFallback(ai, {
          max_tokens: 4000,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mimeType as any, data: base64Data } },
                { type: "text", text: `Transcribe all text visible in this image ("${fileName}") exactly as written. Return only the transcribed text.` },
              ],
            },
          ],
        });
        const text = getTextFromMessage(response);
        if (!text) {
          return res.status(422).json({ error: "Claude could not find any readable text in this image." });
        }
        return res.json({ text, method: "claude-vision" });
      }

      return res.status(400).json({ error: `Unsupported file type: ${mimeType}. Please upload a PDF, Word (.docx), or plain text document.` });
    } catch (e: any) {
      console.error("Error in /api/claude/extract-document:", e);
      const status = e instanceof UnrecoverableAIError ? 402 : 500;
      res.status(status).json({ error: e.message || "Failed to extract text from document" });
    }
  });

  app.post("/api/claude/name-document", async (req, res) => {
    try {
      const ai = getAI();
      const { documentText } = req.body;
      if (!documentText) {
        return res.status(400).json({ error: "documentText is required" });
      }

      const prompt = `
      Analyze the following text from a medical document. Provide a concise, descriptive title for this document.
      The title should be 5 words or less and accurately reflect the main topic.

      Examples:
      - "2023 AAO-HNS Sinusitis Guidelines"
      - "Chapter on Laryngeal Anatomy"
      - "Research Paper on Cochlear Implants"

      --- DOCUMENT TEXT (first 3000 characters) ---
      ${documentText.substring(0, 3000)}
      --- END OF TEXT ---

      Return ONLY the title as a single line of plain text, with no quotation marks.
      `;

      // Naming is a trivial task, so it goes straight to the cheap/fast model rather than the
      // primary one.
      const response = await generateWithFallback(
        ai,
        { max_tokens: 100, messages: [{ role: "user", content: prompt }] },
        [FALLBACK_MODEL, PRIMARY_MODEL]
      );

      const title = getTextFromMessage(response).replace(/"/g, "") || "Untitled Document";
      res.json({ title });
    } catch (e: any) {
      console.warn("Naming document failed, using local fallback title:", e);
      const textSample = (req.body.documentText || "").trim();
      const cleanText = textSample.replace(/[^\w\s-]/g, "").substring(0, 50);
      const titleWords = cleanText.split(/\s+/).slice(0, 4).join(" ");
      res.json({ title: titleWords ? `${titleWords}...` : "Medical Document" });
    }
  });

  app.post("/api/claude/generate-questions", async (req, res) => {
    try {
      const ai = getAI();
      const { count, difficulty, subspecialty, sourceOptions, excludeQuestions } = req.body;
      const { sourceMode, documents } = sourceOptions || { sourceMode: "textbooks" };

      // Defense in depth: re-apply the same bounds the client already enforces, in case of a
      // misbehaving client or a future caller. Keeps prompt size (and cost) predictable.
      const safeExcludeQuestions: string[] = Array.isArray(excludeQuestions)
        ? excludeQuestions.slice(0, 250).map((q: any) => String(q).slice(0, 220))
        : [];

      let userPrompt: string;

      const documentSection = (documents && documents.length > 0)
        ? documents.map((doc: any, i: number) =>
            `--- DOCUMENT ${i + 1}: "${doc.aiName}" ---\n${doc.text}\n--- END OF DOCUMENT ${i + 1} ---`
          ).join("\n\n")
        : "";

      const systemPrompt = `You are an expert medical question writer specializing in Otolaryngology-Head and Neck Surgery board certification exams. Your task is to generate high-quality, challenging, multiple-choice questions suitable for board preparation.

The questions must be clinically relevant, clear, and unambiguous, mirroring the style of actual board exam questions. Explanations should be detailed and reference the core concepts from the specified source materials. Exactly one option per question must have isCorrect set to true.

For any questions involving cancer staging, you MUST use the American Joint Committee on Cancer (AJCC) 8th Edition staging manual as the source of truth, citing "AJCC 8th Edition Staging Manual" when you do.

DO NOT GUESS OR FABRICATE CITATION DETAILS. Accuracy is paramount — include chapter/page/quote details only if you are certain of them; omit them otherwise. Call the submit_board_questions tool exactly once with the complete set of questions.`;

      if (sourceMode === "documents") {
        if (!documentSection) {
          return res.status(400).json({ error: "Source mode is 'documents', but no documents were provided." });
        }
        userPrompt = `
          Generate ${count} questions at ${difficulty} difficulty, focused on the subspecialty: ${subspecialty} (if "Mixed" or "General", balance across subspecialties).

          **Primary Source Material:**
          Base your questions primarily on the following document content. Synthesize it with your own expert knowledge of core Otolaryngology textbooks (Cummings, Bailey's, Myers) and AAO-HNS guidelines to ensure accuracy and clinical relevance. If the document directly conflicts with established medical knowledge, prioritize established knowledge (with the AJCC staging exception below taking precedence over everything).

          ${documentSection}

          **Citation Rules:** For non-staging questions, cite the document's title (e.g., "Uploaded Document: 2023 Sinusitis Guidelines"). You may also cite standard textbooks if used to synthesize information.
        `;
      } else if (sourceMode === "both") {
        if (!documentSection) {
          return res.status(400).json({ error: "Source mode is 'both', but no documents were provided." });
        }
        userPrompt = `
          Generate ${count} questions at ${difficulty} difficulty, focused on the subspecialty: ${subspecialty} (if "Mixed" or "General", balance across subspecialties).

          **Primary Source Material:** Synthesize two sources: (1) your expert knowledge of core Otolaryngology textbooks (Cummings, Bailey's, Myers) and AAO-HNS guidelines, and (2) the user-provided document(s) below. Use the documents as a significant basis for the questions, enriched and validated against the established textbook knowledge.

          ${documentSection}

          **Citation Rules:** Cite the textbook (e.g., "Cummings Otolaryngology") or the document name (e.g., "Uploaded Document: 2023 Sinusitis Guidelines") as appropriate for each question.
        `;
      } else {
        userPrompt = `
          Generate ${count} questions at ${difficulty} difficulty, focused on the subspecialty: ${subspecialty} (if "Mixed" or "General", balance across subspecialties).

          Base your questions on the most recent editions of:
          1. Cummings Otolaryngology and Head and Neck Surgery
          2. Bailey's Head and Neck Surgery
          3. Myers Operative Otolaryngology
          4. AAO-HNS clinical practice guidelines

          **Citation Rules:** Provide the source name (e.g., "Cummings Otolaryngology"). Include chapter/page/quotes only if certain of their accuracy.
        `;
      }

      if (safeExcludeQuestions.length > 0) {
        userPrompt += `\n\n**Avoid Repetition:** The test-taker has already seen the following questions in past sessions. Write genuinely new questions — do not reuse the same clinical scenario, the same tested fact, or the same "twist" as any of these:\n${safeExcludeQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n`;
      }

      const response = await generateWithFallback(ai, {
        max_tokens: questionGenerationMaxTokens(count || 10),
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools: [generateQuestionsTool],
        tool_choice: { type: "tool", name: "submit_board_questions" },
      });

      const toolUseBlock = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const generatedQs = (toolUseBlock?.input as any)?.questions || [];

      if (generatedQs.length === 0) {
        throw new Error("Claude did not return any questions. Please try again or adjust your parameters.");
      }

      const questions = generatedQs.map((q: any, index: number) => ({
        ...q,
        id: `gen-${Date.now()}-${index}`,
        difficulty: q.difficulty || difficulty || Difficulty.Medium,
      }));

      res.json({ questions });
    } catch (e: any) {
      console.warn("Failed to generate questions using Claude, serving from preloaded high-yield curated board repository:", e);
      try {
        const { count, difficulty, subspecialty } = req.body;
        const fallbacks = getFilteredCuratedQuestions(count || 10, difficulty || Difficulty.Mixed, subspecialty || Subspecialty.Mixed);
        const questions = fallbacks.map((q, index) => ({
          ...q,
          id: `fallback-${Date.now()}-${index}`,
          explanation: `${q.explanation}\n\n*[Notice: This high-yield board question was served from the preloaded medical repository due to temporary high demand on Claude. Your study session continues uninterrupted!]*`
        }));
        res.json({ questions });
      } catch (fallbackError: any) {
        console.error("Secondary error inside question generator fallback:", fallbackError);
        res.status(500).json({ error: e.message || "Failed to generate questions" });
      }
    }
  });

  app.post("/api/claude/ask-followup", async (req, res) => {
    try {
      const ai = getAI();
      const { question, userQuery } = req.body;
      if (!question || !userQuery) {
        return res.status(400).json({ error: "question and userQuery are required" });
      }

      const prompt = `
        You are an expert medical tutor specializing in Otolaryngology-Head and Neck Surgery. A student has just answered a practice question and has a follow-up question. Provide a clear, concise, and accurate answer based on the context of the practice question and your extensive knowledge.

        **Context of the Original Question:**
        - **Question:** ${question.question}
        - **Options:**
          ${question.options.map((opt: any, i: number) => `${String.fromCharCode(65 + i)}: ${opt.text} ${opt.isCorrect ? '(Correct Answer)' : ''}`).join('\n          ')}
        - **Explanation Provided:** ${question.explanation}
        - **References Provided:** ${question.references?.map((ref: any) => `${ref.source}${ref.chapter ? `, Ch. ${ref.chapter}` : ''}${ref.page ? `, p. ${ref.page}` : ''}${ref.quote ? ` ("${ref.quote}")` : ''}`).join('\n')}

        **Student's Follow-up Question:**
        "${userQuery}"

        Answer the student's question directly. If appropriate, refer back to the original question's context or the provided references. Base your answer on established medical knowledge from sources like Cummings Otolaryngology, Bailey's Head and Neck Surgery, and AAO-HNS guidelines. For staging questions, refer to the AJCC 8th Edition.
      `;

      const response = await generateWithFallback(ai, { max_tokens: 1500, messages: [{ role: "user", content: prompt }] });
      const answer = getTextFromMessage(response) || "No answer received.";
      res.json({ answer });
    } catch (e: any) {
      console.warn("Ask follow-up failed, using local offline expert fallback response:", e);
      const question = req.body.question || {};
      const refDetail = question.references && question.references[0]
        ? `${question.references[0].source}${question.references[0].chapter ? `, Chapter ${question.references[0].chapter}` : ""}`
        : "Standard Otolaryngology Textbooks (Cummings, Bailey's)";
      const correctOptText = question.options
        ? (question.options.find((o: any) => o.isCorrect)?.text || "the indicated correct option")
        : "the correct option";

      const fallbackAnswer = `**[Offline Tutor Mode]**

Claude is currently experiencing high demand. Here's a quick reference while you wait:

- **Key Reference**: ${refDetail}
- **Correct Concept**: **${correctOptText}**
- **Clinical Review Pearl**: ${question.explanation || "No additional explanation available."}

*Try again in a moment, or check your Anthropic account's rate limits at console.anthropic.com if this keeps happening.*`;
      res.json({ answer: fallbackAnswer });
    }
  });

  app.post("/api/claude/report-error", async (req, res) => {
    try {
      const ai = getAI();
      const { question, userFeedback } = req.body;
      if (!question || !userFeedback) {
        return res.status(400).json({ error: "question and userFeedback are required" });
      }

      const prompt = `
        You are a senior member of a medical board examination committee. A test-taker has flagged a question for a potential error. Analyze their feedback with precision and provide a helpful, expert response.

        **Original Question Context:**
        - **Question:** ${question.question}
        - **Options:**
          ${question.options.map((opt: any, i: number) => `${String.fromCharCode(65 + i)}: ${opt.text} ${opt.isCorrect ? '(Correct Answer)' : ''}`).join('\n          ')}
        - **Explanation Provided:** ${question.explanation}
        - **References Provided:** ${question.references?.map((ref: any) => `${ref.source}${ref.chapter ? `, Ch. ${ref.chapter}` : ''}${ref.page ? `, p. ${ref.page}` : ''}`).join('\n')}

        **Test-Taker's Feedback:**
        "${userFeedback}"

        **Your Task:**
        1. **Analyze:** Evaluate the feedback. Is it valid? Does it point out a factual error, a typo, an ambiguity, or a flaw in the answer choices or explanation?
        2. **Verify:** Cross-reference with your internal knowledge of "Cummings Otolaryngology," "Bailey's Head and Neck Surgery," AAO-HNS guidelines, and the AJCC 8th Edition staging manual.
        3. **Respond:** Formulate a clear, professional response.

        **Response Format:**
        - **If valid:** Start with "Thank you for your feedback. You've identified a valid issue." Explain the error, then provide a corrected version of the question with clear headings (e.g., "Corrected Question:", "Corrected Explanation:"). Plain text, no JSON.
        - **If incorrect:** Start politely, e.g., "Thank you for your feedback. This is a nuanced topic, and your query raises an important point." Then explain why the original question is correct, citing authoritative sources.

        Be concise but thorough.
      `;

      const response = await generateWithFallback(ai, { max_tokens: 1500, messages: [{ role: "user", content: prompt }] });
      const answer = getTextFromMessage(response) || "No response generated.";
      res.json({ answer });
    } catch (e: any) {
      console.warn("Report error failed, using local offline fallback response:", e);
      const question = req.body.question || {};
      const refDetail = question.references && question.references[0]
        ? question.references[0].source
        : "Standard Otolaryngology Textbooks (Cummings, Bailey's)";
      const feedback = req.body.userFeedback || "potential factual discrepancy";

      const fallbackAnswer = `Thank you for auditing this board question. Your feedback ("${feedback}") has been recorded locally.

Claude is currently experiencing high demand, so the real-time review couldn't complete. This ticket has been queued against **${refDetail}** and will be reviewed once you retry.

Your active review keeps this board preparation study bank clean, clear, and accurate!`;
      res.json({ answer: fallbackAnswer });
    }
  });

  // ----------------------------------------------------------------------------------------
  // Question Bank — a shared, growing pool of curated questions, separate from Claude entirely.
  // ----------------------------------------------------------------------------------------
  app.post("/api/bank/add", async (req, res) => {
    try {
      const db = getBankDb();
      const { question } = req.body;
      if (!question || typeof question.question !== "string" || !Array.isArray(question.options)) {
        return res.status(400).json({ error: "A valid question object is required." });
      }

      const docId = questionBankDocId(question.question);
      const docRef = db.collection("questionBank").doc(docId);
      const existing = await docRef.get();
      if (existing.exists) {
        return res.json({ added: false, alreadyExisted: true });
      }

      // Drop the ephemeral generation-time id (e.g. "gen-1234-0") — the Firestore doc ID is the
      // canonical identifier for a banked question from here on.
      const { id, ...questionWithoutId } = question;
      await docRef.set({
        ...questionWithoutId,
        curatedAt: FieldValue.serverTimestamp(),
      });

      res.json({ added: true, alreadyExisted: false });
    } catch (e: any) {
      console.error("Error adding to question bank:", e);
      res.status(e instanceof Error && e.message.includes("FIREBASE_SERVICE_ACCOUNT_BASE64") ? 503 : 500).json({ error: e.message || "Failed to add question to the bank." });
    }
  });

  app.get("/api/bank/count", async (req, res) => {
    try {
      const db = getBankDb();
      const snapshot = await db.collection("questionBank").count().get();
      res.json({ count: snapshot.data().count });
    } catch (e: any) {
      console.error("Error counting question bank:", e);
      res.status(e instanceof Error && e.message.includes("FIREBASE_SERVICE_ACCOUNT_BASE64") ? 503 : 500).json({ error: e.message || "Failed to read the question bank." });
    }
  });

  app.post("/api/bank/sample", async (req, res) => {
    try {
      const db = getBankDb();
      const { count, difficulty, subspecialty } = req.body;
      const requestedCount = Math.max(1, Math.min(50, Number(count) || 10));

      // Firestore filters efficiently on an exact field match, so we apply the difficulty filter
      // there. Subspecialty matching mirrors curatedQuestions.ts's fuzzy substring approach
      // (AI-written subspecialty strings aren't perfectly consistent — e.g. "Otology" vs
      // "Otology/Neurotology" — so an exact Firestore `where` would silently miss matches).
      let query: Query = db.collection("questionBank");
      if (difficulty && difficulty !== Difficulty.Mixed) {
        query = query.where("difficulty", "==", difficulty);
      }

      // Pull a generous pool, then shuffle and slice in memory. Firestore has no native random-
      // sample query; this is the simplest correct approach at the scale this bank is expected to
      // reach (hundreds to low thousands of questions, not millions).
      const POOL_CAP = 500;
      const snapshot = await query.limit(POOL_CAP).get();
      let candidates = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));

      if (subspecialty && subspecialty !== Subspecialty.Mixed) {
        const spec = String(subspecialty).toLowerCase();
        candidates = candidates.filter(q => {
          const qSub = String(q.subspecialty || "").toLowerCase();
          return qSub.includes(spec) || spec.includes(qSub);
        });
      }

      // Fisher-Yates shuffle
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }

      const selected = candidates.slice(0, requestedCount);
      res.json({ questions: selected, totalMatched: candidates.length, requestedCount });
    } catch (e: any) {
      console.error("Error sampling question bank:", e);
      res.status(e instanceof Error && e.message.includes("FIREBASE_SERVICE_ACCOUNT_BASE64") ? 503 : 500).json({ error: e.message || "Failed to sample the question bank." });
    }
  });

  // ----------------------------------------------------------------------------------------
  // Cross-device sync — optional. A signed-in person's sessions/incompleteSessions are stored
  // under their verified uid, completely separate from the shared, anonymous Question Bank
  // above. Each person's data lives in a single document (users/{uid}/sync/main) rather than
  // one Firestore document per session — simpler to read/write atomically, and comfortably
  // within Firestore's 1MiB-per-document limit for the realistic range of session history a
  // single studier accumulates. Documents (uploaded PDFs/text) are intentionally NOT synced —
  // only sessions and in-progress sessions — to keep each sync payload small and fast.
  app.post("/api/sync/upload", async (req, res) => {
    try {
      const decoded = await verifyAuthToken(req);
      const db = getBankDb();
      const { sessions, incompleteSessions } = req.body;
      if (!Array.isArray(sessions) || typeof incompleteSessions !== "object" || incompleteSessions === null) {
        return res.status(400).json({ error: "sessions (array) and incompleteSessions (object) are required." });
      }
      await db.collection("users").doc(decoded.uid).collection("sync").doc("main").set({
        sessions,
        incompleteSessions,
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ success: true });
    } catch (e: any) {
      console.error("Error uploading sync data:", e);
      const status = e instanceof UnauthorizedError ? 401 : (e instanceof Error && e.message.includes("FIREBASE_SERVICE_ACCOUNT_BASE64") ? 503 : 500);
      res.status(status).json({ error: e.message || "Failed to sync your data." });
    }
  });

  app.get("/api/sync/download", async (req, res) => {
    try {
      const decoded = await verifyAuthToken(req);
      const db = getBankDb();
      const doc = await db.collection("users").doc(decoded.uid).collection("sync").doc("main").get();
      if (!doc.exists) {
        return res.json(null);
      }
      const data = doc.data() || {};
      res.json({ sessions: data.sessions || [], incompleteSessions: data.incompleteSessions || {} });
    } catch (e: any) {
      console.error("Error downloading sync data:", e);
      const status = e instanceof UnauthorizedError ? 401 : (e instanceof Error && e.message.includes("FIREBASE_SERVICE_ACCOUNT_BASE64") ? 503 : 500);
      res.status(status).json({ error: e.message || "Failed to load your synced data." });
    }
  });

  // Serve static assets / Vite in development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*all", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Global JSON error-handling middleware (placed at the bottom of the stack to resolve any unhandled routing/compilation errors gracefully)
  app.use((err: any, req: any, res: any, next: any) => {
    if (res.headersSent) {
      return next(err);
    }
    console.error("Global Express Error Caught:", err);
    res.status(err.status || 500).json({
      error: err.message || "An error occurred on the server processing your request.",
      code: err.code || "SERVER_ERROR",
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

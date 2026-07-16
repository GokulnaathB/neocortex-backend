import express from "express";
import { getAuth } from "@clerk/express";
import { OpenAIEmbeddings } from "@langchain/openai";
import { AIClient } from "../config/openai.js";
import { client as qdrantClient } from "../config/qdrant.js";
import { db } from "../index.js";
import { messages, sessionDocuments } from "../db/schema.js";
import { and, desc, eq } from "drizzle-orm";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { query, messages: history, sessionId } = req.body;
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Save user message
    await db.insert(messages).values({
      sessionId: sessionId,
      userId: userId,
      role: "user",
      content: query,
      sources: JSON.stringify([]),
      followUps: JSON.stringify([]),
    });

    // Query contextualization will not be useful when the follow-up question is not a follow-up question, but a random question like "how are you", "make a pdf", or something else completely irrelevant to the converstion. It will still try to rewrite it into a search query, but since there's no meaningful conversation context to attach to "how are you", the LLM will just return something like "how are you" or "greeting" as the search query. But since in the system prompt we've got the line "If the context isn't helpful enough, then use your knowledge.", we're fine. Otherwise, we'd get weird answers.

    const contextualizedQuery = await AIClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are a precise linguistic processor. Based on the conversation history that will be provided to you, you have to rewrite the latest user message into a standalone search query or declarative statement.\n

        RULES:\n
        1. If the latest message is a standalone keyword or a topic or a question in itself, completely unrelated to the conversation history, output that text EXACTLY as it is!\n
        2. If the latest message asks a question, output a clean standalone search query. Example, if the most recent message of the assistant talked about parasites, then rewrite the latest user message "examples?" as "Can you give me examples of parasites?"\n
        3.If the latest user message is a short follow-up instruction, command, or clarification (e.g., "be specific", "explain more", "why?", "give examples"), you MUST anchor it to the subject matter of the last assistant message. (e.g., If the assistant talked about parasites, "be specific" must be rewritten to something like "Provide specific examples and details about parasites").\n

        CRITICAL RULE:\n
        - Do not answer/reply to the user's latest message. Only output the rewritten standalone query or the declarative statement, NOTHING ELSE!`,
        }, // The LLM is designed to read the system message as "instructions set before the conversation begins."
        {
          role: "user",
          content: `[CONVERSATION HISTORY START]\n${JSON.stringify(history)}\n[CONVERSATION HISTORY END]\n\n[LATEST USER MESSAGE START]\n"${query.trim()}"\n[LATEST USER MESSAGE END]`,
        }, // "query" is the message that needs to be rewritten. It's added at the end so the LLM sees the full conversation first, then the latest message.
      ],
    });

    const searchQuery = contextualizedQuery.choices[0].message.content;

    const embeddings = new OpenAIEmbeddings({
      apiKey: process.env.OPENAI_API_KEY,
    }); // creates an OpenAI's embeddings model instance, which is what will convert our search query into a vector before similarity-searching Qdrant.

    let relevantChunks = [];
    let context = "";

    const currSessInfo = await db
      .select()
      .from(sessionDocuments)
      .where(
        and(
          eq(sessionDocuments.userId, userId),
          eq(sessionDocuments.sessionId, sessionId),
        ),
      );

    const docIds = currSessInfo.map((cSI) => cSI.documentId);

    try {
      const queryVector = await embeddings.embedQuery(searchQuery);
      const results = await qdrantClient.search("pdf-chunks", {
        vector: queryVector,
        limit: 8,
        filter: {
          must: [
            {
              key: "metadata.userId",
              match: { value: userId },
            },
            {
              key: "metadata.documentId",
              match: { any: docIds },
            },
          ],
        },
        with_payload: true,
      });

      relevantChunks = results.map((r) => ({
        pageContent: r.payload.content,
        metadata: r.payload.metadata,
      }));

      // Build context from chunks
      context = relevantChunks.map((doc) => doc.pageContent).join("\n\n");
    } catch (err) {
      console.log("Logging error: ", err);
    }

    const SYS_PROMPT = `You are given a user query and a context retrieved from PDF documents. Reply with only "YES" if the context is relevant to answering the query. Reply with only "NO" if the context is not at all relevant to the query.
  `;

    let nonInfoRequiringQuery;
    const showOrNotShowSources = await AIClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYS_PROMPT },
        { role: "user", content: `Query: ${query}\n\nContext: ${context}` },
      ],
    });
    nonInfoRequiringQuery =
      showOrNotShowSources.choices[0].message.content === "NO";

    // Ask the LLM
    const SYSTEM_PROMPT = `You are a helpful AI Assistant that answers questions strictly based on the provided context that has been constructed from the PDF(s) uploaded by the user.
  
  [RULES]
  1. Answer ONLY from the provided context below.
  2. If the user's query is a partial word or an incomplete sentence, fragment, or a single ambiguous term like "pro", "pre", "anti", etc., then treat it as a prompt to explore the context for related information, related topics, and summarize what the context covers related to that fragment, rather than assuming the message was cut off.
  3. If the context has limited information on the query, share what is available and mention the PDF has limited information on the topic.
  4. If the query cannot be answered from the context at all, you MUST answer it using your outside knowledge. NEVER refuse to answer. NEVER say you don't have enough information. Just answer it as a knowledgeable assistant would. Begin your answer with exactly: "NOTE: This answer is not from the uploaded PDF(s)." then leave a blank line and give your full answer.
  5. If the user sends a greeting or small talk, respond naturally and conversationally without mentioning the PDF context.
  6. When writing mathematical formulas, always use LaTeX syntax wrapped in single dollar signs for inline math and double dollar signs for block math.
  
  [CONTEXT]
  ${context}`;

    const chatResult = await AIClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...history, // to answer questions like "what was my 2nd last query"
        { role: "user", content: query },
      ],
    });

    const chatResultText = chatResult.choices[0].message.content;
    const outsideKnowledge = chatResultText.includes(
      "NOTE: This answer is not from the uploaded PDF(s).",
    );
    let sources, uniqueSources;
    if (outsideKnowledge === false && nonInfoRequiringQuery === false) {
      sources = relevantChunks.map((r) => ({
        PDF: r.metadata.source,
        page: r.metadata.page,
      }));
      uniqueSources = [...new Map(sources.map((s) => [s.page, s])).values()];
    }

    const followUpPrompt = `You are a curious research assistant. Given a user's query, its answer, and the context the answer came from, generate exactly 3 short follow-up questions that:
    - Explore the topic deeper or from related angles
    - Can be answered using the provided context
    - Are concise (under 12 words each)
    
    Return ONLY a JSON array of 3 strings, nothing else. Example: ["Question one?", "Question two?", "Question three?"]
    
    The question: ${query}.
    The answer: ${chatResultText}
    The context: ${context}`;

    let followUpQuestionsArray = [];

    if (!nonInfoRequiringQuery) {
      const followUp = await AIClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: followUpPrompt }],
      });

      try {
        const raw = followUp.choices[0].message.content.trim();
        const pureJSON = raw.replace(/```json\n?|```/g, "").trim();
        followUpQuestionsArray = JSON.parse(pureJSON);
      } catch (e) {
        followUpQuestionsArray = [];
      }
    }

    const insertedMessage = await db
      .insert(messages)
      .values({
        sessionId: sessionId,
        userId: userId,
        role: "assistant",
        content: chatResultText,
        sources:
          !outsideKnowledge && !nonInfoRequiringQuery
            ? JSON.stringify(uniqueSources)
            : JSON.stringify([]),
        followUps: JSON.stringify(followUpQuestionsArray),
      })
      .returning();
    const insertedMessageId = insertedMessage[0].id;

    // return response from llm
    return res.status(200).json({
      message: chatResultText,
      sources: uniqueSources,
      followUpQuestions: followUpQuestionsArray,
      idForFollowUpQs: insertedMessage,
    });
  } catch (e) {
    return res.status(500).json({
      error: `Error: ${e}. Check your network/try logging out and in. Sorry.`,
    });
  }
});
export default router;

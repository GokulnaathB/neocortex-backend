import "dotenv/config";
import { Worker } from "bullmq";
import { OpenAIEmbeddings } from "@langchain/openai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { Document } from "@langchain/core/documents";
import { extractText } from "unpdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { db } from "./src/index.js";
import { eq } from "drizzle-orm";
import { downloadFromR2 } from "./src/config/r2.js";
import { redisConnection } from "./src/config/queue.js";
import { client as qdrantClient } from "./src/config/qdrant.js";
import { documents } from "./src/db/schema.js";
import { AIClient } from "./src/config/openai.js";

const worker = new Worker(
  "file-upload-queue",
  async (job) => {
    /* 
    Path: job.data.path,
    read the pdf from Path,
    chunk the pdf, 
    call the openai embedding model for every chunk, 
    store the chunk in qdrant db
    */
    // const filePath = path.resolve(job.data.path); // Node may have trouble with the backslashes. Resolving fixes it by normalizing the path.

    await db
      .update(documents)
      .set({ status: "processing" })
      .where(eq(documents.id, job.data.documentId));

    const buffer = await downloadFromR2(job.data.fileKey);

    const { text } = await extractText(buffer, { mergePages: false });
    const textForAI = text.join("\n\n");

    /* 
    When you use mergePages: true, all pages are merged into one single big chunk of text. When the text splitter splits it, the chunks lose their page number context — a chunk could contain text from page 3 and page 4 mixed together, and you can't tell which page it came from.
    When you use mergePages: false, each page is a separate Document with its own page metadata. When the splitter splits a page into chunks, all those chunks inherit the correct page number. So when a chunk is retrieved, you know exactly which page it came from — which is what powers your "Sources" section showing accurate page numbers.
    */

    // Get the summary of this PDF and set it.
    const systemPrompt = `You are a literature expert who conveys complex things in a simple and concise manner without compromising on the core details/essence of the text given to you. You are given the following text and your job is to summarize it in 100 to 150 words only.
    [TEXT START]${textForAI}[TEXT END]`;

    const response = await AIClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }],
    });

    const summary = response.choices[0].message.content;

    await db
      .update(documents)
      .set({ summary: summary })
      .where(eq(documents.id, job.data.documentId));

    const docs = text.map(
      (pageText, index) =>
        new Document({
          pageContent: pageText,
          metadata: {
            source: job.data.filename,
            page: index + 1,
            userId: job.data.userId,
            documentId: job.data.documentId,
          },
        }),
    );

    // 1. Split into chunks
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 500,
      chunkOverlap: 300,
    });
    const chunks = await splitter.splitDocuments(docs);

    const embeddings = new OpenAIEmbeddings({
      apiKey: process.env.OPENAI_API_KEY,
    });
    const vectorStore = await QdrantVectorStore.fromDocuments(
      chunks,
      embeddings,
      { client: qdrantClient, collectionName: "pdf-chunks" },
    );

    await db
      .update(documents)
      .set({ status: "done" })
      .where(eq(documents.id, job.data.documentId));
  },
  {
    concurrency: 100,
    connection: redisConnection,
  },
);

worker.on("failed", async (job, err) => {
  console.error("Job failed:", job.id, err);

  await db
    .update(documents)
    .set({ status: "failed" })
    .where(eq(documents.id, job.data.documentId));
});

worker.on("error", (err) => {
  console.error("Worker error:", err);
});
// worker listens
// worker listens to jobs arriving in the file-upload-queue queue.

// Notice:
// new Queue("file-upload-queue")
// and
// new Worker("file-upload-queue")
// have the same name. That's how they communicate.

// BullMQ fetches the waiting job from Valkey and passes it into: job.

// LangChain is mostly a convenience library.
// Without LangChain:
// Read PDF manually
// Chunk manually
// Call OpenAI manually(for text -> vector embeddings)
// Store in Qdrant manually

// LangChain provides readymade tools for chunking, embeddings, vector stores, and pdf processing.

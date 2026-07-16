import express from "express";
import { getAuth } from "@clerk/express";
import { db } from "../index.js";
import {
  chatSessions,
  documents,
  messages,
  sessionDocuments,
} from "../db/schema.js";
import { and, eq, desc, isNull, inArray } from "drizzle-orm";
import { client as qdrantClient } from "../config/qdrant.js";
import { deleteFromR2 } from "../config/r2.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const sessions = await db
      .select()
      .from(chatSessions)
      .where(
        and(eq(chatSessions.userId, userId), isNull(chatSessions.deletedAt)),
      )
      .orderBy(desc(chatSessions.createdAt));

    return res.status(200).json({ sessions });
  } catch (e) {
    return res.status(500).json({
      error: `Error: ${e}. Check your network/try logging out and in. Sorry.`,
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const session = await db
      .insert(chatSessions)
      .values({ userId, title: req.body.title || "New Chat" })
      .returning();

    return res.status(200).json({ session });
  } catch (e) {
    return res.status(500).json({
      error: `Error: ${e}. Check your network/try logging out and in. Sorry.`,
    });
  }
});

router.get("/:sessionId", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const sessionId = req.params.sessionId;

    const history = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.userId, userId), eq(messages.sessionId, sessionId)),
      )
      .orderBy(messages.createdAt);

    return res.status(200).json({
      messages: history,
    });
  } catch (e) {
    return res.status(500).json({
      error: `Error: ${e}. Check your network/try logging out and in. Sorry.`,
    });
  }
});

router.get("/docs/:sessionId", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const sessionId = req.params.sessionId;
    const sessDocs = await db
      .select()
      .from(sessionDocuments)
      .where(
        and(
          eq(sessionDocuments.userId, userId),
          eq(sessionDocuments.sessionId, sessionId),
        ),
      );
    const docIds = sessDocs.map((sD) => sD.documentId);
    const docsInfo = await db
      .select()
      .from(documents)
      .where(inArray(documents.id, docIds));
    const docs = docsInfo.map((d) => ({
      pdfName: d.filename,
      pdfId: d.id,
      summary: d.summary,
    }));
    if (docs.length === 0) return res.status(200).json({ docs: [] });

    return res.status(200).json({ docs });
  } catch (e) {
    return res.status(500).json({
      error: `Error: ${e}. Check your network/try logging out and in. Sorry.`,
    });
  }
});

router.put("/:sessionId", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const sessionId = req.params.sessionId;
    const newTitle = req.body.newTitle;
    const updatedSessionInfo = await db
      .update(chatSessions)
      .set({ title: newTitle })
      .where(eq(chatSessions.id, sessionId))
      .returning();
    return res.status(200).json({ message: "Title updated successfully." });
  } catch (e) {
    return res.status(500).json({ error: `Couldn't update, error:${e}` });
  }
});

router.delete("/:sessionId", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const sessionId = req.params.sessionId;
    let docIds = await db
      .select()
      .from(sessionDocuments)
      .where(
        and(
          eq(sessionDocuments.userId, userId),
          eq(sessionDocuments.sessionId, sessionId),
        ),
      );
    docIds = docIds.map((d) => d.documentId);

    await db
      .delete(sessionDocuments)
      .where(eq(sessionDocuments.sessionId, sessionId));

    const existingDocs = await db
      .select()
      .from(sessionDocuments)
      .where(
        and(
          eq(sessionDocuments.userId, userId),
          inArray(sessionDocuments.documentId, docIds),
        ),
      );

    const existingDocIds = existingDocs.map((eD) => eD.documentId);

    // Now I have to do docIds-existingDocIds
    const toDelete = docIds.filter((id) => !existingDocIds.includes(id));

    // get the filekeys of the docs to be deleted
    let fileKeys = await db
      .select({ fileKey: documents.fileKey })
      .from(documents)
      .where(inArray(documents.id, toDelete));
    fileKeys = fileKeys.map((fK) => fK.fileKey);

    if (toDelete.length > 0) {
      // delete from documents
      await db.delete(documents).where(inArray(documents.id, toDelete));

      // delete from Qdrant
      await qdrantClient.delete("pdf-chunks", {
        filter: {
          must: [{ key: "metadata.documentId", match: { any: toDelete } }],
        },
      });

      // delete from R2
      for (let i = 0; i < fileKeys.length; i += 1)
        await deleteFromR2(fileKeys[i]);
    }

    // delete from chatSessions
    await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));

    return res
      .status(200)
      .json({ message: "Chat session deletion successful." });
  } catch (e) {
    return res.status(500).json({ error: `Couldn't delete session: ${e}` });
  }
});

router.get("/:docId/summary", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const docId = req.params.docId;
    const [summary] = await db
      .select({ summary: documents.summary })
      .from(documents)
      .where(eq(documents.id, docId));
    const s = summary.summary;
    return res.status(200).json({ summary: s });
  } catch (e) {
    return res.status(500).json({ error: `Something went wrong: ${e}` });
  }
});

export default router;

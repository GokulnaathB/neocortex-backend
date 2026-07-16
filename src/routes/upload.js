import express from "express";
import multer from "multer";
import crypto from "crypto";
import { getAuth } from "@clerk/express";
import { db } from "../index.js";
import { documents, sessionDocuments } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { deleteFromR2, uploadToR2 } from "../config/r2.js";
import { queue as uploadQueue } from "../config/queue.js";
import { client as qdrantClient } from "../config/qdrant.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post(
  "/pdf",
  async (req, res, next) => {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    next();
  },
  upload.single("pdf"),
  async (req, res) => {
    try {
      const { userId } = getAuth(req);
      const { sessionId } = req.body;
      const fileHash = crypto
        .createHash("sha256") // hashing process using the "SHA 256 algorithm"
        .update(req.file.buffer) // feeding the file's content in memory into the hash function.
        .digest("hex"); // the hash computation returned as a readable, standard hexadecimal string.

      // Checking if this user already uploaded this exact file
      const existing = await db
        .select()
        .from(documents)
        .where(
          and(eq(documents.userId, userId), eq(documents.fileHash, fileHash)),
        );

      if (existing.length > 0) {
        const docId = existing[0].id;
        const currSessInfo = await db
          .select()
          .from(sessionDocuments)
          .where(
            and(
              eq(sessionDocuments.sessionId, sessionId),
              eq(sessionDocuments.documentId, docId),
            ),
          );
        if (currSessInfo.length === 0) {
          // Document exists but not in this session — add it
          await db
            .insert(sessionDocuments)
            .values({ userId, sessionId, documentId: docId });
          return res.status(200).json({
            message: "File uploaded",
            docName: existing[0].filename,
            documentId: existing[0].id,
            docSummary: existing[0].summary,
          });
        }

        return res.status(500).json({
          message: "File already uploaded",
        });
      }

      const fileKey = `${userId}/${Date.now()}-${req.file.originalname}`;
      await uploadToR2(req.file.buffer, fileKey);

      // Insert document record
      const [document] = await db
        .insert(documents)
        .values({
          userId: userId,
          filename: req.file.originalname,
          fileKey,
          fileHash,
          summary: "",
          status: "pending",
        })
        .returning();

      await uploadQueue.add("file-upload-queue", {
        filename: req.file.originalname,
        // destination: req.file.destination,
        fileKey,
        // path: req.file.path,
        userId,
        documentId: document.id,
      });

      const [finalDocument] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, document.id));

      await db
        .insert(sessionDocuments)
        .values({ userId, sessionId, documentId: document.id });

      return res.status(200).json({
        message: "uploaded",
        documentId: document.id,
        docName: document.filename,
        docSummary: finalDocument.summary,
      });
    } catch (e) {
      return res.status(500).json({
        error: `Error: ${e}. Check your network/try logging out and in. Sorry.`,
      });
    }
  },
);

router.delete("/pdf", async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { docId, sessionId } = req.body;
    const docInfo = await db
      .delete(sessionDocuments)
      .where(
        and(
          eq(sessionDocuments.documentId, docId),
          eq(sessionDocuments.sessionId, sessionId),
        ),
      )
      .returning();
    const deletedDocId = docInfo[0].documentId;
    const docs = await db
      .select()
      .from(sessionDocuments)
      .where(
        and(
          eq(sessionDocuments.userId, userId),
          eq(sessionDocuments.documentId, deletedDocId),
        ),
      );
    if (docs.length > 0)
      return res
        .status(200)
        .json({ message: "PDF deleted.", idOfDeletedDoc: deletedDocId });
    const [deletedDoc] = await db
      .delete(documents)
      .where(eq(documents.id, deletedDocId))
      .returning();
    await qdrantClient.delete("pdf-chunks", {
      filter: {
        must: [
          { key: "metadata.userId", match: { value: userId } },
          { key: "metadata.documentId", match: { value: deletedDocId } },
        ],
      },
    });
    const filekey = deletedDoc.fileKey;
    await deleteFromR2(filekey);
    return res.status(200).json({
      message: "File deleted successfully.",
      idOfDeletedDoc: deletedDoc.id,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ error: "Couldn't delete, trying logging out and logging in." });
  }
});

export default router;

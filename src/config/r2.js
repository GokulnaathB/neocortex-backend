import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  },
});

async function uploadToR2(buffer, fileKey) {
  await r2Client.send(
    new PutObjectCommand({
      Bucket: process.env.CLOUDFLARE_BUCKET_NAME,
      Key: fileKey,
      Body: buffer,
      ContentType: "application/pdf",
    }),
  );
}

async function downloadFromR2(fileKey) {
  const response = await r2Client.send(
    new GetObjectCommand({
      Bucket: process.env.CLOUDFLARE_BUCKET_NAME,
      Key: fileKey,
    }),
  );
  // What exactly does await r2Client.send(GetObjectCommand) wait for?
  /* 
      It waits for R2 to:

      1. Receive your request
      2. Find the file
      3. Send back the headers (metadata — file size, type, status 200 OK etc.)
      4. Open the stream pipe — ready to start sending data (response.Body is the stream pipe)
       */

  /* 
      The connection is still open after await r2Client.send(). That's the whole point. await r2Client.send() only waits for:
      Connection to be established with Cloudflare
      Headers to arrive
      Stream pipe to be opened and ready

      The connection stays open after that. Cloudflare is still on the other end, actively sending the file bytes through that open connection.
      The connection only closes when: All the bytes have been sent (end of file)
       */

  const chunks = [];

  /*
      This loops over the stream, waiting for each piece (chunk) to arrive. for await is used because each chunk arrives asynchronously — you have to wait for each one before the next comes.
      */
  for await (const chunk of response.Body) {
    // each chunk is a buffer, each buffer is just raw bytes.
    // the stream delivered the PDF data in small chunks (each <Buffer ...> is one chunk that arrived through the stream pipe).
    chunks.push(chunk);
  }
  // Connection closes.
  return new Uint8Array(Buffer.concat(chunks)); // an array of 8-bit unsigned integers.
}

async function deleteFromR2(fileKey) {
  await r2Client.send(
    new DeleteObjectCommand({
      Bucket: process.env.CLOUDFLARE_BUCKET_NAME,
      Key: fileKey,
    }),
  );
}

export { r2Client, uploadToR2, downloadFromR2, deleteFromR2 };

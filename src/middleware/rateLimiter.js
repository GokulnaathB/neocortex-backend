import { Redis } from "ioredis";
import crypto from "crypto";
import { getAuth } from "@clerk/express";

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const WINDOW_SIZE = 60; //seconds
const MAX_REQUESTS = 2; // per window

// export const rateLimiter = async (req, res, next) => {
// Logic goes here
//   const { userId } = req.auth;
//   if (!userId) return res.status(401).json({ error: "Unauthorized" });

//   const key = `rate_limit:${userId}`;

//   const now = Date.now();
//   const windowStart = now - WINDOW_SIZE * 1000;

//   await redis.zremrangebyscore(key, 0, windowStart);

//   const requestCount = await redis.zcard(key); // count

//   if (requestCount >= MAX_REQUESTS) {
//     return res.status(429).json({
//       error: "Too many requests. Please slow down.",
//       retryAfter: WINDOW_SIZE,
//     });
//   }

//   await redis.zadd(key, now, now.toString()); // ZADD key score member
//   Redis sorted-set members are strings/binary-safe values.

//   Imagine a user makes one request and never uses our application again. Their Redis key contains that old timestamp. Without the following, that key could remain in Redis indefinitely unless something else cleaned it up, which is not memory efficient if we eventually have a huge number of users.
//   await redis.expire(key, WINDOW_SIZE); // "Delete this key if it remains completely unused for 60 seconds."

//   next();
// }; // This implementation has a race condition. Right now, zremrangebyscore, zcard, zadd, and expire are separate Redis operations. Imagine a user sends two requests at almost exactly the same time. Req. A could do zcard and before it updates its key, req. B could do zcard and read the same value as read by A and hence both A and B proceed to /chat, which is not intended.
// Solution: make these four operations together an atomic unit for a request. Instead of sending Redis these four operations as independent commands, we'll send one Lua script containing all four operations. Redis executes the Lua script atomically.  While Redis is running one Lua script, it cannot execute another Lua script, nor can it process any other incoming Redis commands.
// The operations inside our atomic unit cannot be interleaved with operations from another request.

// Sorted-set is key: {member1: score1, member2: score2, ...}
// Also, Date.now() has only millisecond resolution, two requests can theoretically have the exact same timestamp. Redis sorted-set members must be unique. So, adding the same member twice doesn't create two entries. The second ZADD updates/replaces the existing member.

// Correct implementation is as follows:

const rateLimitScript = `
  redis.call("ZREMRANGEBYSCORE", KEYS[1], 0, ARGV[1])

  local requestCount = redis.call("ZCARD", KEYS[1])

  if requestCount >= tonumber(ARGV[2]) then
    return 0
  end

  redis.call("ZADD", KEYS[1], ARGV[3], ARGV[4])

  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[5]))

  return 1
  `;

export const rateLimiter = async (req, res, next) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const key = `rate_limit:${userId}`;

    const now = Date.now();
    const windowStart = now - WINDOW_SIZE * 1000;
    const member = `${now}-${crypto.randomUUID()}`;

    const allowed = await redis.eval(
      rateLimitScript,
      1,
      key, //KEYS[1]
      windowStart, // ARGV[1]
      MAX_REQUESTS, // ARGV[2]
      now, // ARGV[3]
      member, // ARGV[4]
      WINDOW_SIZE, // ARGV[5]
    );

    if (allowed === 0)
      return res.status(429).json({
        error: "Too many requests. Please slow down.",
        retryAfter: WINDOW_SIZE,
      });
    next();
  } catch (e) {
    console.log("Rate limiter error:", e);

    // Fail open: If the rate limiter itself fails, then allow the request.
    next();
  }
};

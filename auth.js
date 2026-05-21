/**
 * Tutor Kay — Cross-session memory auth module
 * Copyright © 2026 Radhika Kolachina. All rights reserved.
 *
 * Mounts passkey (WebAuthn) + recovery-phrase auth routes on an existing
 * Express app, plus authenticated /state and /account endpoints.
 *
 * Design summary:
 *   - Anonymous-account pattern: server generates a random pseudonym
 *     ("purple-tiger-7421") and a discoverable passkey for the user.
 *     No PII collected.
 *   - EFF diceware 6-word recovery phrase (77 bits entropy) as
 *     cross-device / lost-passkey fallback.
 *   - Bearer-token sessions (NOT cookies) stored server-side in Redis,
 *     so the cross-origin Cloudflare-frontend ↔ Render-backend split
 *     doesn't hit Safari ITP third-party-cookie problems.
 *
 * Redis key layout (under kay:staging:* prefix):
 *   user:{pseudonym}            → { createdAt, lastSeenAt, recoveryHash }
 *   passkey:{credentialIdB64}   → { pseudonym, publicKeyB64, counter,
 *                                   transports, createdAt }
 *   pseudonymIndex:{pseudonym}  → SET of credentialIdB64 (for revoke-all)
 *   state:{pseudonym}           → opaque JSON blob (mastery + practice +
 *                                   session-titles only — NEVER chat content)
 *   session:{token}             → { pseudonym, createdAt } with 30-day TTL
 *   recoveryLookup:{hmacHex}    → pseudonym (fast O(1) phrase lookup)
 *   challenge:reg:{nonce}       → { pseudonym, challenge } with 5-min TTL
 *   challenge:auth:{nonce}      → challenge with 5-min TTL
 *   challenge:add:{pseudonym}   → challenge with 5-min TTL
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const argon2 = require('@node-rs/argon2');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

// ── Env-var validation ──────────────────────────────────────────────────────
// Required at module load. Failing here surfaces config problems at deploy
// time rather than at the first request, which is much easier to debug.
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`auth.js: required env var ${name} is not set`);
  return v;
}

const RP_ID                  = requireEnv('RP_ID');                  // e.g. "kay-staging.pages.dev"
const RP_NAME                = process.env.RP_NAME || 'Tutor Kay';
const EXPECTED_ORIGIN        = requireEnv('EXPECTED_ORIGIN');        // e.g. "https://kay-staging.pages.dev"
const RECOVERY_LOOKUP_SECRET = requireEnv('RECOVERY_LOOKUP_SECRET'); // 32+ random bytes (base64)
const KAY_NS                 = process.env.KAY_NS || 'kay:staging';

// Session TTL: 30 days, rolling (extended on each use)
const SESSION_TTL_SECONDS    = 30 * 24 * 60 * 60;
// Challenge TTL: 5 min (must complete the WebAuthn ceremony in this window)
const CHALLENGE_TTL_SECONDS  = 5 * 60;

// ── EFF diceware wordlist ───────────────────────────────────────────────────
// Loaded once at module init. Canonical 7,776-word EFF Long Wordlist.
// 6 words → 77 bits of entropy → infeasible to brute-force.
const WORDLIST_PATH = path.join(__dirname, 'eff-wordlist.json');
const EFF_WORDLIST = JSON.parse(fs.readFileSync(WORDLIST_PATH, 'utf-8'));
if (EFF_WORDLIST.length !== 7776) {
  throw new Error(`auth.js: eff-wordlist.json must have exactly 7776 entries, got ${EFF_WORDLIST.length}`);
}

// ── Pseudonym generator ─────────────────────────────────────────────────────
// Docker-style: adjective + noun + 4-digit number. ~50K possibilities per
// adjective×noun pair × 10K numbers = plenty for non-collision at our scale.
// On the rare collision we re-roll once.
const ADJECTIVES = [
  'amber','azure','brave','bright','calm','cheerful','clever','cosmic','crimson',
  'curious','daring','dazzling','dreamy','eager','emerald','fearless','fierce',
  'gentle','glowing','golden','graceful','happy','honest','jolly','keen','kind',
  'lively','loyal','lucky','merry','mighty','noble','peaceful','quick','quiet',
  'radiant','rapid','rosy','sapphire','silent','silver','sleek','spry','steady',
  'stellar','sunny','swift','tidy','vivid','warm','witty','zesty',
];
const NOUNS = [
  'badger','bear','beetle','butterfly','cat','cheetah','crane','crow','deer',
  'dolphin','dragon','eagle','falcon','ferret','finch','fox','gecko','hare',
  'hawk','heron','iguana','jackal','jay','koala','lemur','lion','lizard','lynx',
  'magpie','manta','marlin','moose','newt','ocelot','octopus','orca','otter',
  'owl','panda','panther','parrot','penguin','phoenix','quail','rabbit','raven',
  'salmon','seal','shark','sloth','sparrow','squid','stag','swan','tiger','tortoise',
  'turtle','wolf','wombat','wren',
];

function generatePseudonym() {
  const adj  = ADJECTIVES[crypto.randomInt(ADJECTIVES.length)];
  const noun = NOUNS[crypto.randomInt(NOUNS.length)];
  const num  = String(crypto.randomInt(10000)).padStart(4, '0');
  return `${adj}-${noun}-${num}`;
}

// Returns a UTF-8 Uint8Array of the pseudonym — used as the WebAuthn user.id.
// Deterministic: same pseudonym always maps to the same userID bytes.
function pseudonymToUserID(pseudonym) {
  return new Uint8Array(Buffer.from(pseudonym, 'utf-8'));
}

// ── Recovery phrase generation, hashing, lookup ─────────────────────────────
// Six words separated by spaces. We accept any whitespace separator on input
// (user may copy from a wrapped display), and lowercase on both sides.
function generateRecoveryPhrase() {
  const words = [];
  for (let i = 0; i < 6; i++) {
    words.push(EFF_WORDLIST[crypto.randomInt(EFF_WORDLIST.length)]);
  }
  return words.join(' ');
}

function normalizePhrase(phrase) {
  return String(phrase || '').toLowerCase().trim().split(/\s+/).join(' ');
}

// Argon2id with sensible defaults for Render's free-tier CPU.
// memoryCost 19MB, time cost 2, parallelism 1 — fast enough to verify in
// well under a second on a cold-started instance, slow enough that brute-
// forcing a 77-bit phrase remains infeasible.
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };

async function hashPhrase(phrase) {
  return argon2.hash(normalizePhrase(phrase), ARGON_OPTS);
}

async function verifyPhraseHash(phrase, encodedHash) {
  try {
    return await argon2.verify(encodedHash, normalizePhrase(phrase));
  } catch {
    return false;
  }
}

// Fast O(1) lookup key for a recovery phrase. HMAC with a server secret so
// an attacker who only has the DB can't compute it for guesses. Verified
// against the argon2 hash afterward for defense in depth.
function recoveryLookupKey(phrase) {
  return crypto
    .createHmac('sha256', RECOVERY_LOOKUP_SECRET)
    .update(normalizePhrase(phrase))
    .digest('hex');
}

// ── Session tokens ──────────────────────────────────────────────────────────
function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateNonce() {
  return crypto.randomBytes(16).toString('base64url');
}

// ── Redis key helpers ───────────────────────────────────────────────────────
const k = {
  user:           p => `${KAY_NS}:user:${p}`,
  passkey:        c => `${KAY_NS}:passkey:${c}`,
  pseudonymIndex: p => `${KAY_NS}:pseudonymIndex:${p}`,
  state:          p => `${KAY_NS}:state:${p}`,
  session:        t => `${KAY_NS}:session:${t}`,
  recoveryLookup: h => `${KAY_NS}:recoveryLookup:${h}`,
  challengeReg:   n => `${KAY_NS}:challenge:reg:${n}`,
  challengeAuth:  n => `${KAY_NS}:challenge:auth:${n}`,
  challengeAdd:   p => `${KAY_NS}:challenge:add:${p}`,
};

// ── Module entry point ──────────────────────────────────────────────────────
// Call mountAuth(app, redis) once at server startup. `redis` is the Upstash
// client instance (the same one the rest of the app uses for stats).
function mountAuth(app, redis) {

  // ── Auth middleware ──────────────────────────────────────────────────────
  // Reads `Authorization: Bearer <token>`, resolves to a pseudonym, sets
  // req.user.pseudonym. On any failure (missing/expired/invalid) returns
  // 401 — no leaking which case it was.
  async function requireAuth(req, res, next) {
    try {
      const header = req.get('Authorization') || '';
      const match = header.match(/^Bearer\s+(\S+)$/);
      if (!match) return res.status(401).json({ error: 'unauthenticated' });

      const token = match[1];
      const raw = await redis.get(k.session(token));
      if (!raw) return res.status(401).json({ error: 'unauthenticated' });

      const session = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!session || !session.pseudonym) {
        return res.status(401).json({ error: 'unauthenticated' });
      }

      // Rolling TTL — every authenticated request extends the session.
      // (lastSeenAt on the user record is updated on /state writes, not every
      // request — saves a read+write per call.)
      await redis.expire(k.session(token), SESSION_TTL_SECONDS);

      req.user = { pseudonym: session.pseudonym, token };
      next();
    } catch (err) {
      console.error('requireAuth error:', err);
      res.status(401).json({ error: 'unauthenticated' });
    }
  }

  // ── Register (first-time signup, no auth required) ────────────────────────
  // Two-step ceremony: client requests options (with a fresh challenge), then
  // posts the registration response back. We store the challenge keyed by a
  // server-issued nonce so we can validate it on the verify step without
  // trusting the client to echo it back unchanged.
  //
  // Returns: { nonce, pseudonym, options }
  app.post('/auth/passkey/register/options', async (req, res) => {
    try {
      const pseudonym = generatePseudonym();
      const userID = pseudonymToUserID(pseudonym);

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID:   RP_ID,
        userID,
        userName:        pseudonym,
        userDisplayName: pseudonym,   // Chrome requires non-empty + matching userName
        attestationType: 'none',
        authenticatorSelection: {
          residentKey:       'required',
          userVerification:  'preferred',
        },
        excludeCredentials: [],
      });

      const nonce = generateNonce();
      await redis.set(
        k.challengeReg(nonce),
        JSON.stringify({ pseudonym, challenge: options.challenge }),
        { ex: CHALLENGE_TTL_SECONDS },
      );

      res.json({ nonce, pseudonym, options });
    } catch (err) {
      console.error('register/options error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Body: { nonce, registrationResponse }
  // On success: stores credential + creates user + issues recovery phrase +
  // returns a session token and the phrase (shown once to the user).
  app.post('/auth/passkey/register/verify', async (req, res) => {
    try {
      const { nonce, registrationResponse } = req.body || {};
      if (!nonce || !registrationResponse) {
        return res.status(400).json({ error: 'missing nonce or registrationResponse' });
      }

      const raw = await redis.get(k.challengeReg(nonce));
      if (!raw) return res.status(400).json({ error: 'challenge expired or unknown' });
      const { pseudonym, challenge } = typeof raw === 'string' ? JSON.parse(raw) : raw;
      // One-shot: delete the challenge immediately so it can't be replayed.
      await redis.del(k.challengeReg(nonce));

      const verification = await verifyRegistrationResponse({
        response:           registrationResponse,
        expectedChallenge:  challenge,
        expectedOrigin:     EXPECTED_ORIGIN,
        expectedRPID:       RP_ID,
        requireUserVerification: false,
      });

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'registration not verified' });
      }

      const { credential } = verification.registrationInfo;
      // credential.id is a base64url string; credential.publicKey is a Uint8Array.
      const credentialId = credential.id;
      const publicKeyB64 = Buffer.from(credential.publicKey).toString('base64url');

      // Generate recovery phrase + hash + lookup key BEFORE writing anything,
      // so a hash failure doesn't leave a half-created user record.
      const recoveryPhrase = generateRecoveryPhrase();
      const recoveryHash   = await hashPhrase(recoveryPhrase);
      const lookupKey      = recoveryLookupKey(recoveryPhrase);

      const now = Date.now();

      // Persist user record. recoveryLookupKey is stored so we can clean
      // up the reverse-index entry on /account delete (hashes are one-way).
      await redis.set(k.user(pseudonym), JSON.stringify({
        createdAt:  now,
        lastSeenAt: now,
        recoveryHash,
        recoveryLookupKey: lookupKey,
      }));

      // Persist credential
      await redis.set(k.passkey(credentialId), JSON.stringify({
        pseudonym,
        publicKeyB64,
        counter:    credential.counter || 0,
        transports: credential.transports || [],
        createdAt:  now,
      }));

      // Index credential under this pseudonym (for revoke-all on delete)
      await redis.sadd(k.pseudonymIndex(pseudonym), credentialId);

      // Index recovery phrase HMAC → pseudonym (for O(1) lookup on recovery)
      await redis.set(k.recoveryLookup(lookupKey), pseudonym);

      // Initialize empty state blob
      await redis.set(k.state(pseudonym), JSON.stringify({
        mastery: {},
        practiceStats: {},
        sessions: [],
        updatedAt: now,
      }));

      // Issue session token
      const sessionToken = generateSessionToken();
      await redis.set(
        k.session(sessionToken),
        JSON.stringify({ pseudonym, createdAt: now }),
        { ex: SESSION_TTL_SECONDS },
      );

      res.json({
        pseudonym,
        sessionToken,
        recoveryPhrase,  // shown ONCE to the user; never returned again
      });
    } catch (err) {
      console.error('register/verify error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Authenticate (returning user with passkey on this device) ─────────────
  // Usernameless / discoverable-credential flow: server doesn't know which
  // user is logging in until the browser picks a passkey and posts back.
  app.post('/auth/passkey/authenticate/options', async (req, res) => {
    try {
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials: [],        // discoverable credentials only
        userVerification: 'preferred',
      });

      const nonce = generateNonce();
      await redis.set(
        k.challengeAuth(nonce),
        options.challenge,
        { ex: CHALLENGE_TTL_SECONDS },
      );

      res.json({ nonce, options });
    } catch (err) {
      console.error('authenticate/options error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Body: { nonce, authenticationResponse }
  app.post('/auth/passkey/authenticate/verify', async (req, res) => {
    try {
      const { nonce, authenticationResponse } = req.body || {};
      if (!nonce || !authenticationResponse) {
        return res.status(400).json({ error: 'missing nonce or authenticationResponse' });
      }

      const challenge = await redis.get(k.challengeAuth(nonce));
      if (!challenge) return res.status(400).json({ error: 'challenge expired or unknown' });
      await redis.del(k.challengeAuth(nonce));

      const credentialId = authenticationResponse.id;
      if (!credentialId) return res.status(400).json({ error: 'missing credential id' });

      const credRaw = await redis.get(k.passkey(credentialId));
      if (!credRaw) return res.status(401).json({ error: 'unknown credential' });
      const credRec = typeof credRaw === 'string' ? JSON.parse(credRaw) : credRaw;

      const verification = await verifyAuthenticationResponse({
        response:           authenticationResponse,
        expectedChallenge:  challenge,
        expectedOrigin:     EXPECTED_ORIGIN,
        expectedRPID:       RP_ID,
        credential: {
          id:         credentialId,
          publicKey:  new Uint8Array(Buffer.from(credRec.publicKeyB64, 'base64url')),
          counter:    credRec.counter || 0,
          transports: credRec.transports || [],
        },
        requireUserVerification: false,
      });

      if (!verification.verified || !verification.authenticationInfo) {
        return res.status(401).json({ error: 'authentication not verified' });
      }

      // Update counter (defense against cloned authenticators)
      const newCounter = verification.authenticationInfo.newCounter;
      await redis.set(k.passkey(credentialId), JSON.stringify({
        ...credRec,
        counter: newCounter,
      }));

      // Issue session
      const sessionToken = generateSessionToken();
      await redis.set(
        k.session(sessionToken),
        JSON.stringify({ pseudonym: credRec.pseudonym, createdAt: Date.now() }),
        { ex: SESSION_TTL_SECONDS },
      );

      res.json({ pseudonym: credRec.pseudonym, sessionToken });
    } catch (err) {
      console.error('authenticate/verify error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Recovery (lost passkey or new device) ────────────────────────────────
  // Body: { phrase }
  // Issues a session immediately on a valid phrase. The frontend should then
  // prompt the user to add a passkey on this device via /auth/passkey/add/*.
  app.post('/auth/recovery/redeem', async (req, res) => {
    try {
      const { phrase } = req.body || {};
      if (!phrase) return res.status(400).json({ error: 'phrase required' });

      const lookupKey = recoveryLookupKey(phrase);
      const pseudonym = await redis.get(k.recoveryLookup(lookupKey));
      if (!pseudonym) return res.status(401).json({ error: 'invalid phrase' });

      const userRaw = await redis.get(k.user(pseudonym));
      if (!userRaw) return res.status(401).json({ error: 'invalid phrase' });
      const user = typeof userRaw === 'string' ? JSON.parse(userRaw) : userRaw;

      // Defense in depth: also verify argon2 hash. If the HMAC matched but
      // argon2 doesn't, something is very wrong — refuse and log.
      const argonOK = await verifyPhraseHash(phrase, user.recoveryHash);
      if (!argonOK) {
        console.error(`recovery: HMAC matched but argon2 didn't for pseudonym=${pseudonym}`);
        return res.status(401).json({ error: 'invalid phrase' });
      }

      const sessionToken = generateSessionToken();
      await redis.set(
        k.session(sessionToken),
        JSON.stringify({ pseudonym, createdAt: Date.now() }),
        { ex: SESSION_TTL_SECONDS },
      );

      res.json({ pseudonym, sessionToken });
    } catch (err) {
      console.error('recovery/redeem error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Add a passkey to an existing account (auth required) ─────────────────
  // Used after recovery on a new device so the user doesn't need the phrase
  // every time. Also usable to add a second passkey to an existing device.
  app.post('/auth/passkey/add/options', requireAuth, async (req, res) => {
    try {
      const { pseudonym } = req.user;
      const userID = pseudonymToUserID(pseudonym);

      // Build excludeCredentials so the browser doesn't offer to overwrite
      // an existing credential.
      const existingIds = await redis.smembers(k.pseudonymIndex(pseudonym));
      const excludeCredentials = (existingIds || []).map(id => ({
        id, type: 'public-key',
      }));

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID:   RP_ID,
        userID,
        userName:        pseudonym,
        userDisplayName: pseudonym,
        attestationType: 'none',
        authenticatorSelection: {
          residentKey:      'required',
          userVerification: 'preferred',
        },
        excludeCredentials,
      });

      await redis.set(
        k.challengeAdd(pseudonym),
        options.challenge,
        { ex: CHALLENGE_TTL_SECONDS },
      );

      res.json({ options });
    } catch (err) {
      console.error('passkey/add/options error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Body: { registrationResponse }
  app.post('/auth/passkey/add/verify', requireAuth, async (req, res) => {
    try {
      const { pseudonym } = req.user;
      const { registrationResponse } = req.body || {};
      if (!registrationResponse) return res.status(400).json({ error: 'missing registrationResponse' });

      const challenge = await redis.get(k.challengeAdd(pseudonym));
      if (!challenge) return res.status(400).json({ error: 'challenge expired or unknown' });
      await redis.del(k.challengeAdd(pseudonym));

      const verification = await verifyRegistrationResponse({
        response:          registrationResponse,
        expectedChallenge: challenge,
        expectedOrigin:    EXPECTED_ORIGIN,
        expectedRPID:      RP_ID,
        requireUserVerification: false,
      });

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'registration not verified' });
      }

      const { credential } = verification.registrationInfo;
      const credentialId = credential.id;
      const publicKeyB64 = Buffer.from(credential.publicKey).toString('base64url');

      await redis.set(k.passkey(credentialId), JSON.stringify({
        pseudonym,
        publicKeyB64,
        counter:    credential.counter || 0,
        transports: credential.transports || [],
        createdAt:  Date.now(),
      }));
      await redis.sadd(k.pseudonymIndex(pseudonym), credentialId);

      res.json({ ok: true, credentialId });
    } catch (err) {
      console.error('passkey/add/verify error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── State sync (auth required) ───────────────────────────────────────────
  // GET → return the user's state blob (mastery + practice + session names).
  // POST → replace it (last-write-wins; frontend is the source of truth for
  // now, server is just a mirror). NEVER stores chat content.
  app.get('/state', requireAuth, async (req, res) => {
    try {
      const raw = await redis.get(k.state(req.user.pseudonym));
      const state = raw
        ? (typeof raw === 'string' ? JSON.parse(raw) : raw)
        : { mastery: {}, practiceStats: {}, sessions: [], updatedAt: 0 };
      res.json({ pseudonym: req.user.pseudonym, state });
    } catch (err) {
      console.error('GET /state error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/state', requireAuth, async (req, res) => {
    try {
      const { state } = req.body || {};
      if (!state || typeof state !== 'object') {
        return res.status(400).json({ error: 'state object required' });
      }
      // Whitelist the fields we accept — defense against the client trying
      // to stash chat content (or arbitrary blobs) here.
      const sanitized = {
        mastery:        (state.mastery && typeof state.mastery === 'object') ? state.mastery : {},
        practiceStats:  (state.practiceStats && typeof state.practiceStats === 'object') ? state.practiceStats : {},
        sessions:       Array.isArray(state.sessions)
          ? state.sessions.map(s => ({
              id:        String(s.id || ''),
              title:     String(s.title || '').slice(0, 200),
              createdAt: Number(s.createdAt) || 0,
              updatedAt: Number(s.updatedAt) || 0,
            }))
          : [],
        updatedAt: Date.now(),
      };
      await redis.set(k.state(req.user.pseudonym), JSON.stringify(sanitized));
      res.json({ ok: true, updatedAt: sanitized.updatedAt });
    } catch (err) {
      console.error('POST /state error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Logout — invalidate the current session token ────────────────────────
  app.post('/auth/logout', requireAuth, async (req, res) => {
    try {
      await redis.del(k.session(req.user.token));
      res.json({ ok: true });
    } catch (err) {
      console.error('logout error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Delete account — full wipe (auth required, GDPR/CCPA hygiene) ─────────
  // Removes: user record, every credential, the credential index, state blob,
  // recovery lookup entry, and the current session. Other sessions (e.g. an
  // older device still logged in) become orphaned — the underlying user
  // record is gone so requireAuth will fail for them on next request.
  app.delete('/account', requireAuth, async (req, res) => {
    try {
      const { pseudonym } = req.user;

      // Gather credential ids first so we can delete every passkey record
      const credIds = (await redis.smembers(k.pseudonymIndex(pseudonym))) || [];
      for (const id of credIds) {
        await redis.del(k.passkey(id));
      }
      await redis.del(k.pseudonymIndex(pseudonym));
      await redis.del(k.state(pseudonym));

      // Find + delete the recovery lookup entry (key stored on user record).
      const userRaw = await redis.get(k.user(pseudonym));
      if (userRaw) {
        const user = typeof userRaw === 'string' ? JSON.parse(userRaw) : userRaw;
        if (user.recoveryLookupKey) {
          await redis.del(k.recoveryLookup(user.recoveryLookupKey));
        }
      }
      await redis.del(k.user(pseudonym));
      await redis.del(k.session(req.user.token));

      res.json({ ok: true });
    } catch (err) {
      console.error('DELETE /account error:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mountAuth };

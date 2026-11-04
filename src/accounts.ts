// Account rules that don't need the database: validating what someone signs
// up with, and hashing passphrases and session tokens. Kept pure so
// spec/accounts-logic.test.ts can check them without a running server.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Async: scrypt is deliberately slow (~40ms), and the sync version would
// block every live update while one person signs in.
const scrypt = promisify(scryptCb) as (pass: string, salt: Buffer, len: number) => Promise<Buffer>;

// Other users only ever see the handle. Full name and student ID are held
// server-side for record keeping and returned only to their owner.
export interface SignupInput {
  handle: string;
  fullName: string;
  studentId: string;
  passphrase: string;
  consent: boolean;
}

export const HANDLE_RE = /^[A-Za-z0-9_.-]{3,24}$/;
// ANU's format: "u" followed by seven digits. Format only: there's no way to
// check a number really belongs to the person typing it (see CLAUDE.md).
export const STUDENT_ID_RE = /^u\d{7}$/;
export const PASSPHRASE_MIN = 10;
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

// Words a handle can't be, because the activity log and UI already use them
// for people who aren't signed in or no longer exist.
const RESERVED_HANDLES = new Set(["anonymous", "deleted", "deleted-user", "system", "admin"]);

export type SignupResult = { ok: true; value: SignupInput } | { ok: false; error: string };

export function validateSignup(body: Record<string, unknown>): SignupResult {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const handle = str(body.handle);
  const fullName = str(body.fullName).replace(/\s+/g, " ");
  const studentId = str(body.studentId).toLowerCase();
  const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";

  if (!HANDLE_RE.test(handle)) {
    return { ok: false, error: "Handle must be 3–24 letters, numbers, dots, dashes or underscores." };
  }
  if (RESERVED_HANDLES.has(handle.toLowerCase())) {
    return { ok: false, error: "That handle is reserved. Pick another." };
  }
  if (fullName.length < 2 || fullName.length > 80) {
    return { ok: false, error: "Enter your full name (2–80 characters)." };
  }
  if (!STUDENT_ID_RE.test(studentId)) {
    return { ok: false, error: "Student ID must look like u1234567." };
  }
  if (passphrase.length < PASSPHRASE_MIN || passphrase.length > 200) {
    return { ok: false, error: `Passphrase must be at least ${PASSPHRASE_MIN} characters.` };
  }
  if (body.consent !== true) {
    return { ok: false, error: "You need to agree to the privacy notice to make an account." };
  }
  return { ok: true, value: { handle, fullName, studentId, passphrase, consent: true } };
}

// scrypt with a per-user salt; stored as "salt:hash", both hex.
export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(passphrase, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) return false;
  const actual = await scrypt(passphrase, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

// Session tokens live only in the user's cookie; the database stores a hash,
// so a copy of the database can't be used to sign in as anyone.
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  return `session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "session") return v.join("=") || null;
  }
  return null;
}

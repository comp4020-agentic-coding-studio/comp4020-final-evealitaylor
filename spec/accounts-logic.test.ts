import { describe, expect, it } from "vitest";
import {
  hashPassphrase,
  hashSessionToken,
  readSessionCookie,
  sessionCookie,
  validateSignup,
  verifyPassphrase,
} from "../src/accounts.ts";

// Pure account rules, no server needed.

const good = {
  handle: "sam_h",
  fullName: "Sam Holloway",
  studentId: "u7654321",
  passphrase: "long enough phrase",
  consent: true,
};

describe("validateSignup", () => {
  it("accepts a well-formed signup and normalises it", () => {
    const r = validateSignup({ ...good, fullName: "  Sam   Holloway ", studentId: "U7654321" });
    expect(r).toEqual({ ok: true, value: { ...good, fullName: "Sam Holloway", studentId: "u7654321" } });
  });

  it("requires explicit consent to store name and student ID", () => {
    expect(validateSignup({ ...good, consent: false }).ok).toBe(false);
    expect(validateSignup({ ...good, consent: "true" }).ok).toBe(false);
    const { consent: _, ...noConsent } = good;
    expect(validateSignup(noConsent).ok).toBe(false);
  });

  it("only accepts ANU-format student IDs", () => {
    for (const id of ["1234567", "u123456", "u12345678", "a1234567", "u12e4567", ""]) {
      expect(validateSignup({ ...good, studentId: id }).ok, id).toBe(false);
    }
  });

  it("rejects handles that would impersonate the log's own labels", () => {
    for (const handle of ["Anonymous", "deleted", "deleted-user", "admin"]) {
      expect(validateSignup({ ...good, handle }).ok, handle).toBe(false);
    }
  });

  it("rejects malformed handles, names and short passphrases", () => {
    expect(validateSignup({ ...good, handle: "ab" }).ok).toBe(false);
    expect(validateSignup({ ...good, handle: "has space" }).ok).toBe(false);
    expect(validateSignup({ ...good, handle: "<script>" }).ok).toBe(false);
    expect(validateSignup({ ...good, fullName: "x" }).ok).toBe(false);
    expect(validateSignup({ ...good, passphrase: "short" }).ok).toBe(false);
  });
});

describe("passphrases and sessions", () => {
  it("stores passphrases salted, so two identical passphrases hash differently", () => {
    const a = hashPassphrase("same passphrase");
    const b = hashPassphrase("same passphrase");
    expect(a).not.toBe(b);
    expect(a).not.toContain("same passphrase");
    expect(verifyPassphrase("same passphrase", a)).toBe(true);
    expect(verifyPassphrase("same passphrase", b)).toBe(true);
    expect(verifyPassphrase("wrong passphrase", a)).toBe(false);
    expect(verifyPassphrase("same passphrase", "garbage")).toBe(false);
  });

  it("stores only a hash of the session token", () => {
    expect(hashSessionToken("abc")).not.toContain("abc");
    expect(hashSessionToken("abc")).toBe(hashSessionToken("abc"));
  });

  it("sets an HttpOnly, SameSite cookie, Secure over https", () => {
    const c = sessionCookie("tok", true);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Secure");
    expect(sessionCookie("tok", false)).not.toContain("Secure");
    expect(readSessionCookie(`a=1; session=tok; b=2`)).toBe("tok");
    expect(readSessionCookie(undefined)).toBeNull();
  });
});

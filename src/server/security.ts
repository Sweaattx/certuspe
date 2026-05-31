import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import type { Role } from "../shared/types";

export interface PasswordRecord {
  passwordHash: string;
}

export interface Session {
  token: string;
  userId: string;
  role: Role;
  expiresAt: number;
}

const sessionDurationMs = 1000 * 60 * 60 * 8;

export function createPasswordRecord(password: string): PasswordRecord {
  return {
    passwordHash: bcrypt.hashSync(password, 12)
  };
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  return bcrypt.compareSync(password, passwordHash);
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function sessionSecret(): string {
  return process.env.CERTUS_SESSION_SECRET ?? process.env.CERTUS_DATA_KEY ?? "certus-local-session-secret";
}

function signSessionPayload(payload: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function createSession(userId: string, role: Role): Session {
  const expiresAt = Date.now() + sessionDurationMs;
  const payload = base64Url(
    JSON.stringify({
      userId,
      role,
      expiresAt,
      nonce: crypto.randomBytes(12).toString("base64url")
    })
  );
  const token = `${payload}.${signSessionPayload(payload)}`;
  const session: Session = {
    token,
    userId,
    role,
    expiresAt
  };
  return session;
}

export function getSession(token: string | null): Session | null {
  if (!token) {
    return null;
  }
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return null;
  }
  const expectedSignature = signSessionPayload(payload);
  if (
    signature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  ) {
    return null;
  }

  const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Omit<Session, "token">;
  if (session.expiresAt <= Date.now()) {
    return null;
  }
  return { ...session, token };
}

export function destroySession(token: string): void {
  void token;
}

function getKeyFilePath(): string {
  return path.join(process.cwd(), "data", ".certus-key");
}

function getEncryptionKey(): Buffer {
  const envKey = process.env.CERTUS_DATA_KEY;
  if (envKey && envKey.length >= 32) {
    return crypto.createHash("sha256").update(envKey).digest();
  }
  if (process.env.VERCEL === "1") {
    throw new Error("CERTUS_DATA_KEY debe estar configurado en Vercel para cifrar respaldos.");
  }

  const keyPath = getKeyFilePath();
  if (!fs.existsSync(path.dirname(keyPath))) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  }
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(keyPath, "utf8"), "base64");
}

export function encryptPayload(plainText: string): { encryptedPayload: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encryptedPayload: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64")
  };
}

export function decryptPayload(payload: { encryptedPayload: string; iv: string; tag: string }): string {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.encryptedPayload, "base64")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

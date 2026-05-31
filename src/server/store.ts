import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  PROJECT_META,
  SEED_CANDIDATES,
  SEED_DISTRICTS,
  SEED_PLACES,
  SEED_TABLES,
  SEED_ZONES
} from "../shared/constants";
import type {
  AuditLog,
  BallotImage,
  Candidate,
  District,
  EmailReceipt,
  Incidence,
  ProcessStatus,
  ProjectMeta,
  Role,
  User,
  VoterReceipt,
  VoteRecord,
  VoteScan,
  VotingPlace,
  VotingTable,
  Zone
} from "../shared/types";
import { createPasswordRecord } from "./security";

export interface StoredUser extends User {
  passwordHash: string;
}

export interface CertusDb {
  meta: ProjectMeta;
  process: {
    id: string;
    name: string;
    status: ProcessStatus;
    startedAt: string;
    closedAt: string | null;
  };
  users: StoredUser[];
  candidates: Candidate[];
  districts: District[];
  zones: Zone[];
  places: VotingPlace[];
  tables: VotingTable[];
  scans: VoteScan[];
  images: BallotImage[];
  records: VoteRecord[];
  voterReceipts: VoterReceipt[];
  emailReceipts: EmailReceipt[];
  incidences: Incidence[];
  auditLogs: AuditLog[];
}

const dbPath = path.join(process.cwd(), "data", "db.json");
const remoteDbKey = "certus_app_db";
let remoteStoreClient: SupabaseClient | null = null;

function now(): string {
  return new Date().toISOString();
}

function createUser(name: string, email: string, role: Role, password: string): StoredUser {
  const timestamp = now();
  return {
    id: randomUUID(),
    name,
    email,
    role,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    passwordHash: createPasswordRecord(password).passwordHash
  };
}

function remoteStoreEnabled(): boolean {
  return Boolean(
    process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      (process.env.CERTUS_REMOTE_DB === "true" || process.env.VERCEL === "1")
  );
}

function getRemoteStoreClient(): SupabaseClient {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase no esta configurado para almacenar la base remota.");
  }
  remoteStoreClient ??= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
  return remoteStoreClient;
}

function createSeedDb(): CertusDb {
  const timestamp = now();
  return {
    meta: PROJECT_META,
    process: {
      id: "proc-2026-certus",
      name: "Proceso electoral CERTUS 2026",
      status: "En progreso",
      startedAt: timestamp,
      closedAt: null
    },
    users: [
      createUser("Administrador CERTUS", "admin@certus.pe", "admin", "Admin2026!")
    ],
    candidates: SEED_CANDIDATES,
    districts: SEED_DISTRICTS,
    zones: SEED_ZONES,
    places: SEED_PLACES,
    tables: SEED_TABLES,
    scans: [],
    images: [],
    records: [],
    voterReceipts: [],
    emailReceipts: [],
    incidences: [],
    auditLogs: [
      {
        id: randomUUID(),
        userId: "system",
        action: "seed",
        entity: "system",
        entityId: "proc-2026-certus",
        detail: "Base inicial creada con mesas, candidatos y usuarios de prueba.",
        createdAt: timestamp
      }
    ]
  };
}

export async function ensureDb(): Promise<void> {
  if (remoteStoreEnabled()) {
    const client = getRemoteStoreClient();
    const existing = await client.from("system_settings").select("key").eq("key", remoteDbKey).maybeSingle();
    if (existing.error) {
      throw existing.error;
    }
    if (!existing.data) {
      const seed = createSeedDb();
      const inserted = await client.from("system_settings").upsert({
        key: remoteDbKey,
        value: seed,
        updated_at: new Date().toISOString()
      });
      if (inserted.error) {
        throw inserted.error;
      }
    }
    return;
  }

  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await fs.writeFile(dbPath, JSON.stringify(createSeedDb(), null, 2), "utf8");
  }
}

function normalizeDb(db: CertusDb): CertusDb {
  db.voterReceipts ??= [];
  db.emailReceipts ??= [];
  return db;
}

export async function readDb(): Promise<CertusDb> {
  await ensureDb();
  if (remoteStoreEnabled()) {
    const client = getRemoteStoreClient();
    const { data, error } = await client.from("system_settings").select("value").eq("key", remoteDbKey).maybeSingle();
    if (error) {
      throw error;
    }
    if (!data?.value) {
      throw new Error("No se encontro la base remota de CERTUS.");
    }
    return normalizeDb(data.value as CertusDb);
  }

  const raw = await fs.readFile(dbPath, "utf8");
  const db = JSON.parse(raw) as CertusDb;
  return normalizeDb(db);
}

export async function writeDb(db: CertusDb): Promise<void> {
  if (remoteStoreEnabled()) {
    const client = getRemoteStoreClient();
    const { error } = await client.from("system_settings").upsert({
      key: remoteDbKey,
      value: db,
      updated_at: new Date().toISOString()
    });
    if (error) {
      throw error;
    }
    return;
  }

  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const tempPath = `${dbPath}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(tempPath, dbPath);
}

export async function updateDb<T>(mutator: (db: CertusDb) => T | Promise<T>): Promise<T> {
  if (remoteStoreEnabled()) {
    const client = getRemoteStoreClient();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await ensureDb();
      const { data, error } = await client
        .from("system_settings")
        .select("value,updated_at")
        .eq("key", remoteDbKey)
        .maybeSingle();
      if (error) {
        throw error;
      }
      if (!data?.value) {
        throw new Error("No se encontro la base remota de CERTUS.");
      }

      const db = normalizeDb(data.value as CertusDb);
      const result = await mutator(db);
      const nextUpdatedAt = new Date().toISOString();
      const updated = await client
        .from("system_settings")
        .update({
          value: db,
          updated_at: nextUpdatedAt
        })
        .eq("key", remoteDbKey)
        .eq("updated_at", data.updated_at)
        .select("key")
        .maybeSingle();

      if (updated.error) {
        throw updated.error;
      }
      if (updated.data) {
        return result;
      }
    }
    throw new Error("No se pudo guardar la base remota de CERTUS por concurrencia. Intenta nuevamente.");
  }

  const db = await readDb();
  const result = await mutator(db);
  await writeDb(db);
  return result;
}

export function publicUser(user: StoredUser): User {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

export function createAuditLog(userId: string, action: string, entity: string, entityId: string, detail: string): AuditLog {
  return {
    id: randomUUID(),
    userId,
    action,
    entity,
    entityId,
    detail,
    createdAt: now()
  };
}

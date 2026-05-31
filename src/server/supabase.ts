import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EmailReceipt, User, VoteRecord } from "../shared/types";
import type { CertusDb } from "./store";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let serviceClient: SupabaseClient | null = null;
const authUserCache = new Map<string, boolean>();

interface SupabaseVoterIdentityInput {
  name: string;
  email: string;
  dni: string;
}

export function getSupabaseStatus() {
  return {
    url: supabaseUrl ?? null,
    authMode: "dni_email_otp",
    writeConfigured: Boolean(supabaseUrl && supabaseServiceRoleKey),
    requireWriteSync: process.env.CERTUS_REQUIRE_SUPABASE_SYNC === "true"
  };
}

export function requireSupabaseSync() {
  return process.env.CERTUS_REQUIRE_SUPABASE_SYNC === "true";
}

function getServiceClient() {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return null;
  }
  serviceClient ??= createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
  return serviceClient;
}

async function authUserExists(client: SupabaseClient, userId: string | null | undefined) {
  if (!userId) {
    return false;
  }
  const cached = authUserCache.get(userId);
  if (cached !== undefined) {
    return cached;
  }
  const { data, error } = await client.auth.admin.getUserById(userId);
  const exists = Boolean(!error && data.user);
  authUserCache.set(userId, exists);
  return exists;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

async function findAuthUserByEmail(client: SupabaseClient, email: string) {
  const normalizedEmail = normalizeEmail(email);
  const perPage = 1000;
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw error;
    }

    const user = data.users.find((item) => item.email?.toLowerCase() === normalizedEmail);
    if (user) {
      return user;
    }
    if (data.users.length < perPage) {
      return null;
    }
  }
  return null;
}

export async function ensureSupabaseVoterIdentity(input: SupabaseVoterIdentityInput) {
  const client = getServiceClient();
  if (!client) {
    return null;
  }

  const email = normalizeEmail(input.email);
  let authUser = await findAuthUserByEmail(client, email);
  if (!authUser) {
    const { data, error } = await client.auth.admin.createUser({
      email,
      password: `${randomUUID()}${randomUUID()}`,
      email_confirm: true,
      user_metadata: {
        full_name: input.name,
        name: input.name,
        dni: input.dni,
        provider: "certus_otp"
      },
      app_metadata: {
        role: "citizen",
        auth_mode: "dni_email_otp"
      }
    });

    if (error) {
      const retryUser = await findAuthUserByEmail(client, email);
      if (!retryUser) {
        throw error;
      }
      authUser = retryUser;
    } else {
      authUser = data.user;
    }
  }

  const supabaseUserId = authUser.id;
  const profile = await client.from("profiles").upsert(
    {
      id: supabaseUserId,
      email,
      full_name: input.name,
      role: "citizen",
      status: "active",
      updated_at: new Date().toISOString()
    },
    { onConflict: "id" }
  );
  if (profile.error) {
    throw profile.error;
  }

  authUserCache.set(supabaseUserId, true);
  return supabaseUserId;
}

async function findRequiredId(
  client: SupabaseClient,
  table: string,
  column: string,
  value: string,
  label: string
) {
  const { data, error } = await client.from(table).select("id").eq(column, value).maybeSingle();
  if (error) {
    throw error;
  }
  if (!data?.id) {
    throw new Error(`No existe ${label} en Supabase: ${value}`);
  }
  return data.id as string;
}

async function insertOrFindBy(
  client: SupabaseClient,
  table: string,
  matchColumn: string,
  matchValue: string,
  payload: Record<string, unknown>
) {
  const existing = await client.from(table).select("id").eq(matchColumn, matchValue).maybeSingle();
  if (existing.error) {
    throw existing.error;
  }
  if (existing.data?.id) {
    return existing.data.id as string;
  }

  const inserted = await client.from(table).insert(payload).select("id").single();
  if (inserted.error) {
    throw inserted.error;
  }
  return inserted.data.id as string;
}

export async function syncVoteRecordToSupabase(
  db: CertusDb,
  record: VoteRecord,
  actor: User,
  emailReceipt?: EmailReceipt | null
) {
  const client = getServiceClient();
  if (!client) {
    return { skipped: true, reason: "SUPABASE_SERVICE_ROLE_KEY no configurado" };
  }

  const processId = await findRequiredId(client, "electoral_processes", "code", db.process.id, "proceso electoral");
  const localTable = db.tables.find((item) => item.id === record.tableId);
  if (!localTable) {
    throw new Error(`No existe mesa local: ${record.tableId}`);
  }
  const tableId = await findRequiredId(client, "voting_tables", "code", localTable.code, "mesa");

  const scan = db.scans.find((item) => item.id === record.scanId);
  const image = db.images.find((item) => item.id === record.imageId);
  if (!scan || !image) {
    throw new Error(`Registro local incompleto: ${record.id}`);
  }

  const candidateMap = new Map<string, string>();
  for (const candidate of db.candidates) {
    const { data, error } = await client.from("candidates").select("id").eq("code", candidate.id).maybeSingle();
    if (error) {
      throw error;
    }
    if (data?.id) {
      candidateMap.set(candidate.id, data.id as string);
    }
  }

  const supabaseCandidateId = record.candidateId ? candidateMap.get(record.candidateId) ?? null : null;
  const detectedCandidateIds = scan.detectedMarks.map((id) => candidateMap.get(id)).filter(Boolean);
  const selectedCandidateIds = scan.selectedCandidateIds.map((id) => candidateMap.get(id)).filter(Boolean);

  const scanId = await insertOrFindBy(client, "vote_scans", "id", record.scanId, {
    id: record.scanId,
    process_id: processId,
    vote_type: scan.voteType,
    observation: scan.observation,
    selected_candidate_ids: selectedCandidateIds,
    detected_candidate_ids: detectedCandidateIds,
    confidence: scan.confidence,
    created_at: record.createdAt
  });

  const imageId = await insertOrFindBy(client, "ballot_images", "id", record.imageId, {
    id: record.imageId,
    process_id: processId,
    table_id: tableId,
    ballot_serial: image.ballotSerial,
    resolution: image.resolution,
    captured_at: image.capturedAt,
    image_hash: image.imageHash,
    encrypted_payload: image.encryptedPayload,
    storage_bucket: "certus-ballots",
    storage_path: `records/${record.id}.json`,
    iv: image.iv,
    tag: image.tag,
    created_at: image.capturedAt
  });

  const supabaseActorId =
    actor.supabaseUserId ??
    (actor.role === "citizen" && actor.dni
      ? await ensureSupabaseVoterIdentity({
          name: actor.name,
          email: actor.email,
          dni: actor.dni
        })
      : actor.id);
  const canReferenceActor = await authUserExists(client, supabaseActorId);
  const supabaseRecordId = await insertOrFindBy(client, "vote_records", "integrity_hash", record.integrityHash, {
    id: record.id,
    process_id: processId,
    table_id: tableId,
    scan_id: scanId,
    image_id: imageId,
    vote_type: record.voteType,
    candidate_id: supabaseCandidateId,
    ballot_serial: record.ballotSerial,
    integrity_hash: record.integrityHash,
    secure_transmission_seal: record.secureTransmissionSeal,
    source: record.ballotSerial.startsWith("QR-") ? "qr_virtual" : "manual_scan",
    created_by: canReferenceActor ? supabaseActorId : null,
    created_at: record.createdAt,
    confirmed_at: record.confirmedAt
  });

  for (const step of record.trace) {
    const existingTrace = await client
      .from("vote_record_trace")
      .select("id")
      .eq("record_id", supabaseRecordId)
      .eq("state", step.state)
      .maybeSingle();
    if (existingTrace.error) {
      throw existingTrace.error;
    }
    if (!existingTrace.data?.id) {
      const insertedTrace = await client.from("vote_record_trace").insert({
        id: randomUUID(),
        record_id: supabaseRecordId,
        state: step.state,
        occurred_at: step.at
      });
      if (insertedTrace.error) {
        throw insertedTrace.error;
      }
    }
  }

  const localReceipt = db.voterReceipts.find((item) => item.recordId === record.id);
  let supabaseEmailId: string | null = null;
  if (emailReceipt && canReferenceActor) {
    supabaseEmailId = await insertOrFindBy(client, "email_receipts", "id", emailReceipt.id, {
      id: emailReceipt.id,
      user_id: supabaseActorId,
      record_id: supabaseRecordId,
      to_email: emailReceipt.to,
      subject: emailReceipt.subject,
      body_text: emailReceipt.bodyText,
      status: emailReceipt.status,
      provider: emailReceipt.provider,
      created_at: emailReceipt.createdAt,
      sent_at: emailReceipt.sentAt,
      error: emailReceipt.error
    });
  }

  if (localReceipt && canReferenceActor) {
    await insertOrFindBy(client, "voter_receipts", "receipt_hash", record.integrityHash, {
      id: localReceipt.id,
      user_id: supabaseActorId,
      process_id: processId,
      table_id: tableId,
      record_id: supabaseRecordId,
      email_receipt_id: supabaseEmailId,
      receipt_hash: record.integrityHash,
      created_at: localReceipt.createdAt
    });
  }

  await client.from("audit_logs").insert({
    user_id: canReferenceActor ? supabaseActorId : null,
    action: "sync_vote_record",
    entity: "vote_record",
    entity_id: supabaseRecordId,
    detail: `Registro ${record.ballotSerial} sincronizado desde la app CERTUS. Correo: ${emailReceipt?.provider ?? "none"}.`
  });

  return { skipped: false, recordId: supabaseRecordId };
}

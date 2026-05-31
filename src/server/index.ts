import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import type { EmailReceipt, Role, User, VoteRecord, VoteType } from "../shared/types";
import { createPasswordRecord, createSession, decryptPayload, destroySession, getSession, sha256, verifyPassword } from "./security";
import { createAuditLog, ensureDb, publicUser, readDb, updateDb, type StoredUser } from "./store";
import { deliverEmailReceipt, deliverPlainEmail } from "./email";
import {
  DomainError,
  computeResults,
  createReport,
  crossValidateRecord,
  detailedRecords,
  processBallot,
  processVirtualVote,
  queueVoteConfirmationEmail
} from "./domain";
import {
  ensureSupabaseVoterIdentity,
  getSupabaseStatus,
  requireSupabaseSync,
  syncVoteRecordToSupabase
} from "./supabase";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../../dist");

function normalizeBaseUrl(value: string | undefined | null) {
  const clean = value?.trim().replace(/\/+$/, "");
  return clean || null;
}

function getPublicAppUrl(req: Request) {
  const configuredUrl = normalizeBaseUrl(process.env.PUBLIC_APP_URL);
  if (configuredUrl) {
    return configuredUrl;
  }
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto || req.protocol;
  const host = req.get("host");
  return host ? `${proto}://${host}` : "";
}

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "8mb" }));
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 1200,
    standardHeaders: "draft-7",
    legacyHeaders: false
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const voterAccessSchema = z.object({
  name: z.string().min(3).max(120),
  dni: z.string().transform((value) => value.replace(/\D/g, "")).refine((value) => /^\d{8}$/.test(value), {
    message: "Ingresa un DNI de 8 digitos."
  }),
  email: z.string().email()
});

const voterCodeSchema = z.object({
  dni: z.string().transform((value) => value.replace(/\D/g, "")).refine((value) => /^\d{8}$/.test(value), {
    message: "Ingresa un DNI de 8 digitos."
  }),
  email: z.string().email(),
  code: z.string().trim().regex(/^\d{6}$/, "Ingresa el codigo de 6 digitos.")
});

const processBallotSchema = z.object({
  ballotSerial: z.string().min(3).max(40),
  tableId: z.string().min(1),
  imageData: z.string().min(20).max(6_500_000),
  markedCandidateIds: z.array(z.string()).max(6)
});

const virtualVoteSchema = z.object({
  tableId: z.string().min(1),
  markedCandidateIds: z.array(z.string()).max(6)
});

const voteTypeSchema = z.enum(["valid", "null", "blank"]);
const crossValidateSchema = z.object({
  recordId: z.string().min(1),
  physicalVoteType: voteTypeSchema,
  physicalCandidateId: z.string().nullable(),
  note: z.string().max(300).default("")
});

const createUserSchema = z.object({
  name: z.string().min(3).max(120),
  email: z.string().email(),
  role: z.enum(["admin", "auditor", "member", "citizen"]),
  password: z.string().min(8).max(120)
});

const patchUserSchema = z.object({
  name: z.string().min(3).max(120).optional(),
  role: z.enum(["admin", "auditor", "member", "citizen"]).optional(),
  status: z.enum(["active", "inactive"]).optional()
});

interface PendingVoterCode {
  name: string;
  dni: string;
  email: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

const voterCodeTtlMs = 1000 * 60 * 10;
const pendingVoterCodes = new Map<string, PendingVoterCode>();

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length).trim();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function voterCodeKey(dni: string, email: string): string {
  return `${dni}:${normalizeEmail(email)}`;
}

function voterCodeHash(dni: string, email: string, code: string): string {
  return sha256(`${dni}:${normalizeEmail(email)}:${code}`);
}

function createVoterCodeEmail(name: string, code: string) {
  return [
    `Hola ${name.trim()},`,
    "",
    "Usa este codigo para validar tu identidad y continuar con la votacion virtual en CERTUSPE.",
    "",
    `Codigo de verificacion: ${code}`,
    "",
    "El codigo vence en 10 minutos. Si no solicitaste este acceso, puedes ignorar este mensaje.",
    "CERTUSPE"
  ].join("\n");
}

function publicEmailReceipt(email: EmailReceipt | null) {
  if (!email) {
    return null;
  }
  return {
    id: email.id,
    to: email.to,
    subject: email.subject,
    status: email.status,
    provider: email.provider,
    createdAt: email.createdAt,
    sentAt: email.sentAt
  };
}

async function authResponse(user: StoredUser, action: string, detail: string) {
  const session = createSession(user.id, user.role);
  await updateDb((draft) => {
    draft.auditLogs.push(createAuditLog(user.id, action, "user", user.id, detail));
  });
  return { token: session.token, expiresAt: session.expiresAt, user: publicUser(user) };
}

async function syncVoteSafely(record: VoteRecord, actor: User, email?: EmailReceipt | null) {
  const db = await readDb();
  try {
    await syncVoteRecordToSupabase(db, record, actor, email);
  } catch (error) {
    if (requireSupabaseSync()) {
      throw error;
    }
    console.error("No se pudo sincronizar el voto con Supabase:", error);
  }
}

async function requireUser(req: Request, roles?: Role[]): Promise<StoredUser> {
  const session = getSession(bearerToken(req));
  if (!session) {
    throw new DomainError("La sesiÃ³n no es vÃ¡lida o expirÃ³.", 401);
  }
  const db = await readDb();
  const user = db.users.find((item) => item.id === session.userId && item.status === "active");
  if (!user) {
    throw new DomainError("El usuario no estÃ¡ activo.", 401);
  }
  if (roles && !roles.includes(user.role)) {
    throw new DomainError("No tienes permisos para realizar esta acciÃ³n.", 403);
  }
  return user;
}

function getTableContext(db: Awaited<ReturnType<typeof readDb>>, tableKey: string) {
  const normalized = tableKey.trim().toLowerCase();
  const table = db.tables.find(
    (item) => item.id.toLowerCase() === normalized || item.code.toLowerCase() === normalized
  );
  if (!table) {
    throw new DomainError("La mesa del QR no existe.", 404);
  }
  const place = db.places.find((item) => item.id === table.placeId);
  const zone = db.zones.find((item) => item.id === place?.zoneId);
  const district = db.districts.find((item) => item.id === zone?.districtId);
  return { table, place, zone, district };
}

app.get(
  "/api/health",
  asyncRoute(async (req, res) => {
    await ensureDb();
    res.json({
      ok: true,
      service: "CERTUS",
      publicAppUrl: getPublicAppUrl(req),
      supabase: getSupabaseStatus(),
      at: new Date().toISOString()
    });
  })
);

app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const db = await readDb();
    const user = db.users.find((item) => item.email.toLowerCase() === normalizeEmail(input.email));
    if (!user || user.status !== "active" || !verifyPassword(input.password, user.passwordHash)) {
      throw new DomainError("Correo o contraseÃ±a invÃ¡lidos.", 401);
    }
    if (user.role === "citizen") {
      throw new DomainError("Los votantes ingresan con DNI, correo y codigo de verificacion.", 403);
    }
    res.json(await authResponse(user, "login", "Inicio de sesion correcto."));
  })
);

app.post(
  "/api/auth/voter/request-code",
  asyncRoute(async (req, res) => {
    const input = voterAccessSchema.parse(req.body);
    const email = normalizeEmail(input.email);
    const timestamp = Date.now();
    for (const [key, pending] of pendingVoterCodes) {
      if (pending.expiresAt <= timestamp) {
        pendingVoterCodes.delete(key);
      }
    }

    const db = await readDb();
    const existingByEmail = db.users.find((item) => item.email.toLowerCase() === email);
    const existingByDni = db.users.find((item) => item.dni === input.dni);
    if (existingByEmail && existingByEmail.role !== "citizen") {
      throw new DomainError("Ese correo pertenece a una cuenta operativa.", 409);
    }
    if (existingByEmail?.dni && existingByEmail.dni !== input.dni) {
      throw new DomainError("Ese correo ya esta vinculado a otro DNI.", 409);
    }
    if (existingByDni && existingByDni.email.toLowerCase() !== email) {
      throw new DomainError("Ese DNI ya esta vinculado a otro correo.", 409);
    }

    const code = randomInt(100000, 1000000).toString();
    pendingVoterCodes.set(voterCodeKey(input.dni, email), {
      name: input.name.trim(),
      dni: input.dni,
      email,
      codeHash: voterCodeHash(input.dni, email, code),
      expiresAt: timestamp + voterCodeTtlMs,
      attempts: 0
    });

    const delivery = await deliverPlainEmail({
      to: email,
      subject: "CERTUSPE: codigo de verificacion para votar",
      bodyText: createVoterCodeEmail(input.name, code),
      template: {
        kind: "voter_otp",
        variables: {
          VOTER_NAME: input.name.trim(),
          OTP_CODE: code,
          EXPIRES_MINUTES: Math.round(voterCodeTtlMs / 60_000)
        }
      }
    });
    if (delivery.status === "failed") {
      throw new DomainError(`No se pudo enviar el codigo de verificacion: ${delivery.error}`, 502);
    }

    await updateDb((draft) => {
      draft.auditLogs.push(
        createAuditLog("system", "voter_code_requested", "voter_access", input.dni, `Codigo solicitado para ${email}.`)
      );
    });

    res.json({
      ok: true,
      email,
      expiresInSeconds: Math.round(voterCodeTtlMs / 1000),
      deliveryStatus: delivery.status,
      provider: delivery.provider
    });
  })
);

app.post(
  "/api/auth/voter/verify-code",
  asyncRoute(async (req, res) => {
    const input = voterCodeSchema.parse(req.body);
    const email = normalizeEmail(input.email);
    const key = voterCodeKey(input.dni, email);
    const pending = pendingVoterCodes.get(key);
    if (!pending || pending.expiresAt <= Date.now()) {
      pendingVoterCodes.delete(key);
      throw new DomainError("El codigo expiro. Solicita uno nuevo.", 401);
    }
    if (pending.attempts >= 5) {
      pendingVoterCodes.delete(key);
      throw new DomainError("Se supero el numero de intentos. Solicita un nuevo codigo.", 429);
    }
    if (pending.codeHash !== voterCodeHash(input.dni, email, input.code)) {
      pending.attempts += 1;
      throw new DomainError("El codigo ingresado no es correcto.", 401);
    }
    pendingVoterCodes.delete(key);

    let supabaseUserId: string | null = null;
    try {
      supabaseUserId = await ensureSupabaseVoterIdentity({
        name: pending.name,
        dni: input.dni,
        email
      });
    } catch (error) {
      if (requireSupabaseSync()) {
        throw new DomainError(
          `No se pudo registrar el votante en Supabase: ${error instanceof Error ? error.message : "error desconocido"}`,
          502
        );
      }
      console.error("No se pudo registrar el votante en Supabase:", error);
    }
    if (!supabaseUserId && requireSupabaseSync()) {
      throw new DomainError("Supabase no esta configurado para registrar votantes.", 502);
    }

    const user = await updateDb((db) => {
      const existingByEmail = db.users.find((item) => item.email.toLowerCase() === email);
      const existingByDni = db.users.find((item) => item.dni === input.dni);
      const existing = existingByDni ?? existingByEmail;
      if (existing) {
        if (existing.role !== "citizen") {
          throw new DomainError("Ese correo pertenece a una cuenta operativa.", 409);
        }
        if (existing.status !== "active") {
          throw new DomainError("El votante no esta activo.", 401);
        }
        existing.name = pending.name;
        existing.email = email;
        existing.dni = input.dni;
        existing.supabaseUserId = supabaseUserId ?? existing.supabaseUserId;
        existing.updatedAt = new Date().toISOString();
        db.auditLogs.push(
          createAuditLog(existing.id, "voter_otp_login", "user", existing.id, "Ingreso ciudadano con DNI y correo verificado.")
        );
        return existing;
      }

      const now = new Date().toISOString();
      const created: StoredUser = {
        id: randomUUID(),
        supabaseUserId: supabaseUserId ?? undefined,
        name: pending.name,
        email,
        dni: input.dni,
        role: "citizen",
        status: "active",
        createdAt: now,
        updatedAt: now,
        passwordHash: createPasswordRecord(`${input.dni}:${email}:${randomUUID()}`).passwordHash
      };
      db.users.push(created);
      db.auditLogs.push(
        createAuditLog(created.id, "voter_otp_register", "user", created.id, "Registro ciudadano con DNI y correo verificado.")
      );
      return created;
    });

    res.json(await authResponse(user, "login", "Inicio ciudadano con codigo de verificacion."));
  })
);
app.post(
  "/api/auth/logout",
  asyncRoute(async (req, res) => {
    const token = bearerToken(req);
    if (token) {
      destroySession(token);
    }
    res.json({ ok: true });
  })
);

app.get(
  "/api/me",
  asyncRoute(async (req, res) => {
    const user = await requireUser(req);
    res.json({ user: publicUser(user) });
  })
);

app.get(
  "/api/bootstrap",
  asyncRoute(async (req, res) => {
    const db = await readDb();
    res.json({
      meta: db.meta,
      app: {
        publicBaseUrl: getPublicAppUrl(req)
      },
      process: db.process,
      candidates: db.candidates,
      districts: db.districts,
      zones: db.zones,
      places: db.places,
      tables: db.tables,
      results: createSafeResults(db)
    });
  })
);

app.get(
  "/api/results",
  asyncRoute(async (_req, res) => {
    const db = await readDb();
    res.json(createSafeResults(db));
  })
);

app.get(
  "/api/vote/:tableId",
  asyncRoute(async (req, res) => {
    const db = await readDb();
    const { table, place, zone, district } = getTableContext(db, req.params.tableId);
    res.json({
      process: db.process,
      table,
      place,
      zone,
      district,
      candidates: db.candidates
    });
  })
);

app.get(
  "/api/vote/:tableId/status",
  asyncRoute(async (req, res) => {
    const actor = await requireUser(req, ["citizen"]);
    const db = await readDb();
    const { table } = getTableContext(db, req.params.tableId);
    const receipt = db.voterReceipts.find(
      (item) => item.userId === actor.id && item.processId === db.process.id
    );
    const emailReceipt = receipt
      ? db.emailReceipts.find((item) => item.id === receipt.emailReceiptId || item.recordId === receipt.recordId) ?? null
      : null;
    res.json({
      hasVoted: Boolean(receipt),
      tableId: table.id,
      receipt: receipt
        ? {
            id: receipt.id,
            recordId: receipt.recordId,
            tableId: receipt.tableId,
            createdAt: receipt.createdAt,
            email: publicEmailReceipt(emailReceipt)
          }
        : null
    });
  })
);

app.post(
  "/api/votes/virtual",
  asyncRoute(async (req, res) => {
    const actor = await requireUser(req, ["citizen"]);
    const input = virtualVoteSchema.parse(req.body);
    const result = await updateDb((db) => {
      const publicActor = publicUser(actor);
      const record = processVirtualVote(db, input, publicActor);
      const receipt = db.voterReceipts.find((item) => item.recordId === record.id);
      const email = queueVoteConfirmationEmail(db, publicActor, record);
      return { record, receipt, email };
    });
    const delivery = await deliverEmailReceipt(result.email);
    const email = await updateDb((db) => {
      const storedEmail = db.emailReceipts.find((item) => item.id === result.email.id);
      if (!storedEmail) {
        return { ...result.email, ...delivery };
      }
      storedEmail.status = delivery.status;
      storedEmail.provider = delivery.provider;
      storedEmail.sentAt = delivery.sentAt;
      storedEmail.error = delivery.error;
      return storedEmail;
    });
    await syncVoteSafely(result.record, publicUser(actor), email);
    res.status(201).json({
      record: result.record,
      receipt: result.receipt
        ? {
            id: result.receipt.id,
            recordId: result.receipt.recordId,
            tableId: result.receipt.tableId,
            createdAt: result.receipt.createdAt,
            email: publicEmailReceipt(email)
          }
        : null,
      email: publicEmailReceipt(email)
    });
  })
);

app.post(
  "/api/scans/process",
  asyncRoute(async (req, res) => {
    const actor = await requireUser(req, ["admin", "member"]);
    const input = processBallotSchema.parse(req.body);
    const record = await updateDb((db) => processBallot(db, input, publicUser(actor)));
    await syncVoteSafely(record, publicUser(actor));
    res.status(201).json({ record });
  })
);

app.get(
  "/api/records",
  asyncRoute(async (req, res) => {
    const actor = await requireUser(req, ["admin", "auditor", "member"]);
    const db = await readDb();
    res.json({ records: detailedRecords(db, publicUser(actor)) });
  })
);

app.get(
  "/api/images/:imageId",
  asyncRoute(async (req, res) => {
    await requireUser(req, ["admin", "auditor", "member"]);
    const db = await readDb();
    const image = db.images.find((item) => item.id === req.params.imageId);
    if (!image) {
      throw new DomainError("La imagen no existe.", 404);
    }
    const imageData = decryptPayload(image);
    res.json({
      id: image.id,
      ballotSerial: image.ballotSerial,
      imageHash: image.imageHash,
      resolution: image.resolution,
      capturedAt: image.capturedAt,
      imageData
    });
  })
);

app.post(
  "/api/audit/cross-validate",
  asyncRoute(async (req, res) => {
    const actor = await requireUser(req, ["admin", "auditor"]);
    const input = crossValidateSchema.parse(req.body) as {
      recordId: string;
      physicalVoteType: VoteType;
      physicalCandidateId: string | null;
      note: string;
    };
    const record = await updateDb((db) => crossValidateRecord(db, input, publicUser(actor)));
    res.json({ record });
  })
);

app.get(
  "/api/incidences",
  asyncRoute(async (req, res) => {
    await requireUser(req, ["admin", "auditor", "member"]);
    const db = await readDb();
    res.json({ incidences: db.incidences });
  })
);

app.patch(
  "/api/incidences/:id/resolve",
  asyncRoute(async (req, res) => {
    const actor = await requireUser(req, ["admin", "auditor"]);
    const incidence = await updateDb((db) => {
      const item = db.incidences.find((entry) => entry.id === req.params.id);
      if (!item) {
        throw new DomainError("La incidencia no existe.", 404);
      }
      item.status = "Resuelta";
      item.updatedAt = new Date().toISOString();
      db.auditLogs.push(createAuditLog(actor.id, "resolve_incidence", "incidence", item.id, item.title));
      return item;
    });
    res.json({ incidence });
  })
);

app.get(
  "/api/reports/preliminary",
  asyncRoute(async (req, res) => {
    const actor = await requireUser(req, ["admin", "auditor", "member"]);
    const db = await readDb();
    const report = createReport(db, publicUser(actor));
    res.json({ report });
  })
);

app.get(
  "/api/audit/logs",
  asyncRoute(async (req, res) => {
    await requireUser(req, ["admin", "auditor"]);
    const db = await readDb();
    res.json({ logs: db.auditLogs.slice().reverse() });
  })
);

app.get(
  "/api/users",
  asyncRoute(async (req, res) => {
    await requireUser(req, ["admin"]);
    const db = await readDb();
    res.json({ users: db.users.map(publicUser) });
  })
);

app.post(
  "/api/users",
  asyncRoute(async (req, res) => {
    const actor = await requireUser(req, ["admin"]);
    const input = createUserSchema.parse(req.body);
    const user = await updateDb((db) => {
      const email = normalizeEmail(input.email);
      const exists = db.users.some((item) => item.email.toLowerCase() === email);
      if (exists) {
        throw new DomainError("Ya existe un usuario con ese correo.", 409);
      }
      const timestamp = new Date().toISOString();
      const created: StoredUser = {
        id: randomUUID(),
        name: input.name.trim(),
        email,
        role: input.role,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        passwordHash: createPasswordRecord(input.password).passwordHash
      };
      db.users.push(created);
      db.auditLogs.push(createAuditLog(actor.id, "create_user", "user", created.id, `Usuario ${created.email} creado.`));
      return created;
    });
    res.status(201).json({ user: publicUser(user) });
  })
);

app.patch(
  "/api/users/:id",
  asyncRoute(async (req, res) => {
    const actor = await requireUser(req, ["admin"]);
    const input = patchUserSchema.parse(req.body);
    const user = await updateDb((db) => {
      const item = db.users.find((entry) => entry.id === req.params.id);
      if (!item) {
        throw new DomainError("El usuario no existe.", 404);
      }
      if (input.name) {
        item.name = input.name.trim();
      }
      if (input.role) {
        item.role = input.role;
      }
      if (input.status) {
        item.status = input.status;
      }
      item.updatedAt = new Date().toISOString();
      db.auditLogs.push(createAuditLog(actor.id, "update_user", "user", item.id, `Usuario ${item.email} actualizado.`));
      return item;
    });
    res.json({ user: publicUser(user) });
  })
);

app.use(express.static(distPath));
app.get("*", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: "Datos invÃ¡lidos.",
      details: error.errors.map((item) => item.message)
    });
    return;
  }
  if (error instanceof DomainError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "OcurriÃ³ un error interno." });
});

function createSafeResults(db: Awaited<ReturnType<typeof readDb>>) {
  return computeResults(db);
}

await ensureDb();
if (process.env.VERCEL !== "1") {
  app.listen(port, () => {
    console.log(`CERTUS API running on http://localhost:${port}`);
  });
}

export default app;


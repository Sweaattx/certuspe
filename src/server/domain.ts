import { randomUUID } from "node:crypto";
import type {
  DetailedRecord,
  EmailReceipt,
  Incidence,
  ResultSummary,
  Role,
  User,
  VoteRecord,
  VoteScan,
  VoteType
} from "../shared/types";
import type { CertusDb } from "./store";
import { createAuditLog } from "./store";
import { encryptPayload, sha256 } from "./security";

export interface ProcessBallotInput {
  ballotSerial: string;
  tableId: string;
  imageData: string;
  markedCandidateIds: string[];
}

export interface CrossValidateInput {
  recordId: string;
  physicalVoteType: VoteType;
  physicalCandidateId: string | null;
  note: string;
}

export interface ProcessVirtualVoteInput {
  tableId: string;
  markedCandidateIds: string[];
}

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

function now(): string {
  return new Date().toISOString();
}

function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase();
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getVoteType(selectedCandidateIds: string[]): VoteType {
  if (selectedCandidateIds.length === 0) {
    return "blank";
  }
  if (selectedCandidateIds.length > 1) {
    return "null";
  }
  return "valid";
}

function roleCanAccessDetailed(role: Role): boolean {
  return role === "admin" || role === "auditor" || role === "member";
}

function createVirtualBallotImage(tableCode: string, candidates: CertusDb["candidates"], markedCandidateIds: string[]): string {
  const height = 370 + Math.max(0, candidates.length - 4) * 46;
  const footerY = height - 34;
  const frameHeight = height - 36;
  const rows = candidates
    .map((candidate, index) => {
      const y = 92 + index * 46;
      const marked = markedCandidateIds.includes(candidate.id);
      return `
        <rect x="32" y="${y}" width="376" height="36" fill="#ffffff" stroke="#dfe5f0"/>
        <text x="48" y="${y + 22}" font-family="Arial" font-size="13" fill="#171b29">${escapeSvgText(candidate.name)}</text>
        <rect x="358" y="${y + 8}" width="20" height="20" fill="#ffffff" stroke="#1D3096" stroke-width="2"/>
        ${marked ? `<path d="M362 ${y + 18} L367 ${y + 25} L378 ${y + 6}" fill="none" stroke="#1D3096" stroke-width="4"/>` : ""}
      `;
    })
    .join("");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="440" height="${height}" viewBox="0 0 440 ${height}">
      <rect width="440" height="${height}" fill="#fbfcff"/>
      <rect x="18" y="18" width="404" height="${frameHeight}" rx="4" fill="#ffffff" stroke="#d8dfec"/>
      <text x="32" y="52" font-family="Arial" font-size="20" font-weight="700" fill="#1D3096">CERTUS</text>
      <text x="32" y="72" font-family="Arial" font-size="10" fill="#5B6EA6">Cedula virtual - mesa ${escapeSvgText(tableCode)}</text>
      ${rows}
      <text x="32" y="${footerY}" font-family="Arial" font-size="9" fill="#667086">Voto emitido desde QR general con mesa asignada</text>
    </svg>
  `;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export function processBallot(db: CertusDb, input: ProcessBallotInput, actor: User): VoteRecord {
  if (actor.role !== "admin" && actor.role !== "member") {
    throw new DomainError("No tienes permisos para procesar votos.", 403);
  }

  const table = db.tables.find((item) => item.id === input.tableId);
  if (!table) {
    throw new DomainError("La mesa seleccionada no existe.", 404);
  }

  const ballotSerial = normalizeSerial(input.ballotSerial);
  if (!ballotSerial) {
    throw new DomainError("El numero de cedula es obligatorio.", 400);
  }

  const duplicated = db.records.find((record) => record.ballotSerial === ballotSerial);
  if (duplicated) {
    const incidence = createIncidence(
      duplicated.id,
      "Alta",
      "Intento de duplicidad",
      `La cedula ${ballotSerial} ya fue procesada en el registro ${duplicated.id}.`
    );
    db.incidences.push(incidence);
    db.auditLogs.push(createAuditLog(actor.id, "duplicate_rejected", "vote_record", duplicated.id, incidence.detail));
    throw new DomainError("La cedula ya fue procesada. El sistema evito un voto duplicado.", 409);
  }

  const uniqueMarks = Array.from(new Set(input.markedCandidateIds));
  const knownCandidateIds = new Set(db.candidates.map((candidate) => candidate.id));
  const detectedMarks = uniqueMarks.filter((candidateId) => knownCandidateIds.has(candidateId));
  if (detectedMarks.length !== uniqueMarks.length) {
    throw new DomainError("La cedula contiene marcas no reconocidas por la plantilla electoral.", 400);
  }

  const voteType = getVoteType(detectedMarks);
  const selectedCandidateIds = voteType === "valid" ? detectedMarks : [];
  const candidateId = selectedCandidateIds[0] ?? null;
  const confidence = voteType === "valid" ? 0.94 : voteType === "blank" ? 0.91 : 0.86;
  const scan: VoteScan = {
    id: randomUUID(),
    voteType,
    observation:
      voteType === "valid"
        ? "Marca detectada dentro del area valida"
        : voteType === "blank"
          ? "No se detectaron marcas"
          : "Se detectaron multiples marcas",
    selectedCandidateIds,
    detectedMarks,
    confidence
  };

  const imageHash = sha256(input.imageData);
  const encryptedImage = encryptPayload(input.imageData);
  const image = {
    id: randomUUID(),
    ballotSerial,
    resolution: "300dpi",
    capturedAt: now(),
    imageHash,
    ...encryptedImage
  };

  const createdAt = now();
  const recordSeed = JSON.stringify({
    ballotSerial,
    tableId: table.id,
    scanId: scan.id,
    imageHash,
    voteType,
    candidateId,
    createdAt
  });
  const integrityHash = sha256(recordSeed);
  const secureTransmissionSeal = sha256(`${integrityHash}:${actor.id}:${createdAt}`);
  const record: VoteRecord = {
    id: randomUUID(),
    ballotSerial,
    tableId: table.id,
    scanId: scan.id,
    imageId: image.id,
    voteType,
    candidateId,
    integrityHash,
    secureTransmissionSeal,
    createdBy: actor.id,
    createdAt,
    confirmedAt: now(),
    trace: [
      { state: "created", at: createdAt },
      { state: "hash_generated", at: now() },
      { state: "transmitted", at: now() },
      { state: "stored", at: now() },
      { state: "confirmed", at: now() }
    ]
  };

  db.scans.push(scan);
  db.images.push(image);
  db.records.push(record);
  db.auditLogs.push(createAuditLog(actor.id, "process_ballot", "vote_record", record.id, `Cedula ${ballotSerial} registrada en ${table.code}.`));

  if (voteType !== "valid") {
    db.incidences.push(
      createIncidence(
        record.id,
        "Media",
        voteType === "blank" ? "Voto en blanco" : "Voto nulo",
        `La cedula ${ballotSerial} fue clasificada como ${displayVoteType(voteType)}.`
      )
    );
  }

  return record;
}

export function processVirtualVote(db: CertusDb, input: ProcessVirtualVoteInput, actor: User): VoteRecord {
  if (actor.role !== "citizen") {
    throw new DomainError("Solo una cuenta ciudadana puede emitir voto virtual.", 403);
  }
  if (db.process.status !== "En progreso") {
    throw new DomainError("El proceso electoral no esta abierto.", 409);
  }

  const table = db.tables.find((item) => item.id === input.tableId);
  if (!table) {
    throw new DomainError("La mesa del QR no existe.", 404);
  }

  const previousReceipt = db.voterReceipts.find(
    (receipt) => receipt.userId === actor.id && receipt.processId === db.process.id
  );
  if (previousReceipt) {
    throw new DomainError("Tu voto ya fue registrado para este proceso electoral.", 409);
  }

  const uniqueMarks = Array.from(new Set(input.markedCandidateIds));
  const knownCandidateIds = new Set(db.candidates.map((candidate) => candidate.id));
  const detectedMarks = uniqueMarks.filter((candidateId) => knownCandidateIds.has(candidateId));
  if (detectedMarks.length !== uniqueMarks.length) {
    throw new DomainError("La cedula virtual contiene una opcion no valida.", 400);
  }

  const voteType = getVoteType(detectedMarks);
  const selectedCandidateIds = voteType === "valid" ? detectedMarks : [];
  const candidateId = selectedCandidateIds[0] ?? null;
  const scan: VoteScan = {
    id: randomUUID(),
    voteType,
    observation:
      voteType === "valid"
        ? "Marca virtual confirmada por el votante"
        : voteType === "blank"
          ? "Voto virtual enviado sin marcas"
          : "Voto virtual enviado con multiples marcas",
    selectedCandidateIds,
    detectedMarks,
    confidence: 1
  };

  const ballotSerial = normalizeSerial(`QR-${table.code}-${sha256(actor.id).slice(0, 10)}`);
  const duplicated = db.records.find((record) => record.ballotSerial === ballotSerial);
  if (duplicated) {
    throw new DomainError("Tu voto ya fue registrado para este proceso electoral.", 409);
  }

  const imageData = createVirtualBallotImage(table.code, db.candidates, detectedMarks);
  const imageHash = sha256(imageData);
  const encryptedImage = encryptPayload(imageData);
  const image = {
    id: randomUUID(),
    ballotSerial,
    resolution: "virtual",
    capturedAt: now(),
    imageHash,
    ...encryptedImage
  };

  const createdAt = now();
  const recordSeed = JSON.stringify({
    ballotSerial,
    tableId: table.id,
    scanId: scan.id,
    imageHash,
    voteType,
    candidateId,
    createdAt,
    source: "qr_virtual"
  });
  const integrityHash = sha256(recordSeed);
  const secureTransmissionSeal = sha256(`${integrityHash}:${actor.id}:${createdAt}`);
  const record: VoteRecord = {
    id: randomUUID(),
    ballotSerial,
    tableId: table.id,
    scanId: scan.id,
    imageId: image.id,
    voteType,
    candidateId,
    integrityHash,
    secureTransmissionSeal,
    createdBy: actor.id,
    createdAt,
    confirmedAt: now(),
    trace: [
      { state: "created", at: createdAt },
      { state: "hash_generated", at: now() },
      { state: "transmitted", at: now() },
      { state: "stored", at: now() },
      { state: "confirmed", at: now() }
    ]
  };

  db.scans.push(scan);
  db.images.push(image);
  db.records.push(record);
  db.voterReceipts.push({
    id: randomUUID(),
    userId: actor.id,
    processId: db.process.id,
    tableId: table.id,
    recordId: record.id,
    createdAt
  });
  db.auditLogs.push(
    createAuditLog(actor.id, "virtual_qr_vote", "vote_record", record.id, `Voto virtual registrado en ${table.code}.`)
  );

  return record;
}

export function queueVoteConfirmationEmail(db: CertusDb, actor: User, record: VoteRecord): EmailReceipt {
  const table = db.tables.find((item) => item.id === record.tableId);
  const place = table ? db.places.find((item) => item.id === table.placeId) : null;
  const receipt = db.voterReceipts.find((item) => item.recordId === record.id);
  const createdAt = now();
  const verificationCode = record.integrityHash.slice(0, 16).toUpperCase();
  const subject = "CERTUSPE: confirmacion de voto procesado";
  const bodyText = [
    `Hola ${actor.name},`,
    "",
    "Tu voto ha sido procesado correctamente por CERTUSPE.",
    `DNI: ${actor.dni ?? "No registrado"}`,
    `Mesa: ${table?.code ?? record.tableId}`,
    `Local de votacion: ${place?.name ?? "No registrado"}`,
    `Direccion: ${place?.address ?? "No registrada"}`,
    `Fecha de registro: ${createdAt}`,
    `Codigo de verificacion: ${verificationCode}`,
    "",
    "Este comprobante confirma el registro de tu voto y no revela por quien votaste.",
    "Gracias por confiar en Certuspe."
  ].join("\n");
  const email: EmailReceipt = {
    id: randomUUID(),
    userId: actor.id,
    recordId: record.id,
    to: actor.email,
    subject,
    bodyText,
    status: "queued",
    provider: "local_outbox",
    createdAt,
    sentAt: null,
    error: null,
    template: {
      kind: "vote_confirmation",
      variables: {
        VOTER_NAME: actor.name,
        VOTER_DNI: actor.dni ?? "No registrado",
        TABLE_CODE: table?.code ?? record.tableId,
        VOTING_PLACE: place?.name ?? "No registrado",
        VOTING_ADDRESS: place?.address ?? "No registrada",
        REGISTERED_AT: createdAt,
        RECEIPT_CODE: verificationCode
      }
    }
  };

  db.emailReceipts.push(email);
  if (receipt) {
    receipt.emailReceiptId = email.id;
  }
  db.auditLogs.push(
    createAuditLog(actor.id, "vote_confirmation_email", "email_receipt", email.id, `Comprobante generado para ${actor.email}.`)
  );

  return email;
}

export function crossValidateRecord(db: CertusDb, input: CrossValidateInput, actor: User): VoteRecord {
  if (actor.role !== "admin" && actor.role !== "auditor") {
    throw new DomainError("No tienes permisos para validar actas fisicas.", 403);
  }

  const record = db.records.find((item) => item.id === input.recordId);
  if (!record) {
    throw new DomainError("El registro no existe.", 404);
  }

  const consistent =
    record.voteType === input.physicalVoteType &&
    (record.voteType !== "valid" || record.candidateId === input.physicalCandidateId);

  record.crossValidation = {
    physicalVoteType: input.physicalVoteType,
    physicalCandidateId: input.physicalCandidateId,
    status: consistent ? "consistent" : "inconsistent",
    note: input.note.trim(),
    validatedBy: actor.id,
    validatedAt: now()
  };

  db.auditLogs.push(
    createAuditLog(
      actor.id,
      "cross_validate",
      "vote_record",
      record.id,
      consistent ? "Validacion cruzada consistente." : "Validacion cruzada con inconsistencia."
    )
  );

  if (!consistent) {
    db.incidences.push(
      createIncidence(
        record.id,
        "Alta",
        "Inconsistencia con acta fisica",
        `El registro ${record.id} no coincide con la validacion fisica.`
      )
    );
  }

  return record;
}

export function computeResults(db: CertusDb): ResultSummary {
  const generatedAt = now();
  const totalVotes = db.records.length;
  const validVotes = db.records.filter((record) => record.voteType === "valid").length;
  const nullVotes = db.records.filter((record) => record.voteType === "null").length;
  const blankVotes = db.records.filter((record) => record.voteType === "blank").length;
  const totalElectors = db.tables.reduce((sum, table) => sum + table.electors, 0);

  const byCandidate = db.candidates.map((candidate) => {
    const votes = db.records.filter((record) => record.candidateId === candidate.id).length;
    return {
      candidateId: candidate.id,
      name: candidate.name,
      party: candidate.party,
      color: candidate.color,
      partyCode: candidate.partyCode,
      photoUrl: candidate.photoUrl,
      logoUrl: candidate.logoUrl,
      officialVotes: candidate.officialVotes,
      officialValidPercentage: candidate.officialValidPercentage,
      officialEmittedPercentage: candidate.officialEmittedPercentage,
      votes,
      percentage: totalVotes === 0 ? 0 : Number(((votes / totalVotes) * 100).toFixed(1))
    };
  });

  const byTable = db.tables.map((table) => {
    const records = db.records.filter((record) => record.tableId === table.id);
    return {
      tableId: table.id,
      tableCode: table.code,
      totalVotes: records.length,
      validVotes: records.filter((record) => record.voteType === "valid").length,
      nullVotes: records.filter((record) => record.voteType === "null").length,
      blankVotes: records.filter((record) => record.voteType === "blank").length
    };
  });

  return {
    generatedAt,
    processStatus: db.process.status,
    totalVotes,
    validVotes,
    nullVotes,
    blankVotes,
    participation: totalElectors === 0 ? 0 : Number(((totalVotes / totalElectors) * 100).toFixed(2)),
    byCandidate,
    byTable
  };
}

export function detailedRecords(db: CertusDb, actor: User): DetailedRecord[] {
  if (!roleCanAccessDetailed(actor.role)) {
    throw new DomainError("No tienes permisos para ver resultados detallados.", 403);
  }

  return db.records.map((record) => {
    const table = db.tables.find((item) => item.id === record.tableId);
    const place = db.places.find((item) => item.id === table?.placeId);
    const zone = db.zones.find((item) => item.id === place?.zoneId);
    const district = db.districts.find((item) => item.id === zone?.districtId);
    const candidate = record.candidateId ? db.candidates.find((item) => item.id === record.candidateId) : null;
    const voter = db.users.find((item) => item.id === record.createdBy);
    return {
      ...record,
      voterName: voter?.name ?? "No registrado",
      voterEmail: voter?.email ?? "No registrado",
      voterDni: voter?.dni ?? null,
      tableCode: table?.code ?? "Sin mesa",
      placeName: place?.name ?? "Sin local",
      zoneName: zone?.name ?? "Sin zona",
      districtName: district?.name ?? "Sin distrito",
      candidateName: candidate?.name ?? null,
      candidateParty: candidate?.party ?? null
    };
  });
}

export function createReport(db: CertusDb, actor: User) {
  if (actor.role !== "admin" && actor.role !== "auditor" && actor.role !== "member") {
    throw new DomainError("No tienes permisos para generar reportes.", 403);
  }

  const results = computeResults(db);
  const openIncidences = db.incidences.filter((incidence) => incidence.status === "Abierta");
  const inconsistentRecords = db.records.filter((record) => record.crossValidation?.status === "inconsistent");
  return {
    id: randomUUID(),
    generatedAt: now(),
    generatedBy: actor.id,
    level: "preliminar",
    results,
    openIncidences,
    inconsistentRecords,
    integrity: {
      totalImages: db.images.length,
      totalRecords: db.records.length,
      confirmedRecords: db.records.filter((record) => record.trace.some((step) => step.state === "confirmed")).length
    }
  };
}

export function createIncidence(
  recordId: string | null,
  priority: Incidence["priority"],
  title: string,
  detail: string
): Incidence {
  const timestamp = now();
  return {
    id: randomUUID(),
    recordId,
    priority,
    title,
    detail,
    status: "Abierta",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function displayVoteType(type: VoteType): string {
  if (type === "valid") {
    return "valido";
  }
  if (type === "blank") {
    return "en blanco";
  }
  return "nulo";
}

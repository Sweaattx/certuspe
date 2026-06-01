import { describe, expect, it } from "vitest";
import {
  PROJECT_META,
  SEED_CANDIDATES,
  SEED_DISTRICTS,
  SEED_PLACES,
  SEED_TABLES,
  SEED_ZONES
} from "../shared/constants";
import type { User } from "../shared/types";
import type { CertusDb } from "./store";
import { DomainError, computeResults, detailedRecords, processBallot, processVirtualVote, queueVoteConfirmationEmail } from "./domain";

function dbFixture(): CertusDb {
  return {
    meta: PROJECT_META,
    process: {
      id: "proc-test",
      name: "Proceso de prueba",
      status: "En progreso",
      startedAt: new Date().toISOString(),
      closedAt: null
    },
    users: [],
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
    qrHandoffs: [],
    voterCodeRequests: [],
    incidences: [],
    auditLogs: []
  };
}

const memberUser: User = {
  id: "user-member",
  name: "Miembro de Mesa 014",
  email: "mesa@certus.pe",
  role: "member",
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const citizenUser: User = {
  id: "user-citizen",
  name: "Votante DNI",
  email: "votante@certus.local",
  dni: "12345678",
  role: "citizen",
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

describe("CERTUS vote processing domain", () => {
  it("registers a valid vote with hash, image backup, and confirmed trace", () => {
    const db = dbFixture();
    const record = processBallot(
      db,
      {
        ballotSerial: "ced-1002",
        tableId: "mesa-014",
        imageData: "data:image/svg+xml;base64,PHN2Zy8+",
        markedCandidateIds: ["cand-003"]
      },
      memberUser
    );

    expect(record.voteType).toBe("valid");
    expect(record.candidateId).toBe("cand-003");
    expect(record.integrityHash).toHaveLength(64);
    expect(record.trace.map((step) => step.state)).toEqual([
      "created",
      "hash_generated",
      "transmitted",
      "stored",
      "confirmed"
    ]);
    expect(db.images).toHaveLength(1);
    expect(db.records).toHaveLength(1);
    expect(computeResults(db).byCandidate.find((item) => item.candidateId === "cand-003")?.votes).toBe(1);
  });

  it("classifies blank and null ballots", () => {
    const db = dbFixture();
    const blank = processBallot(
      db,
      {
        ballotSerial: "ced-blank",
        tableId: "mesa-014",
        imageData: "data:image/svg+xml;base64,PHN2Zy8+",
        markedCandidateIds: []
      },
      memberUser
    );
    const nulled = processBallot(
      db,
      {
        ballotSerial: "ced-null",
        tableId: "mesa-014",
        imageData: "data:image/svg+xml;base64,PHN2Zy8+",
        markedCandidateIds: ["cand-001", "cand-002"]
      },
      memberUser
    );

    expect(blank.voteType).toBe("blank");
    expect(nulled.voteType).toBe("null");
    expect(computeResults(db).blankVotes).toBe(1);
    expect(computeResults(db).nullVotes).toBe(1);
  });

  it("rejects duplicated ballot serials and creates an incidence", () => {
    const db = dbFixture();
    processBallot(
      db,
      {
        ballotSerial: "ced-duplicada",
        tableId: "mesa-014",
        imageData: "data:image/svg+xml;base64,PHN2Zy8+",
        markedCandidateIds: ["cand-001"]
      },
      memberUser
    );

    expect(() =>
      processBallot(
        db,
        {
          ballotSerial: "CED-DUPLICADA",
          tableId: "mesa-014",
          imageData: "data:image/svg+xml;base64,PHN2Zy8+",
          markedCandidateIds: ["cand-001"]
        },
        memberUser
      )
    ).toThrow(DomainError);
    expect(db.incidences.some((item) => item.title === "Intento de duplicidad")).toBe(true);
  });

  it("registers one virtual QR vote per citizen and blocks duplicates", () => {
    const db = dbFixture();
    db.users.push({ ...citizenUser, passwordHash: "hash" });
    const record = processVirtualVote(
      db,
      {
        tableId: "mesa-014",
        markedCandidateIds: ["cand-001"]
      },
      citizenUser
    );

    expect(record.voteType).toBe("valid");
    expect(record.candidateId).toBe("cand-001");
    expect(db.voterReceipts).toHaveLength(1);
    const email = queueVoteConfirmationEmail(db, citizenUser, record);
    expect(email.to).toBe(citizenUser.email);
    expect(email.bodyText).toContain("Gracias por confiar en Certuspe.");
    expect(email.bodyText).toContain("DNI: 12345678");
    expect(email.bodyText).toContain("Local de votacion: IE Republica del Peru");
    expect(email.bodyText).not.toContain("cand-001");
    expect(db.voterReceipts[0].emailReceiptId).toBe(email.id);
    expect(computeResults(db).totalVotes).toBe(1);
    expect(detailedRecords(db, memberUser)[0]).toMatchObject({
      voterName: "Votante DNI",
      voterEmail: "votante@certus.local",
      voterDni: "12345678"
    });
    expect(() =>
      processVirtualVote(
        db,
        {
          tableId: "mesa-014",
          markedCandidateIds: ["cand-002"]
        },
        citizenUser
      )
    ).toThrow(DomainError);
  });
});

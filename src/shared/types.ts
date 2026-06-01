export type Role = "admin" | "auditor" | "member" | "citizen";

export type VoteType = "valid" | "null" | "blank";

export type RecordState =
  | "created"
  | "hash_generated"
  | "transmitted"
  | "stored"
  | "confirmed";

export type ProcessStatus = "Configuracion" | "En progreso" | "Cerrado";

export type Priority = "Baja" | "Media" | "Alta";

export interface ProjectMember {
  name: string;
  code: string;
}

export interface ProjectMeta {
  university: string;
  course: string;
  document: string;
  systemName: string;
  subtitle: string;
  professor: string;
  members: ProjectMember[];
  colors: {
    primary: string;
    secondary: string;
  };
}

export interface User {
  id: string;
  supabaseUserId?: string;
  name: string;
  email: string;
  dni?: string;
  role: Role;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface Candidate {
  id: string;
  name: string;
  party: string;
  color: string;
  partyCode?: string;
  photoUrl?: string;
  logoUrl?: string;
  officialVotes?: number;
  officialValidPercentage?: number;
  officialEmittedPercentage?: number;
}

export interface District {
  id: string;
  name: string;
}

export interface Zone {
  id: string;
  districtId: string;
  name: string;
}

export interface VotingPlace {
  id: string;
  zoneId: string;
  name: string;
  address: string;
}

export interface VotingTable {
  id: string;
  placeId: string;
  code: string;
  electors: number;
  status: ProcessStatus;
}

export interface BallotImage {
  id: string;
  ballotSerial: string;
  resolution: string;
  capturedAt: string;
  imageHash: string;
  encryptedPayload: string;
  iv: string;
  tag: string;
}

export interface VoteScan {
  id: string;
  voteType: VoteType;
  observation: string;
  selectedCandidateIds: string[];
  detectedMarks: string[];
  confidence: number;
}

export interface VoteRecord {
  id: string;
  ballotSerial: string;
  tableId: string;
  scanId: string;
  imageId: string;
  voteType: VoteType;
  candidateId: string | null;
  integrityHash: string;
  secureTransmissionSeal: string;
  createdBy: string;
  createdAt: string;
  confirmedAt: string;
  trace: Array<{
    state: RecordState;
    at: string;
  }>;
  crossValidation?: {
    physicalVoteType: VoteType;
    physicalCandidateId: string | null;
    status: "consistent" | "inconsistent";
    note: string;
    validatedBy: string;
    validatedAt: string;
  };
}

export interface VoterReceipt {
  id: string;
  userId: string;
  processId: string;
  tableId: string;
  recordId: string;
  emailReceiptId?: string;
  createdAt: string;
}

export interface EmailReceipt {
  id: string;
  userId: string;
  recordId: string;
  to: string;
  subject: string;
  bodyText: string;
  status: "queued" | "sent" | "failed";
  provider: "local_outbox" | "smtp" | "resend";
  createdAt: string;
  sentAt: string | null;
  error: string | null;
  template?: {
    kind: "voter_otp" | "vote_confirmation";
    variables: Record<string, string | number>;
  };
}

export interface Incidence {
  id: string;
  recordId: string | null;
  priority: Priority;
  title: string;
  detail: string;
  status: "Abierta" | "Resuelta";
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  userId: string;
  action: string;
  entity: string;
  entityId: string;
  detail: string;
  createdAt: string;
}

export interface ResultSummary {
  generatedAt: string;
  processStatus: ProcessStatus;
  totalVotes: number;
  validVotes: number;
  nullVotes: number;
  blankVotes: number;
  participation: number;
  byCandidate: Array<{
    candidateId: string;
    name: string;
    party: string;
    color: string;
    partyCode?: string;
    photoUrl?: string;
    logoUrl?: string;
    officialVotes?: number;
    officialValidPercentage?: number;
    officialEmittedPercentage?: number;
    votes: number;
    percentage: number;
  }>;
  byTable: Array<{
    tableId: string;
    tableCode: string;
    totalVotes: number;
    validVotes: number;
    nullVotes: number;
    blankVotes: number;
  }>;
}

export interface DetailedRecord extends VoteRecord {
  voterName: string;
  voterEmail: string;
  voterDni: string | null;
  tableCode: string;
  placeName: string;
  zoneName: string;
  districtName: string;
  candidateName: string | null;
  candidateParty: string | null;
}

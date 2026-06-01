import type {
  AuditLog,
  Candidate,
  DetailedRecord,
  District,
  Incidence,
  ProjectMeta,
  ResultSummary,
  User,
  VoteRecord,
  VoteType,
  VotingPlace,
  VotingTable,
  Zone
} from "../shared/types";

export interface BootstrapData {
  meta: ProjectMeta;
  app: {
    publicBaseUrl: string;
  };
  process: {
    id: string;
    name: string;
    status: string;
    startedAt: string;
    closedAt: string | null;
  };
  candidates: Candidate[];
  districts: District[];
  zones: Zone[];
  places: VotingPlace[];
  tables: VotingTable[];
  results: ResultSummary;
}

export interface AuthState {
  token: string;
  user: User;
}

export interface VirtualVoteData {
  process: BootstrapData["process"];
  table: VotingTable;
  place: VotingPlace | null;
  zone: Zone | null;
  district: District | null;
  candidates: Candidate[];
}

export interface VoteEmailSummary {
  id: string;
  to: string;
  subject: string;
  status: "queued" | "sent" | "failed";
  provider: "local_outbox" | "smtp" | "resend";
  createdAt: string;
  sentAt: string | null;
}

export interface VirtualVoteStatus {
  hasVoted: boolean;
  tableId: string;
  receipt: {
    id: string;
    recordId: string;
    tableId: string;
    createdAt: string;
    email: VoteEmailSummary | null;
  } | null;
}

export interface VoterCodeResponse {
  ok: boolean;
  email: string;
  expiresInSeconds: number;
  deliveryStatus: "queued" | "sent" | "failed";
  provider: "local_outbox" | "smtp" | "resend";
}

export interface HandoffResponse {
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
}

export interface PreliminaryReport {
  id: string;
  generatedAt: string;
  generatedBy: string;
  level: string;
  results: ResultSummary;
  openIncidences: Incidence[];
  inconsistentRecords: VoteRecord[];
  integrity: {
    totalImages: number;
    totalRecords: number;
    confirmedRecords: number;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(path, {
    ...options,
    headers
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError("La API devolvio una respuesta no valida.", response.status);
  }
  const payload = await response.json();
  if (!response.ok) {
    throw new ApiError(payload?.error ?? "No se pudo completar la operacion.", response.status);
  }
  return payload as T;
}

export async function login(email: string, password: string): Promise<AuthState> {
  return api<AuthState>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export async function requestVoterCode(input: { name: string; dni: string; email: string }): Promise<VoterCodeResponse> {
  return api<VoterCodeResponse>("/api/auth/voter/request-code", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function verifyVoterCode(input: {
  dni: string;
  email: string;
  code: string;
}): Promise<AuthState> {
  return api<AuthState>("/api/auth/voter/verify-code", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function createCitizenHandoff(token: string): Promise<HandoffResponse> {
  return api<HandoffResponse>(
    "/api/auth/handoff",
    {
      method: "POST"
    },
    token
  );
}

export async function redeemCitizenHandoff(token: string): Promise<AuthState> {
  return api<AuthState>("/api/auth/handoff/redeem", {
    method: "POST",
    body: JSON.stringify({ token })
  });
}

export async function loadBootstrap(): Promise<BootstrapData> {
  return api<BootstrapData>("/api/bootstrap");
}

export async function loadResults(): Promise<ResultSummary> {
  return api<ResultSummary>("/api/results");
}

export async function loadVirtualVote(tableId: string): Promise<VirtualVoteData> {
  return api<VirtualVoteData>(`/api/vote/${encodeURIComponent(tableId)}`);
}

export async function loadVirtualVoteStatus(token: string, tableId: string): Promise<VirtualVoteStatus> {
  return api<VirtualVoteStatus>(`/api/vote/${encodeURIComponent(tableId)}/status`, {}, token);
}

export async function submitVirtualVote(
  token: string,
  input: { tableId: string; markedCandidateIds: string[] }
): Promise<{ record: VoteRecord; receipt: VirtualVoteStatus["receipt"]; email: VoteEmailSummary | null }> {
  return api<{ record: VoteRecord; receipt: VirtualVoteStatus["receipt"]; email: VoteEmailSummary | null }>(
    "/api/votes/virtual",
    {
      method: "POST",
      body: JSON.stringify(input)
    },
    token
  );
}

export async function loadMe(token: string): Promise<{ user: User }> {
  return api<{ user: User }>("/api/me", {}, token);
}

export async function loadRecords(token: string): Promise<{ records: DetailedRecord[] }> {
  return api<{ records: DetailedRecord[] }>("/api/records", {}, token);
}

export async function loadIncidences(token: string): Promise<{ incidences: Incidence[] }> {
  return api<{ incidences: Incidence[] }>("/api/incidences", {}, token);
}

export async function loadLogs(token: string): Promise<{ logs: AuditLog[] }> {
  return api<{ logs: AuditLog[] }>("/api/audit/logs", {}, token);
}

export async function loadUsers(token: string): Promise<{ users: User[] }> {
  return api<{ users: User[] }>("/api/users", {}, token);
}

export async function processScan(
  token: string,
  input: { ballotSerial: string; tableId: string; imageData: string; markedCandidateIds: string[] }
): Promise<{ record: VoteRecord }> {
  return api<{ record: VoteRecord }>(
    "/api/scans/process",
    {
      method: "POST",
      body: JSON.stringify(input)
    },
    token
  );
}

export async function crossValidate(
  token: string,
  input: {
    recordId: string;
    physicalVoteType: VoteType;
    physicalCandidateId: string | null;
    note: string;
  }
): Promise<{ record: VoteRecord }> {
  return api<{ record: VoteRecord }>(
    "/api/audit/cross-validate",
    {
      method: "POST",
      body: JSON.stringify(input)
    },
    token
  );
}

export async function loadReport(token: string): Promise<{ report: PreliminaryReport }> {
  return api<{ report: PreliminaryReport }>("/api/reports/preliminary", {}, token);
}

export async function createUser(
  token: string,
  input: { name: string; email: string; role: User["role"]; password: string }
): Promise<{ user: User }> {
  return api<{ user: User }>(
    "/api/users",
    {
      method: "POST",
      body: JSON.stringify(input)
    },
    token
  );
}

export async function updateUser(
  token: string,
  id: string,
  input: Partial<Pick<User, "name" | "role" | "status">>
): Promise<{ user: User }> {
  return api<{ user: User }>(
    `/api/users/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify(input)
    },
    token
  );
}

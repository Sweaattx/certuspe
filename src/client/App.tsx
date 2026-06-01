import {
  Archive,
  ChartBar,
  CheckCircle,
  ClockCounterClockwise,
  EnvelopeSimple,
  FileText,
  IdentificationCard,
  ListChecks,
  LockKey,
  Pulse,
  SignOut,
  SlidersHorizontal,
  UserGear,
  WarningCircle
} from "@phosphor-icons/react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";
import upcLogoUrl from "./assets/upc-logo.png";
import type {
  AuditLog,
  Candidate,
  DetailedRecord,
  Incidence,
  ResultSummary,
  Role,
  User,
  VoteRecord,
  VoteType
} from "../shared/types";
import {
  type AuthState,
  type BootstrapData,
  type PreliminaryReport,
  ApiError,
  createCitizenHandoff,
  createUser,
  crossValidate,
  loadBootstrap,
  loadIncidences,
  loadLogs,
  loadMe,
  loadRecords,
  loadReport,
  loadVirtualVote,
  loadVirtualVoteStatus,
  loadUsers,
  login,
  processScan,
  requestVoterCode,
  redeemCitizenHandoff,
  submitVirtualVote,
  type VoterCodeResponse,
  type VoteEmailSummary,
  type VirtualVoteData,
  type VirtualVoteStatus,
  verifyVoterCode,
  updateUser
} from "./api";

type ViewId = "scan" | "results" | "detail" | "reports" | "users" | "history" | "project";
type ScanStageId = "capture" | "processing" | "hash" | "confirmation";
type CrossValidationStatus = NonNullable<VoteRecord["crossValidation"]>["status"];
type VoterIdentityInput = { name: string; dni: string; email: string };
type VoterCodeInput = { dni: string; email: string; code: string };

const tokenStorageKey = "certus-token";
const randomVoteRoute = "__random_vote_route__";
const scanStages: Array<{
  id: ScanStageId;
  label: string;
  title: string;
  summary: string;
  details: string[];
  evidence: string;
}> = [
  {
    id: "capture",
    label: "Captura",
    title: "Captura fisica de la cedula",
    summary: "El miembro de mesa inserta la cedula en el terminal de escaneo para obtener una imagen digital verificable.",
    details: [
      "Se registra mesa, codigo de cedula, fecha y operador responsable.",
      "La imagen queda como respaldo digital antes de depositar la cedula en la urna fisica.",
      "El QR se usa solo como demostracion cuando no hay escaner real disponible."
    ],
    evidence: "RF-001 / US-001"
  },
  {
    id: "processing",
    label: "Procesamiento",
    title: "Procesamiento de imagen e IA",
    summary: "CERTUS interpreta la imagen capturada, identifica marcas y determina si existe un candidato seleccionado.",
    details: [
      "El motor detecta marcas realizadas por el votante dentro de la cedula.",
      "El sistema clasifica el voto como valido, en blanco o nulo.",
      "La validacion automatica reduce errores de conteo manual y observaciones tardias."
    ],
    evidence: "RF-002 / RF-003 / RF-005"
  },
  {
    id: "hash",
    label: "Hash",
    title: "Trazabilidad y respaldo",
    summary: "Cada registro confirmado genera una huella unica para auditoria sin exponer la identidad del voto.",
    details: [
      "Se genera un hash con datos del registro, mesa, tipo de voto y marca temporal.",
      "La imagen digital y el voto procesado se guardan en repositorios separados.",
      "El auditor puede contrastar actas fisicas con registros digitales ante inconsistencias."
    ],
    evidence: "RF-013 / RF-014 / RF-015"
  },
  {
    id: "confirmation",
    label: "Confirmacion",
    title: "Transmision segura y confirmacion",
    summary: "El terminal envia el registro al servidor central y deja evidencia para resultados preliminares.",
    details: [
      "La transmision se realiza de forma segura hacia el servidor central.",
      "El sistema bloquea duplicados y registra acciones para auditoria.",
      "Los resultados preliminares quedan disponibles para usuarios autorizados y ciudadania."
    ],
    evidence: "RF-008 / RF-009 / RF-018 / RF-020"
  }
];

function currentVoteRoute(): string | null {
  if (window.location.pathname === "/votar") {
    return randomVoteRoute;
  }
  const match = window.location.pathname.match(/^\/votar\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function currentVoteRouteRequiresVoterAccess(): boolean {
  return new URLSearchParams(window.location.search).get("registro") === "1";
}

function currentResultsRoute(): boolean {
  return window.location.pathname === "/resultados";
}

function clearVoterRegistrationModeFromUrl() {
  if (currentVoteRouteRequiresVoterAccess()) {
    window.history.replaceState(null, "", window.location.pathname);
  }
}

function votingUrl(tableId?: string, baseUrl?: string | null, forceVoterAccess = false): string {
  const origin = baseUrl?.trim().replace(/\/+$/, "") || window.location.origin;
  const path = tableId ? `${origin}/votar/${encodeURIComponent(tableId)}` : `${origin}/votar`;
  return forceVoterAccess ? `${path}?registro=1` : path;
}

function UpcLogo({ large = false }: { large?: boolean }) {
  return <img className={large ? "brand-logo large" : "brand-logo"} src={upcLogoUrl} alt="Logo UPC" />;
}

function randomVotingTableId(tables: BootstrapData["tables"]): string | null {
  const openTables = tables.filter((table) => table.status === "En progreso");
  const pool = openTables.length > 0 ? openTables : tables;
  if (pool.length === 0) {
    return null;
  }
  return pool[Math.floor(Math.random() * pool.length)].id;
}

const requirementGroups = [
  {
    title: "Captura y procesamiento de votos",
    items: ["RF-001 Captura digital de cedula", "RF-002 Procesamiento de imagen", "RF-003 Deteccion de marcas", "RF-004 Determinacion de candidato"]
  },
  {
    title: "Validacion y registro",
    items: ["RF-005 Clasificacion de voto", "RF-006 Registro centralizado", "RF-007 Asociacion por mesa", "RF-008 Control de duplicidad"]
  },
  {
    title: "Visualizacion y acceso",
    items: ["RF-009 Resultados preliminares", "RF-010 Resultados en tiempo real", "RF-011 Consulta ciudadana", "RF-012 Vista de auditor"]
  },
  {
    title: "Seguridad y auditoria",
    items: ["RF-013 Respaldo digital", "RF-014 Validacion cruzada", "RF-015 Deteccion de inconsistencias", "RF-016 Reportes automaticos"]
  },
  {
    title: "Gestion del sistema",
    items: ["RF-017 Roles y permisos", "RF-018 Transmision segura", "RF-019 Consulta historica", "RF-020 Registro de acciones"]
  }
];

const navItems: Array<{
  id: ViewId;
  label: string;
  roles: Role[] | "all";
  icon: typeof ChartBar;
}> = [
  { id: "scan", label: "Escaneo", roles: "all", icon: IdentificationCard },
  { id: "results", label: "Resultados", roles: "all", icon: ChartBar },
  { id: "detail", label: "Auditoria", roles: ["admin", "auditor", "member"], icon: SlidersHorizontal },
  { id: "reports", label: "Reportes", roles: ["admin", "auditor", "member"], icon: FileText },
  { id: "users", label: "Usuarios", roles: ["admin"], icon: UserGear },
  { id: "history", label: "Historial", roles: ["admin", "auditor"], icon: ClockCounterClockwise },
  { id: "project", label: "Proyecto", roles: "all", icon: Archive }
];

function roleLabel(role: Role): string {
  const labels: Record<Role, string> = {
    admin: "Administrador",
    auditor: "Auditor",
    member: "Miembro de mesa",
    citizen: "Ciudadania"
  };
  return labels[role];
}

function voteTypeLabel(type: VoteType): string {
  const labels: Record<VoteType, string> = {
    valid: "Valido",
    null: "Nulo",
    blank: "En blanco"
  };
  return labels[type];
}

function crossValidationLabel(status?: CrossValidationStatus): string {
  if (status === "consistent") {
    return "Validado";
  }
  if (status === "inconsistent") {
    return "Inconsistente";
  }
  return "Pendiente";
}

function crossValidationBadgeClass(status?: CrossValidationStatus): string {
  if (status === "consistent") {
    return "badge success";
  }
  if (status === "inconsistent") {
    return "badge danger";
  }
  return "badge";
}

function projectMemberName(name: string): string {
  return name.startsWith("Llanos Alvarez, Guillermo ") ? "Llanos Alvarez, Guillermo" : name;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(value));
}

function encodeSvg(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createBallotPreview(candidates: Candidate[], selectedIds: string[], serial: string): string {
  const height = 404 + Math.max(0, candidates.length - 4) * 54;
  const footerLineY = height - 38;
  const footerTextY = height - 25;
  const frameHeight = height - 44;
  const rows = candidates
    .map((candidate, index) => {
      const y = 104 + index * 54;
      const marked = selectedIds.includes(candidate.id);
      const name = escapeSvgText(candidate.name);
      const party = escapeSvgText(candidate.party);
      return `
        <rect x="42" y="${y}" width="416" height="42" rx="1.5" fill="#ffffff" stroke="#dfe5f0"/>
        <rect x="42" y="${y}" width="4" height="42" fill="${candidate.color}"/>
        <text x="62" y="${y + 18}" font-family="'IBM Plex Sans', Arial, sans-serif" font-size="14" font-weight="500" fill="#171b29">${name}</text>
        <text x="62" y="${y + 33}" font-family="'IBM Plex Sans', Arial, sans-serif" font-size="9.5" font-weight="500" fill="#1D3096">${party}</text>
        <rect x="412" y="${y + 8}" width="24" height="24" fill="#ffffff" stroke="#1D3096" stroke-width="2"/>
        ${marked ? `<path d="M418 ${y + 14} L430 ${y + 26} M430 ${y + 14} L418 ${y + 26}" fill="none" stroke="#1D3096" stroke-width="4.2" stroke-linecap="square" stroke-linejoin="miter"/>` : ""}
      `;
    })
    .join("");

  const safeSerial = escapeSvgText(serial.trim() || "CEDULA-DEMO");
  return encodeSvg(`
    <svg xmlns="http://www.w3.org/2000/svg" width="500" height="${height}" viewBox="0 0 500 ${height}">
      <rect width="500" height="${height}" fill="#fbfcff"/>
      <rect x="26" y="22" width="448" height="${frameHeight}" rx="4" fill="#ffffff" stroke="#d8dfec"/>
      <text x="42" y="55" font-family="'IBM Plex Sans', Arial, sans-serif" font-size="21" font-weight="700" fill="#1D3096">CERTUS</text>
      <text x="42" y="75" font-family="'IBM Plex Mono', Consolas, monospace" font-size="9.5" font-weight="600" fill="#5b6ea6">CEDULA DIGITAL ${safeSerial}</text>
      <line x1="42" y1="88" x2="458" y2="88" stroke="#eef2f7"/>
      ${rows}
      <line x1="42" y1="${footerLineY}" x2="458" y2="${footerLineY}" stroke="#eef2f7"/>
      <text x="42" y="${footerTextY}" font-family="'IBM Plex Mono', Consolas, monospace" font-size="8.5" fill="#667086">Documento generado por terminal CERTUS</text>
    </svg>
  `);
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [activeView, setActiveView] = useState<ViewId>("scan");
  const [records, setRecords] = useState<DetailedRecord[]>([]);
  const [incidences, setIncidences] = useState<Incidence[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const loadProtectedData = useCallback(async (nextAuth: AuthState | null) => {
    if (!nextAuth) {
      setRecords([]);
      setIncidences([]);
      setLogs([]);
      setUsers([]);
      return;
    }

    const role = nextAuth.user.role;
    const tasks: Array<Promise<void>> = [];

    if (["admin", "auditor", "member"].includes(role)) {
      tasks.push(
        Promise.all([loadRecords(nextAuth.token), loadIncidences(nextAuth.token)]).then(([recordData, incidenceData]) => {
          setRecords(recordData.records);
          setIncidences(incidenceData.incidences);
        })
      );
    } else {
      setRecords([]);
      setIncidences([]);
    }

    if (["admin", "auditor"].includes(role)) {
      tasks.push(
        loadLogs(nextAuth.token).then((logData) => {
          setLogs(logData.logs);
        })
      );
    } else {
      setLogs([]);
    }

    if (role === "admin") {
      tasks.push(
        loadUsers(nextAuth.token).then((userData) => {
          setUsers(userData.users);
        })
      );
    } else {
      setUsers([]);
    }

    await Promise.all(tasks);
  }, []);

  const refresh = useCallback(
    async (nextAuth = auth) => {
      const data = await loadBootstrap();
      setBootstrap(data);
      await loadProtectedData(nextAuth);
    },
    [auth, loadProtectedData]
  );

  useEffect(() => {
    let mounted = true;
    async function boot() {
      try {
        const data = await loadBootstrap();
        if (!mounted) {
          return;
        }
        setBootstrap(data);

        const handoffToken = new URLSearchParams(window.location.search).get("handoff");

        if (handoffToken && currentVoteRoute()) {
          try {
            const nextAuth = await redeemCitizenHandoff(handoffToken);
            localStorage.setItem(tokenStorageKey, nextAuth.token);
            setAuth(nextAuth);
            setActiveView("results");
            setHandoffError(null);
            window.history.replaceState(null, "", window.location.pathname);
            setLoading(false);
            void refresh(nextAuth).catch((error) => {
              setNotice(error instanceof Error ? error.message : "No se pudo actualizar la informacion.");
            });
            return;
          } catch (error) {
            localStorage.removeItem(tokenStorageKey);
            setHandoffError(error instanceof ApiError ? error.message : "No se pudo validar el QR de acceso.");
            window.history.replaceState(null, "", window.location.pathname);
          }
        }

        const savedToken = localStorage.getItem(tokenStorageKey);

        if (savedToken && !currentVoteRouteRequiresVoterAccess()) {
          const me = await loadMe(savedToken);
          const nextAuth = { token: savedToken, user: me.user };
          setAuth(nextAuth);
          setActiveView(me.user.role === "auditor" ? "detail" : me.user.role === "citizen" ? "results" : "scan");
          setLoading(false);
          void loadProtectedData(nextAuth).catch((error) => {
            if (mounted) {
              setNotice(error instanceof Error ? error.message : "No se pudo cargar la informacion privada.");
            }
          });
        }
      } catch (error) {
        if (mounted) {
          setBootError(error instanceof Error ? error.message : "No se pudo cargar la aplicacion.");
        }
        localStorage.removeItem(tokenStorageKey);
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }
    boot();
    return () => {
      mounted = false;
    };
  }, []);

  const role = auth?.user.role ?? "citizen";
  const availableNav = navItems.filter((item) => item.roles === "all" || item.roles.includes(role));

  function handleLogout() {
    localStorage.removeItem(tokenStorageKey);
    setAuth(null);
    setRecords([]);
    setIncidences([]);
    setLogs([]);
    setUsers([]);
    setActiveView("scan");
  }

  function applyAuth(nextAuth: AuthState) {
    localStorage.setItem(tokenStorageKey, nextAuth.token);
    setAuth(nextAuth);
    setActiveView(nextAuth.user.role === "auditor" ? "detail" : nextAuth.user.role === "citizen" ? "results" : "scan");
    void refresh(nextAuth).catch((error) => {
      setNotice(error instanceof Error ? error.message : "No se pudo actualizar la informacion.");
    });
  }

  async function handleLogin(email: string, password: string) {
    applyAuth(await login(email, password));
  }

  async function handleVoterCodeRequest(input: VoterIdentityInput): Promise<VoterCodeResponse> {
    return requestVoterCode(input);
  }

  async function handleVoterCodeVerify(input: VoterCodeInput) {
    const nextAuth = await verifyVoterCode(input);
    applyAuth(nextAuth);
    return nextAuth;
  }

  async function handleVotingVoterAccess(input: VoterCodeInput) {
    const nextAuth = await verifyVoterCode(input);
    localStorage.setItem(tokenStorageKey, nextAuth.token);
    setAuth(nextAuth);
    clearVoterRegistrationModeFromUrl();
    void refresh(nextAuth).catch((error) => {
      setNotice(error instanceof Error ? error.message : "No se pudo actualizar la informacion.");
    });
    return nextAuth;
  }

  if (loading) {
    return (
      <div className="app-loading" aria-live="polite" aria-label="Cargando CERTUS">
        <div className="loading-sequence">
          <span className="loading-kicker">Cargando sistema</span>
          <span className="loading-title" aria-label="CERTUS">
            {"CERTUS".split("").map((letter, index) => (
              <span key={`${letter}-${index}`} aria-hidden="true">
                {letter}
              </span>
            ))}
          </span>
          <div className="loading-bar" aria-hidden="true">
            <span />
          </div>
          <span className="loading-status">Preparando proceso electoral</span>
        </div>
      </div>
    );
  }

  if (!bootstrap) {
    return (
      <div className="app-loading app-loading-error">
        <h1>No se pudo cargar CERTUS</h1>
        <p>{bootError ?? "La API no respondio correctamente."}</p>
        <button type="button" className="primary-action" onClick={() => window.location.reload()}>
          Reintentar
        </button>
      </div>
    );
  }

  const voteRouteTableId = currentVoteRoute();
  if (currentResultsRoute()) {
    return <PublicResultsPage data={bootstrap} />;
  }

  if (voteRouteTableId) {
    if (voteRouteTableId === randomVoteRoute) {
      return (
        <RandomVoteRoute
          auth={auth}
          tables={bootstrap.tables}
          onRequestCode={handleVoterCodeRequest}
          onVerifyCode={handleVotingVoterAccess}
          onRefresh={refresh}
          accessError={handoffError}
        />
      );
    }
    return (
      <VirtualVotePage
        auth={auth}
        tableId={voteRouteTableId}
        onRequestCode={handleVoterCodeRequest}
        onVerifyCode={handleVotingVoterAccess}
        onRefresh={refresh}
        accessError={handoffError}
      />
    );
  }

  if (!auth) {
    return (
      <AuthScreen
        data={bootstrap}
        onLogin={handleLogin}
        onRequestCode={handleVoterCodeRequest}
        onVerifyCode={handleVoterCodeVerify}
      />
    );
  }

  if (auth.user.role === "citizen") {
    return (
      <CitizenQrOnlyPage
        processName={bootstrap.process.name}
        auth={auth}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <UpcLogo />
          <div>
            <strong>CERTUS</strong>
            <span>Conteo preliminar</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="Navegacion principal">
          {availableNav.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={activeView === item.id ? "nav-item active" : "nav-item"}
                type="button"
                onClick={() => setActiveView(item.id)}
                title={item.label}
              >
                <Icon size={19} weight="duotone" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        {auth ? (
          <div className="session-card">
            <>
              <span className="eyebrow">{roleLabel(auth.user.role)}</span>
              <strong>{auth.user.name}</strong>
              <button className="ghost-button" type="button" onClick={handleLogout}>
                <SignOut size={17} />
                Salir
              </button>
            </>
          </div>
        ) : null}
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">{bootstrap.process.name}</span>
            <h1>{viewTitle(activeView)}</h1>
          </div>
          <div className="status-strip">
            <span className="status-dot" />
            <span>{bootstrap.process.status}</span>
          </div>
        </header>

        {notice ? (
          <div className="notice" role="status">
            <CheckCircle size={18} />
            {notice}
            <button type="button" onClick={() => setNotice(null)}>
              Cerrar
            </button>
          </div>
        ) : null}

        {activeView === "scan" ? (
          <ScanView
            auth={auth}
            data={bootstrap}
            onRefresh={refresh}
            onNotice={setNotice}
          />
        ) : null}
        {activeView === "results" ? <ResultsView results={bootstrap.results} /> : null}
        {activeView === "detail" ? (
          <DetailView
            auth={auth}
            data={bootstrap}
            records={records}
            incidences={incidences}
            onRefresh={refresh}
            onNotice={setNotice}
          />
        ) : null}
        {activeView === "reports" ? <ReportsView auth={auth} incidences={incidences} /> : null}
        {activeView === "users" ? (
          <UsersView auth={auth} users={users} onRefresh={refresh} onNotice={setNotice} />
        ) : null}
        {activeView === "history" ? <HistoryView logs={logs} users={users} /> : null}
        {activeView === "project" ? <ProjectView data={bootstrap} /> : null}
      </main>
    </div>
  );
}

function viewTitle(view: ViewId): string {
  const titles: Record<ViewId, string> = {
    scan: "Escaneo de cedula",
    results: "Resultados generales",
    detail: "Resultados detallados",
    reports: "Reportes automaticos",
    users: "Gestion de usuarios",
    history: "Historial de acciones",
    project: "Ficha del proyecto"
  };
  return titles[view];
}

function CitizenQrOnlyPage({
  processName,
  auth,
  onLogout
}: {
  processName: string;
  auth: AuthState;
  onLogout: () => void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [handoffUrl, setHandoffUrl] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingQr, setLoadingQr] = useState(false);

  const refreshQr = useCallback(async () => {
    setLoadingQr(true);
    setError(null);
    try {
      const handoff = await createCitizenHandoff(auth.token);
      const qr = await QRCode.toDataURL(handoff.url, {
        width: 260,
        margin: 1,
        color: {
          dark: "#1D3096",
          light: "#FFFFFF"
        }
      });
      setHandoffUrl(handoff.url);
      setExpiresAt(handoff.expiresAt);
      setQrDataUrl(qr);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo generar el QR ciudadano.");
    } finally {
      setLoadingQr(false);
    }
  }, [auth.token]);

  useEffect(() => {
    void refreshQr();
  }, [refreshQr]);

  return (
    <main className="citizen-page" aria-label="Acceso ciudadano CERTUS">
      <section className="citizen-shell">
        <div className="brand auth-brand">
          <UpcLogo />
          <div>
            <strong>CERTUS</strong>
            <span>Votacion por QR</span>
          </div>
        </div>
        <div className="citizen-copy">
          <span className="eyebrow">{processName}</span>
          <h1>Escanea el QR para votar</h1>
          <p>
            Tu cuenta ciudadana ya esta activa. Esta pantalla solo muestra el QR para llevar la sesion al telefono y abrir la cedula virtual.
          </p>
        </div>
        <div className="citizen-qr-card">
          <div>
            <span className="eyebrow">QR ciudadano temporal</span>
            <strong>Sesion lista para escanear</strong>
            <small>
              El telefono usara tu cuenta y CERTUS asignara una mesa disponible. El acceso vence {expiresAt ? formatDate(expiresAt) : "en unos minutos"}.
            </small>
          </div>
          {qrDataUrl ? <img src={qrDataUrl} alt="QR general para votar" /> : <div className="qr-placeholder" />}
          <button className="ghost-button wide" type="button" onClick={refreshQr} disabled={loadingQr}>
            {loadingQr ? "Generando QR" : "Actualizar QR"}
          </button>
          {handoffUrl ? <code>{handoffUrl}</code> : null}
          {error ? <p className="field-error">{error}</p> : null}
        </div>
        <div className="citizen-account">
          <span>Cuenta conectada</span>
          <strong>{auth.user.email}</strong>
          <button className="ghost-button" type="button" onClick={onLogout}>
            <SignOut size={17} />
            Salir
          </button>
        </div>
      </section>
    </main>
  );
}

function PublicResultsPage({ data }: { data: BootstrapData }) {
  return (
    <main className="vote-page results-public-page">
      <section className="vote-shell results-public-shell">
        <div className="vote-header">
          <div className="brand auth-brand">
            <UpcLogo />
            <div>
              <strong>CERTUS</strong>
              <span>Resultados</span>
            </div>
          </div>
          <div>
            <span className="eyebrow">{data.process.name}</span>
            <h1>Resultados electorales</h1>
            <p>Conteo preliminar publicado para consulta ciudadana.</p>
          </div>
        </div>
        <OnpeResultsPanel results={data.results} />
      </section>
    </main>
  );
}

function RandomVoteRoute({
  auth,
  tables,
  onRequestCode,
  onVerifyCode,
  onRefresh,
  accessError
}: {
  auth: AuthState | null;
  tables: BootstrapData["tables"];
  onRequestCode: (input: VoterIdentityInput) => Promise<VoterCodeResponse>;
  onVerifyCode: (input: VoterCodeInput) => Promise<AuthState | null>;
  onRefresh: (auth?: AuthState | null) => Promise<void>;
  accessError?: string | null;
}) {
  const [assignedTableId] = useState(() => randomVotingTableId(tables));

  useEffect(() => {
    if (assignedTableId) {
      const nextRoute = currentVoteRouteRequiresVoterAccess()
        ? `/votar/${encodeURIComponent(assignedTableId)}?registro=1`
        : `/votar/${encodeURIComponent(assignedTableId)}`;
      window.history.replaceState(null, "", nextRoute);
    }
  }, [assignedTableId]);

  if (!assignedTableId) {
    return (
      <main className="vote-page">
        <section className="vote-shell">
          <div className="brand auth-brand">
            <UpcLogo />
            <div>
              <strong>CERTUS</strong>
              <span>Cedula virtual</span>
            </div>
          </div>
          <div className="vote-auth-panel">
            <span className="eyebrow">Proceso electoral</span>
            <h2>No hay mesas disponibles</h2>
            <p>El proceso no tiene mesas habilitadas para votacion en este momento.</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <VirtualVotePage
      auth={auth}
      tableId={assignedTableId}
      onRequestCode={onRequestCode}
      onVerifyCode={onVerifyCode}
      onRefresh={onRefresh}
      accessError={accessError}
    />
  );
}

function AuthScreen({
  data,
  onLogin,
  onRequestCode,
  onVerifyCode
}: {
  data: BootstrapData;
  onLogin: (email: string, password: string) => Promise<void>;
  onRequestCode: (input: VoterIdentityInput) => Promise<VoterCodeResponse>;
  onVerifyCode: (input: VoterCodeInput) => Promise<AuthState | null>;
}) {
  return (
    <main className="auth-page" aria-label="Acceso CERTUS">
      <section className="auth-card" aria-label="Ventana de ingreso y registro">
        <div className="auth-copy">
          <div>
            <span className="eyebrow">{data.process.name}</span>
            <h1>Acceso al sistema electoral</h1>
            <p>
              El equipo operativo ingresa con contrasena. Los votantes validan su identidad con DNI, correo y codigo de verificacion.
            </p>
          </div>
        </div>
        <AuthPanel
          onLogin={onLogin}
          onRequestCode={onRequestCode}
          onVerifyCode={onVerifyCode}
        />
      </section>
    </main>
  );
}

function AuthPanel({
  onLogin,
  onRequestCode,
  onVerifyCode
}: {
  onLogin: (email: string, password: string) => Promise<void>;
  onRequestCode: (input: VoterIdentityInput) => Promise<VoterCodeResponse>;
  onVerifyCode: (input: VoterCodeInput) => Promise<AuthState | null>;
}) {
  const [mode, setMode] = useState<"login" | "voter">("voter");
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(loginForm.email, loginForm.password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo iniciar sesion.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-panel auth-window">
      <div className="auth-tabs" aria-label="Tipo de acceso">
        <button className={mode === "voter" ? "active" : ""} type="button" onClick={() => setMode("voter")}>
          Votante
        </button>
        <button className={mode === "login" ? "active" : ""} type="button" onClick={() => setMode("login")}>
          Equipo operativo
        </button>
      </div>

      {mode === "login" ? (
        <>
          <form className="auth-form" onSubmit={submitLogin}>
            <label>
              Correo
              <input
                value={loginForm.email}
                onChange={(event) => setLoginForm({ ...loginForm, email: event.target.value })}
                autoComplete="email"
              />
            </label>
            <label>
              Contrasena
              <input
                value={loginForm.password}
                onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })}
                type="password"
                autoComplete="current-password"
              />
            </label>
            <button className="primary-button" type="submit" disabled={submitting}>
              <LockKey size={17} />
              {submitting ? "Validando" : "Ingresar"}
            </button>
          </form>
          {error ? <p className="field-error">{error}</p> : null}
        </>
      ) : (
        <VoterAccessForm onRequestCode={onRequestCode} onVerifyCode={onVerifyCode} />
      )}
    </div>
  );
}

function VoterAccessForm({
  onRequestCode,
  onVerifyCode,
  compact = false
}: {
  onRequestCode: (input: VoterIdentityInput) => Promise<VoterCodeResponse>;
  onVerifyCode: (input: VoterCodeInput) => Promise<AuthState | null>;
  compact?: boolean;
}) {
  const [step, setStep] = useState<"identity" | "code">("identity");
  const [form, setForm] = useState({ name: "", dni: "", email: "", code: "" });
  const [delivery, setDelivery] = useState<VoterCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"request" | "verify" | null>(null);

  async function submitIdentity(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting("request");
    setError(null);
    try {
      const response = await onRequestCode({
        name: form.name,
        dni: form.dni,
        email: form.email
      });
      setDelivery(response);
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo enviar el codigo.");
    } finally {
      setSubmitting(null);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting("verify");
    setError(null);
    try {
      await onVerifyCode({ dni: form.dni, email: form.email, code: form.code });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo verificar el codigo.");
    } finally {
      setSubmitting(null);
    }
  }

  if (step === "code") {
    return (
      <form className={compact ? "voter-form compact" : "voter-form"} onSubmit={submitCode}>
        <div className="otp-note">
          <span className="eyebrow">Correo verificado</span>
          <strong>Ingresa el codigo enviado</strong>
          <small>{delivery?.email ?? form.email}</small>
        </div>
        <label>
          Codigo de verificacion
          <input
            value={form.code}
            onChange={(event) => setForm({ ...form, code: event.target.value.replace(/\D/g, "").slice(0, 6) })}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
          />
        </label>
        <button className="primary-button wide" type="submit" disabled={submitting !== null}>
          <IdentificationCard size={17} />
          {submitting === "verify" ? "Verificando" : "Continuar"}
        </button>
        <button className="ghost-button wide" type="button" onClick={() => setStep("identity")} disabled={submitting !== null}>
          Cambiar datos
        </button>
        {error ? <p className="field-error">{error}</p> : null}
      </form>
    );
  }

  return (
    <form className={compact ? "voter-form compact" : "voter-form"} onSubmit={submitIdentity}>
      <div className="otp-note">
        <span className="eyebrow">Registro de votante</span>
        <strong>DNI y correo</strong>
        <small>El codigo evita accesos no autorizados antes de emitir el voto.</small>
      </div>
      <label>
        Nombres y apellidos
        <input
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          autoComplete="name"
          minLength={3}
          required
        />
      </label>
      <div className="form-grid">
        <label>
          DNI
          <input
            value={form.dni}
            onChange={(event) => setForm({ ...form, dni: event.target.value.replace(/\D/g, "").slice(0, 8) })}
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            required
          />
        </label>
        <label>
          Correo
          <input
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
            type="email"
            autoComplete="email"
            required
          />
        </label>
      </div>
      <button className="primary-button wide" type="submit" disabled={submitting !== null}>
        <EnvelopeSimple size={17} />
        {submitting === "request" ? "Enviando codigo" : "Enviar codigo"}
      </button>
      {error ? <p className="field-error">{error}</p> : null}
    </form>
  );
}

function VoterLocationCard({
  user,
  data
}: {
  user: User;
  data: VirtualVoteData;
}) {
  const items = [
    { label: "DNI", value: user.dni ?? "No registrado" },
    { label: "Nombres y apellidos", value: user.name },
    { label: "Local de votacion", value: data.place?.name ?? "No asignado" },
    { label: "Direccion", value: data.place?.address ?? "No asignada" },
    { label: "Distrito", value: data.district?.name ?? "No asignado" },
    { label: "Zona", value: data.zone?.name ?? "No asignada" },
    { label: "Mesa", value: data.table.code },
    { label: "Electores", value: formatNumber(data.table.electors) }
  ];

  return (
    <section className="voter-location-card" aria-label="Datos del votante">
      <div>
        <span className="eyebrow">Datos de votacion</span>
        <strong>Consulta de mesa</strong>
      </div>
      <dl>
        {items.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function VirtualVotePage({
  auth,
  tableId,
  onRequestCode,
  onVerifyCode,
  onRefresh,
  accessError
}: {
  auth: AuthState | null;
  tableId: string;
  onRequestCode: (input: VoterIdentityInput) => Promise<VoterCodeResponse>;
  onVerifyCode: (input: VoterCodeInput) => Promise<AuthState | null>;
  onRefresh: (auth?: AuthState | null) => Promise<void>;
  accessError?: string | null;
}) {
  const [data, setData] = useState<VirtualVoteData | null>(null);
  const [status, setStatus] = useState<VirtualVoteStatus | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"vote" | null>(null);
  const [submittedRecord, setSubmittedRecord] = useState<VoteRecord | null>(null);
  const [confirmationEmail, setConfirmationEmail] = useState<VoteEmailSummary | null>(null);

  useEffect(() => {
    let mounted = true;
    loadVirtualVote(tableId)
      .then((response) => {
        if (mounted) {
          setData(response);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err instanceof ApiError ? err.message : "No se pudo cargar la cedula virtual.");
        }
      });
    return () => {
      mounted = false;
    };
  }, [tableId]);

  useEffect(() => {
    if (!auth || auth.user.role !== "citizen" || !data) {
      setStatus(null);
      setConfirmationEmail(null);
      return;
    }
    let mounted = true;
    loadVirtualVoteStatus(auth.token, data.table.id)
      .then((response) => {
        if (mounted) {
          setStatus(response);
          setConfirmationEmail(response.receipt?.email ?? null);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err instanceof ApiError ? err.message : "No se pudo validar tu estado de votacion.");
        }
      });
    return () => {
      mounted = false;
    };
  }, [auth, data]);

  function toggleCandidate(candidateId: string) {
    setSelectedIds((current) =>
      current.includes(candidateId)
        ? current.filter((item) => item !== candidateId)
        : [...current, candidateId]
    );
  }

  async function submitVote() {
    if (!auth || auth.user.role !== "citizen" || !data) {
      setError("Valida tu DNI y correo para emitir tu voto.");
      return;
    }
    setSubmitting("vote");
    setError(null);
    try {
      const response = await submitVirtualVote(auth.token, {
        tableId: data.table.id,
        markedCandidateIds: selectedIds
      });
      setSubmittedRecord(response.record);
      setConfirmationEmail(response.email ?? response.receipt?.email ?? null);
      setStatus({
        hasVoted: true,
        tableId: data.table.id,
        receipt:
          response.receipt ?? {
            id: response.record.id,
            recordId: response.record.id,
            tableId: data.table.id,
            createdAt: response.record.createdAt,
            email: response.email ?? null
          }
      });
      setSubmitting(null);
      void onRefresh(auth).catch(() => undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo registrar el voto.");
      setSubmitting(null);
    }
  }

  const voteType = selectedIds.length === 0 ? "blank" : selectedIds.length > 1 ? "null" : "valid";
  const canVote = auth?.user.role === "citizen" && !status?.hasVoted && data?.process.status === "En progreso";
  const hasProcessedVote = Boolean(status?.hasVoted || submittedRecord);
  const emailReceipt = confirmationEmail ?? status?.receipt?.email ?? null;
  const emailTarget = emailReceipt?.to ?? auth?.user.email;
  const emailStatusText =
    emailReceipt?.status === "sent"
      ? "Correo enviado."
      : emailReceipt?.status === "failed"
        ? "El voto fue registrado; el correo quedo pendiente de reintento."
        : "Comprobante registrado para envio.";

  return (
    <main className="vote-page">
      <section className="vote-shell">
        {!hasProcessedVote ? (
          <div className="vote-header">
            <div className="brand auth-brand">
              <UpcLogo />
              <div>
                <strong>CERTUS</strong>
                <span>Cedula virtual</span>
              </div>
            </div>
            <div>
              <span className="eyebrow">{data?.process.name ?? "Proceso electoral"}</span>
              <h1>Votacion virtual</h1>
              <p>
                Mesa {data?.table.code ?? tableId}
                {data?.place ? ` - ${data.place.name}` : ""}
              </p>
            </div>
          </div>
        ) : null}

        {auth?.user.role === "citizen" && data && !hasProcessedVote ? <VoterLocationCard user={auth.user} data={data} /> : null}

        {!auth ? (
          <div className="vote-auth-panel">
            <span className="eyebrow">Acceso requerido</span>
            <h2>Valida tu DNI para votar</h2>
            <p>El QR es fijo. El DNI y el correo verificado evitan votos duplicados dentro del proceso.</p>
            <VoterAccessForm compact onRequestCode={onRequestCode} onVerifyCode={onVerifyCode} />
            {accessError ? <p className="field-error">{accessError}</p> : null}
          </div>
        ) : auth.user.role !== "citizen" ? (
          <div className="vote-auth-panel">
            <span className="eyebrow">{roleLabel(auth.user.role)}</span>
            <h2>Usa una cuenta ciudadana</h2>
            <p>Cierra sesion e ingresa con DNI y correo como votante para abrir esta cedula.</p>
          </div>
        ) : hasProcessedVote ? (
          <div className="vote-auth-panel success">
            <CheckCircle size={24} weight="fill" />
            <h2>Listo, tu voto ha sido procesado</h2>
            <p>Muchas gracias. CERTUSPE registro tu voto y bloqueo nuevos envios de esta cuenta para el proceso actual.</p>
            <div className="vote-email-receipt">
              <EnvelopeSimple size={20} weight="duotone" />
              <div>
                <span>Comprobante de verificacion</span>
                <strong>{emailTarget}</strong>
                <small>{emailStatusText} No revela por quien votaste. Gracias por confiar en Certuspe.</small>
              </div>
            </div>
            <code>{submittedRecord?.integrityHash.slice(0, 24) ?? status?.receipt?.recordId}</code>
            <a className="primary-button wide" href="/resultados" target="_blank" rel="noreferrer">
              Mostrar resultados
            </a>
            {error ? <p className="field-error">{error}</p> : null}
          </div>
        ) : (
          <div className="virtual-ballot">
            <div className="section-heading">
              <span className="eyebrow">Cedula virtual</span>
              <h2>Marca una opcion</h2>
            </div>
            <div className="virtual-candidate-list">
              {data?.candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  className={selectedIds.includes(candidate.id) ? "virtual-candidate selected" : "virtual-candidate"}
                  type="button"
                  onClick={() => toggleCandidate(candidate.id)}
                >
                  <CandidateMedia candidate={candidate} compact />
                  <span className="candidate-color" style={{ background: candidate.color }} />
                  <strong>{candidate.name}</strong>
                  <small>{candidate.party}</small>
                  <i aria-hidden="true" />
                </button>
              ))}
            </div>
            <div className="virtual-summary">
              <span>Tipo detectado</span>
              <strong>{voteTypeLabel(voteType)}</strong>
              <button className="ghost-button" type="button" onClick={() => setSelectedIds([])}>
                Votar en blanco
              </button>
            </div>
            {error ? <p className="field-error">{error}</p> : null}
            <button className="primary-button wide" type="button" onClick={submitVote} disabled={!canVote || submitting !== null}>
              {submitting === "vote" ? "Registrando voto" : "Enviar voto"}
            </button>
          </div>
        )}

        {error && (!auth || auth.user.role !== "citizen") ? <p className="field-error">{error}</p> : null}
      </section>
    </main>
  );
}

function ScanView({
  auth,
  data,
  onRefresh,
  onNotice
}: {
  auth: AuthState | null;
  data: BootstrapData;
  onRefresh: (auth?: AuthState | null) => Promise<void>;
  onNotice: (message: string | null) => void;
}) {
  const [tableId, setTableId] = useState(data.tables[0]?.id ?? "");
  const [serial, setSerial] = useState(`CED-${Date.now().toString().slice(-6)}`);
  const [selectedIds, setSelectedIds] = useState<string[]>([data.candidates[0]?.id ?? ""]);
  const [imageData, setImageData] = useState(() => createBallotPreview(data.candidates, selectedIds, serial));
  const [lastRecord, setLastRecord] = useState<VoteRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeStageId, setActiveStageId] = useState<ScanStageId>("capture");
  const canProcess = auth?.user.role === "admin" || auth?.user.role === "member";
  const activeStage = scanStages.find((stage) => stage.id === activeStageId) ?? scanStages[0];

  useEffect(() => {
    setImageData(createBallotPreview(data.candidates, selectedIds, serial));
  }, [data.candidates, selectedIds, serial]);

  function toggleCandidate(candidateId: string) {
    setSelectedIds((current) =>
      current.includes(candidateId)
        ? current.filter((item) => item !== candidateId)
        : [...current, candidateId]
    );
  }

  function setValidSample() {
    setSelectedIds([data.candidates[0]?.id ?? ""]);
  }

  function setBlankSample() {
    setSelectedIds([]);
  }

  function setNullSample() {
    setSelectedIds(data.candidates.slice(0, 2).map((candidate) => candidate.id));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canProcess || !auth) {
      setError("Inicia sesion como administrador o miembro de mesa para registrar votos.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setDurationMs(null);
    const started = performance.now();
    try {
      const response = await processScan(auth.token, {
        ballotSerial: serial,
        tableId,
        imageData,
        markedCandidateIds: selectedIds.filter(Boolean)
      });
      setLastRecord(response.record);
      setDurationMs(Math.round(performance.now() - started));
      onNotice(`Registro ${response.record.id.slice(0, 8)} confirmado.`);
      setSerial(`CED-${Date.now().toString().slice(-6)}`);
      await onRefresh(auth);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo procesar la cedula.");
    } finally {
      setSubmitting(false);
    }
  }

  const detectedType = selectedIds.length === 0 ? "blank" : selectedIds.length > 1 ? "null" : "valid";
  const detectedCandidate = data.candidates.find((candidate) => candidate.id === selectedIds[0]);

  return (
    <section className="scan-layout">
      <div className="scan-intro">
        <div>
          <span className="eyebrow">Terminal activa</span>
          <h2>Escaneo y registro de cedulas</h2>
        </div>
        <div className="scan-stage-list" role="tablist" aria-label="Proceso original CERTUS">
          {scanStages.map((stage) => (
            <button
              key={stage.id}
              className={stage.id === activeStage.id ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={stage.id === activeStage.id}
              aria-controls="scan-stage-detail"
              id={`scan-stage-${stage.id}`}
              onClick={() => setActiveStageId(stage.id)}
            >
              {stage.label}
            </button>
          ))}
        </div>
        <div
          className="scan-process-panel"
          id="scan-stage-detail"
          role="tabpanel"
          aria-labelledby={`scan-stage-${activeStage.id}`}
        >
          <div>
            <span className="eyebrow">{activeStage.evidence}</span>
            <h3>{activeStage.title}</h3>
            <p>{activeStage.summary}</p>
          </div>
          <ol>
            {activeStage.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ol>
        </div>
      </div>
      <form className="panel scan-form" onSubmit={submit}>
        <div className="section-heading">
          <span className="eyebrow">Lectura de mesa</span>
          <h2>Datos de la cedula</h2>
        </div>
        <div className="form-grid">
          <label>
            Mesa
            <select value={tableId} onChange={(event) => setTableId(event.target.value)}>
              {data.tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.code}
                </option>
              ))}
            </select>
          </label>
          <label>
            Codigo de cedula
            <input value={serial} onChange={(event) => setSerial(event.target.value)} />
          </label>
        </div>

        <VirtualQrPanel tables={data.tables} publicBaseUrl={data.app.publicBaseUrl} />

        <div className="scan-mode" aria-label="Tipo de lectura detectada">
          <button
            className={detectedType === "valid" ? "mode-button active" : "mode-button"}
            type="button"
            onClick={setValidSample}
          >
            Valido
          </button>
          <button
            className={detectedType === "blank" ? "mode-button active" : "mode-button"}
            type="button"
            onClick={setBlankSample}
          >
            En blanco
          </button>
          <button
            className={detectedType === "null" ? "mode-button active" : "mode-button"}
            type="button"
            onClick={setNullSample}
          >
            Nulo
          </button>
        </div>

        <div className="candidate-list">
          {data.candidates.map((candidate) => (
            <button
              key={candidate.id}
              className={selectedIds.includes(candidate.id) ? "candidate-option selected" : "candidate-option"}
              type="button"
              onClick={() => toggleCandidate(candidate.id)}
            >
              <span style={{ background: candidate.color }} />
              <strong>{candidate.name}</strong>
              <small>{candidate.party}</small>
            </button>
          ))}
        </div>

        {error ? <p className="field-error">{error}</p> : null}
        <button className="primary-button wide process-button" type="submit" disabled={submitting || !canProcess}>
          <Pulse size={18} />
          {submitting ? "Procesando" : canProcess ? "Procesar y registrar voto" : "Acceso requerido"}
        </button>
      </form>

      <div className="panel scanner-preview">
        <div className="preview-frame">
          <img src={imageData} alt="Cedula digital capturada" />
          <span className="corner top-left" />
          <span className="corner top-right" />
          <span className="corner bottom-left" />
          <span className="corner bottom-right" />
        </div>
        <div className="result-box">
          <span className="eyebrow">Resultado detectado</span>
          <dl>
            <div>
              <dt>Tipo de voto</dt>
              <dd>{voteTypeLabel(detectedType)}</dd>
            </div>
            <div>
              <dt>Candidato</dt>
              <dd>{detectedCandidate && detectedType === "valid" ? detectedCandidate.name : "No aplica"}</dd>
            </div>
            <div>
              <dt>Rendimiento</dt>
              <dd>{durationMs === null ? "Sin procesar" : `${durationMs} ms`}</dd>
            </div>
          </dl>
        </div>
        {lastRecord ? <Trace record={lastRecord} /> : <EmptyState title="Sin registro confirmado" />}
      </div>
    </section>
  );
}

function VirtualQrPanel({ tables, publicBaseUrl }: { tables: BootstrapData["tables"]; publicBaseUrl: string }) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [expanded, setExpanded] = useState(false);
  const url = votingUrl(undefined, publicBaseUrl, true);
  const availableTables = tables.filter((item) => item.status === "En progreso");
  const tableCodes = (availableTables.length > 0 ? availableTables : tables).map((item) => item.code).join(", ");

  useEffect(() => {
    let mounted = true;
    QRCode.toDataURL(url, {
      width: 220,
      margin: 1,
      color: {
        dark: "#1D3096",
        light: "#FFFFFF"
      }
    }).then((nextUrl) => {
      if (mounted) {
        setQrDataUrl(nextUrl);
      }
    });
    return () => {
      mounted = false;
    };
  }, [url]);

  return (
    <div className="virtual-qr-panel">
      <div>
        <span className="eyebrow">Escaner virtual</span>
        <strong>QR publico de votantes</strong>
        <small>Proyecta o imprime este QR. El votante valida DNI y correo antes de recibir una mesa al azar entre {tableCodes}.</small>
        <div className="qr-actions">
          <button className="ghost-button" type="button" onClick={() => setExpanded(true)}>
            Mostrar QR
          </button>
          <a className="ghost-button" href={url} target="_blank" rel="noreferrer">
            Probar registro y voto
          </a>
        </div>
      </div>
      {qrDataUrl ? <img src={qrDataUrl} alt="QR publico para registro y votacion" /> : null}

      {expanded ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-panel qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-title">
            <div className="section-heading">
              <span className="eyebrow">Mesas disponibles</span>
              <h2 id="qr-title">QR publico de registro</h2>
            </div>
            {qrDataUrl ? <img src={qrDataUrl} alt="QR publico ampliado para registro y votacion" /> : null}
            <code>{url}</code>
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setExpanded(false)}>
                Cerrar
              </button>
              <a className="primary-button" href={url} target="_blank" rel="noreferrer">
                Probar registro y voto
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Trace({ record }: { record: VoteRecord }) {
  return (
    <div className="trace">
      <span className="eyebrow">Trazabilidad</span>
      {record.trace.map((step) => (
        <div key={`${step.state}-${step.at}`} className="trace-row">
          <CheckCircle size={16} weight="fill" />
          <span>{stateLabel(step.state)}</span>
          <small>{formatDate(step.at)}</small>
        </div>
      ))}
      <code>{record.integrityHash.slice(0, 24)}...</code>
    </div>
  );
}

function stateLabel(state: VoteRecord["trace"][number]["state"]): string {
  const labels: Record<VoteRecord["trace"][number]["state"], string> = {
    created: "Registro creado",
    hash_generated: "Hash generado",
    transmitted: "Transmitido al servidor",
    stored: "Almacenado",
    confirmed: "Confirmado"
  };
  return labels[state];
}

type CandidateVisual = Pick<
  Candidate,
  "name" | "party" | "color" | "partyCode" | "photoUrl" | "logoUrl" | "officialVotes" | "officialValidPercentage"
>;

function fallbackInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");
}

function formatNumber(value: number | undefined): string {
  return new Intl.NumberFormat("es-PE").format(value ?? 0);
}

function formatPercent(value: number | undefined): string {
  return `${Number(value ?? 0).toFixed(3).replace(/\.?0+$/, "")}%`;
}

function CandidateMedia({ candidate, compact = false }: { candidate: CandidateVisual; compact?: boolean }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <span className={compact ? "candidate-media compact" : "candidate-media"}>
      <span className="party-logo" style={{ borderColor: candidate.color }}>
        {candidate.logoUrl && !logoFailed ? (
          <img src={candidate.logoUrl} alt={`Logo ${candidate.party}`} onError={() => setLogoFailed(true)} />
        ) : (
          <span>{candidate.partyCode ?? "ONPE"}</span>
        )}
      </span>
      <span className="candidate-photo" style={{ borderColor: candidate.color }}>
        {candidate.photoUrl && !photoFailed ? (
          <img src={candidate.photoUrl} alt={candidate.name} onError={() => setPhotoFailed(true)} />
        ) : (
          <span>{fallbackInitials(candidate.name)}</span>
        )}
      </span>
    </span>
  );
}

function OnpeResultsPanel({ results }: { results: ResultSummary }) {
  const rows = [...results.byCandidate].sort((a, b) => {
    if (b.votes !== a.votes) {
      return b.votes - a.votes;
    }
    return (b.officialVotes ?? 0) - (a.officialVotes ?? 0);
  });
  const maxVotes = Math.max(1, ...rows.map((item) => item.votes));
  const maxOfficial = Math.max(1, ...rows.map((item) => item.officialValidPercentage ?? 0));
  return (
    <div className="onpe-panel">
      <div className="onpe-panel-head">
        <div>
          <span className="eyebrow">ONPE | CERTUSPE</span>
          <h3>Resultados presidenciales</h3>
          <p>Conteo preliminar del proceso virtual con candidatos de primera vuelta.</p>
        </div>
        <div className="onpe-update">
          <span>Actualizado</span>
          <strong>{formatDate(results.generatedAt)}</strong>
        </div>
      </div>
      <div className="onpe-stats">
        <Metric label="Total" value={formatNumber(results.totalVotes)} />
        <Metric label="Validos" value={formatNumber(results.validVotes)} />
        <Metric label="Nulos" value={formatNumber(results.nullVotes)} />
        <Metric label="Blancos" value={formatNumber(results.blankVotes)} />
      </div>
      <div className="onpe-chart" aria-label="Grafico de resultados presidenciales">
        {rows.map((item, index) => (
          <div className="onpe-row" key={item.candidateId}>
            <span className="onpe-rank">{index + 1}</span>
            <CandidateMedia candidate={item} />
            <div className="onpe-name">
              <strong>{item.name}</strong>
              <span>{item.party}</span>
            </div>
            <div className="onpe-bars">
              <div className="onpe-main-bar">
                <span style={{ width: `${Math.max(item.votes > 0 ? 3 : 0, (item.votes / maxVotes) * 100)}%`, background: item.color }} />
              </div>
              <div className="onpe-reference-bar">
                <span style={{ width: `${((item.officialValidPercentage ?? 0) / maxOfficial) * 100}%`, background: item.color }} />
              </div>
            </div>
            <div className="onpe-count">
              <strong>{formatPercent(item.percentage)}</strong>
              <span>{formatNumber(item.votes)} votos</span>
              <small>Ref. ONPE {formatPercent(item.officialValidPercentage)}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultsView({ results }: { results: ResultSummary }) {
  const maxVotes = Math.max(1, ...results.byCandidate.map((item) => item.votes));
  return (
    <section className="results-layout">
      <div className="metric-strip">
        <Metric label="Total de votos" value={results.totalVotes.toString()} />
        <Metric label="Validos" value={results.validVotes.toString()} />
        <Metric label="Nulos" value={results.nullVotes.toString()} />
        <Metric label="Blancos" value={results.blankVotes.toString()} />
        <Metric label="Participacion" value={`${results.participation}%`} />
      </div>
      <div className="panel chart-panel">
        <div className="section-heading row">
          <div>
            <span className="eyebrow">Ultima actualizacion {formatDate(results.generatedAt)}</span>
            <h2>Conteo preliminar</h2>
          </div>
          <select aria-label="Tipo de grafico">
            <option>Grafico de barras</option>
          </select>
        </div>
        <div className="bar-chart" aria-label="Resultados por candidato">
          {results.byCandidate.map((item) => (
            <div className="bar-row" key={item.candidateId}>
              <CandidateMedia candidate={item} compact />
              <div>
                <strong>{item.name}</strong>
                <span>{item.party}</span>
              </div>
              <div className="bar-track">
                <span
                  className="bar-fill"
                  style={{ width: `${Math.max(4, (item.votes / maxVotes) * 100)}%`, background: item.color }}
                />
              </div>
              <code>{item.votes}</code>
              <small>{item.percentage}%</small>
            </div>
          ))}
        </div>
      </div>
      <div className="panel table-panel">
        <div className="section-heading">
          <span className="eyebrow">Detalle por mesa</span>
          <h2>Avance territorial</h2>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>Mesa</th>
                <th>Total</th>
                <th>Validos</th>
                <th>Nulos</th>
                <th>Blancos</th>
              </tr>
            </thead>
            <tbody>
              {results.byTable.map((table) => (
                <tr key={table.tableId}>
                  <td>{table.tableCode}</td>
                  <td>{table.totalVotes}</td>
                  <td>{table.validVotes}</td>
                  <td>{table.nullVotes}</td>
                  <td>{table.blankVotes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailView({
  auth,
  data,
  records,
  incidences,
  onRefresh,
  onNotice
}: {
  auth: AuthState | null;
  data: BootstrapData;
  records: DetailedRecord[];
  incidences: Incidence[];
  onRefresh: (auth?: AuthState | null) => Promise<void>;
  onNotice: (message: string | null) => void;
}) {
  const [tableId, setTableId] = useState("all");
  const [candidateId, setCandidateId] = useState("all");
  const [selectedRecord, setSelectedRecord] = useState<DetailedRecord | null>(null);
  const [physicalType, setPhysicalType] = useState<VoteType>("valid");
  const [physicalCandidate, setPhysicalCandidate] = useState<string>(data.candidates[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      records.filter((record) => {
        const matchTable = tableId === "all" || record.tableId === tableId;
        const matchCandidate = candidateId === "all" || record.candidateId === candidateId;
        return matchTable && matchCandidate;
      }),
    [candidateId, records, tableId]
  );

  async function validate() {
    if (!auth || !selectedRecord) {
      return;
    }
    setError(null);
    try {
      await crossValidate(auth.token, {
        recordId: selectedRecord.id,
        physicalVoteType: physicalType,
        physicalCandidateId: physicalType === "valid" ? physicalCandidate : null,
        note
      });
      onNotice("Validacion cruzada registrada.");
      setSelectedRecord(null);
      await onRefresh(auth);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo validar el registro.");
    }
  }

  return (
    <section className="detail-layout">
      <div className="panel table-panel wide-panel">
        <div className="section-heading row">
          <div>
            <span className="eyebrow">Auditoria por mesa</span>
            <h2>Registros detallados</h2>
          </div>
          <div className="filters">
            <select value={tableId} onChange={(event) => setTableId(event.target.value)} aria-label="Mesa">
              <option value="all">Todas las mesas</option>
              {data.tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.code}
                </option>
              ))}
            </select>
            <select value={candidateId} onChange={(event) => setCandidateId(event.target.value)} aria-label="Candidato">
              <option value="all">Todos los candidatos</option>
              {data.candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {filtered.length === 0 ? (
          <EmptyState title="No hay registros para los filtros seleccionados" />
        ) : (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Nombre y apellido</th>
                  <th>Correo</th>
                  <th>DNI</th>
                  <th>Cedula</th>
                  <th>Mesa</th>
                  <th>Distrito</th>
                  <th>Tipo</th>
                  <th>Candidato</th>
                  <th>Validacion</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((record) => (
                  <tr key={record.id}>
                    <td>{record.voterName}</td>
                    <td>{record.voterEmail}</td>
                    <td>{record.voterDni ?? "No registrado"}</td>
                    <td>{record.ballotSerial}</td>
                    <td>{record.tableCode}</td>
                    <td>{record.districtName}</td>
                    <td>{voteTypeLabel(record.voteType)}</td>
                    <td>{record.candidateName ?? "No aplica"}</td>
                    <td>
                      <span className={crossValidationBadgeClass(record.crossValidation?.status)}>
                        {crossValidationLabel(record.crossValidation?.status)}
                      </span>
                    </td>
                    <td>
                      <button className="small-button" type="button" onClick={() => setSelectedRecord(record)}>
                        Validar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <aside className="panel audit-side">
        <div className="section-heading">
          <span className="eyebrow">Incidencias</span>
          <h2>{incidences.length} alertas</h2>
        </div>
        <div className="incidence-list">
          {incidences.slice(0, 5).map((item) => (
            <div key={item.id} className="incidence-item">
              <WarningCircle size={17} />
              <div>
                <strong>{item.title}</strong>
                <span>{item.priority} - {item.status}</span>
              </div>
            </div>
          ))}
          {incidences.length === 0 ? <EmptyState title="Sin incidencias registradas" /> : null}
        </div>
      </aside>

      {selectedRecord ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="validate-title">
            <div className="section-heading">
              <span className="eyebrow">{selectedRecord.ballotSerial}</span>
              <h2 id="validate-title">Validacion cruzada</h2>
            </div>
            <label>
              Tipo en acta fisica
              <select value={physicalType} onChange={(event) => setPhysicalType(event.target.value as VoteType)}>
                <option value="valid">Valido</option>
                <option value="null">Nulo</option>
                <option value="blank">En blanco</option>
              </select>
            </label>
            {physicalType === "valid" ? (
              <label>
                Candidato en acta
                <select value={physicalCandidate} onChange={(event) => setPhysicalCandidate(event.target.value)}>
                  {data.candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              Observacion
              <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} />
            </label>
            {error ? <p className="field-error">{error}</p> : null}
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setSelectedRecord(null)}>
                Cancelar
              </button>
              <button className="primary-button" type="button" onClick={validate}>
                Registrar validacion
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ReportsView({ auth, incidences }: { auth: AuthState | null; incidences: Incidence[] }) {
  const [report, setReport] = useState<PreliminaryReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (!auth) {
      setError("Debes iniciar sesion para generar reportes.");
      return;
    }
    setError(null);
    try {
      const response = await loadReport(auth.token);
      setReport(response.report);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo generar el reporte.");
    }
  }

  function download() {
    if (!report) {
      return;
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `reporte-certus-${report.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="reports-layout">
      <div className="panel">
        <div className="section-heading">
          <span className="eyebrow">Reporte preliminar</span>
          <h2>Resumen automatico del conteo</h2>
        </div>
        {error ? <p className="field-error">{error}</p> : null}
        <div className="button-row">
          <button className="primary-button" type="button" onClick={generate}>
            <FileText size={17} />
            Generar reporte
          </button>
          <button className="ghost-button" type="button" onClick={download} disabled={!report}>
            Descargar JSON
          </button>
        </div>
      </div>
      <div className="panel report-summary">
        {report ? (
          <>
            <Metric label="Registros" value={report.integrity.totalRecords.toString()} />
            <Metric label="Imagenes" value={report.integrity.totalImages.toString()} />
            <Metric label="Confirmados" value={report.integrity.confirmedRecords.toString()} />
            <Metric label="Incidencias abiertas" value={report.openIncidences.length.toString()} />
          </>
        ) : (
          <EmptyState title="Genera un reporte para revisar integridad, incidencias y resultados" />
        )}
      </div>
      <div className="panel">
        <div className="section-heading">
          <span className="eyebrow">Alertas operativas</span>
          <h2>Riesgos detectados</h2>
        </div>
        <div className="incidence-list">
          {incidences.map((item) => (
            <div key={item.id} className="incidence-item">
              <WarningCircle size={17} />
              <div>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </div>
            </div>
          ))}
          {incidences.length === 0 ? <EmptyState title="No hay riesgos registrados" /> : null}
        </div>
      </div>
    </section>
  );
}

function UsersView({
  auth,
  users,
  onRefresh,
  onNotice
}: {
  auth: AuthState | null;
  users: User[];
  onRefresh: (auth?: AuthState | null) => Promise<void>;
  onNotice: (message: string | null) => void;
}) {
  const [form, setForm] = useState({ name: "", email: "", role: "auditor" as Role, password: "Certus2026!" });
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!auth) {
      return;
    }
    setError(null);
    try {
      await createUser(auth.token, form);
      setForm({ name: "", email: "", role: "auditor", password: "Certus2026!" });
      onNotice("Usuario creado correctamente.");
      await onRefresh(auth);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo crear el usuario.");
    }
  }

  async function patchUser(user: User, role: Role, status: User["status"]) {
    if (!auth) {
      return;
    }
    await updateUser(auth.token, user.id, { role, status });
    await onRefresh(auth);
  }

  return (
    <section className="users-layout">
      <form className="panel" onSubmit={submit}>
        <div className="section-heading">
          <span className="eyebrow">Roles y permisos</span>
          <h2>Nuevo usuario</h2>
        </div>
        <label>
          Nombre
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </label>
        <label>
          Correo
          <input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        </label>
        <label>
          Rol
          <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })}>
            <option value="admin">Administrador</option>
            <option value="auditor">Auditor</option>
            <option value="member">Miembro de mesa</option>
            <option value="citizen">Ciudadania</option>
          </select>
        </label>
        <label>
          Contrasena inicial
          <input value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </label>
        {error ? <p className="field-error">{error}</p> : null}
        <button className="primary-button" type="submit">
          Crear usuario
        </button>
      </form>
      <div className="panel table-panel">
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Correo</th>
                <th>Rol</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>
                    <select
                      value={user.role}
                      onChange={(event) => patchUser(user, event.target.value as Role, user.status)}
                    >
                      <option value="admin">Administrador</option>
                      <option value="auditor">Auditor</option>
                      <option value="member">Miembro de mesa</option>
                      <option value="citizen">Ciudadania</option>
                    </select>
                  </td>
                  <td>
                    <select
                      value={user.status}
                      onChange={(event) => patchUser(user, user.role, event.target.value as User["status"])}
                    >
                      <option value="active">Activo</option>
                      <option value="inactive">Inactivo</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function HistoryView({ logs, users }: { logs: AuditLog[]; users: User[] }) {
  const userById = new Map(users.map((user) => [user.id, user.name]));
  return (
    <section className="panel">
      <div className="section-heading">
        <span className="eyebrow">Registro de acciones</span>
        <h2>Auditoria del sistema</h2>
      </div>
      <div className="timeline">
        {logs.map((log) => (
          <div key={log.id} className="timeline-row">
            <ListChecks size={17} />
            <div>
              <strong>{log.action}</strong>
              <span>{log.detail}</span>
            </div>
            <small>{userById.get(log.userId) ?? log.userId}</small>
            <time>{formatDate(log.createdAt)}</time>
          </div>
        ))}
        {logs.length === 0 ? <EmptyState title="Sin acciones registradas" /> : null}
      </div>
    </section>
  );
}

function ProjectView({ data }: { data: BootstrapData }) {
  return (
    <section className="project-layout">
      <div className="panel project-cover">
        <UpcLogo large />
        <span>{data.meta.university}</span>
        <h2>{data.meta.systemName}</h2>
        <p>{data.meta.subtitle}</p>
        <dl>
          <div>
            <dt>Curso</dt>
            <dd>{data.meta.course}</dd>
          </div>
        </dl>
      </div>
      <div className="panel">
        <div className="section-heading">
          <span className="eyebrow">Integrantes</span>
          <h2>Equipo del proyecto</h2>
        </div>
        <div className="member-list">
          {data.meta.members.map((member) => (
            <div key={member.code} className="member-row">
              <strong>{projectMemberName(member.name)}</strong>
              <code>{member.code}</code>
            </div>
          ))}
        </div>
      </div>
      <div className="panel requirements-panel">
        <div className="section-heading">
          <span className="eyebrow">Requisitos</span>
          <h2>Cobertura funcional</h2>
        </div>
        <div className="requirements-grid">
          {requirementGroups.map((group) => (
            <div key={group.title} className="requirement-group">
              <strong>{group.title}</strong>
              {group.items.map((item) => (
                <span key={item}>
                  <CheckCircle size={15} weight="fill" />
                  {item}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function EmptyState({ title }: { title: string }) {
  return (
    <div className="empty-state">
      <span />
      <p>{title}</p>
    </div>
  );
}

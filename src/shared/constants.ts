import type { Candidate, District, ProjectMeta, VotingPlace, VotingTable, Zone } from "./types";

export const CERTUS_COLORS = {
  primary: "#1D3096",
  secondary: "#5B6EA6"
} as const;

export const PROJECT_META: ProjectMeta = {
  university: "Universidad Peruana de Ciencias Aplicadas",
  course: "SI720 Diseno y Patrones de Software",
  document: "Documento de Especificaciones Funcionales (DEF)",
  systemName: "STELA / CERTUS",
  subtitle: "Sistema de conteo preliminar para procesos electorales",
  professor: "Jorge Luis Delgado Vite",
  members: [
    { name: "Llanos Alvarez, Guillermo Enrique", code: "U202422204" },
    { name: "Garcia Bernal, Daniela", code: "U202212994" },
    { name: "Condor Velasquez, Angela", code: "U202217165" },
    { name: "Chavez Valeriano, Milene", code: "U20241C489" },
    { name: "Ayvar Valdez, Piero", code: "U202312035" }
  ],
  colors: CERTUS_COLORS
};

export const SEED_CANDIDATES: Candidate[] = [
  {
    id: "cand-001",
    name: "Maria Torres Ibarra",
    party: "Alianza Ciudadana",
    color: "#1D3096"
  },
  {
    id: "cand-002",
    name: "Rafael Nunez Salcedo",
    party: "Renovacion Democratica",
    color: "#5B6EA6"
  },
  {
    id: "cand-003",
    name: "Juan Perez",
    party: "Partido Del Progreso",
    color: "#314BBD"
  },
  {
    id: "cand-004",
    name: "Valeria Cardenas Rojas",
    party: "Frente Regional",
    color: "#7483B7"
  }
];

export const SEED_DISTRICTS: District[] = [
  { id: "dist-lima-centro", name: "Lima Centro" },
  { id: "dist-lima-norte", name: "Lima Norte" }
];

export const SEED_ZONES: Zone[] = [
  { id: "zona-001", districtId: "dist-lima-centro", name: "Zona 01" },
  { id: "zona-002", districtId: "dist-lima-centro", name: "Zona 02" },
  { id: "zona-003", districtId: "dist-lima-norte", name: "Zona 03" }
];

export const SEED_PLACES: VotingPlace[] = [
  {
    id: "local-001",
    zoneId: "zona-001",
    name: "IE Republica del Peru",
    address: "Av. Central 481"
  },
  {
    id: "local-002",
    zoneId: "zona-002",
    name: "Colegio San Martin",
    address: "Jr. Los Proceres 204"
  },
  {
    id: "local-003",
    zoneId: "zona-003",
    name: "IE Jose Olaya",
    address: "Av. Las Palmeras 1102"
  }
];

export const SEED_TABLES: VotingTable[] = [
  { id: "mesa-014", placeId: "local-001", code: "M-014", electors: 370, status: "En progreso" },
  { id: "mesa-018", placeId: "local-001", code: "M-018", electors: 358, status: "En progreso" },
  { id: "mesa-021", placeId: "local-002", code: "M-021", electors: 392, status: "En progreso" },
  { id: "mesa-037", placeId: "local-003", code: "M-037", electors: 344, status: "En progreso" }
];

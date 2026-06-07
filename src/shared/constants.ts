import type { Candidate, District, ProjectMeta, VotingPlace, VotingTable, Zone } from "./types";

const onpeImageBaseUrl = "https://resultadoelectoral.onpe.gob.pe/assets/img-reales";

function onpePartyLogo(code: string): string {
  return `${onpeImageBaseUrl}/partidos/${code.padStart(8, "0")}.jpg`;
}

function onpeCandidatePhoto(dni: string): string {
  return `${onpeImageBaseUrl}/candidatos/${dni}.jpg`;
}

export const CERTUS_COLORS = {
  primary: "#1D3096",
  secondary: "#5B6EA6"
} as const;

export const PROJECT_META: ProjectMeta = {
  university: "Universidad Peruana de Ciencias Aplicadas",
  course: "SI720 Diseno y Patrones de Software",
  systemName: "STELA / CERTUS",
  subtitle: "Conteo preliminar con trazabilidad por mesa",
  members: [
    { name: "Llanos Alvarez, Guillermo", code: "U202422204" },
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
    name: "KEIKO SOFIA FUJIMORI HIGUCHI",
    party: "FUERZA POPULAR",
    color: "#f36c21",
    partyCode: "8",
    photoUrl: onpeCandidatePhoto("10001088"),
    logoUrl: onpePartyLogo("8"),
    officialVotes: 2877678,
    officialValidPercentage: 17.192,
    officialEmittedPercentage: 14.269
  },
  {
    id: "cand-002",
    name: "ROBERTO HELBERT SANCHEZ PALOMINO",
    party: "JUNTOS POR EL PERU",
    color: "#d72638",
    partyCode: "10",
    photoUrl: onpeCandidatePhoto("16002918"),
    logoUrl: onpePartyLogo("10"),
    officialVotes: 2015114,
    officialValidPercentage: 12.039,
    officialEmittedPercentage: 9.992
  },
  {
    id: "cand-003",
    name: "RAFAEL BERNARDO LOPEZ ALIAGA CAZORLA",
    party: "RENOVACION POPULAR",
    color: "#0b60a8",
    partyCode: "35",
    photoUrl: onpeCandidatePhoto("07845838"),
    logoUrl: onpePartyLogo("35"),
    officialVotes: 1993905,
    officialValidPercentage: 11.912,
    officialEmittedPercentage: 9.887
  },
  {
    id: "cand-004",
    name: "JORGE NIETO MONTESINOS",
    party: "PARTIDO DEL BUEN GOBIERNO",
    color: "#22a06b",
    partyCode: "16",
    photoUrl: onpeCandidatePhoto("06506278"),
    logoUrl: onpePartyLogo("16"),
    officialVotes: 1837517,
    officialValidPercentage: 10.978,
    officialEmittedPercentage: 9.111
  },
  {
    id: "cand-005",
    name: "RICARDO PABLO BELMONT CASSINELLI",
    party: "PARTIDO CIVICO OBRAS",
    color: "#6a1b9a",
    partyCode: "14",
    photoUrl: onpeCandidatePhoto("09177250"),
    logoUrl: onpePartyLogo("14"),
    officialVotes: 1698903,
    officialValidPercentage: 10.15,
    officialEmittedPercentage: 8.424
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

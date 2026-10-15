// Single display name for the provisional project name (see AGENTS.md).
export const APP_NAME = "Proyecto_C";

// Centralised UI copy in Spanish (es-ES). No i18n framework in v1.
export const COPY = {
  healthTitle: "Estado del servicio",
  healthSubtitle: "Comprobación de la API y la base de datos.",
  healthLoading: "Comprobando el estado del servicio…",
  healthOk: "Servicio disponible",
  healthDegraded: "Servicio degradado: la base de datos no responde.",
  healthError: "No se ha podido contactar con la API.",
  healthRetry: "Reintentar",
  apiLabel: "API",
  dbLabel: "Base de datos",
} as const;

export const PIPELINE_STAGES = [
  {
    slug: "new_lead",
    label: "Novo lead",
    order: 1,
  },
  {
    slug: "in_progress",
    label: "Em atendimento",
    order: 2,
  },
  {
    slug: "qualified",
    label: "Qualificado",
    order: 3,
  },
  {
    slug: "proposal_sent",
    label: "Proposta enviada",
    order: 4,
  },
  {
    slug: "won",
    label: "Venda realizada",
    order: 5,
  },
  {
    slug: "lost",
    label: "Perdido",
    order: 6,
  },
] as const;

export type PipelineStageSlug = (typeof PIPELINE_STAGES)[number]["slug"];

export function isPipelineStage(value: unknown): value is PipelineStageSlug {
  return (
    typeof value === "string" &&
    PIPELINE_STAGES.some((stage) => stage.slug === value)
  );
}

export function getPipelineStageLabel(slug: string | null): string {
  return (
    PIPELINE_STAGES.find((stage) => stage.slug === slug)?.label || "Novo lead"
  );
}

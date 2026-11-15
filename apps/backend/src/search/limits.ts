// Limites de taxa por usuário (FR-034). Objeto mutável só para os testes poderem baixá-los ou subi-los.
export const searchLimits = {
  /** buscas por minuto */
  search: 60,
  /** perguntas ao chat por minuto */
  chat: 12,
  /** pedidos de reindexação por hora */
  reindex: 6,
};

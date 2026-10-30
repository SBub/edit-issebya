// The facts the terms and privacy pages need about the provider, defined once.
// A value still in [[DOUBLE_BRACKETS]] is a placeholder the owner has to fill
// in; while any is left, both pages show "Draft: placeholders pending".

export const PLACEHOLDER_PATTERN = /\[\[[A-Z_]+\]\]/;

export const LEGAL = {
  tradingName: "edit issebya",
  ownerName: "Sviatlana Buben",
  nif: "330791745",
  address: "Lagarto 5, 2705-044 Almoçageme, Portugal",
  email: "edit@issebya.com",
  lastUpdated: "2026-10-19",
  complaintsBook: "https://www.livroreclamacoes.pt",
  consumerPortal: "https://www.consumidor.gov.pt",
  dataProtectionAuthority: { name: "CNPD", url: "https://www.cnpd.pt" },
  // The alternative dispute resolution entity named to consumers: CNIACC,
  // chosen by the owner.
  adrEntity: {
    name: "CNIACC, Centro Nacional de Informação e Arbitragem de Conflitos de Consumo",
    url: "https://www.cniacc.pt",
  },
} as const;

// True while any provider fact is still a placeholder: both legal pages then
// say "Draft: placeholders pending" at the top.
export function legalPlaceholdersPending(): boolean {
  const values = [LEGAL.ownerName, LEGAL.nif, LEGAL.address, LEGAL.adrEntity.name];
  return values.some((value) => PLACEHOLDER_PATTERN.test(value));
}

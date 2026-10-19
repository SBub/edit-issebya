// The facts the terms and privacy pages need about the provider, defined once.
// A value still in [[DOUBLE_BRACKETS]] is a placeholder the owner has to fill
// in; while any is left, both pages show "Draft: placeholders pending".

export const PLACEHOLDER_PATTERN = /\[\[[A-Z_]+\]\]/;

// Marks a default rule the owner still has to confirm. Set
// OWNER_REVIEW_PENDING to false once every [[CONFIRM]] rule is confirmed or
// rewritten: the markers then disappear.
export const CONFIRM = "[[CONFIRM]]";
export const OWNER_REVIEW_PENDING = true;

export const LEGAL = {
  tradingName: "edit issebya",
  ownerName: "[[OWNER_NAME]]",
  nif: "[[NIF]]",
  address: "[[ADDRESS]]",
  email: "edit@issebya.com",
  lastUpdated: "2026-10-19",
  complaintsBook: "https://www.livroreclamacoes.pt",
  consumerPortal: "https://www.consumidor.gov.pt",
  dataProtectionAuthority: { name: "CNPD", url: "https://www.cnpd.pt" },
  // The alternative dispute resolution entity named to consumers. CNIACC is
  // the default; the owner may pick the regional centre for her address.
  adrEntity: {
    placeholder: "[[ADR_ENTITY]]",
    name: "CNIACC, Centro Nacional de Informação e Arbitragem de Conflitos de Consumo",
    url: "https://www.cniacc.pt",
  },
} as const;

// True while any provider fact or a [[CONFIRM]] rule
// is still a placeholder: both legal pages then say so at the top.
export function legalPlaceholdersPending(): boolean {
  const values = [LEGAL.ownerName, LEGAL.nif, LEGAL.address, LEGAL.adrEntity.placeholder];
  return OWNER_REVIEW_PENDING || values.some((value) => PLACEHOLDER_PATTERN.test(value));
}

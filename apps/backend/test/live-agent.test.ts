import { describe, expect, it } from "vitest";
import { shouldConsolidate, shouldExtract } from "../src/agent/triggers";

const opts = { minSpeechSeconds: 90, maxIntervalSeconds: 180 };

describe("shouldExtract", () => {
  it("dispara com 90 s de fala nova", () => {
    expect(shouldExtract({ newSegments: 8, newSpeechSeconds: 90, secondsSinceLastExtract: 20 }, opts)).toBe(true);
    expect(shouldExtract({ newSegments: 8, newSpeechSeconds: 89, secondsSinceLastExtract: 20 }, opts)).toBe(false);
  });

  it("dispara aos 180 s com pelo menos 1 segmento novo", () => {
    expect(shouldExtract({ newSegments: 1, newSpeechSeconds: 4, secondsSinceLastExtract: 180 }, opts)).toBe(true);
    expect(shouldExtract({ newSegments: 1, newSpeechSeconds: 4, secondsSinceLastExtract: 179 }, opts)).toBe(false);
  });

  it("sem segmento novo nunca dispara", () => {
    expect(shouldExtract({ newSegments: 0, newSpeechSeconds: 0, secondsSinceLastExtract: 3600 }, opts)).toBe(false);
  });
});

describe("shouldConsolidate", () => {
  it("consolida a cada 900 s se houve extração", () => {
    expect(shouldConsolidate({ secondsSinceLastConsolidate: 900, extractionsSince: 2 }, { intervalSeconds: 900 })).toBe(true);
    expect(shouldConsolidate({ secondsSinceLastConsolidate: 899, extractionsSince: 2 }, { intervalSeconds: 900 })).toBe(false);
    expect(shouldConsolidate({ secondsSinceLastConsolidate: 5000, extractionsSince: 0 }, { intervalSeconds: 900 })).toBe(false);
  });
});

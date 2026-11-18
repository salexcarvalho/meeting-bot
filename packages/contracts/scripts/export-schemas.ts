// Gera packages/contracts/schemas/*.json a partir dos schemas zod,
// para documentação e para validar os contratos fora do TypeScript.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AdrPatch, AgentCalendarImportInput, AgentMeetingsQuery, ChatLlmOutput, HeartbeatInput, ItemPatch, LLM_SCHEMAS, NewItemInput, ProjectInput, ScheduledMeetingInput } from "../src";

const outDir = path.join(__dirname, "..", "schemas");
mkdirSync(outDir, { recursive: true });

const all: Record<string, z.ZodType> = {
  ...LLM_SCHEMAS,
  ChatLlmOutput,
  ScheduledMeetingInput,
  ItemPatch,
  NewItemInput,
  AdrPatch,
  ProjectInput,
  HeartbeatInput,
  AgentCalendarImportInput,
  AgentMeetingsQuery,
};

for (const [name, schema] of Object.entries(all)) {
  const file = path.join(outDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(z.toJSONSchema(schema, { target: "draft-07" }), null, 2) + "\n");
  console.log(`gerado ${path.relative(process.cwd(), file)}`);
}

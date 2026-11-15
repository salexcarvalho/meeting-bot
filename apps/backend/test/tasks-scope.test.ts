import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Guarda contra regressão de vazamento (specs/002 T045): TODA consulta SQL sobre `tasks` ou `task_history`
// em src/tasks precisa do escopo por dono (`owner_id`). A tarefa é pessoal; nem admin lê tarefa alheia.
//
// Mutação que valida este teste: tirar `t.owner_id = $1 AND` de `loadRows` (service.ts) ou o `owner_id` de
// `taskParamGuard` (routes.ts) faz este teste falhar (e `db/tarefas-acesso.test.ts` também).

const DIR = path.resolve(__dirname, "../src/tasks");
const TOUCHES_TASKS = /\b(?:FROM|UPDATE|JOIN|INTO)\s+(?:tasks|task_history)\b/i;
// Fragmento de SELECT sem WHERE: só é usado depois de `WHERE t.owner_id = $1` (ver loadRows e buildTaskQuery).
const BASE_SELECT = /^\s*SELECT t\.id, t\.title[\s\S]*FROM tasks t LEFT JOIN projects p ON p\.id = t\.project_id\s*$/;
// Escrita do histórico: sempre depois de `lockOwned`/inserção da própria tarefa, na mesma transação.
const HISTORY_INSERT = /^\s*INSERT INTO task_history \(task_id, action, before, after, actor_id\) VALUES/;

function sqlLiterals(source: string): string[] {
  return [...source.matchAll(/`([^`]*)`/g)].map((m) => m[1]).filter((text) => TOUCHES_TASKS.test(text));
}

describe("escopo por dono nas consultas de tarefas", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));

  it("encontra os módulos do diretório", () => {
    expect(files).toEqual(expect.arrayContaining(["service.ts", "routes.ts", "query.ts", "fromItem.ts"]));
  });

  for (const file of files) {
    it(`${file}: toda consulta sobre tasks/task_history tem owner_id`, () => {
      const source = readFileSync(path.join(DIR, file), "utf8");
      const bad = sqlLiterals(source).filter(
        (text) => !text.includes("owner_id") && !BASE_SELECT.test(text) && !HISTORY_INSERT.test(text),
      );
      expect(bad).toEqual([]);
    });
  }

  it("não existe rota que lista tarefas de outro usuário", () => {
    const routes = readFileSync(path.join(DIR, "routes.ts"), "utf8");
    expect(routes).not.toMatch(/\/admin\/tasks|\/users\/:\w+\/tasks/);
  });

  it("o guarda de :taskId confere o dono antes do handler", () => {
    const routes = readFileSync(path.join(DIR, "routes.ts"), "utf8");
    expect(routes).toMatch(/router\.param\("taskId", taskParamGuard\(\)\)/);
    expect(routes).toMatch(/t\.owner_id = \$1 AND t\.id = \$2/);
  });
});

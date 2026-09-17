import { ROLE_KEYS, type RoleKey } from "@meeting-bot/contracts";
import { hashPassword, validatePasswordStrength } from "../auth";
import { createUser, deleteUser, deleteUserSessions, findUserByUsername, listUsers, pool, updatePassword } from "../db";
import { migrate } from "../schema";

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("Sem terminal interativo: rode com `docker compose exec` (com TTY) ou defina PASSWORD."));
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (char: string) => {
      if (char === "\r" || char === "\n" || char === "") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(value);
      } else if (char === "") {
        process.stdout.write("\n");
        process.exit(130);
      } else if (char === "" || char === "\b") {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.PASSWORD;
  const password = fromEnv ?? (await askHidden("Senha: "));
  const problem = validatePasswordStrength(password);
  if (problem) throw new Error(problem);
  if (!fromEnv && (await askHidden("Confirme a senha: ")) !== password) {
    throw new Error("As senhas não conferem.");
  }
  return password;
}

async function main() {
  const args = process.argv.slice(2);
  const roleArg = args.find((a) => a.startsWith("--role="));
  const [command, rawUsername] = args.filter((a) => !a.startsWith("--"));
  const role = roleArg ? (roleArg.slice("--role=".length).toUpperCase() as RoleKey) : undefined;
  if (role && !ROLE_KEYS.includes(role)) throw new Error(`Papel inválido. Use: ${ROLE_KEYS.join(", ")}.`);
  await migrate(pool);

  if (command === "list") {
    for (const u of await listUsers()) {
      const state = u.active ? "" : " [inativo]";
      console.log(`${u.username}\t${u.roles.join(",") || "-"}${state}\t(criado em ${u.created_at.toISOString().slice(0, 10)})`);
    }
    return;
  }

  const username = (rawUsername ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new Error("Informe um usuário com 3-32 caracteres (letras minúsculas, números, . _ -).");
  }

  if (command === "create") {
    if (await findUserByUsername(username)) throw new Error(`Usuário "${username}" já existe.`);
    const user = await createUser(username, await hashPassword(await readPassword()), { role });
    console.log(`Usuário "${username}" criado (${user.roles.join(", ")}).`);
  } else if (command === "passwd") {
    const user = await findUserByUsername(username);
    if (!user) throw new Error(`Usuário "${username}" não existe.`);
    await updatePassword(user.id, await hashPassword(await readPassword()));
    await deleteUserSessions(user.id);
    console.log(`Senha de "${username}" alterada; sessões abertas foram encerradas.`);
  } else if (command === "delete") {
    const user = await findUserByUsername(username);
    if (!user) throw new Error(`Usuário "${username}" não existe.`);
    await deleteUser(user.id);
    console.log(`Usuário "${username}" removido (reuniões dele continuam no sistema).`);
  } else {
    throw new Error("Uso: user.js create <usuario> [--role=SUPER_ADMIN|ADMIN|USER|VIEWER] | passwd <usuario> | delete <usuario> | list");
  }
}

main()
  .catch((err) => {
    console.error(`Erro: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

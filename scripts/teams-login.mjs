// Abre o Teams num navegador seu, deixa você entrar na conta do AGENTE e salva a sessão num arquivo.
// O arquivo é enviado em Configurações → Meu agente → Conta do agente no Teams. A senha nunca passa
// pelo sistema: só cookies e localStorage da sessão.
//
// Uso: npm run teams:login [-- saida.json]     (precisa de um Chromium do Playwright: npx playwright install chromium)
import { chmod } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";

const out = process.argv[2] || "teams-session.json";

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.goto("https://teams.microsoft.com/v2/");

console.log(`
Conta do AGENTE no Teams

1. No navegador que abriu, entre com a conta do AGENTE (nunca a sua) e, se perguntar "Manter conectado?", escolha Sim.
2. Espere o Teams carregar por inteiro.
3. Volte aqui e aperte Enter.
`);

let closed = false;
browser.on("disconnected", () => {
  closed = true;
});
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("Enter quando o Teams estiver aberto e logado... ");
rl.close();

if (closed) {
  console.error("O navegador foi fechado antes de salvar. Rode de novo.");
  process.exit(1);
}

await context.storageState({ path: out });
await chmod(out, 0o600);
await browser.close();

console.log(`
Sessão salva em ${out}.
Agora: Configurações → Meu agente → Conta do agente no Teams → informe o nome da conta e envie este arquivo.
Depois de enviar, apague o arquivo: ele vale como uma senha.`);

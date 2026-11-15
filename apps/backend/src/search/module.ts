import { config } from "../config";
import { features } from "../features";
import { registerChatRoutes } from "./chat/routes";
import { registerSearchRoutes } from "./routes";
import { startSearchWorker, stopSearchWorker } from "./worker";

// Registro da busca e do chat (specs/003-busca-chat). Com SEARCH_ENABLED=false nada é registrado:
// as rotas respondem 404, não há worker nem gatilhos, e o resto da aplicação não muda.

if (config.search.enabled) {
  features.authedRouters.push(registerSearchRoutes, registerChatRoutes);
  features.starters.push(() => startSearchWorker());
  features.stoppers.push(() => stopSearchWorker());
}

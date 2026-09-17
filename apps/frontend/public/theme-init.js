// Aplica o tema escolhido antes da primeira pintura (evita piscar).
// Arquivo externo porque a CSP do backend não permite script inline.
try {
  var t = localStorage.getItem("agente-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}

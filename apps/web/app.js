const API_BASE =
  window.PANORAM_API_BASE ||
  (window.location.protocol === "file:"
    ? "http://127.0.0.1:3001"
    : `${window.location.protocol}//${window.location.hostname}:3001`);

const state = {
  stages: [],
  leads: [],
  selectedLead: null,
  search: "",
  loading: false,
};

const board = document.querySelector("#board");
const metrics = document.querySelector("#metrics");
const statusBanner = document.querySelector("#statusBanner");
const searchInput = document.querySelector("#searchInput");
const refreshButton = document.querySelector("#refreshButton");
const leadPanel = document.querySelector("#leadPanel");
const panelTitle = document.querySelector("#panelTitle");
const panelBody = document.querySelector("#panelBody");
const closePanelButton = document.querySelector("#closePanelButton");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "-";

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function setStatus(message, tone = "info") {
  if (!message) {
    statusBanner.hidden = true;
    statusBanner.textContent = "";
    return;
  }

  statusBanner.hidden = false;
  statusBanner.textContent = message;
  statusBanner.style.borderLeftColor =
    tone === "error" ? "var(--danger)" : "var(--warning)";
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `HTTP ${response.status}`);
  }

  return response.json();
}

async function loadLeads() {
  state.loading = true;
  renderBoard();
  setStatus("");

  try {
    const params = new URLSearchParams({
      take: "100",
    });

    if (state.search) {
      params.set("search", state.search);
    }

    const data = await apiFetch(`/leads?${params.toString()}`);
    state.stages = data.stages || [];
    state.leads = data.leads || [];
  } catch (error) {
    console.error(error);
    setStatus("Nao foi possivel carregar os leads. Verifique se a API esta online.", "error");
  } finally {
    state.loading = false;
    renderMetrics();
    renderBoard();
  }
}

function getLeadsByStage(stageSlug) {
  return state.leads.filter((lead) => (lead.currentStage || "new_lead") === stageSlug);
}

function renderMetrics() {
  const total = state.leads.length;
  const won = getLeadsByStage("won").length;
  const qualified = getLeadsByStage("qualified").length;

  const metricItems = [
    ["Total", total],
    ["Qualificados", qualified],
    ["Vendas", won],
    ["Novos", getLeadsByStage("new_lead").length],
    ["Em atendimento", getLeadsByStage("in_progress").length],
    ["Perdidos", getLeadsByStage("lost").length],
  ];

  metrics.innerHTML = metricItems
    .map(
      ([label, value]) => `
        <article class="metric">
          <strong>${value}</strong>
          <span>${escapeHtml(label)}</span>
        </article>
      `,
    )
    .join("");
}

function renderBoard() {
  if (state.loading && state.stages.length === 0) {
    board.innerHTML = `<section class="column"><p class="empty-state">Carregando leads...</p></section>`;
    return;
  }

  const stages = state.stages.length
    ? state.stages
    : [
        { slug: "new_lead", label: "Novo lead", order: 1 },
        { slug: "in_progress", label: "Em atendimento", order: 2 },
        { slug: "qualified", label: "Qualificado", order: 3 },
        { slug: "proposal_sent", label: "Proposta enviada", order: 4 },
        { slug: "won", label: "Venda realizada", order: 5 },
        { slug: "lost", label: "Perdido", order: 6 },
      ];

  board.innerHTML = stages
    .map((stage) => {
      const leads = getLeadsByStage(stage.slug);
      const cards = leads.length
        ? leads.map(renderLeadCard).join("")
        : `<p class="empty-state">Sem leads neste estágio</p>`;

      return `
        <section class="column" data-stage="${escapeHtml(stage.slug)}">
          <header class="column-header">
            <h2 class="column-title">${escapeHtml(stage.label)}</h2>
            <span class="count-pill">${leads.length}</span>
          </header>
          <div class="lead-list">${cards}</div>
        </section>
      `;
    })
    .join("");

  board.querySelectorAll(".lead-card").forEach((button) => {
    button.addEventListener("click", () => openLead(button.dataset.leadId));
  });
}

function renderLeadCard(lead) {
  const attribution = lead.latestAttribution;
  const campaign = attribution?.utmCampaign || attribution?.campaignName || "Sem campanha";
  const message = lead.latestMessage?.body || lead.firstMessage || "Sem mensagem";

  return `
    <button class="lead-card" type="button" data-lead-id="${escapeHtml(lead.id)}">
      <span class="lead-name">${escapeHtml(lead.name || lead.phone || "Lead sem nome")}</span>
      <span class="lead-meta">
        <span>${escapeHtml(lead.phone || "-")}</span>
        <span>${formatDate(lead.updatedAt)}</span>
      </span>
      <span class="lead-source">
        <span>${escapeHtml(campaign)}</span>
        <span>${escapeHtml(attribution?.matchMethod || "sem atribuicao")}</span>
      </span>
      <span class="message-preview">${escapeHtml(message)}</span>
    </button>
  `;
}

async function openLead(leadId) {
  leadPanel.classList.add("open");
  leadPanel.setAttribute("aria-hidden", "false");
  panelTitle.textContent = "Carregando...";
  panelBody.innerHTML = "";

  try {
    const lead = await apiFetch(`/leads/${encodeURIComponent(leadId)}`);
    state.selectedLead = lead;
    renderLeadPanel(lead);
  } catch (error) {
    console.error(error);
    panelTitle.textContent = "Erro ao abrir lead";
    panelBody.innerHTML = `<p class="status-banner">Nao foi possivel carregar o detalhe.</p>`;
  }
}

function renderLeadPanel(lead) {
  panelTitle.textContent = lead.name || lead.phone || "Lead sem nome";

  const latestAttribution = lead.attributions?.[0];
  const stageButtons = lead.stages
    .map(
      (stage) => `
        <button
          class="stage-button ${stage.slug === (lead.currentStage || "new_lead") ? "active" : ""}"
          type="button"
          data-stage="${escapeHtml(stage.slug)}"
        >
          ${escapeHtml(stage.label)}
        </button>
      `,
    )
    .join("");

  const history = lead.stageHistory?.length
    ? lead.stageHistory
        .map(
          (item) => `
            <article class="timeline-item">
              <p>${escapeHtml(item.fromStage || "new_lead")} -> ${escapeHtml(item.toStage)}</p>
              <small>${formatDate(item.changedAt)}${item.note ? ` - ${escapeHtml(item.note)}` : ""}</small>
            </article>
          `,
        )
        .join("")
    : `<p class="empty-state">Sem movimentacoes registradas</p>`;

  const messages = lead.messages?.slice(-5).reverse().length
    ? lead.messages
        .slice(-5)
        .reverse()
        .map(
          (message) => `
            <article class="timeline-item">
              <p>${escapeHtml(message.body || "(mensagem sem texto)")}</p>
              <small>${escapeHtml(message.direction)} - ${formatDate(message.sentAt)}</small>
            </article>
          `,
        )
        .join("")
    : `<p class="empty-state">Sem mensagens</p>`;

  panelBody.innerHTML = `
    <section class="detail-section">
      <h3>Dados</h3>
      <dl class="detail-grid">
        <dt>Telefone</dt>
        <dd>${escapeHtml(lead.phone || "-")}</dd>
        <dt>Estagio</dt>
        <dd>${escapeHtml(lead.currentStageLabel || "-")}</dd>
        <dt>Origem</dt>
        <dd>${escapeHtml(lead.source || "-")}</dd>
        <dt>Criado</dt>
        <dd>${formatDate(lead.createdAt)}</dd>
      </dl>
    </section>

    <section class="detail-section">
      <h3>Pipeline</h3>
      <div class="stage-actions">${stageButtons}</div>
    </section>

    <section class="detail-section">
      <h3>Atribuicao</h3>
      <dl class="detail-grid">
        <dt>Campanha</dt>
        <dd>${escapeHtml(latestAttribution?.utmCampaign || latestAttribution?.campaignName || "-")}</dd>
        <dt>Metodo</dt>
        <dd>${escapeHtml(latestAttribution?.matchMethod || "-")}</dd>
        <dt>Confianca</dt>
        <dd>${escapeHtml(latestAttribution?.matchConfidence || "-")}</dd>
        <dt>fbclid</dt>
        <dd>${escapeHtml(latestAttribution?.fbclid || "-")}</dd>
      </dl>
    </section>

    <section class="detail-section">
      <h3>Historico de estagio</h3>
      <div class="timeline">${history}</div>
    </section>

    <section class="detail-section">
      <h3>Mensagens recentes</h3>
      <div class="timeline">${messages}</div>
    </section>
  `;

  panelBody.querySelectorAll(".stage-button").forEach((button) => {
    button.addEventListener("click", () => updateStage(lead.id, button.dataset.stage));
  });
}

async function updateStage(leadId, stage) {
  try {
    const updated = await apiFetch(`/leads/${encodeURIComponent(leadId)}/stage`, {
      method: "PATCH",
      body: JSON.stringify({
        stage,
        changedBy: "web",
      }),
    });

    await loadLeads();
    await openLead(updated.lead.id);
  } catch (error) {
    console.error(error);
    setStatus("Nao foi possivel mover o lead.", "error");
  }
}

function closePanel() {
  leadPanel.classList.remove("open");
  leadPanel.setAttribute("aria-hidden", "true");
  state.selectedLead = null;
}

let searchTimer = null;
searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.search = searchInput.value.trim();
    loadLeads();
  }, 250);
});

refreshButton.addEventListener("click", loadLeads);
closePanelButton.addEventListener("click", closePanel);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closePanel();
  }
});

loadLeads();

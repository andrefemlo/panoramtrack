const API_BASE =
  window.PANORAM_API_BASE ||
  (window.location.protocol === "file:"
    ? "http://127.0.0.1:3001"
    : `${window.location.protocol}//${window.location.hostname}:3001`);

// const API_BASE_URL = "http://2.24.95.64:3001";

// const state = {
//   leads: [],
//   stages: [],
//   selectedLeadId: null,
//   selectedLead: null,
//   search: "",
//   loading: false,
// };

const boardEl = document.getElementById("board");
const leadPanelEl = document.getElementById("lead-panel");
const refreshButtonEl = document.getElementById("refresh-button");
const searchInputEl = document.getElementById("search-input");
const apiStatusEl = document.getElementById("api-status");
const modalRootEl = document.getElementById("modal-root");

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(text || `Erro HTTP ${response.status}`);
  }

  return text ? JSON.parse(text) : null;
}

async function checkHealth() {
  try {
    await request("/health");
    apiStatusEl.textContent = "API online";
  } catch (error) {
    apiStatusEl.textContent = "API offline";
  }
}

async function listLeads() {
  const params = new URLSearchParams();

  if (state.search) {
    params.set("search", state.search);
  }

  const query = params.toString();
  return request(`/leads${query ? `?${query}` : ""}`);
}

async function getLead(id) {
  return request(`/leads/${id}`);
}

async function updateLeadStage(id, stage) {
  return request(`/leads/${id}/stage`, {
    method: "PATCH",
    body: JSON.stringify({
      stage,
      changedBy: "crm-ui",
    }),
  });
}

async function listAttributionCandidates(leadId, search = "") {
  const params = new URLSearchParams();

  params.set("sinceHours", "72");

  if (search) {
    params.set("search", search);
  }

  return request(`/leads/${leadId}/attribution-candidates?${params.toString()}`);
}

async function createManualAttribution(leadId, body) {
  return request(`/leads/${leadId}/attributions/manual`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function refreshLeads() {
  state.loading = true;
  renderBoard();

  try {
    const data = await listLeads();
    state.leads = data.leads || [];
    state.stages = data.stages || [];

    if (state.selectedLeadId) {
      await openLead(state.selectedLeadId, false);
    }
  } catch (error) {
    boardEl.innerHTML = `<div class="error">Erro ao carregar leads: ${escapeHtml(
      error.message,
    )}</div>`;
  } finally {
    state.loading = false;
    renderBoard();
  }
}

async function openLead(leadId, shouldRenderBoard = true) {
  state.selectedLeadId = leadId;

  if (shouldRenderBoard) {
    renderBoard();
  }

  leadPanelEl.classList.remove("hidden");
  leadPanelEl.innerHTML = `<div class="empty-panel">Carregando lead...</div>`;

  try {
    state.selectedLead = await getLead(leadId);
    renderLeadPanel();
  } catch (error) {
    leadPanelEl.innerHTML = `<div class="empty-panel error">Erro ao carregar lead: ${escapeHtml(
      error.message,
    )}</div>`;
  }
}

async function moveLead(leadId, stage) {
  try {
    await updateLeadStage(leadId, stage);
    await refreshLeads();
    await openLead(leadId, false);
  } catch (error) {
    alert(`Erro ao mover lead: ${error.message}`);
  }
}

function closeLeadPanel() {
  state.selectedLeadId = null;
  state.selectedLead = null;
  leadPanelEl.classList.add("hidden");
  leadPanelEl.innerHTML = `<div class="empty-panel">Selecione um lead para ver detalhes.</div>`;
  renderBoard();
}

function renderBoard() {
  if (state.loading) {
    boardEl.innerHTML = `<div class="loading">Carregando leads...</div>`;
    return;
  }

  if (!state.stages.length) {
    boardEl.innerHTML = `<div class="empty-state">Nenhuma etapa de pipeline encontrada.</div>`;
    return;
  }

  const columns = state.stages
    .map((stage) => {
      const leads = state.leads.filter((lead) => lead.currentStage === stage.slug);

      return `
        <article class="pipeline-column">
          <header class="column-header">
            <div class="column-title">
              <strong>${escapeHtml(stage.label)}</strong>
              <span>${leads.length} lead${leads.length === 1 ? "" : "s"}</span>
            </div>
            <span class="column-count">${leads.length}</span>
          </header>

          <div class="column-body">
            ${leads.length
          ? leads.map(renderLeadCard).join("")
          : `<div class="empty-state">Sem leads nesta etapa.</div>`
        }
          </div>
        </article>
      `;
    })
    .join("");

  boardEl.innerHTML = columns;

  document.querySelectorAll("[data-open-lead]").forEach((button) => {
    button.addEventListener("click", () => {
      openLead(button.dataset.openLead);
    });
  });
}

function renderLeadCard(lead) {
  const isActive = lead.id === state.selectedLeadId;
  const attribution = lead.latestAttribution;
  const campaign =
    attribution?.utmCampaign ||
    attribution?.campaignName ||
    attribution?.utmSource ||
    null;

  return `
    <button
      class="lead-card ${isActive ? "active" : ""}"
      type="button"
      data-open-lead="${escapeAttribute(lead.id)}"
    >
      <div class="lead-card-top">
        <div class="lead-card-title">
          <strong>${escapeHtml(lead.name || lead.phone || "Lead sem nome")}</strong>
          <span>${escapeHtml(lead.phone || "Sem telefone")}</span>
        </div>

        <span class="badge badge-neutral">${escapeHtml(lead.source || "lead")}</span>
      </div>

      <div class="latest-message">
        ${escapeHtml(lead.latestMessage?.body || "Sem mensagem registrada.")}
      </div>

      <div class="badge-row">
        ${attribution
      ? `
              <span class="badge badge-green">${escapeHtml(
        attribution.matchMethod || "atribuído",
      )}</span>
              <span class="badge badge-blue">${escapeHtml(campaign || "campanha")}</span>
            `
      : `<span class="badge badge-amber">sem atribuição</span>`
    }
      </div>
    </button>
  `;
}

function renderLeadPanel() {
  const lead = state.selectedLead;

  if (!lead) {
    return;
  }

  const currentStage = lead.currentStage || "new_lead";
  const stagesOptions = state.stages
    .map(
      (stage) => `
        <option value="${escapeAttribute(stage.slug)}" ${stage.slug === currentStage ? "selected" : ""
        }>
          ${escapeHtml(stage.label)}
        </option>
      `,
    )
    .join("");

  leadPanelEl.innerHTML = `
    <div class="panel-header">
      <div class="panel-header-top">
        <div class="truncate">
          <h2>${escapeHtml(lead.name || lead.phone || "Lead sem nome")}</h2>
          <p>${escapeHtml(lead.phone || "Sem telefone")}</p>
        </div>

        <button id="close-panel-button" class="secondary-button" type="button">
          Fechar
        </button>
      </div>

      <div class="field">
        <label>Etapa do pipeline</label>
        <select id="stage-select">
          ${stagesOptions}
        </select>
      </div>
    </div>

    <div class="panel-body">
      <section class="panel-section">
        <div class="panel-header-top">
          <h3>Atribuição</h3>
          <button id="manual-attribution-button" class="primary-button" type="button">
            Atribuir
          </button>
        </div>

        ${renderAttributions(lead.attributions || [])}
      </section>

      <section class="panel-section">
        <h3>Conversas</h3>
        ${renderConversations(lead.conversations || [])}
      </section>

      <section class="panel-section">
        <h3>Mensagens</h3>
        ${renderMessages(lead.messages || [])}
      </section>

      <section class="panel-section">
        <h3>Histórico</h3>
        ${renderStageHistory(lead.stageHistory || [])}
      </section>
    </div>
  `;

  document.getElementById("close-panel-button").addEventListener("click", closeLeadPanel);

  document.getElementById("stage-select").addEventListener("change", (event) => {
    moveLead(lead.id, event.target.value);
  });

  document
    .getElementById("manual-attribution-button")
    .addEventListener("click", () => {
      openManualAttributionModal(lead);
    });
}

function renderAttributions(attributions) {
  if (!attributions.length) {
    return `<div class="empty-state">Nenhuma atribuição encontrada.</div>`;
  }

  return attributions
    .map((attr) => {
      const campaign =
        attr.utmCampaign || attr.campaignName || attr.utmSource || "Sem campanha";

      return `
        <div class="attribution-card">
          <div class="badge-row">
            <span class="badge badge-green">${escapeHtml(attr.matchMethod || "unknown")}</span>
            <span class="badge badge-blue">${escapeHtml(
        attr.matchConfidence || "unknown",
      )}</span>
          </div>

          <p class="truncate"><strong>${escapeHtml(campaign)}</strong></p>
          <p class="truncate">Origem: ${escapeHtml(
        attr.sourcePlatform || attr.utmSource || "não informada",
      )}</p>
          ${attr.fbclid
          ? `<p class="truncate">fbclid: ${escapeHtml(attr.fbclid)}</p>`
          : ""
        }
          ${attr.gclid
          ? `<p class="truncate">gclid: ${escapeHtml(attr.gclid)}</p>`
          : ""
        }
        </div>
      `;
    })
    .join("");
}

function renderConversations(conversations) {
  if (!conversations.length) {
    return `<div class="empty-state">Nenhuma conversa encontrada.</div>`;
  }

  return conversations
    .map(
      (conversation) => `
        <div class="history-card">
          <strong>${escapeHtml(conversation.channel || "whatsapp")}</strong>
          <p class="truncate">Chat: ${escapeHtml(conversation.externalChatId || "-")}</p>
          <p>Status: ${escapeHtml(conversation.status || "-")}</p>
          <p>Última mensagem: ${formatDate(conversation.lastMessageAt)}</p>
        </div>
      `,
    )
    .join("");
}

function renderMessages(messages) {
  if (!messages.length) {
    return `<div class="empty-state">Nenhuma mensagem encontrada.</div>`;
  }

  return `
    <div class="chat">
      ${messages
      .map(
        (message) => `
            <div class="message ${message.direction === "outbound" ? "outbound" : "inbound"}">
              <div>${escapeHtml(message.body || "Mensagem sem texto")}</div>
              <div class="message-time">${formatDate(message.sentAt)}</div>
            </div>
          `,
      )
      .join("")}
    </div>
  `;
}

function renderStageHistory(history) {
  if (!history.length) {
    return `<div class="empty-state">Nenhuma mudança de etapa registrada.</div>`;
  }

  return history
    .map(
      (item) => `
        <div class="history-card">
          <strong>${escapeHtml(item.fromStage || "início")} → ${escapeHtml(
        item.toStage,
      )}</strong>
          <p>${formatDate(item.changedAt)}</p>
          ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}
        </div>
      `,
    )
    .join("");
}

async function openManualAttributionModal(lead) {
  modalRootEl.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <header class="modal-header">
          <div>
            <h3>Atribuição manual</h3>
            <p>${escapeHtml(lead.name || lead.phone || "Lead")}</p>
          </div>

          <button id="close-modal-button" class="secondary-button" type="button">
            Fechar
          </button>
        </header>

        <div class="modal-body">
          <section>
            <h3>Cliques candidatos</h3>

            <div class="field">
              <label>Buscar por campanha, clickCode, fbclid ou gclid</label>
              <input id="candidate-search-input" placeholder="Ex: campanha, 64990DE8, fbclid..." />
            </div>

            <button id="candidate-search-button" class="primary-button" type="button">
              Buscar cliques
            </button>

            <div id="candidate-list" class="candidate-list">
              <div class="loading">Carregando candidatos...</div>
            </div>
          </section>

          <section>
            <h3>Atribuição sem clique</h3>

            <div class="form-grid">
              <div class="field">
                <label>Origem/plataforma</label>
                <input id="manual-source-input" value="manual" placeholder="meta, google, direct..." />
              </div>

              <div class="field">
                <label>Campanha</label>
                <input id="manual-campaign-input" placeholder="Nome da campanha" />
              </div>

              <div class="field">
                <label>UTM source</label>
                <input id="manual-utm-source-input" placeholder="meta, google..." />
              </div>

              <div class="field">
                <label>UTM campaign</label>
                <input id="manual-utm-campaign-input" placeholder="campanha_x" />
              </div>

              <button id="save-manual-only-button" class="primary-button" type="button">
                Salvar atribuição manual
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  `;

  const closeModalButton = document.getElementById("close-modal-button");
  const searchButton = document.getElementById("candidate-search-button");
  const saveManualOnlyButton = document.getElementById("save-manual-only-button");

  closeModalButton.addEventListener("click", closeModal);
  searchButton.addEventListener("click", () => loadCandidates(lead.id));
  saveManualOnlyButton.addEventListener("click", () => saveManualOnly(lead.id));

  await loadCandidates(lead.id);
}

function closeModal() {
  modalRootEl.innerHTML = "";
}

async function loadCandidates(leadId) {
  const listEl = document.getElementById("candidate-list");
  const searchEl = document.getElementById("candidate-search-input");
  const search = searchEl ? searchEl.value.trim() : "";

  listEl.innerHTML = `<div class="loading">Carregando candidatos...</div>`;

  try {
    const data = await listAttributionCandidates(leadId, search);
    const candidates = data.candidates || [];

    if (!candidates.length) {
      listEl.innerHTML = `<div class="empty-state">Nenhum clique candidato encontrado.</div>`;
      return;
    }

    listEl.innerHTML = candidates.map(renderCandidateCard).join("");

    document.querySelectorAll("[data-select-candidate]").forEach((button) => {
      button.addEventListener("click", () => {
        saveCandidateAttribution(leadId, button.dataset.selectCandidate);
      });
    });
  } catch (error) {
    listEl.innerHTML = `<div class="error">Erro ao carregar candidatos: ${escapeHtml(
      error.message,
    )}</div>`;
  }
}

function renderCandidateCard(candidate) {
  const campaign =
    candidate.utmCampaign ||
    candidate.trackingLink?.campaignName ||
    candidate.trackingLink?.name ||
    candidate.clickCode;

  return `
    <button
      class="candidate-card"
      type="button"
      data-select-candidate="${escapeAttribute(candidate.clickEventId)}"
    >
      <strong class="truncate">${escapeHtml(campaign || "Clique sem campanha")}</strong>
      <p class="truncate">Código: ${escapeHtml(candidate.clickCode || "-")}</p>
      <p class="truncate">Origem: ${escapeHtml(candidate.utmSource || "-")}</p>
      <p class="truncate">fbclid: ${escapeHtml(candidate.fbclid || "-")}</p>
      <p>${formatDate(candidate.clickedAt)}</p>
    </button>
  `;
}

async function saveCandidateAttribution(leadId, clickEventId) {
  try {
    await createManualAttribution(leadId, {
      clickEventId,
    });

    closeModal();
    await refreshLeads();
    await openLead(leadId, false);
  } catch (error) {
    alert(`Erro ao atribuir clique: ${error.message}`);
  }
}

async function saveManualOnly(leadId) {
  const sourcePlatform = document.getElementById("manual-source-input").value.trim();
  const campaignName = document.getElementById("manual-campaign-input").value.trim();
  const utmSource = document.getElementById("manual-utm-source-input").value.trim();
  const utmCampaign = document.getElementById("manual-utm-campaign-input").value.trim();

  if (!campaignName && !utmCampaign) {
    alert("Informe pelo menos o nome da campanha ou UTM campaign.");
    return;
  }

  try {
    await createManualAttribution(leadId, {
      sourcePlatform,
      campaignName,
      utmSource: utmSource || sourcePlatform,
      utmCampaign: utmCampaign || campaignName,
    });

    closeModal();
    await refreshLeads();
    await openLead(leadId, false);
  } catch (error) {
    alert(`Erro ao salvar atribuição manual: ${error.message}`);
  }
}

function escapeHtml(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  try {
    return new Date(value).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

refreshButtonEl.addEventListener("click", refreshLeads);

searchInputEl.addEventListener("input", () => {
  state.search = searchInputEl.value.trim();

  clearTimeout(window.__searchTimeout);
  window.__searchTimeout = setTimeout(refreshLeads, 350);
});

checkHealth();
refreshLeads();
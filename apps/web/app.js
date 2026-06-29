const API_BASE =
  window.PANORAM_API_BASE ||
  (window.location.protocol === "file:"
    ? "http://127.0.0.1:3001"
    : `${window.location.protocol}//${window.location.hostname}:3001`);

const DEFAULT_STAGES = [
  { slug: "new_lead", label: "Novo lead", order: 1 },
  { slug: "in_progress", label: "Em atendimento", order: 2 },
  { slug: "qualified", label: "Qualificado", order: 3 },
  { slug: "proposal_sent", label: "Proposta enviada", order: 4 },
  { slug: "won", label: "Venda realizada", order: 5 },
  { slug: "lost", label: "Perdido", order: 6 },
];

const state = {
  view: "pipeline",
  leads: [],
  stages: [],
  selectedLeadId: null,
  selectedLead: null,
  search: "",
  loading: false,
  error: null,
};

const boardEl = document.getElementById("board");
const leadPanelEl = document.getElementById("lead-panel");
const refreshButtonEl = document.getElementById("refresh-button");
const searchInputEl = document.getElementById("search-input");
const apiStatusEl = document.getElementById("api-status");
const modalRootEl = document.getElementById("modal-root");

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
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
    const data = await request("/health");
    apiStatusEl.textContent = data?.status === "ok" ? "API online" : "API respondeu";
  } catch (error) {
    apiStatusEl.textContent = "API offline";
    console.error("Health check failed:", error);
  }
}

async function sendConversationText(leadId, text) {
  return request(`/conversations/leads/${leadId}/messages/text`, {
    method: "POST",
    body: JSON.stringify({
      text,
    }),
  });
}

async function sendConversationMedia(leadId, body) {
  return request(`/conversations/leads/${leadId}/messages/media`, {
    method: "POST",
    body: JSON.stringify(body),
  });
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
  state.error = null;
  renderCurrentView();

  try {
    const data = await listLeads();

    const normalized = normalizeLeadsResponse(data);

    state.leads = normalized.leads;
    state.stages = normalized.stages;

    if (state.selectedLeadId) {
      await openLead(state.selectedLeadId, false);
    }
  } catch (error) {
    state.error = error;
    state.leads = [];
    state.stages = DEFAULT_STAGES;
    console.error("Erro ao carregar leads:", error);
  } finally {
    state.loading = false;
    renderCurrentView();
  }
}

function normalizeLeadsResponse(data) {
  const leads = Array.isArray(data) ? data : data?.leads || [];

  let stages = Array.isArray(data?.stages) && data.stages.length
    ? data.stages
    : DEFAULT_STAGES;

  const unknownStageSlugs = Array.from(
    new Set(
      leads
        .map((lead) => lead.currentStage || "new_lead")
        .filter((slug) => !stages.some((stage) => stage.slug === slug)),
    ),
  );

  if (unknownStageSlugs.length) {
    stages = [
      ...stages,
      ...unknownStageSlugs.map((slug, index) => ({
        slug,
        label: slug,
        order: stages.length + index + 1,
      })),
    ];
  }

  return {
    leads,
    stages: [...stages].sort((a, b) => (a.order || 0) - (b.order || 0)),
  };
}

async function openLead(leadId, shouldRenderView = true) {
  state.selectedLeadId = leadId;

  if (shouldRenderView) {
    renderCurrentView();
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
  renderCurrentView();
}

function setView(view) {
  state.view = view;

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  renderCurrentView();
}

function renderCurrentView() {
  updateHeader();

  if (state.loading) {
    boardEl.className = "pipeline-board";
    boardEl.innerHTML = `<div class="loading">Carregando leads...</div>`;
    return;
  }

  if (state.error) {
    boardEl.className = "pipeline-board";
    boardEl.innerHTML = `
      <div class="error">
        Erro ao carregar dados da API.<br />
        <strong>${escapeHtml(state.error.message)}</strong><br />
        <small>Verifique se o app.js está usando ${escapeHtml(API_BASE)}.</small>
      </div>
    `;
    return;
  }

  if (state.view === "conversations") {
    renderConversationsView();
    return;
  }

  if (state.view === "contacts") {
    renderContactsView();
    return;
  }

  renderPipelineView();
}

function updateHeader() {
  const titleEl = document.querySelector(".topbar h1");
  const subtitleEl = document.querySelector(".topbar p");

  if (!titleEl || !subtitleEl) {
    return;
  }

  if (state.view === "conversations") {
    titleEl.textContent = "Conversas";
    subtitleEl.textContent = "Últimas conversas recebidas pelo WhatsApp.";
    return;
  }

  if (state.view === "contacts") {
    titleEl.textContent = "Contatos";
    subtitleEl.textContent = "Base de leads e contatos capturados.";
    return;
  }

  titleEl.textContent = "Pipeline comercial";
  subtitleEl.textContent = "Leads, conversas e atribuições das campanhas.";
}

function renderPipelineView() {
  boardEl.className = "pipeline-board";

  if (!state.stages.length) {
    boardEl.innerHTML = `<div class="empty-state">Nenhuma etapa de pipeline encontrada.</div>`;
    return;
  }

  const columns = state.stages
    .map((stage) => {
      const leads = state.leads.filter(
        (lead) => (lead.currentStage || "new_lead") === stage.slug,
      );

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
  bindOpenLeadButtons();
}

function renderConversationsView() {
  boardEl.className = "conversation-app-view";

  const conversations = [...state.leads]
    .filter((lead) => lead.latestConversation || lead.latestMessage)
    .sort((a, b) => {
      const aDate = new Date(
        a.latestConversation?.lastMessageAt ||
        a.latestMessage?.sentAt ||
        a.updatedAt ||
        0,
      ).getTime();

      const bDate = new Date(
        b.latestConversation?.lastMessageAt ||
        b.latestMessage?.sentAt ||
        b.updatedAt ||
        0,
      ).getTime();

      return bDate - aDate;
    });

  if (!conversations.length) {
    boardEl.innerHTML = `<div class="empty-state">Nenhuma conversa encontrada.</div>`;
    return;
  }

  const selectedLead =
    state.selectedLead ||
    conversations.find((lead) => lead.id === state.selectedLeadId) ||
    conversations[0];

  if (!state.selectedLeadId) {
    state.selectedLeadId = selectedLead.id;
    openLead(selectedLead.id, false);
  }

  boardEl.innerHTML = `
    <aside class="conversation-sidebar">
      <div class="conversation-sidebar-header">
        <strong>Conversas</strong>
        <span>${conversations.length} conversas</span>
      </div>

      <div class="conversation-thread-list">
        ${conversations
      .map((lead) => {
        const message = lead.latestMessage;
        const conversation = lead.latestConversation;
        const isActive = lead.id === state.selectedLeadId;

        return `
              <button
                class="conversation-thread ${isActive ? "active" : ""}"
                type="button"
                data-open-conversation="${escapeAttribute(lead.id)}"
              >
                <div class="avatar">${escapeHtml(getInitials(lead.name || lead.phone))}</div>

                <div class="conversation-thread-content">
                  <div class="conversation-thread-top">
                    <strong>${escapeHtml(lead.name || lead.phone || "Contato")}</strong>
                    <span>${formatDate(
          conversation?.lastMessageAt || message?.sentAt || lead.updatedAt,
        )}</span>
                  </div>

                  <div class="conversation-thread-phone">
                    ${escapeHtml(formatPhoneLabel(lead))}
                  </div>

                  <p>${escapeHtml(message?.body || getMessageTypeLabel(message))}</p>
                </div>
              </button>
            `;
      })
      .join("")}
      </div>
    </aside>

    <section id="conversation-chat" class="conversation-chat">
      <div class="chat-empty">Carregando conversa...</div>
    </section>
  `;

  document.querySelectorAll("[data-open-conversation]").forEach((button) => {
    button.addEventListener("click", async () => {
      await openConversation(button.dataset.openConversation);
    });
  });

  renderConversationChat();
}

async function openConversation(leadId) {
  state.selectedLeadId = leadId;

  await openLead(leadId, false);

  renderConversationsView();
}

function renderConversationChat() {
  const chatEl = document.getElementById("conversation-chat");

  if (!chatEl) {
    return;
  }

  const lead = state.selectedLead;

  if (!lead) {
    chatEl.innerHTML = `<div class="chat-empty">Selecione uma conversa.</div>`;
    return;
  }

  const messages = lead.messages || [];

  chatEl.innerHTML = `
    <header class="chat-header">
      <div class="avatar">${escapeHtml(getInitials(lead.name || lead.phone))}</div>

      <div class="chat-contact">
        <strong>${escapeHtml(lead.name || lead.phone || "Contato")}</strong>
        <span>${escapeHtml(formatPhoneLabel(lead))}</span>
      </div>

      <button class="secondary-button" type="button" id="open-lead-info-button">
        Ver lead
      </button>
    </header>

    <div class="chat-messages" id="chat-messages">
      ${messages.length
      ? messages.map(renderChatMessage).join("")
      : `<div class="chat-empty">Nenhuma mensagem nesta conversa.</div>`
    }
    </div>

    <footer class="chat-composer">
      <input
        id="media-input"
        type="file"
        accept="image/*,audio/*"
        hidden
      />

      <button id="attach-media-button" class="secondary-button" type="button">
        Anexar
      </button>

      <input
        id="chat-text-input"
        class="chat-text-input"
        type="text"
        placeholder="Digite uma mensagem..."
      />

      <button id="send-message-button" class="primary-button" type="button">
        Enviar
      </button>
    </footer>
  `;

  document.getElementById("open-lead-info-button").addEventListener("click", () => {
    leadPanelEl.classList.remove("hidden");
    renderLeadPanel();
  });

  document.getElementById("send-message-button").addEventListener("click", () => {
    sendTextFromComposer(lead.id);
  });

  document.getElementById("chat-text-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      sendTextFromComposer(lead.id);
    }
  });

  document.getElementById("attach-media-button").addEventListener("click", () => {
    document.getElementById("media-input").click();
  });

  document.getElementById("media-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];

    if (file) {
      sendMediaFromComposer(lead.id, file);
    }
  });

  const messagesEl = document.getElementById("chat-messages");
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderChatMessage(message) {
  const direction = message.direction === "outbound" ? "outbound" : "inbound";
  const type = message.messageType || "text";

  let content = "";

  if (type === "image" && message.mediaUrl) {
    content = `
      <img class="chat-image" src="${escapeAttribute(message.mediaUrl)}" alt="Imagem enviada" />
      ${message.body ? `<div>${escapeHtml(message.body)}</div>` : ""}
    `;
  } else if (type === "audio" && message.mediaUrl) {
    content = `
      <audio class="chat-audio" controls src="${escapeAttribute(message.mediaUrl)}"></audio>
      ${message.body ? `<div>${escapeHtml(message.body)}</div>` : ""}
    `;
  } else if (type === "image") {
    content = `<div>Imagem recebida${message.body ? `: ${escapeHtml(message.body)}` : ""}</div>`;
  } else if (type === "audio") {
    content = `<div>Áudio recebido${message.body ? `: ${escapeHtml(message.body)}` : ""}</div>`;
  } else {
    content = `<div>${escapeHtml(message.body || "Mensagem sem texto")}</div>`;
  }

  return `
    <div class="chat-message-row ${direction}">
      <div class="chat-bubble ${direction}">
        ${content}
        <div class="message-time">${formatDate(message.sentAt)}</div>
      </div>
    </div>
  `;
}

async function sendTextFromComposer(leadId) {
  const input = document.getElementById("chat-text-input");
  const text = input.value.trim();

  if (!text) {
    return;
  }

  input.disabled = true;

  try {
    await sendConversationText(leadId, text);
    input.value = "";
    await openLead(leadId, false);
    renderConversationChat();
    await refreshLeads();
  } catch (error) {
    alert(`Erro ao enviar mensagem: ${error.message}`);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function sendMediaFromComposer(leadId, file) {
  const allowed = file.type.startsWith("image/") || file.type.startsWith("audio/");

  if (!allowed) {
    alert("Envie apenas imagem ou áudio.");
    return;
  }

  try {
    const mediaBase64 = await fileToBase64(file);

    await sendConversationMedia(leadId, {
      mediaBase64,
      mimeType: file.type,
      fileName: file.name,
      mediaType: file.type.startsWith("audio/") ? "audio" : "image",
    });

    await openLead(leadId, false);
    renderConversationChat();
    await refreshLeads();
  } catch (error) {
    alert(`Erro ao enviar mídia: ${error.message}`);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getMessageTypeLabel(message) {
  if (!message) return "Sem mensagem";

  if (message.messageType === "image") return "Imagem";
  if (message.messageType === "audio") return "Áudio";

  return "Mensagem sem texto";
}

function formatPhoneLabel(lead) {
  const phone = lead.phone || "-";
  const chatId = lead.latestConversation?.externalChatId || "";

  if (chatId.endsWith("@g.us")) {
    return `${phone} · grupo`;
  }

  return phone;
}

function renderContactsView() {
  boardEl.className = "list-view";

  if (!state.leads.length) {
    boardEl.innerHTML = `<div class="empty-state">Nenhum contato encontrado.</div>`;
    return;
  }

  const contacts = [...state.leads].sort((a, b) => {
    const aName = a.name || a.phone || "";
    const bName = b.name || b.phone || "";

    return aName.localeCompare(bName, "pt-BR");
  });

  boardEl.innerHTML = `
    <div class="contacts-list">
      ${contacts
      .map((lead) => {
        const attribution = lead.latestAttribution;
        const campaign =
          attribution?.utmCampaign ||
          attribution?.campaignName ||
          attribution?.utmSource ||
          "Sem atribuição";

        return `
            <button
              class="contact-card ${lead.id === state.selectedLeadId ? "active" : ""}"
              type="button"
              data-open-lead="${escapeAttribute(lead.id)}"
            >
              <div class="avatar">${escapeHtml(getInitials(lead.name || lead.phone))}</div>

              <div class="contact-content">
                <strong class="truncate">${escapeHtml(
          lead.name || lead.phone || "Contato sem nome",
        )}</strong>
                <span class="truncate">${escapeHtml(lead.phone || "-")}</span>
              </div>

              <div class="contact-meta">
                <span class="badge badge-neutral">${escapeHtml(
          lead.currentStageLabel || lead.currentStage || "Novo lead",
        )}</span>
                <span class="badge ${attribution ? "badge-blue" : "badge-amber"
          }">${escapeHtml(campaign)}</span>
              </div>
            </button>
          `;
      })
      .join("")}
    </div>
  `;

  bindOpenLeadButtons();
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

function bindOpenLeadButtons() {
  document.querySelectorAll("[data-open-lead]").forEach((button) => {
    button.addEventListener("click", () => {
      openLead(button.dataset.openLead);
    });
  });
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
          <button id="open-conversation-button" class="secondary-button" type="button">
            Abrir conversa
          </button>
        </div>

        ${renderAttributions(lead.attributions || [])}
      </section>

      <section class="panel-section">
        <h3>Conversas</h3>
        ${renderConversationDetails(lead.conversations || [])}
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

  document.getElementById("open-conversation-button").addEventListener("click", async () => {
    setView("conversations");
    await openConversation(lead.id);
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

function renderConversationDetails(conversations) {
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

  document.getElementById("close-modal-button").addEventListener("click", closeModal);

  document.getElementById("candidate-search-button").addEventListener("click", () => {
    loadCandidates(lead.id);
  });

  document.getElementById("save-manual-only-button").addEventListener("click", () => {
    saveManualOnly(lead.id);
  });

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

function getInitials(value) {
  const safeValue = String(value || "P").trim();

  return safeValue
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
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

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    setView(button.dataset.view);
  });
});

refreshButtonEl.addEventListener("click", refreshLeads);

searchInputEl.addEventListener("input", () => {
  state.search = searchInputEl.value.trim();

  clearTimeout(window.__searchTimeout);
  window.__searchTimeout = setTimeout(refreshLeads, 350);
});

checkHealth();
refreshLeads();
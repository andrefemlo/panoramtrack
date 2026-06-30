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

const { createApp, nextTick } = Vue;

createApp({
  data() {
    return {
      apiStatus: "Conectando...",
      attributionCandidates: [],
      attributionModalOpen: false,
      candidateSearch: "",
      composerText: "",
      contacts: [],
      conversationMessages: [],
      conversations: [],
      drawerOpen: false,
      drawerMessage: "",
      error: "",
      leads: [],
      loading: false,
      manualAttribution: {
        campaignName: "",
        sourcePlatform: "manual",
        utmCampaign: "",
        utmSource: "",
      },
      navItems: [
        { view: "pipeline", label: "Pipeline", icon: "▦" },
        { view: "conversations", label: "Conversas", icon: "◌" },
        { view: "contacts", label: "Contatos", icon: "◎" },
      ],
      search: "",
      searchTimer: null,
      selectedConversation: null,
      selectedConversationId: null,
      selectedLead: null,
      selectedLeadId: null,
      stages: DEFAULT_STAGES,
      view: "pipeline",
    };
  },

  computed: {
    currentSubtitle() {
      if (this.view === "conversations") return "Atendimento WhatsApp";
      if (this.view === "contacts") return "Base comercial";
      return "Funil comercial";
    },

    currentTitle() {
      if (this.view === "conversations") return "Conversas";
      if (this.view === "contacts") return "Contatos";
      return "Pipeline";
    },

    searchPlaceholder() {
      if (this.view === "conversations") return "Buscar conversa ou mensagem...";
      if (this.view === "contacts") return "Buscar contato, telefone ou tag...";
      return "Buscar lead, telefone ou campanha...";
    },

    pipelineMetrics() {
      return [
        { label: "Leads", value: this.leads.length },
        { label: "Qualificados", value: this.leadsByStage("qualified").length },
        { label: "Propostas", value: this.leadsByStage("proposal_sent").length },
        { label: "Vendas", value: this.leadsByStage("won").length },
      ];
    },
  },

  mounted() {
    this.checkHealth();
    this.refreshActiveView();
  },

  methods: {
    async api(path, options = {}) {
      const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });

      const text = await response.text();

      if (!response.ok) {
        throw new Error(text || `HTTP ${response.status}`);
      }

      return text ? JSON.parse(text) : null;
    },

    async checkHealth() {
      try {
        const data = await this.api("/health");
        this.apiStatus = data?.status === "ok" ? "API online" : "API respondeu";
      } catch (error) {
        this.apiStatus = "API offline";
        console.error(error);
      }
    },

    async refreshActiveView() {
      this.error = "";
      this.loading = true;

      try {
        if (this.view === "contacts") {
          await this.loadContacts();
        } else if (this.view === "conversations") {
          await this.loadConversations();
        } else {
          await this.loadPipeline();
        }
      } catch (error) {
        this.error = "Não foi possível carregar os dados da API.";
        console.error(error);
      } finally {
        this.loading = false;
      }
    },

    async loadPipeline() {
      const params = new URLSearchParams({ take: "100" });

      if (this.search) params.set("search", this.search);

      const data = await this.api(`/leads?${params.toString()}`);
      this.stages = this.normalizeStages(data?.stages);
      this.leads = data?.leads || [];
    },

    async loadContacts() {
      const params = new URLSearchParams({ take: "100" });

      if (this.search) params.set("search", this.search);

      const data = await this.api(`/contacts?${params.toString()}`);
      this.contacts = data?.contacts || [];
    },

    async loadConversations() {
      const params = new URLSearchParams({ take: "100", archived: "false" });

      if (this.search) params.set("search", this.search);

      const data = await this.api(`/conversations?${params.toString()}`);
      this.conversations = data?.conversations || [];

      if (!this.selectedConversationId && this.conversations.length) {
        await this.openConversation(this.conversations[0].id);
      }
    },

    normalizeStages(stages) {
      const normalized = Array.isArray(stages) && stages.length ? stages : DEFAULT_STAGES;
      return [...normalized].sort((a, b) => (a.order || 0) - (b.order || 0));
    },

    async setView(view) {
      this.view = view;
      this.error = "";
      this.drawerOpen = false;
      this.selectedLead = null;
      this.selectedLeadId = null;

      if (view !== "conversations") {
        this.selectedConversation = null;
        this.selectedConversationId = null;
        this.conversationMessages = [];
      }

      await this.refreshActiveView();
    },

    scheduleRefresh() {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => this.refreshActiveView(), 300);
    },

    leadsByStage(stageSlug) {
      return this.leads.filter(
        (lead) => (lead.currentStage || "new_lead") === stageSlug,
      );
    },

    displayName(record) {
      return record?.name || record?.phone || "Contato sem nome";
    },

    leadCampaign(lead) {
      const attribution = lead?.latestAttribution;
      return (
        attribution?.utmCampaign ||
        attribution?.campaignName ||
        attribution?.utmSource ||
        ""
      );
    },

    async openLead(leadId) {
      this.selectedLeadId = leadId;
      this.drawerOpen = true;
      this.selectedLead = null;
      this.drawerMessage = "";

      const lead = await this.api(`/leads/${encodeURIComponent(leadId)}`);
      this.selectedLead = lead;
      this.stages = this.normalizeStages(lead?.stages || this.stages);
    },

    closeDrawer() {
      this.drawerOpen = false;
      this.selectedLead = null;
      this.selectedLeadId = null;
      this.drawerMessage = "";
    },

    async moveLead(leadId, stage) {
      const result = await this.api(`/leads/${encodeURIComponent(leadId)}/stage`, {
        method: "PATCH",
        body: JSON.stringify({ changedBy: "crm-vue", stage }),
      });

      if (this.selectedLead?.id === leadId) {
        this.selectedLead = {
          ...this.selectedLead,
          ...result.lead,
        };
      }

      await this.refreshActiveView();

      if (this.selectedLeadId) {
        await this.openLead(this.selectedLeadId);
      }
    },

    async openConversation(conversationId) {
      this.selectedConversationId = conversationId;
      const detail = await this.api(
        `/conversations/${encodeURIComponent(conversationId)}/messages?take=80`,
      );

      this.selectedConversation = detail.conversation;
      this.conversationMessages = detail.messages || [];

      await nextTick();

      const messagesEl = this.$refs.chatMessages;
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    },

    async sendTextMessage() {
      const text = this.composerText.trim();

      if (!text || !this.selectedConversationId) return;

      await this.api(
        `/conversations/${encodeURIComponent(this.selectedConversationId)}/messages/text`,
        {
          method: "POST",
          body: JSON.stringify({ text }),
        },
      );

      this.composerText = "";
      await this.openConversation(this.selectedConversationId);
      await this.loadConversations();
    },

    async openLeadConversation(lead) {
      const conversation = this.getLeadConversation(lead);

      if (!conversation) {
        this.error = "Este lead ainda não tem conversa individual vinculada.";
        return;
      }

      this.view = "conversations";
      this.drawerOpen = false;
      await this.loadConversations();
      await this.openConversation(conversation.id);
    },

    async sendDrawerMessage() {
      const text = this.drawerMessage.trim();

      if (!text || !this.selectedLead?.id) return;

      try {
        await this.api(
          `/conversations/leads/${encodeURIComponent(this.selectedLead.id)}/messages/text`,
          {
            method: "POST",
            body: JSON.stringify({ text }),
          },
        );

        this.drawerMessage = "";
        await this.openLead(this.selectedLead.id);
        await this.refreshActiveView();
      } catch (error) {
        this.error = this.extractErrorMessage(error);
      }
    },

    getLeadConversation(lead) {
      return (lead?.conversations || []).find((conversation) =>
        String(conversation.externalChatId || "").endsWith("@s.whatsapp.net"),
      );
    },

    openAttributionModal() {
      if (!this.selectedLead) return;

      this.attributionModalOpen = true;
      this.candidateSearch = "";
      this.manualAttribution = {
        campaignName: "",
        sourcePlatform: "manual",
        utmCampaign: "",
        utmSource: "",
      };
      this.loadAttributionCandidates();
    },

    closeAttributionModal() {
      this.attributionModalOpen = false;
      this.attributionCandidates = [];
    },

    async loadAttributionCandidates() {
      if (!this.selectedLead?.id) return;

      const params = new URLSearchParams({ sinceHours: "720", take: "50" });

      if (this.candidateSearch) params.set("search", this.candidateSearch);

      const data = await this.api(
        `/leads/${encodeURIComponent(this.selectedLead.id)}/attribution-candidates?${params.toString()}`,
      );

      this.attributionCandidates = data?.candidates || [];
    },

    async saveCandidateAttribution(clickEventId) {
      await this.api(
        `/leads/${encodeURIComponent(this.selectedLead.id)}/attributions/manual`,
        {
          method: "POST",
          body: JSON.stringify({ clickEventId }),
        },
      );

      this.closeAttributionModal();
      await this.openLead(this.selectedLead.id);
      await this.refreshActiveView();
    },

    async saveManualAttribution() {
      const payload = {
        ...this.manualAttribution,
        utmSource:
          this.manualAttribution.utmSource ||
          this.manualAttribution.sourcePlatform,
        utmCampaign:
          this.manualAttribution.utmCampaign ||
          this.manualAttribution.campaignName,
      };

      if (!payload.campaignName && !payload.utmCampaign) {
        this.error = "Informe ao menos uma campanha para atribuir manualmente.";
        return;
      }

      await this.api(
        `/leads/${encodeURIComponent(this.selectedLead.id)}/attributions/manual`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );

      this.closeAttributionModal();
      await this.openLead(this.selectedLead.id);
      await this.refreshActiveView();
    },

    lastMessages(messages = []) {
      return [...messages].slice(-8).reverse();
    },

    messagePreview(message, emptyLabel = "Sem mensagem registrada.") {
      if (!message) return emptyLabel;
      return message.body || this.messageTypeLabel(message);
    },

    messageTypeLabel(message) {
      if (!message) return "Sem mensagem";
      if (message.messageType === "image") return "Imagem";
      if (message.messageType === "audio") return "Áudio";
      if (message.messageType === "video") return "Vídeo";
      if (message.messageType === "document") return "Documento";
      if (message.messageType === "sticker") return "Figurinha";
      return "Mensagem sem texto";
    },

    documentLabel(message) {
      return message?.mediaFileName || message?.body || "Abrir documento";
    },

    initials(value) {
      return String(value || "P")
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase();
    },

    formatDate(value) {
      if (!value) return "-";

      return new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        month: "2-digit",
      }).format(new Date(value));
    },

    extractErrorMessage(error) {
      const message = String(error?.message || error || "Erro desconhecido");

      try {
        const parsed = JSON.parse(message);
        if (typeof parsed.message === "string" && parsed.response) {
          return `${parsed.message}: ${JSON.stringify(parsed.response)}`;
        }

        if (typeof parsed.message === "object") {
          return JSON.stringify(parsed.message);
        }

        return parsed.message || message;
      } catch {
        return message;
      }
    },
  },
}).mount("#app");

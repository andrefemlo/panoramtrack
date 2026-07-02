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
      connectionError: "",
      connectionLoading: false,
      selectedMediaFile: null,
      selectedMediaLabel: "",
      sendingMessage: false,
      audioRecorder: null,
      audioRecordingChunks: [],
      audioRecordingStartedAt: null,
      audioRecordingTimer: null,
      audioRecordingSeconds: 0,
      audioRecordingStream: null,
      isRecordingAudio: false,
      contacts: [],
      conversationMessages: [],
      conversations: [],
      drawerOpen: false,
      drawerMessage: "",
      error: "",
      leads: [],
      contactEditForm: {
        name: "",
        email: "",
      },
      contactEditOpen: false,
      contactNoteBody: "",
      savingContact: false,
      savingNote: false,
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
      eventsSource: null,
      qrModalOpen: false,
      qrCodeDataUrl: "",
      qrCodeText: "",
      qrPairingCode: "",
      selectedWhatsappInstanceName: "",
      selectedConversation: null,
      selectedConversationId: null,
      selectedLead: null,
      selectedLeadId: null,
      stages: DEFAULT_STAGES,
      view: "pipeline",
      whatsappInstances: [],
    };
  },

  computed: {
    currentWhatsappInstance() {
      return (
        this.whatsappInstances.find(
          (instance) => instance.name === this.selectedWhatsappInstanceName,
        ) ||
        this.whatsappInstances[0] ||
        null
      );
    },

    whatsappConnectionLabel() {
      return this.connectionStatusLabel(this.currentWhatsappInstance?.status);
    },

    whatsappConnectionClass() {
      return this.connectionStatusClass(this.currentWhatsappInstance?.status);
    },

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
    this.loadWhatsappInstances().then(() => this.refreshWhatsappStatus());
    this.refreshActiveView();
    this.connectRealtimeEvents();
  },

  beforeUnmount() {
    this.cancelAudioRecording();
    this.disconnectRealtimeEvents();
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

    async loadWhatsappInstances() {
      this.connectionError = "";

      try {
        const data = await this.api("/whatsapp-instances");
        this.whatsappInstances = data?.instances || [];

        if (
          !this.selectedWhatsappInstanceName ||
          !this.whatsappInstances.some(
            (instance) => instance.name === this.selectedWhatsappInstanceName,
          )
        ) {
          this.selectedWhatsappInstanceName = this.whatsappInstances[0]?.name || "";
        }
      } catch (error) {
        this.connectionError = this.extractErrorMessage(error);
      }
    },

    async refreshWhatsappStatus() {
      const instanceName = this.selectedWhatsappInstanceName;

      if (!instanceName || this.connectionLoading) {
        return;
      }

      this.connectionLoading = true;
      this.connectionError = "";

      try {
        const data = await this.api(
          `/whatsapp-instances/${encodeURIComponent(instanceName)}/status`,
          { method: "POST", body: JSON.stringify({}) },
        );
        const updatedInstance = data?.instance;

        if (updatedInstance) {
          this.upsertWhatsappInstance(updatedInstance);
        } else {
          await this.loadWhatsappInstances();
        }
      } catch (error) {
        this.connectionError = this.extractErrorMessage(error);
      } finally {
        this.connectionLoading = false;
      }
    },

    async generateWhatsappQrCode() {
      const instanceName = this.selectedWhatsappInstanceName;

      if (!instanceName || this.connectionLoading) {
        return;
      }

      this.connectionLoading = true;
      this.connectionError = "";
      this.qrCodeDataUrl = "";
      this.qrCodeText = "";
      this.qrPairingCode = "";

      try {
        const data = await this.api(
          `/whatsapp-instances/${encodeURIComponent(instanceName)}/reconnect`,
          { method: "POST", body: JSON.stringify({}) },
        );

        this.qrCodeDataUrl = data?.qrCodeDataUrl || "";
        this.qrCodeText = data?.qrCodeText || "";
        this.qrPairingCode = data?.pairingCode || "";
        this.qrModalOpen = true;

        await this.loadWhatsappInstances();
      } catch (error) {
        this.connectionError = this.extractErrorMessage(error);
      } finally {
        this.connectionLoading = false;
      }
    },

    closeQrModal() {
      this.qrModalOpen = false;
      this.qrCodeDataUrl = "";
      this.qrCodeText = "";
      this.qrPairingCode = "";
    },

    upsertWhatsappInstance(updatedInstance) {
      const index = this.whatsappInstances.findIndex(
        (instance) => instance.name === updatedInstance.name,
      );

      if (index >= 0) {
        this.whatsappInstances.splice(index, 1, {
          ...this.whatsappInstances[index],
          ...updatedInstance,
        });
      } else {
        this.whatsappInstances.unshift(updatedInstance);
      }

      this.selectedWhatsappInstanceName = updatedInstance.name;
    },

    connectionStatusLabel(status) {
      if (status === "active") return "Conectado";
      if (status === "inactive") return "Desconectado";
      if (status === "deleted") return "Desativado";
      return "Sem instância";
    },

    connectionStatusClass(status) {
      if (status === "active") return "connected";
      if (status === "inactive") return "disconnected";
      if (status === "deleted") return "disabled";
      return "unknown";
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

    async loadConversations(options = {}) {
      const params = new URLSearchParams({ take: "100", archived: "false" });

      if (this.search) params.set("search", this.search);

      const data = await this.api(`/conversations?${params.toString()}`);

      this.conversations = [...(data?.conversations || [])].sort((a, b) => {
        const dateA = new Date(a.lastMessageAt || a.updatedAt || a.createdAt || 0).getTime();
        const dateB = new Date(b.lastMessageAt || b.updatedAt || b.createdAt || 0).getTime();

        return dateB - dateA;
      });

      if (!this.selectedConversationId && this.conversations.length && !options.silent) {
        await this.openConversation(this.conversations[0].id);
      }

      if (this.selectedConversationId) {
        const updatedSelected = this.conversations.find(
          (conversation) => conversation.id === this.selectedConversationId,
        );

        if (updatedSelected) {
          this.selectedConversation = {
            ...(this.selectedConversation || {}),
            ...updatedSelected,
          };
        }
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

    leadCampaign(lead) {
      const attribution = lead?.latestAttribution;
      return (
        attribution?.utmCampaign ||
        attribution?.campaignName ||
        attribution?.utmSource ||
        ""
      );
    },

    async openLead(leadId, leadPreview = null) {
      this.selectedLeadId = leadId;
      this.drawerOpen = true;
      this.drawerMessage = "";
      this.contactEditOpen = false;
      this.contactNoteBody = "";

      if (leadPreview) {
        this.selectedLead = this.buildLeadPreview(leadPreview);
        this.contactEditForm = {
          name: this.selectedLead?.name || "",
          email: this.selectedLead?.email || "",
        };
      } else {
        this.selectedLead = null;
      }

      const lead = await this.api(`/leads/${encodeURIComponent(leadId)}`);

      if (this.selectedLeadId !== leadId) {
        return;
      }

      this.selectedLead = lead;
      this.contactEditForm = {
        name: lead?.name || "",
        email: lead?.email || "",
      };
      this.contactEditOpen = false;
      this.contactNoteBody = "";
      this.stages = this.normalizeStages(lead?.stages || this.stages);
    },

    buildLeadPreview(lead) {
      return {
        ...lead,
        attributions: lead.latestAttribution ? [lead.latestAttribution] : [],
        conversations: lead.latestConversation ? [lead.latestConversation] : [],
        messages: lead.latestMessage ? [lead.latestMessage] : [],
        notes: [],
        stageHistory: [],
      };
    },

    closeDrawer() {
      this.drawerOpen = false;
      this.selectedLead = null;
      this.selectedLeadId = null;
      this.drawerMessage = "";
      this.contactEditOpen = false;
      this.contactNoteBody = "";
      this.contactEditForm = {
        name: "",
        email: "",
      };
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

    toggleContactEdit() {
      if (!this.selectedLead) return;

      this.contactEditForm = {
        name: this.selectedLead.name || "",
        email: this.selectedLead.email || "",
      };

      this.contactEditOpen = !this.contactEditOpen;
    },

    async saveContactProfile() {
      if (!this.selectedLead?.id || this.savingContact) return;

      this.savingContact = true;
      this.error = "";

      try {
        const updated = await this.api(
          `/contacts/${encodeURIComponent(this.selectedLead.id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              name: this.contactEditForm.name,
              email: this.contactEditForm.email,
            }),
          },
        );

        this.selectedLead = {
          ...this.selectedLead,
          ...updated,
        };

        this.contactEditForm = {
          name: updated?.name || "",
          email: updated?.email || "",
        };

        this.contactEditOpen = false;

        await this.refreshActiveView();
      } catch (error) {
        this.error = this.extractErrorMessage(error);
      } finally {
        this.savingContact = false;
      }
    },

    async saveContactNote() {
      const body = this.contactNoteBody.trim();

      if (!body || !this.selectedLead?.id || this.savingNote) return;

      this.savingNote = true;
      this.error = "";

      try {
        await this.api(
          `/contacts/${encodeURIComponent(this.selectedLead.id)}/notes`,
          {
            method: "POST",
            body: JSON.stringify({
              body,
              createdBy: "crm-vue",
            }),
          },
        );

        this.contactNoteBody = "";
        await this.openLead(this.selectedLead.id);
        await this.refreshActiveView();
      } catch (error) {
        this.error = this.extractErrorMessage(error);
      } finally {
        this.savingNote = false;
      }
    },

    async openConversation(conversationId) {
      this.selectedConversationId = conversationId;
      this.clearSelectedMedia();
      this.composerText = "";

      try {
        let detail = await this.api(
          `/conversations/${encodeURIComponent(conversationId)}/messages?take=80`,
        );

        const messages = Array.isArray(detail.messages) ? detail.messages : [];

        const needsHydration = messages.some((message) =>
          this.messageNeedsMediaHydration(message),
        );

        if (needsHydration) {
          const hydrateResult = await this.api(
            `/conversations/${encodeURIComponent(conversationId)}/hydrate-media`,
            {
              method: "POST",
              body: JSON.stringify({
                messagesPerChat: 500,
              }),
            },
          );

          if (hydrateResult?.messagesUpdated > 0) {
            detail = await this.api(
              `/conversations/${encodeURIComponent(conversationId)}/messages?take=80`,
            );
          }
        }

        this.selectedConversation = detail.conversation;
        this.conversationMessages = detail.messages || [];

        await nextTick();

        const container = this.$refs.chatMessages;

        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      } catch (error) {
        this.error = this.extractErrorMessage(error);
      }
    },

    async sendComposer() {
      if (this.selectedMediaFile) {
        await this.sendMediaMessage();
        return;
      }

      await this.sendTextMessage();
    },

    async sendTextMessage() {
      const text = this.composerText.trim();

      if (!text || !this.selectedConversationId || this.sendingMessage) return;

      this.sendingMessage = true;

      try {
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
      } catch (error) {
        this.error = this.extractErrorMessage(error);
      } finally {
        this.sendingMessage = false;
      }
    },

    async toggleAudioRecording() {
      if (this.isRecordingAudio) {
        await this.finishAudioRecording();
        return;
      }

      await this.startAudioRecording();
    },

    async startAudioRecording() {
      if (
        this.sendingMessage ||
        !this.selectedConversationId ||
        this.isRecordingAudio
      ) {
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        this.error = "Seu navegador não permite gravação de áudio neste painel.";
        return;
      }

      if (
        !window.isSecureContext &&
        !["localhost", "127.0.0.1"].includes(window.location.hostname)
      ) {
        this.error =
          "A gravação de áudio no navegador exige HTTPS. Configure um domínio com SSL para usar o microfone no CRM.";
        return;
      }

      try {
        this.clearSelectedMedia();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = this.preferredAudioRecordingMimeType();
        const options = mimeType ? { mimeType } : undefined;
        const recorder = new MediaRecorder(stream, options);

        this.audioRecordingChunks = [];
        this.audioRecordingStream = stream;
        this.audioRecorder = recorder;
        this.audioRecordingStartedAt = Date.now();
        this.audioRecordingSeconds = 0;
        this.isRecordingAudio = true;
        this.error = "";

        recorder.addEventListener("dataavailable", (event) => {
          if (event.data?.size) {
            this.audioRecordingChunks.push(event.data);
          }
        });

        recorder.addEventListener("stop", () => {
          this.stopAudioRecordingTimer();
          this.stopAudioRecordingStream();
        });

        recorder.start();
        this.audioRecordingTimer = window.setInterval(() => {
          this.audioRecordingSeconds = Math.floor(
            (Date.now() - this.audioRecordingStartedAt) / 1000,
          );
        }, 250);
      } catch (error) {
        this.resetAudioRecordingState();
        this.error =
          error?.name === "NotAllowedError"
            ? "Permita o acesso ao microfone para gravar áudio."
            : this.extractErrorMessage(error);
      }
    },

    async finishAudioRecording() {
      if (!this.audioRecorder || !this.isRecordingAudio || this.sendingMessage) {
        return;
      }

      const recorder = this.audioRecorder;

      const stopped = new Promise((resolve) => {
        recorder.addEventListener("stop", resolve, { once: true });
      });

      if (recorder.state !== "inactive") {
        recorder.stop();
      }

      await stopped;

      const chunks = [...this.audioRecordingChunks];
      const mimeType = recorder.mimeType || "audio/webm";
      const durationSeconds = this.audioRecordingSeconds;

      this.resetAudioRecordingState();

      if (!chunks.length || durationSeconds < 1) {
        this.error = "Áudio muito curto para enviar.";
        return;
      }

      const extension = this.audioExtensionFromMimeType(mimeType);
      const file = new File(
        chunks,
        `audio-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
        { type: mimeType },
      );

      await this.sendAudioRecording(file);
    },

    cancelAudioRecording() {
      const recorder = this.audioRecorder;

      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }

      this.resetAudioRecordingState();
    },

    async sendAudioRecording(file) {
      if (!file || !this.selectedConversationId || this.sendingMessage) {
        return;
      }

      this.sendingMessage = true;

      try {
        const mediaBase64 = await this.fileToBase64(file);

        await this.api(
          `/conversations/${encodeURIComponent(this.selectedConversationId)}/messages/media`,
          {
            method: "POST",
            body: JSON.stringify({
              mediaBase64,
              mimeType: file.type || "audio/webm",
              fileName: file.name,
              mediaType: "audio",
            }),
          },
        );

        await this.openConversation(this.selectedConversationId);
        await this.loadConversations();
      } catch (error) {
        this.error = this.extractErrorMessage(error);
      } finally {
        this.sendingMessage = false;
      }
    },

    preferredAudioRecordingMimeType() {
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ];

      return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
    },

    audioExtensionFromMimeType(mimeType) {
      if (mimeType.includes("ogg")) return "ogg";
      if (mimeType.includes("mp4")) return "m4a";
      if (mimeType.includes("mpeg")) return "mp3";
      return "webm";
    },

    resetAudioRecordingState() {
      this.stopAudioRecordingTimer();
      this.stopAudioRecordingStream();
      this.audioRecorder = null;
      this.audioRecordingChunks = [];
      this.audioRecordingStartedAt = null;
      this.audioRecordingSeconds = 0;
      this.isRecordingAudio = false;
    },

    stopAudioRecordingTimer() {
      if (this.audioRecordingTimer) {
        window.clearInterval(this.audioRecordingTimer);
      }

      this.audioRecordingTimer = null;
    },

    stopAudioRecordingStream() {
      if (this.audioRecordingStream) {
        this.audioRecordingStream.getTracks().forEach((track) => track.stop());
      }

      this.audioRecordingStream = null;
    },

    openMediaPicker() {
      if (this.$refs.mediaInput) {
        this.$refs.mediaInput.click();
      }
    },

    handleMediaSelected(event) {
      const file = event.target.files?.[0];

      if (!file) {
        return;
      }

      const maxSizeInBytes = 20 * 1024 * 1024;

      if (file.size > maxSizeInBytes) {
        this.error = "O arquivo deve ter no máximo 20MB.";
        event.target.value = "";
        return;
      }

      const mediaType = this.inferMediaType(file);

      if (!mediaType) {
        this.error = "Formato não suportado. Envie imagem, áudio, vídeo ou documento.";
        event.target.value = "";
        return;
      }

      this.selectedMediaFile = file;
      this.selectedMediaLabel = this.mediaTypeLabel(mediaType);
    },

    clearSelectedMedia() {
      this.selectedMediaFile = null;
      this.selectedMediaLabel = "";

      if (this.$refs.mediaInput) {
        this.$refs.mediaInput.value = "";
      }
    },

    async sendMediaMessage() {
      if (!this.selectedMediaFile || !this.selectedConversationId || this.sendingMessage) {
        return;
      }

      this.sendingMessage = true;

      try {
        const file = this.selectedMediaFile;
        const mediaType = this.inferMediaType(file);

        if (!mediaType) {
          this.error = "Formato não suportado.";
          return;
        }

        const mediaBase64 = await this.fileToBase64(file);
        const caption = this.composerText.trim();

        await this.api(
          `/conversations/${encodeURIComponent(this.selectedConversationId)}/messages/media`,
          {
            method: "POST",
            body: JSON.stringify({
              mediaBase64,
              mimeType: file.type || "application/octet-stream",
              fileName: file.name,
              caption,
              mediaType,
            }),
          },
        );

        this.composerText = "";
        this.clearSelectedMedia();

        await this.openConversation(this.selectedConversationId);
        await this.loadConversations();
      } catch (error) {
        this.error = this.extractErrorMessage(error);
      } finally {
        this.sendingMessage = false;
      }
    },

    fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    },

    inferMediaType(file) {
      const mimeType = file.type || "";
      const fileName = file.name.toLowerCase();

      if (mimeType.startsWith("image/")) return "image";
      if (mimeType.startsWith("audio/")) return "audio";
      if (mimeType.startsWith("video/")) return "video";

      const documentExtensions = [
        ".pdf",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".txt",
        ".csv",
        ".ppt",
        ".pptx",
      ];

      if (documentExtensions.some((extension) => fileName.endsWith(extension))) {
        return "document";
      }

      if (
        mimeType === "application/pdf" ||
        mimeType.includes("document") ||
        mimeType.includes("spreadsheet") ||
        mimeType.includes("presentation") ||
        mimeType === "text/plain" ||
        mimeType === "text/csv"
      ) {
        return "document";
      }

      return null;
    },

    mediaTypeLabel(mediaType) {
      if (mediaType === "image") return "Imagem";
      if (mediaType === "audio") return "Áudio";
      if (mediaType === "video") return "Vídeo";
      if (mediaType === "document") return "Documento";

      return "Arquivo";
    },

    formatFileSize(size) {
      if (!Number.isFinite(size)) {
        return "-";
      }

      if (size < 1024) {
        return `${size} B`;
      }

      if (size < 1024 * 1024) {
        return `${(size / 1024).toFixed(1)} KB`;
      }

      return `${(size / 1024 / 1024).toFixed(1)} MB`;
    },

    formatRecordingTime(seconds) {
      const safeSeconds = Math.max(0, Number(seconds) || 0);
      const minutes = Math.floor(safeSeconds / 60);
      const remainingSeconds = safeSeconds % 60;

      return `${String(minutes).padStart(2, "0")}:${String(
        remainingSeconds,
      ).padStart(2, "0")}`;
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

    messageTypeLabel(message) {
      if (!message) return "Sem mensagem";
      if (message.messageType === "image") return "Imagem";
      if (message.messageType === "audio") return "Áudio";
      if (message.messageType === "video") return "Vídeo";
      if (message.messageType === "document") return "Documento";
      if (message.messageType === "sticker") return "Figurinha";
      return "Mensagem sem texto";
    },

    messageNeedsMediaHydration(message) {
      const mediaTypes = ["image", "audio", "video", "document", "sticker"];

      if (!mediaTypes.includes(message?.messageType)) {
        return false;
      }

      if (!message.mediaUrl) {
        return true;
      }

      return (
        message.mediaUrl.startsWith("http") ||
        message.mediaUrl.includes("mmg.whatsapp.net") ||
        message.mediaUrl.endsWith(".enc")
      );
    },

    isImageMessage(message) {
      return (
        ["image", "sticker"].includes(message?.messageType) &&
        !!message?.mediaUrl
      );
    },

    normalizedAudioMimeType(message) {
      const mimeType = message?.mediaMimeType || "";

      if (mimeType.includes("ogg")) {
        return "audio/ogg";
      }

      if (mimeType.includes("opus")) {
        return "audio/ogg";
      }

      if (mimeType.includes("mpeg")) {
        return "audio/mpeg";
      }

      if (mimeType.includes("mp3")) {
        return "audio/mpeg";
      }

      if (mimeType.includes("mp4")) {
        return "audio/mp4";
      }

      if (mimeType.includes("aac")) {
        return "audio/aac";
      }

      return mimeType || "audio/ogg";
    },

    normalizedAudioSrc(message) {
      const mediaUrl = message?.mediaUrl || "";

      if (!mediaUrl) {
        return "";
      }

      return mediaUrl
        .replace("data:audio/ogg; codecs=opus;base64,", "data:audio/ogg;base64,")
        .replace("data:audio/ogg;codecs=opus;base64,", "data:audio/ogg;base64,");
    },

    isAudioMessage(message) {
      return message?.messageType === "audio" && !!message?.mediaUrl;
    },

    isVideoMessage(message) {
      return message?.messageType === "video" && !!message?.mediaUrl;
    },

    isDocumentMessage(message) {
      return message?.messageType === "document" && !!message?.mediaUrl;
    },

    isMediaMessage(message) {
      return (
        this.isImageMessage(message) ||
        this.isAudioMessage(message) ||
        this.isVideoMessage(message) ||
        this.isDocumentMessage(message)
      );
    },

    isMediaMessageType(message, mediaType) {
      return message?.messageType === mediaType && !!message?.mediaUrl;
    },

    shouldRenderTextFallback(message) {
      if (!message) return true;

      const mediaTypes = ["image", "audio", "video", "document"];

      if (!mediaTypes.includes(message.messageType)) {
        return true;
      }

      return !message.mediaUrl;
    },

    shouldRenderMediaCaption(message) {
      if (!message?.body) {
        return false;
      }

      return ["image", "audio", "video", "document"].includes(message.messageType);
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

    isUnavailableMedia(message) {
      const mediaUrl = message?.mediaUrl || "";

      if (!this.isMediaMessage(message)) {
        return false;
      }

      if (!mediaUrl) {
        return true;
      }

      if (mediaUrl.includes("mmg.whatsapp.net")) {
        return true;
      }

      if (mediaUrl.includes("a.whatsapp.net")) {
        return true;
      }

      if (mediaUrl.includes(".enc")) {
        return true;
      }

      return false;
    },

    contactDisplayName(item) {
      const contact = item?.contact || {};
      const lead = item?.lead || {};

      const name =
        contact.name ||
        lead.name ||
        item?.leadName ||
        item?.name ||
        contact.whatsappName ||
        lead.whatsappName ||
        item?.whatsappName ||
        contact.whatsappPushName ||
        lead.whatsappPushName ||
        item?.whatsappPushName ||
        item?.pushName ||
        "";

      if (name && name.trim()) {
        return name.trim();
      }

      const phone =
        contact.phone ||
        lead.phone ||
        item?.leadPhone ||
        item?.phone ||
        "";

      if (phone) {
        return this.formatPhone(phone);
      }

      return "Contato sem nome";
    },

    contactAvatarUrl(item) {
      const contact = item?.contact || {};
      const lead = item?.lead || {};

      return (
        contact.profilePictureUrl ||
        lead.profilePictureUrl ||
        item?.profilePictureUrl ||
        item?.leadProfilePictureUrl ||
        ""
      );
    },

    contactInitials(item) {
      const displayName = this.contactDisplayName(item);

      if (!displayName || displayName === "Contato sem nome") {
        return "?";
      }

      const parts = displayName
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

      if (!parts.length) {
        return "?";
      }

      if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
      }

      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    },

    formatPhone(phone) {
      const digits = String(phone || "").replace(/\D/g, "");

      if (!digits) {
        return "";
      }

      if (digits.startsWith("55") && digits.length === 13) {
        return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
      }

      if (digits.startsWith("55") && digits.length === 12) {
        return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
      }

      if (digits.startsWith("351") && digits.length === 12) {
        return `+${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
      }

      if (digits.length > 10) {
        return `+${digits}`;
      }

      return digits;
    },

    connectRealtimeEvents() {
      this.disconnectRealtimeEvents();

      const source = new EventSource(`${API_BASE}/realtime/conversations`);

      source.addEventListener("message.created", async (event) => {
        const data = JSON.parse(event.data || "{}");
        await this.handleRealtimeConversationEvent(data);
      });

      source.addEventListener("conversation.updated", async (event) => {
        const data = JSON.parse(event.data || "{}");
        await this.handleRealtimeConversationEvent(data);
      });

      source.onerror = (error) => {
        console.warn("Realtime events connection error", error);
      };

      source.addEventListener("contact.updated", async (event) => {
        const data = JSON.parse(event.data || "{}");
        await this.handleRealtimeConversationEvent(data);
      });

      this.eventsSource = source;
    },

    disconnectRealtimeEvents() {
      if (this.eventsSource) {
        this.eventsSource.close();
        this.eventsSource = null;
      }
    },

    async handleRealtimeConversationEvent(event) {
      if (!event?.conversationId && !event?.leadId) {
        return;
      }

      if (this.view === "conversations") {
        await this.loadConversations({ silent: true });

        if (event.conversationId && this.selectedConversationId === event.conversationId) {
          await this.refreshConversationMessages(event.conversationId);
        }

        return;
      }

      if (this.view === "contacts") {
        await this.loadContacts();
        return;
      }

      if (this.selectedLeadId && event.leadId === this.selectedLeadId) {
        await this.openLead(this.selectedLeadId);
      }
    },

    async refreshConversationMessages(conversationId) {
      if (!conversationId) {
        return;
      }

      const detail = await this.api(
        `/conversations/${encodeURIComponent(conversationId)}/messages?take=80`,
      );

      const oldLastId = this.conversationMessages.at(-1)?.id || null;
      const newMessages = detail.messages || [];
      const newLastId = newMessages.at(-1)?.id || null;

      this.selectedConversation = detail.conversation;
      this.conversationMessages = newMessages;

      if (oldLastId !== newLastId) {
        await nextTick();

        const container = this.$refs.chatMessages;

        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      }
    },
  },
}).mount("#app");

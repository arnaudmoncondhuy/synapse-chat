import { Controller } from '@hotwired/stimulus';
import { escapeHtml, formatDate } from '../helpers.js';

/**
 * Synapse Chat Controller V2 (Minimalist Organic)
 *
 * Gère l'UI du chat (streaming NDJSON) ET la liste des conversations (historique).
 * Remplace l'ancienne séparation `synapse_chat_controller` / `synapse_sidebar_controller`.
 */
export default class extends Controller {
    static targets = [
        // Zone Chat Principal
        'messages', 'input', 'submitBtn', 'greeting', 'conversationTitle',
        'agentPicker', 'agentTrigger', 'agentMenu', 'currentAgentEmoji', 'currentAgentName', 'agentInput',
        'tonePicker', 'toneTrigger', 'toneMenu', 'currentToneEmoji', 'currentToneName', 'toneInput',
        // Vision
        'attachBtn', 'fileInput', 'attachmentPreview',
        // Zone Sidebar
        'sidebar', 'sidebarOverlay', 'conversationsList', 'conversationsEmpty',
        // Colonne droite (réflexion interne workflow)
        'aside',
        // Bouton artefacts (top bar)
        'artifactsBtn', 'artifactsCount',
        // Onglets et mémoire
        'tabConversations', 'tabMemory', 'panelConversations', 'panelMemory',
        'memoryInput', 'memoryList', 'memoryEmpty'
    ];

    static values = {
        chatUrl: String,
        resetUrl: String,
        csrfUrl: String,
        memoryConfirmUrl: String,
        memoryRejectUrl: String,
        memoryListUrl: String,
        memoryDeleteUrlTemplate: String,
        memoryManualUrl: String,
        memoryUpdateUrlTemplate: String,
        conversationsUrl: String,
        debugUrlTemplate: String,
        currentConversationId: String,
        debug: { type: Boolean, default: false },
        supportsVision: { type: Boolean, default: false },
        acceptedMimeTypes: { type: Array, default: [] },
        attachmentUrlTemplate: { type: String, default: '/synapse/attachment/ATTACHMENT_ID' }
    };

    connect() {
        this.scrollToBottom();
        this.inputTarget.focus();

        // Artefacts persistants (accumulés sur toute la conversation)
        this._allArtifacts = [];
        this._loadExistingArtifacts();
        this._updateArtifactsButton();

        // Écouteurs pour le textarea (auto-resize et Entrée = submit)
        this.onKeydown = this.handleKeydown.bind(this);
        this.onInput = this.autoResize.bind(this);
        if (this.hasInputTarget) {
            this.inputTarget.addEventListener('keydown', this.onKeydown);
            this.inputTarget.addEventListener('input', this.onInput);
        }

        // Écouteur pour fermer les menus (ton, agent) si on clique ailleurs
        this.onClickOutside = (e) => { this.closeToneMenuOutside(e); this.closeAgentMenuOutside(e); };
        document.addEventListener('click', this.onClickOutside);

        const urlParams = new URLSearchParams(window.location.search);
        this.isDebugMode = urlParams.has('debug') || this.debugValue;

        // Charger Markdown (Asynchrone)
        this.loadMarked();

        // Charger la liste des conversations (Sidebar)
        this.loadConversations();

        // Charger le ton persistant
        this.loadPersistentTone();

        // Charger l'agent persistant
        this.loadPersistentAgent();

        // Pièces jointes en attente d'envoi (images, PDF, etc.)
        this.pendingFiles = [];
        this.updateSendButton();

        // Lightbox : clic sur les images du chat pour les voir en grand
        this.onImageClick = (e) => {
            const img = e.target.closest('.synapse-chat-message-attachments img, .synapse-chat-input-images img');
            if (!img) return;
            this.openLightbox(img.src);
        };
        if (this.hasMessagesTarget) {
            this.messagesTarget.addEventListener('click', this.onImageClick);
        }
    }

    disconnect() {
        if (this.hasInputTarget) {
            this.inputTarget.removeEventListener('keydown', this.onKeydown);
            this.inputTarget.removeEventListener('input', this.onInput);
        }
        document.removeEventListener('click', this.onClickOutside);
        if (this.hasMessagesTarget) {
            this.messagesTarget.removeEventListener('click', this.onImageClick);
        }
        if (this._scrollRafId) cancelAnimationFrame(this._scrollRafId);
    }

    /* ── 1. GESTION DE LA SIDEBAR (MOBILE & LAYOUTS CONTRAINTS) ────── */

    toggleSidebar() {
        if (!this.hasSidebarTarget) return;

        if (this._isMobile()) {
            this.sidebarTarget.classList.toggle('is-open');
            if (this.hasSidebarOverlayTarget) {
                this.sidebarOverlayTarget.classList.toggle('is-visible');
            }
        } else {
            this.sidebarTarget.classList.toggle('is-collapsed');
        }
    }

    closeSidebar() {
        if (!this.hasSidebarTarget) return;

        if (this._isMobile()) {
            this.sidebarTarget.classList.remove('is-open');
            if (this.hasSidebarOverlayTarget) {
                this.sidebarOverlayTarget.classList.remove('is-visible');
            }
        } else {
            this.sidebarTarget.classList.add('is-collapsed');
        }
    }

    _isMobile() {
        return window.innerWidth <= 800;
    }

    /* ── 1.5. ONGLET CONVERSATIONS / MÉMOIRE ───────────────────────── */

    showConversationsTab() {
        if (this.hasTabConversationsTarget) this.tabConversationsTarget.classList.add('active');
        if (this.hasTabMemoryTarget) this.tabMemoryTarget.classList.remove('active');

        if (this.hasPanelConversationsTarget) this.panelConversationsTarget.classList.remove('synapse-hidden', 'active'); // trick to force reflow if needed
        if (this.hasPanelConversationsTarget) this.panelConversationsTarget.classList.add('active');

        if (this.hasPanelMemoryTarget) {
            this.panelMemoryTarget.classList.remove('active');
            this.panelMemoryTarget.classList.add('synapse-hidden');
        }
    }

    showMemoryTab() {
        if (this.hasTabConversationsTarget) this.tabConversationsTarget.classList.remove('active');
        if (this.hasTabMemoryTarget) this.tabMemoryTarget.classList.add('active');

        if (this.hasPanelConversationsTarget) {
            this.panelConversationsTarget.classList.remove('active');
            this.panelConversationsTarget.classList.add('synapse-hidden');
        }

        if (this.hasPanelMemoryTarget) this.panelMemoryTarget.classList.remove('synapse-hidden', 'active');
        if (this.hasPanelMemoryTarget) this.panelMemoryTarget.classList.add('active');

        this.loadMemories();
    }

    /* ── 2. CHARGEMENT DES CONVERSATIONS (Anciennement sidebar_controller) ── */

    async loadConversations() {
        try {
            const url = this.conversationsUrlValue || '/synapse/api/conversations';
            const response = await fetch(url);

            if (!response.ok) {
                if (response.status === 401) this.renderConversations([]); // Utilisateur non loggé
                else throw new Error('Erreur de chargement des conversations');
                return;
            }

            const conversations = await response.json();
            this.renderConversations(conversations);
        } catch (error) {
            console.error('[Synapse] Impossible de charger l\'historique', error);
            if (this.hasConversationsListTarget) {
                this.conversationsListTarget.innerHTML = `<div class="p-3 text-sm text-red-500">Erreur de chargement de l'historique.</div>`;
            }
        }
    }

    renderConversations(conversations) {
        console.log('[Synapse] renderConversations', conversations.length, 'targets:', {
            list: this.hasConversationsListTarget,
            empty: this.hasConversationsEmptyTarget
        });

        if (conversations.length === 0) {
            if (this.hasConversationsEmptyTarget) this.conversationsEmptyTarget.classList.remove('synapse-hidden');
            if (this.hasConversationsListTarget) this.conversationsListTarget.innerHTML = '';
            return;
        }

        if (this.hasConversationsEmptyTarget) this.conversationsEmptyTarget.classList.add('synapse-hidden');

        const html = conversations.map(conv => {
            const isActive = String(conv.id) === String(this.currentConversationIdValue);
            return `
                <div class="synapse-chat-conv-item ${isActive ? 'is-active' : ''}" 
                     data-conversation-id="${conv.id}"
                     data-action="click->${this.identifier}#selectConversation">
                    <div class="synapse-chat-conv-item__title" data-title-target="true">${escapeHtml(conv.title || 'Nouvelle conversation')}</div>
                    <div class="synapse-chat-conv-item__meta">
                        <span>${formatDate(conv.updated_at)}</span>
                    </div>
                    
                    <div class="synapse-chat-conv-actions">
                        <button type="button" class="synapse-btn-small" data-action="click->${this.identifier}#startRename:stop" aria-label="Renommer">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        </button>
                        <button type="button" class="synapse-btn-small is-danger" data-action="click->${this.identifier}#deleteConversation:stop" aria-label="Supprimer">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        if (this.hasConversationsListTarget) {
            this.conversationsListTarget.innerHTML = html;
        }

        // Mettre à jour le titre du header avec la conversation active
        if (this.hasConversationTitleTarget && this.currentConversationIdValue) {
            const active = conversations.find(c => String(c.id) === String(this.currentConversationIdValue));
            if (active && active.title) {
                this.conversationTitleTarget.textContent = active.title;
            }
        }
    }

    selectConversation(event) {
        const conversationId = event.currentTarget.dataset.conversationId;
        // On redirige carrément pour recharger l'historique côté serveur (SSR Twig)
        const url = new URL(window.location.href);
        url.searchParams.set('conversation', conversationId);
        window.location.href = url.toString();
    }

    async deleteConversation(event) {
        const item = event.currentTarget.closest('.synapse-chat-conv-item');
        const conversationId = item.dataset.conversationId;

        if (!confirm('Supprimer cette conversation ?')) return;

        // UI optimiste
        item.style.opacity = '0.5';
        item.style.pointerEvents = 'none';

        try {
            const url = `${this.conversationsUrlValue || '/synapse/api/conversations'}/${conversationId}`;
            const response = await fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });

            if (!response.ok) throw new Error('Échec suppression');

            item.remove();

            // Si c'était la discussion active, on retourne à l'accueil
            if (String(conversationId) === String(this.currentConversationIdValue)) {
                this.newConversation({ preventDefault: () => { } }); // Simule click nouveau chat
            }
        } catch (error) {
            console.error('Erreur suppression:', error);
            item.style.opacity = '1';
            item.style.pointerEvents = 'auto';
            alert('Impossible de supprimer la conversation.');
        }
    }

    startRename(event) {
        const item = event.currentTarget.closest('.synapse-chat-conv-item');
        const titleDiv = item.querySelector('[data-title-target="true"]');
        const currentTitle = titleDiv.textContent;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentTitle;
        input.className = 'synapse-chat-conv-input';

        titleDiv.replaceWith(input);
        input.focus();
        input.select();

        const save = async () => {
            const newTitle = input.value.trim();
            const div = document.createElement('div');
            div.className = 'synapse-chat-conv-item__title';
            div.dataset.titleTarget = 'true';

            if (newTitle && newTitle !== currentTitle) {
                div.textContent = newTitle;
                input.replaceWith(div);
                try {
                    const url = `${this.conversationsUrlValue || '/synapse/api/conversations'}/${item.dataset.conversationId}/rename`;
                    await fetch(url, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title: newTitle })
                    });
                } catch (err) {
                    console.error('Erreur renommage', err);
                    div.textContent = currentTitle; // Rollback
                }
            } else {
                div.textContent = currentTitle;
                input.replaceWith(div);
            }
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            else if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
        });
    }

    /* ── 3. CHAT CENTRAL (STREAMING & AFFICHAGE) ────────────────────────── */

    handleKeydown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.send(event);
        }
    }

    autoResize(event) {
        const textarea = event ? event.target : this.inputTarget;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
        this.updateSendButton();
    }

    updateSendButton() {
        if (!this.hasSubmitBtnTarget || !this.hasInputTarget) return;
        const hasContent = this.inputTarget.value.trim().length > 0 || this.pendingFiles.length > 0;
        this.submitBtnTarget.disabled = !hasContent;
    }

    async newConversation(event) {
        if (event) event.preventDefault();

        // Supprimer le paramètre 'conversation' de l'url et rediriger
        const url = new URL(window.location.href);
        url.searchParams.delete('conversation');
        window.location.href = url.toString();
    }

    async send(event) {
        if (event) event.preventDefault();

        const message = this.inputTarget.value.trim();
        const hasFiles = this.pendingFiles.length > 0;
        if (!message && !hasFiles) return;

        // Passage du mode Accueil au mode Chat Actif
        this.element.classList.remove('synapse-chat-mode-welcome');
        this.element.classList.add('synapse-chat-mode-active');
        if (this.hasGreetingTarget) this.greetingTarget.classList.add('synapse-hidden');

        const filesToSend = [...this.pendingFiles];
        this.addMessage(message, 'user', { attachments: filesToSend });

        this.inputTarget.value = '';
        this.inputTarget.style.height = 'auto';
        this.clearPendingFiles();
        this.setLoading(true);
        this.closeTransparencyPanel();

        const tone = this.hasToneInputTarget ? this.toneInputTarget.value : null;
        const agent = this.hasAgentInputTarget ? this.agentInputTarget.value : null;
        const csrfToken = await this.ensureCsrfToken();
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

        try {
            const payload = {
                message, conversation_id: this.currentConversationIdValue,
                options: { tone, ...(agent ? { agent } : {}) },
                debug: this.isDebugMode
            };
            if (filesToSend.length > 0) {
                payload.attachments = filesToSend.map(f => ({ mime_type: f.mime_type, data: f.data, name: f.name }));
            }

            const response = await fetch(this.chatUrlValue || '/synapse/api/chat', {
                method: 'POST', headers, body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const msg = response.status === 401 ? 'Session expirée. Rechargez la page.' : `Erreur serveur (${response.status}).`;
                throw new Error(msg);
            }

            await this._processStream(response.body.getReader());

        } catch (error) {
            this.setLoading(false);
            this._markTransparencyError(error.message || 'Erreur réseau');
            this.addMessage('❌ ' + error.message, 'assistant');
            console.error('Erreur API Chat:', error);
        } finally {
            this.setLoading(false);
            this.inputTarget.focus();
        }
    }

    // ── Stream processing ─────────────────────────────────────────────────

    async _processStream(reader) {
        const decoder = new TextDecoder();
        let buffer = '';
        const state = { text: '', bubble: null, error: null, done: false };

        let timeoutId = null;
        const resetTimeout = () => {
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                if (!state.done) {
                    reader.cancel();
                    this.setLoading(false);
                    this._markTransparencyError('Timeout — le serveur ne répond plus');
                    this.addMessage('⏱️ Le serveur ne répond plus (Timeout).', 'assistant');
                }
            }, 30000);
        };

        resetTimeout();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                resetTimeout();

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('{')) continue;
                    try {
                        const evt = JSON.parse(trimmed);
                        if (!evt?.type) continue;
                        if (this._handleStreamEvent(evt, state, timeoutId) === 'break') return;
                    } catch (e) { /* Ligne partielle */ }
                }
            }

            if (state.error) {
                this.setLoading(false);
                this._markTransparencyError(state.error);
                this.addMessage('❌ ' + state.error, 'assistant');
            } else if (!state.done && state.text === '') {
                this.setLoading(false);
                this._markTransparencyError('Réponse vide du serveur');
                this.addMessage('⚠️ Réponse vide du serveur.', 'assistant');
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }

    _handleStreamEvent(evt, state, timeoutId) {
        const p = evt.payload;
        const handlers = {
            'delta':                 () => this._onDelta(p, state),
            'result':                () => this._onResult(p, state, timeoutId),
            'status':                () => { if (p?.message) this.updateLoadingText(p.message); },
            'title':                 () => this._onTitle(p),
            'error':                 () => { state.error = typeof p === 'string' ? p : (p?.message || 'Erreur interne.'); state.done = true; clearTimeout(timeoutId); return 'break'; },
            'thinking_delta':        () => this.renderThinkingDelta(p),
            'tool_started':          () => this.renderToolStarted(p),
            'tool_completed':        () => this.renderToolCompleted(p),
            'turn_iteration':        () => this.renderTurnIteration(p),
            'rag_context':           () => this.renderRagContext(p),
            'memory_recalled':       () => this.renderMemoryRecalled(p),
            'usage_update':          () => this.renderUsageUpdate(p),
            'artifacts':             () => this.renderArtifacts(p),
            'workflow_step_started': () => this.renderWorkflowStepStarted(p),
            'workflow_step':         () => this.renderWorkflowStepCompleted(p),
            'tool_executed':         () => this._onToolExecuted(p),
        };
        return handlers[evt.type]?.();
    }

    _onDelta(payload, state) {
        if (!state.bubble) {
            this.setLoading(false);
            this.addMessage('', 'assistant');
            const bubbles = this.messagesTarget.querySelectorAll('.synapse-chat-message--assistant .synapse-chat-bubble');
            state.bubble = bubbles[bubbles.length - 1];
        }
        if (payload?.text) {
            state.text += payload.text;
            state.bubble.innerHTML = this.parseMarkdown(state.text);
            this.scrollToBottom();
        }
    }

    _onResult(payload, state, timeoutId) {
        state.done = true;
        if (timeoutId) clearTimeout(timeoutId);
        this.setLoading(false);

        if (payload?.conversation_id) this.updateUrlConversation(payload.conversation_id);

        if (state.bubble && payload?.answer) {
            state.bubble.innerHTML = this.parseMarkdown(payload.answer);
            if (this.debugValue && payload?.debug_id) {
                this.addDebugButtonToMessage(state.bubble.closest('.synapse-chat-message'), payload.debug_id);
            }
        } else if (!state.bubble && (payload?.answer || payload?.generated_attachments?.length > 0)) {
            const displayText = payload?.answer && payload.answer !== '[image]' ? payload.answer : '';
            this.addMessage(displayText, 'assistant', { debug_id: payload.debug_id });
            const bubbles = this.messagesTarget.querySelectorAll('.synapse-chat-message--assistant .synapse-chat-bubble');
            state.bubble = bubbles[bubbles.length - 1];
        }

        if (state.bubble && payload?.generated_attachments?.length > 0) {
            const html = '<div class="synapse-chat-message-attachments">' +
                payload.generated_attachments.map(att => {
                    const url = this.attachmentUrlTemplateValue.replace('ATTACHMENT_ID', att.uuid);
                    return this._renderAttachmentBadge(att.mime_type || 'image/png', url, att.display_name);
                }).join('') + '</div>';
            state.bubble.insertAdjacentHTML('afterbegin', html);
        }
    }

    _onTitle(payload) {
        if (!payload?.title) return;
        this.updateSidebarConversationTitle(this.currentConversationIdValue, payload.title);
        if (this.hasConversationTitleTarget) this.conversationTitleTarget.textContent = payload.title;
    }

    _onToolExecuted(payload) {
        if (payload?.tool === 'propose_to_remember' && payload?.proposal) {
            this.showMemoryProposal(payload.proposal, payload.conversation_id || this.currentConversationIdValue);
        }
    }

    /* ── Gestion des pièces jointes (images, PDF, etc.) ─────────────────── */

    attachFile() {
        if (this.hasFileInputTarget) {
            this.fileInputTarget.click();
        }
    }

    async handleFileInput() {
        if (!this.hasFileInputTarget) return;
        const files = Array.from(this.fileInputTarget.files);
        this.fileInputTarget.value = ''; // Reset pour permettre de re-sélectionner le même fichier

        const allowed = this.acceptedMimeTypesValue;
        for (const file of files) {
            if (allowed.length > 0 && !allowed.includes(file.type)) continue;
            const data = await this.fileToBase64(file);
            this.pendingFiles.push({ mime_type: file.type, data, name: file.name });
        }
        this.renderFilePreview();
    }

    fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // Extraire uniquement la partie base64 (après la virgule)
                const result = reader.result;
                resolve(typeof result === 'string' ? result.split(',')[1] : '');
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    renderFilePreview() {
        if (!this.hasAttachmentPreviewTarget) return;
        const container = this.attachmentPreviewTarget;

        if (this.pendingFiles.length === 0) {
            container.classList.add('synapse-hidden');
            container.innerHTML = '';
            this.updateSendButton();
            return;
        }

        container.classList.remove('synapse-hidden');
        container.innerHTML = this.pendingFiles.map((file, index) => {
            const badge = this._renderAttachmentBadge(
                file.mime_type,
                `data:${file.mime_type};base64,${file.data}`,
                file.name
            );
            return `
                <div class="synapse-chat-attachment-preview__item">
                    ${badge}
                    <button type="button" class="synapse-chat-attachment-preview__remove"
                        data-action="click->${this.identifier}#removeFile"
                        data-index="${index}"
                        aria-label="Supprimer">×</button>
                </div>
            `;
        }).join('');
        this.updateSendButton();
    }

    removeFile(event) {
        const index = parseInt(event.currentTarget.dataset.index, 10);
        this.pendingFiles.splice(index, 1);
        this.renderFilePreview();
    }

    clearPendingFiles() {
        this.pendingFiles = [];
        this.renderFilePreview();
    }

    openLightbox(src) {
        const overlay = document.createElement('div');
        overlay.className = 'synapse-chat-lightbox';
        overlay.innerHTML = `<img src="${src}" alt="Image en grand">`;
        overlay.addEventListener('click', () => overlay.remove());
        document.addEventListener('keydown', function handler(e) {
            if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handler); }
        });
        document.body.appendChild(overlay);
    }

    addMessage(text, role, metadata = {}) {
        const formattedText = this.parseMarkdown(text);
        const debugId = metadata?.debug_id || null;
        let html = '';

        if (metadata?.subtype === 'system_action') {
            html = `
                <div class="synapse-chat-message synapse-chat-message--system-action">
                    <div class="synapse-chat-message__system-content">
                        ${formattedText}
                    </div>
                </div>
            `;
        } else {
            let avatarContent = '';
            if (role === 'assistant') {
                avatarContent = `
                    <div class="synapse-chat-avatar synapse-chat-avatar--ai">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
                    </div>
                `;
            } else {
                avatarContent = `<div class="synapse-chat-avatar synapse-chat-avatar--empty"></div>`; // Espace pour l'alignement
            }

            let debugButton = '';
            if (role === 'assistant' && this.debugValue && debugId) {
                debugButton = `
                    <button type="button" class="synapse-chat-debug-btn" data-action="click->${this.identifier}#showDebug" data-debug-id="${debugId}" title="Voir le debug">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bug"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>
                    </button>
                `;
            }

            let attachmentPreviewHtml = '';
            if (role === 'user' && metadata?.attachments?.length > 0) {
                attachmentPreviewHtml = '<div class="synapse-chat-message-attachments">' +
                    metadata.attachments.map(file => this._renderAttachmentBadge(
                        file.mime_type,
                        `data:${file.mime_type};base64,${file.data}`,
                        file.name
                    )).join('') +
                    '</div>';
            }
            html = `
                <div class="synapse-chat-message synapse-chat-message--${role}">
                    ${avatarContent}
                    <div class="synapse-chat-message__content">
                        <div class="synapse-chat-bubble">${attachmentPreviewHtml}${formattedText}</div>
                        ${debugButton}
                    </div>
                </div>
            `;
        }

        // Si un encart mémoire est le dernier élément, insérer le message avant
        const memoryEncart = this.messagesTarget.querySelector('.synapse-chat-message:last-child .synapse-chat-memory-encart');
        if (memoryEncart && role === 'assistant') {
            memoryEncart.closest('.synapse-chat-message').insertAdjacentHTML('beforebegin', html);
        } else {
            this.messagesTarget.insertAdjacentHTML('beforeend', html);
        }
        this.scrollToBottom();
    }

    updateLoadingText(text) {
        const dots = this.element.querySelector('#synapse-chat-loading-ind .synapse-chat-dots');
        if (dots) dots.textContent = text;
    }

    setLoading(isLoading) {
        if (this.hasSubmitBtnTarget) this.submitBtnTarget.disabled = isLoading;

        if (isLoading) {
            const html = `
                <div class="synapse-chat-message synapse-chat-message--assistant" id="synapse-chat-loading-ind">
                    <div class="synapse-chat-avatar synapse-chat-avatar--loading">
                        <div class="synapse-chat-spinner"></div>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>
                    </div>
                    <div class="synapse-chat-message__content" style="justify-content: center;">
                        <span class="synapse-chat-dots" style="color:var(--synapse-chat-text-muted);font-size:0.875rem;">Analyse</span>
                    </div>
                </div>
            `;
            this.messagesTarget.insertAdjacentHTML('beforeend', html);
            this.scrollToBottom();
        } else {
            const loader = this.element.querySelector('#synapse-chat-loading-ind');
            if (loader) loader.remove();
        }
    }

    addDebugButtonToMessage(messageElement, debugId) {
        if (!messageElement || !debugId || !this.debugValue) return;

        const contentArea = messageElement.querySelector('.synapse-chat-message__content');
        if (!contentArea || contentArea.querySelector('.synapse-chat-debug-btn')) return;

        const btnHtml = `
            <button type="button" class="synapse-chat-debug-btn" data-action="click->${this.identifier}#showDebug" data-debug-id="${debugId}" title="Voir le debug">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bug"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>
            </button>
        `;
        contentArea.insertAdjacentHTML('beforeend', btnHtml);
    }

    showDebug(event) {
        const debugId = event.currentTarget.dataset.debugId;
        if (!debugId || !this.hasDebugUrlTemplateValue) return;

        const url = this.debugUrlTemplateValue.replace('DEBUG_ID', debugId);
        window.open(url, '_blank');
    }



    /* ── 4. MÉMOIRE ET OUTILS ──────────────────────────────────────────────── */

    showMemoryProposal(proposal, conversationId) {
        const fact = proposal?.fact || proposal?.data?.fact;
        if (!fact) return;

        // Retirer ancien encart si présent
        const existing = this.messagesTarget.querySelector('.synapse-chat-memory-encart');
        if (existing) existing.closest('.synapse-chat-message').remove();

        const html = `
            <div class="synapse-chat-message synapse-chat-message--assistant">
                <div class="synapse-chat-avatar synapse-chat-avatar--empty"></div>
                <div class="synapse-chat-message__content">
                    <div class="synapse-chat-memory-encart">
                        <span class="synapse-chat-memory-encart__label">Mémoire :</span>
                        <span class="synapse-chat-memory-encart__fact">${escapeHtml(fact)}</span>
                        <button type="button" class="synapse-chat-memory-encart__btn" data-action-type="reject">Oublier</button>
                        <button type="button" class="synapse-chat-memory-encart__btn" data-action-type="confirm-conv">Retenir (cette discussion)</button>
                        <button type="button" class="synapse-chat-memory-encart__btn" data-action-type="confirm-user" style="color:var(--synapse-chat-primary);border-color:var(--synapse-chat-primary);">Mémoriser</button>
                    </div>
                </div>
            </div>
        `;

        this.messagesTarget.insertAdjacentHTML('beforeend', html);
        this.scrollToBottom();

        // Ajout des listeners sur le nouvel encart
        const lastMsg = this.messagesTarget.lastElementChild;
        const encart = lastMsg.querySelector('.synapse-chat-memory-encart');

        encart.querySelector('[data-action-type="reject"]').addEventListener('click', async () => {
            lastMsg.remove();
            try {
                const response = await fetch(this.memoryRejectUrlValue || '/synapse/api/memory/reject', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await this.ensureCsrfToken() },
                    body: JSON.stringify({ fact: fact, conversation_id: conversationId })
                });
                const data = await response.json();
                if (data.feedback_message) {
                    this.addMessage(data.feedback_message, 'user', { subtype: 'system_action' });
                }
            } catch (e) { }
        });

        const confirmFunc = async (scope) => {
            try {
                const response = await fetch(this.memoryConfirmUrlValue || '/synapse/api/memory/confirm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await this.ensureCsrfToken() },
                    body: JSON.stringify({ fact: fact, category: proposal.category || 'other', scope, conversation_id: conversationId })
                });
                const data = await response.json();
                encart.classList.add('synapse-chat-memory-encart--success');
                encart.innerHTML = `✅ Sauvegardé dans la mémoire (${scope === 'user' ? 'Générale' : 'Discussion courante'}).`;
                setTimeout(() => { lastMsg.remove(); }, 3000);

                // Basculer sur l'onglet Mémoire pour montrer le nouveau souvenir
                this.showMemoryTab();

                if (data.feedback_message) {
                    this.addMessage(data.feedback_message, 'user', { subtype: 'system_action' });
                }
            } catch (e) { console.error('Erreur mémoire', e); }
        };

        encart.querySelector('[data-action-type="confirm-conv"]').addEventListener('click', () => confirmFunc('conversation'));
        encart.querySelector('[data-action-type="confirm-user"]').addEventListener('click', () => confirmFunc('user'));
    }

    /* ── 4.5. CRUD MÉMOIRE (SIDEBAR) ───────────────────────────────────────── */

    async loadMemories() {
        try {
            const url = this.memoryListUrlValue || '/synapse/api/memory';
            const response = await fetch(url);

            if (!response.ok) {
                if (response.status === 401) this.renderMemories([]);
                else throw new Error('Erreur de chargement des souvenirs');
                return;
            }

            const data = await response.json();
            this.renderMemories(data.memories || []);
        } catch (error) {
            console.error('[Synapse] Impossible de charger la mémoire', error);
            if (this.hasMemoryListTarget) {
                this.memoryListTarget.innerHTML = `<div class="p-3 text-sm text-red-500">Erreur réseau.</div>`;
            }
        }
    }

    renderMemories(memories) {
        if (memories.length === 0) {
            if (this.hasMemoryEmptyTarget) this.memoryEmptyTarget.classList.remove('synapse-hidden');
            if (this.hasMemoryListTarget) this.memoryListTarget.innerHTML = '';
            return;
        }

        if (this.hasMemoryEmptyTarget) this.memoryEmptyTarget.classList.add('synapse-hidden');

        const html = memories.map(mem => {
            const scopeLabel = mem.scope === 'conversation' ? 'Discussion' : 'Général';
            return `
                <div class="synapse-memory-item" data-memory-id="${mem.id}">
                    <div class="synapse-memory-item__content" data-memory-text-target="true">${escapeHtml(mem.content)}</div>
                    <div class="synapse-memory-item__meta">
                        <span>${formatDate(mem.created_at)}</span>
                        <span>${scopeLabel}</span>
                    </div>
                    
                    <div class="synapse-memory-actions">
                        <button type="button" class="synapse-btn-small" data-action="click->${this.identifier}#editMemory" aria-label="Éditer">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        </button>
                        <button type="button" class="synapse-btn-small is-danger" data-action="click->${this.identifier}#deleteMemory" aria-label="Supprimer">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>

                    <div class="synapse-memory-edit-form">
                        <textarea class="synapse-memory-edit-input" data-memory-input-target="true">${escapeHtml(mem.content)}</textarea>
                        <div class="synapse-memory-edit-actions">
                            <button type="button" class="synapse-memory-edit-btn synapse-memory-edit-btn--cancel" data-action="click->${this.identifier}#cancelEditMemory">Annuler</button>
                            <button type="button" class="synapse-memory-edit-btn synapse-memory-edit-btn--save" data-action="click->${this.identifier}#saveMemory">Enregistrer</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        if (this.hasMemoryListTarget) {
            this.memoryListTarget.innerHTML = html;
        }
    }

    async addMemory(event) {
        event.preventDefault();
        const input = this.memoryInputTarget;
        const text = input.value.trim();
        const submitBtn = event.currentTarget.querySelector('button[type="submit"]');

        if (!text) return;

        input.disabled = true;
        submitBtn.disabled = true;

        try {
            const url = this.memoryManualUrlValue || '/synapse/api/memory/manual';
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await this.ensureCsrfToken() },
                body: JSON.stringify({ fact: text })
            });

            if (!response.ok) throw new Error('Erreur ajout souvenir');

            input.value = '';
            this.loadMemories(); // Rafraichissment de la liste complète
        } catch (e) {
            console.error(e);
            alert("Erreur lors de l'enregistrement du fait.");
        } finally {
            input.disabled = false;
            submitBtn.disabled = false;
        }
    }

    async deleteMemory(event) {
        const item = event.currentTarget.closest('.synapse-memory-item');
        if (!confirm('Oublier définitivement ce souvenir ?')) return;

        const id = item.dataset.memoryId;
        item.style.opacity = '0.5';

        try {
            let url = (this.memoryDeleteUrlTemplateValue || '/synapse/api/memory/MEMORY_ID').replace('MEMORY_ID', id);
            const response = await fetch(url, { method: 'DELETE', headers: { 'X-CSRF-Token': await this.ensureCsrfToken() } });
            if (!response.ok) throw new Error('Erreur suppression');
            item.remove();

            // Si la liste est vide après suppression, afficher le state empty
            if (this.memoryListTarget.children.length === 0 && this.hasMemoryEmptyTarget) {
                this.memoryEmptyTarget.classList.remove('synapse-hidden');
            }
        } catch (e) {
            console.error(e);
            item.style.opacity = '1';
        }
    }

    editMemory(event) {
        const item = event.currentTarget.closest('.synapse-memory-item');
        item.classList.add('is-editing');
        const input = item.querySelector('[data-memory-input-target="true"]');
        if (input) input.focus();
    }

    cancelEditMemory(event) {
        const item = event.currentTarget.closest('.synapse-memory-item');
        item.classList.remove('is-editing');
        const input = item.querySelector('[data-memory-input-target="true"]');
        const textTarget = item.querySelector('[data-memory-text-target="true"]');
        if (input && textTarget) input.value = textTarget.textContent; // rollback value
    }

    async saveMemory(event) {
        const item = event.currentTarget.closest('.synapse-memory-item');
        const id = item.dataset.memoryId;
        const input = item.querySelector('[data-memory-input-target="true"]');
        const textTarget = item.querySelector('[data-memory-text-target="true"]');
        const newText = input.value.trim();

        if (!newText) return this.cancelEditMemory(event);
        if (newText === textTarget.textContent) return this.cancelEditMemory(event);

        const btn = event.currentTarget;
        btn.disabled = true;

        try {
            let url = (this.memoryUpdateUrlTemplateValue || '/synapse/api/memory/MEMORY_ID').replace('MEMORY_ID', id);
            const response = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await this.ensureCsrfToken() },
                body: JSON.stringify({ fact: newText })
            });

            if (!response.ok) throw new Error('Erreur maj souvenir');

            textTarget.textContent = newText;
            item.classList.remove('is-editing');
        } catch (e) {
            console.error(e);
            alert("Erreur lors de la mise à jour.");
        } finally {
            btn.disabled = false;
        }
    }

    /* ── 4.5. SÉLECTEUR DE TONS ────────────────────────────────────────────── */

    // ── Helpers génériques pour les menus Tone / Agent ──

    _cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    _toggleMenu(type, event) {
        if (event) event.stopPropagation();
        const menuKey = `${type}Menu`, triggerKey = `${type}Trigger`;
        if (this[`has${this._cap(menuKey)}Target`]) {
            this[`${menuKey}Target`].classList.toggle('synapse-hidden');
            this[`${triggerKey}Target`].classList.toggle('is-open');
        }
    }

    _selectOption(type, event) {
        const ds = event.currentTarget.dataset;
        const key = ds[`${type}Key`], name = ds[`${type}Name`], emoji = ds[`${type}Emoji`];

        if (this[`hasCurrent${this._cap(type)}EmojiTarget`]) this[`current${this._cap(type)}EmojiTarget`].textContent = emoji;
        if (this[`hasCurrent${this._cap(type)}NameTarget`]) this[`current${this._cap(type)}NameTarget`].textContent = name;
        if (this[`has${this._cap(type)}InputTarget`]) this[`${type}InputTarget`].value = key;

        if (this[`has${this._cap(type)}MenuTarget`]) {
            this[`${type}MenuTarget`].querySelectorAll('.synapse-chat-tone-option').forEach(opt => {
                opt.classList.toggle('active', opt.dataset[`${type}Key`] === key);
            });
        }

        localStorage.setItem(`synapse_chat_${type}`, JSON.stringify({ key, name, emoji }));
        this._toggleMenu(type);
    }

    _closeMenuOutside(type, event) {
        const pickerKey = `${type}Picker`;
        if (!this[`has${this._cap(pickerKey)}Target`]) return;
        if (!this[`${pickerKey}Target`].contains(event.target)) {
            const menuKey = `${type}Menu`;
            if (this[`has${this._cap(menuKey)}Target`] && !this[`${menuKey}Target`].classList.contains('synapse-hidden')) {
                this._toggleMenu(type);
            }
        }
    }

    _loadPersistent(type) {
        const saved = localStorage.getItem(`synapse_chat_${type}`);
        if (!saved) return;
        try {
            const { key, name, emoji } = JSON.parse(saved);
            if (this[`hasCurrent${this._cap(type)}EmojiTarget`]) this[`current${this._cap(type)}EmojiTarget`].textContent = emoji;
            if (this[`hasCurrent${this._cap(type)}NameTarget`]) this[`current${this._cap(type)}NameTarget`].textContent = name;
            if (this[`has${this._cap(type)}InputTarget`]) this[`${type}InputTarget`].value = key;
            if (this[`has${this._cap(type)}MenuTarget`]) {
                this[`${type}MenuTarget`].querySelectorAll('.synapse-chat-tone-option').forEach(opt => {
                    opt.classList.toggle('active', opt.dataset[`${type}Key`] === key);
                });
            }
        } catch (e) {
            console.error(`Erreur chargement ${type} persistant`, e);
        }
    }

    // ── API publique Tone (Stimulus actions) ──

    toggleToneMenu(event) { this._toggleMenu('tone', event); }
    selectTone(event) { this._selectOption('tone', event); }
    closeToneMenuOutside(event) { this._closeMenuOutside('tone', event); }
    loadPersistentTone() { this._loadPersistent('tone'); }

    // ── API publique Agent (Stimulus actions) ──

    toggleAgentMenu(event) { this._toggleMenu('agent', event); }
    selectAgent(event) { this._selectOption('agent', event); }
    closeAgentMenuOutside(event) { this._closeMenuOutside('agent', event); }
    loadPersistentAgent() { this._loadPersistent('agent'); }

    /* ── 5. UTILITAIRES & MARKDOWN ─────────────────────────────────────────── */

    scrollToBottom() {
        if (this._scrollRafId) return;
        this._scrollRafId = requestAnimationFrame(() => {
            this._scrollRafId = null;
            const el = this.hasMessagesTarget ? this.messagesTarget.closest('.synapse-chat-main') : null;
            if (el) el.scrollTop = el.scrollHeight;
        });
    }

    updateUrlConversation(conversationId) {
        if (this.currentConversationIdValue === conversationId) return;
        this.currentConversationIdValue = String(conversationId);

        const url = new URL(window.location.href);
        url.searchParams.set('conversation', conversationId);
        window.history.pushState({}, '', url.toString());

        // Rafraîchir la sidebar côté JS (création visuelle nouvelle conv)
        if (this.hasSidebarTarget) {
            this.loadConversations();
        }
    }

    updateSidebarConversationTitle(id, title) {
        if (!this.hasConversationsListTarget) return;
        const item = this.conversationsListTarget.querySelector(`[data-conversation-id="${id}"]`);
        if (item) {
            const titleTarget = item.querySelector('[data-title-target="true"]');
            if (titleTarget) titleTarget.textContent = title;
        }
    }

    async ensureCsrfToken() {
        if (this._csrfToken) return this._csrfToken;
        const fromMeta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
        if (fromMeta) return fromMeta;
        const fromData = this.element?.dataset?.csrfToken;
        if (fromData) return fromData;
        try {
            const r = await fetch(this.csrfUrlValue || '/synapse/api/csrf-token');
            const data = await r.json();
            if (data?.token) this._csrfToken = data.token;
            return this._csrfToken;
        } catch { return ''; }
    }

    async loadMarked() {
        try {
            const m = await import('marked');
            this.markedParse = m.parse || m.default?.parse || m.marked?.parse;
        } catch (_) { /* Support fallback manuel en dessous */ }
    }

    parseMarkdown(text) {
        if (this.markedParse) {
            try { return this.markedParse(text); } catch (e) { }
        }
        // Fallback manuel minimal
        let html = text;
        // Actions buttons (links)
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="synapse-chat-btn-action" target="_blank">$1</a>');
        // Group buttons
        html = html.replace(/(<a class="synapse-chat-btn-action"[^>]*>.*?<\/a>(?:<br>)?){2,}/g, match => `<div class="synapse-chat-action-group">${match.replace(/<br>/g, '')}</div>`);
        // Basic markup
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>');
        html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>').replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\n/g, '<br>');
        return html;
    }

    /**
     * Rendu unifié d'un badge pièce jointe (miroir JS du partial Twig _attachment_badge.html.twig).
     * @param {string} mimeType - Type MIME (ex: 'image/png', 'application/pdf')
     * @param {string} url - URL de la ressource (data URI ou route servie)
     * @param {string|null} name - Nom d'affichage
     * @returns {string} HTML du badge
     */
    _renderAttachmentBadge(mimeType, url, name = null) {
        if (mimeType.startsWith('image/')) {
            return `<img src="${url}" alt="${name || 'Image'}" style="max-width: 300px; border-radius: 8px; border: 1px solid #bae6fd;" loading="lazy">`;
        }

        const configs = {
            'application/pdf': { bg: '#fef3c7', border: '#f59e0b', color: '#92400e', label: 'PDF', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
            'text/': { bg: '#e0f2fe', border: '#38bdf8', color: '#0c4a6e', label: 'Texte', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>' },
            'audio/': { bg: '#f3e8ff', border: '#a78bfa', color: '#5b21b6', label: 'Audio', icon: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' },
            'video/': { bg: '#fce7f3', border: '#f472b6', color: '#9d174d', label: 'Vidéo', icon: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>' },
        };

        const cfg = configs[mimeType]
            || Object.entries(configs).find(([k]) => k.endsWith('/') && mimeType.startsWith(k))?.[1]
            || { bg: '#f1f5f9', border: '#94a3b8', color: '#475569', label: mimeType, icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' };

        const displayName = name || cfg.label;
        const svg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${cfg.icon}</svg>`;
        const style = `display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: ${cfg.bg}; border: 1px solid ${cfg.border}; border-radius: 6px; font-size: 0.85rem; color: ${cfg.color}; text-decoration: none;`;

        if (url.startsWith('data:')) {
            return `<span style="${style}">${svg} ${displayName}</span>`;
        }
        return `<a href="${url}" style="${style}" target="_blank" rel="noopener">${svg} ${displayName}</a>`;
    }

    // ── Panneau de Transparence ("Anti Boîte Noire") ──────────────────────

    /**
     * Scanne les messages assistant existants dans le DOM pour collecter les artefacts (images, fichiers).
     * Appelé au connect() pour pré-remplir la galerie d'artefacts de la conversation.
     */
    _loadExistingArtifacts() {
        if (!this.hasMessagesTarget) return;

        const assistantMsgs = this.messagesTarget.querySelectorAll('.synapse-chat-message--assistant');
        assistantMsgs.forEach(msg => {
            const attachmentsContainer = msg.querySelector('.synapse-chat-message-attachments');
            if (!attachmentsContainer) return;

            // Images
            attachmentsContainer.querySelectorAll('img').forEach(img => {
                const url = img.src;
                if (!url) return;
                this._allArtifacts.push({
                    uuid: this._extractUuidFromUrl(url),
                    url: url,
                    mime_type: 'image/png',
                    display_name: img.alt || 'Image',
                });
            });

            // Liens fichiers (PDF, audio, etc.)
            attachmentsContainer.querySelectorAll('a[href]').forEach(link => {
                const url = link.href;
                if (!url) return;
                // Éviter les doublons si l'<a> contient un <img> (déjà traité)
                if (link.querySelector('img')) return;
                this._allArtifacts.push({
                    uuid: this._extractUuidFromUrl(url),
                    url: url,
                    mime_type: 'application/octet-stream',
                    display_name: link.textContent?.trim() || 'Fichier',
                });
            });
        });
    }

    /**
     * Extrait l'UUID depuis une URL d'attachment (/synapse/attachment/{uuid}).
     */
    _extractUuidFromUrl(url) {
        const match = url.match(/attachment\/([a-f0-9-]+)/i);
        return match ? match[1] : url;
    }

    /**
     * Ouvre le panneau de transparence si nécessaire et retourne l'aside.
     */
    _ensureTransparencyPanel() {
        if (!this.hasAsideTarget) return null;

        const aside = this.asideTarget;

        if (!aside.classList.contains('synapse-chat-aside--open')) {
            aside.classList.add('synapse-chat-aside--open');
            this._transparencyThinkingText = '';
            aside.innerHTML = `
                <div class="synapse-transparency-header">
                    <div class="synapse-transparency-header__icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/><path d="M12 6v6l4 2"/></svg>
                    </div>
                    <span class="synapse-transparency-header__title">Transparence</span>
                    <button type="button" class="synapse-transparency-header__close" aria-label="Fermer">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                    </button>
                </div>
                <div class="synapse-transparency-body">
                    <div class="synapse-transparency-section" data-section="rag" style="display:none"></div>
                    <div class="synapse-transparency-section" data-section="memory" style="display:none"></div>
                    <div class="synapse-transparency-section" data-section="workflow" style="display:none"></div>
                    <div class="synapse-transparency-section" data-section="thinking" style="display:none"></div>
                    <div class="synapse-transparency-section" data-section="turns" style="display:none"></div>
                    <div class="synapse-transparency-section" data-section="artifacts" style="display:none"></div>
                </div>
                <div class="synapse-transparency-footer" style="display:none"></div>
            `;
            aside.querySelector('.synapse-transparency-header__close')?.addEventListener('click', () => {
                this.closeTransparencyPanel();
            });

            // Restaurer les artefacts accumulés de la conversation
            if (this._allArtifacts && this._allArtifacts.length > 0) {
                this._renderArtifactsSection();
            }
        }

        return aside;
    }

    /**
     * Retourne une section du panneau par nom, la rend visible.
     */
    _getSection(name) {
        const aside = this._ensureTransparencyPanel();
        if (!aside) return null;
        const section = aside.querySelector(`[data-section="${name}"]`);
        if (section) section.style.display = '';
        return section;
    }

    /**
     * Retourne le footer du panneau, le rend visible.
     */
    _getFooter() {
        const aside = this._ensureTransparencyPanel();
        if (!aside) return null;
        const footer = aside.querySelector('.synapse-transparency-footer');
        if (footer) footer.style.display = '';
        return footer;
    }

    closeTransparencyPanel() {
        if (!this.hasAsideTarget) return;
        this.asideTarget.classList.remove('synapse-chat-aside--open');
        this.asideTarget.innerHTML = '';
        this._transparencyThinkingText = '';
        this._turnCount = 0;
    }

    /**
     * Marque le panneau de transparence en état d'erreur :
     * - Remplace tous les spinners actifs par une icône d'erreur
     * - Ajoute un indicateur d'erreur dans le footer
     */
    _markTransparencyError(errorMessage) {
        if (!this.hasAsideTarget || !this.asideTarget.classList.contains('synapse-chat-aside--open')) return;

        // Remplacer les spinners actifs par des icônes d'erreur
        this.asideTarget.querySelectorAll('.synapse-workflow-step__spinner').forEach(spinner => {
            spinner.outerHTML = '<span class="synapse-tool-call__icon" style="color: #ef4444;">⚠️</span>';
        });

        // Marquer les tool calls actifs comme en erreur
        this.asideTarget.querySelectorAll('.synapse-tool-call--active').forEach(el => {
            el.classList.remove('synapse-tool-call--active');
            el.classList.add('synapse-tool-call--error');
        });

        // Marquer les workflow steps "thinking" comme en erreur
        this.asideTarget.querySelectorAll('.synapse-workflow-step--thinking').forEach(el => {
            el.classList.remove('synapse-workflow-step--thinking');
            el.classList.add('synapse-workflow-step--error');
            const answerEl = el.querySelector('.synapse-workflow-step__answer--thinking');
            if (answerEl) {
                answerEl.classList.remove('synapse-workflow-step__answer--thinking');
                answerEl.textContent = errorMessage || 'Interrompu';
            }
        });

        // Afficher l'erreur dans le footer
        const footer = this._getFooter();
        if (footer) {
            footer.innerHTML = `<span class="synapse-transparency-footer__error">⚠️ ${escapeHtml(errorMessage || 'Erreur')}</span>`;
        }
    }

    // ── Thinking ────────────────────────────────────────────────────────────

    renderThinkingDelta(payload) {
        const section = this._getSection('thinking');
        if (!section) return;

        if (!this._transparencyThinkingText) this._transparencyThinkingText = '';
        this._transparencyThinkingText += payload.text || '';

        const preview = this._transparencyThinkingText.length > 300
            ? this._transparencyThinkingText.substring(0, 300) + '…'
            : this._transparencyThinkingText;

        section.innerHTML = `
            <div class="synapse-transparency-section__title">💭 Raisonnement</div>
            <div class="synapse-thinking-block synapse-tp-clickable">${escapeHtml(preview)}</div>
        `;

        section.querySelector('.synapse-thinking-block')?.addEventListener('click', () => {
            this._showDetailPopup('💭 Raisonnement', this._transparencyThinkingText || '');
        });

        this.asideTarget.scrollTop = this.asideTarget.scrollHeight;
    }

    /**
     * Popup modale générique pour afficher le contenu complet d'un bloc tronqué.
     */
    _showDetailPopup(title, content) {
        document.querySelector('.synapse-tp-popup')?.remove();

        const modal = document.createElement('div');
        modal.className = 'synapse-tp-popup';
        modal.innerHTML = `
            <div class="synapse-tp-popup__backdrop"></div>
            <div class="synapse-tp-popup__content">
                <div class="synapse-tp-popup__header">
                    <span class="synapse-tp-popup__title">${escapeHtml(title)}</span>
                    <button type="button" class="synapse-tp-popup__close" aria-label="Fermer">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                    </button>
                </div>
                <div class="synapse-tp-popup__body">${escapeHtml(content)}</div>
            </div>
        `;

        document.body.appendChild(modal);

        const close = () => modal.remove();
        modal.querySelector('.synapse-tp-popup__close')?.addEventListener('click', close);
        modal.querySelector('.synapse-tp-popup__backdrop')?.addEventListener('click', close);
    }

    // ── Tool Calls ──────────────────────────────────────────────────────────

    renderToolStarted(payload) {
        const section = this._getSection('turns');
        if (!section) return;

        // Track turn count
        if (!this._turnCount) this._turnCount = 0;

        // Ensure section title
        if (!section.querySelector('.synapse-transparency-section__title')) {
            section.innerHTML = '<div class="synapse-transparency-section__title">🔧 Outils</div>';
        }

        const toolEl = document.createElement('div');
        toolEl.className = 'synapse-tool-call synapse-tool-call--active';
        toolEl.setAttribute('data-tool-call-id', payload.toolCallId);
        const displayName = payload.toolLabel || payload.toolName;
        toolEl.innerHTML = `
            <span class="synapse-workflow-step__spinner"></span>
            <span class="synapse-tool-call__name">${escapeHtml(displayName)}</span>
        `;
        toolEl.title = payload.toolName;
        section.appendChild(toolEl);

        this.asideTarget.scrollTop = this.asideTarget.scrollHeight;
    }

    renderToolCompleted(payload) {
        const section = this._getSection('turns');
        if (!section) return;

        // Find active tool call by name (toolCallId not available in completed event)
        const activeTool = section.querySelector(`.synapse-tool-call--active`);
        if (activeTool) {
            activeTool.classList.remove('synapse-tool-call--active');
            activeTool.classList.add('synapse-tool-call--done');
            const spinner = activeTool.querySelector('.synapse-workflow-step__spinner');
            if (spinner) spinner.outerHTML = '<span class="synapse-tool-call__icon">✅</span>';
        }
    }

    // ── Multi-Turn Iteration ────────────────────────────────────────────────

    renderTurnIteration(payload) {
        const section = this._getSection('turns');
        if (!section) return;

        // Increment real turn counter
        if (!this._turnCount) this._turnCount = 0;
        this._turnCount++;

        // Update section title with actual turn count
        const title = section.querySelector('.synapse-transparency-section__title');
        if (title) {
            title.textContent = `🔧 Outils · Tour ${this._turnCount}`;
        }
    }

    // ── RAG Context ─────────────────────────────────────────────────────────

    renderRagContext(payload) {
        const section = this._getSection('rag');
        if (!section) return;

        const results = payload.results || [];
        let html = `<div class="synapse-transparency-section__title">📚 Sources consultées</div>`;
        if (results.length > 0) {
            html += results.map((r, i) => `
                <div class="synapse-rag-item synapse-tp-clickable" data-rag-index="${i}">
                    <div class="synapse-rag-item__source">${escapeHtml(r.source)}</div>
                    <div class="synapse-rag-item__preview">${escapeHtml(r.content_preview)}</div>
                    <div class="synapse-rag-item__score">Score : ${(r.score * 100).toFixed(0)}%</div>
                </div>
            `).join('');
            html += `<div class="synapse-rag-item__tokens">${payload.tokenEstimate || 0} tokens injectés</div>`;
        }
        section.innerHTML = html;

        // Click handlers for each RAG item
        results.forEach((r, i) => {
            section.querySelector(`[data-rag-index="${i}"]`)?.addEventListener('click', () => {
                this._showDetailPopup(`📚 ${r.source}`, r.content_preview);
            });
        });
    }

    // ── Memory Recalled ─────────────────────────────────────────────────────

    renderMemoryRecalled(payload) {
        const section = this._getSection('memory');
        if (!section) return;

        const memories = payload.memories || [];
        let html = `<div class="synapse-transparency-section__title">🧠 Mémoire rappelée</div>`;
        if (memories.length > 0) {
            html += memories.map((m, i) => `
                <div class="synapse-tp-memory synapse-tp-clickable" data-mem-index="${i}">
                    <div class="synapse-tp-memory__content">${escapeHtml(m.content_preview)}</div>
                    <div class="synapse-tp-memory__score">Score : ${(m.score * 100).toFixed(0)}%</div>
                </div>
            `).join('');
        }
        section.innerHTML = html;

        // Click handlers
        memories.forEach((m, i) => {
            section.querySelector(`[data-mem-index="${i}"]`)?.addEventListener('click', () => {
                this._showDetailPopup('🧠 Mémoire', m.content_preview);
            });
        });
    }

    // ── Usage Update ────────────────────────────────────────────────────────

    renderUsageUpdate(payload) {
        const footer = this._getFooter();
        if (!footer) return;

        const totalTokens = (payload.promptTokens || 0) + (payload.completionTokens || 0);
        const thinkingInfo = payload.thinkingTokens > 0 ? ` · ${payload.thinkingTokens} thinking` : '';
        const costStr = payload.cost > 0 ? (payload.cost < 0.01 ? '<0.01' : payload.cost.toFixed(3)) : '0';

        footer.innerHTML = `
            <span class="synapse-transparency-footer__model">${escapeHtml(payload.model || '')}</span>
            <span class="synapse-transparency-footer__tokens">${totalTokens} tk${thinkingInfo}</span>
            <span class="synapse-transparency-footer__cost">~${costStr}€</span>
        `;
    }

    // ── Artifacts ────────────────────────────────────────────────────────────

    renderArtifacts(payload) {
        const items = payload.items || [];
        if (items.length === 0) return;

        // Accumuler les nouveaux artefacts (éviter les doublons par uuid)
        const existingUuids = new Set(this._allArtifacts.map(a => a.uuid));
        items.forEach(att => {
            if (!existingUuids.has(att.uuid)) {
                const url = this.attachmentUrlTemplateValue.replace('ATTACHMENT_ID', att.uuid);
                this._allArtifacts.push({
                    uuid: att.uuid,
                    url: url,
                    mime_type: att.mime_type || 'application/octet-stream',
                    display_name: att.display_name || 'fichier',
                });
            }
        });

        this._renderArtifactsSection();
    }

    /**
     * Render la section artefacts à partir de this._allArtifacts.
     */
    _renderArtifactsSection() {
        const section = this._getSection('artifacts');
        if (!section) return;
        if (!this._allArtifacts || this._allArtifacts.length === 0) return;

        let html = `<div class="synapse-transparency-section__title">🖼️ Artefacts (${this._allArtifacts.length})</div>`;
        html += '<div class="synapse-artifacts-grid">';
        this._allArtifacts.forEach(att => {
            const isImage = (att.mime_type || '').startsWith('image/');
            if (isImage) {
                html += `<a href="${att.url}" target="_blank" rel="noopener" class="synapse-artifact-link">
                    <img src="${att.url}" alt="${escapeHtml(att.display_name || '')}" class="synapse-artifact-thumb" />
                </a>`;
            } else {
                html += `<a href="${att.url}" target="_blank" rel="noopener" class="synapse-artifact-link synapse-artifact-link--file">
                    📄 ${escapeHtml(att.display_name || 'fichier')}
                </a>`;
            }
        });
        html += '</div>';
        section.innerHTML = html;
        this._updateArtifactsButton();
    }

    /**
     * Ouvre le panneau de transparence pour afficher uniquement les artefacts.
     */
    showArtifacts() {
        if (!this._allArtifacts || this._allArtifacts.length === 0) return;
        this._ensureTransparencyPanel();
        this._renderArtifactsSection();
    }

    /**
     * Affiche/masque le bouton artefacts dans la top bar et met à jour le compteur.
     */
    _updateArtifactsButton() {
        if (!this.hasArtifactsBtnTarget) return;
        const count = this._allArtifacts ? this._allArtifacts.length : 0;
        if (count > 0) {
            this.artifactsBtnTarget.classList.remove('synapse-hidden');
            if (this.hasArtifactsCountTarget) {
                this.artifactsCountTarget.textContent = count;
            }
        } else {
            this.artifactsBtnTarget.classList.add('synapse-hidden');
        }
    }

    // ── Workflow Steps (compatibilité) ──────────────────────────────────────

    renderWorkflowStepStarted(payload) {
        const container = this._getSection('workflow');
        if (!container) return;

        // Ensure section title
        if (!container.querySelector('.synapse-transparency-section__title')) {
            container.innerHTML = '<div class="synapse-transparency-section__title">🔄 Pipeline workflow</div>';
        }

        const stepNum = payload.stepIndex + 1;
        const total = payload.totalSteps;

        const stepEl = document.createElement('div');
        stepEl.className = 'synapse-workflow-step synapse-workflow-step--appear synapse-workflow-step--thinking';
        stepEl.setAttribute('data-step-index', payload.stepIndex);
        stepEl.innerHTML = `
            <div class="synapse-workflow-step__header">
                <span class="synapse-workflow-step__badge">${stepNum}/${total}</span>
                <span class="synapse-workflow-step__name">${escapeHtml(payload.stepName)}</span>
                <span class="synapse-workflow-step__agent">${escapeHtml(payload.agentName)}</span>
            </div>
            <div class="synapse-workflow-step__answer synapse-workflow-step__answer--thinking">
                <span class="synapse-workflow-step__spinner"></span>
                Réflexion en cours…
            </div>
        `;
        container.appendChild(stepEl);

        requestAnimationFrame(() => stepEl.classList.add('synapse-workflow-step--visible'));
        this.asideTarget.scrollTop = this.asideTarget.scrollHeight;
    }

    renderWorkflowStepCompleted(payload) {
        const container = this._getSection('workflow');
        if (!container) return;

        // Ensure section title
        if (!container.querySelector('.synapse-transparency-section__title')) {
            container.innerHTML = '<div class="synapse-transparency-section__title">🔄 Pipeline workflow</div>';
        }

        const tokens = payload.usage?.total_tokens ?? 0;
        const fullAnswer = payload.answer || '';
        let answerPreview = fullAnswer;
        if (answerPreview.length > 120) {
            answerPreview = answerPreview.substring(0, 120) + '…';
        }

        // Retrouver le step "thinking" existant par son index
        const existingStep = container.querySelector(`[data-step-index="${payload.stepIndex}"]`);
        if (existingStep) {
            existingStep.classList.remove('synapse-workflow-step--thinking');
            existingStep.classList.add('synapse-workflow-step--done');
            if (fullAnswer) existingStep.classList.add('synapse-tp-clickable');
            const answerEl = existingStep.querySelector('.synapse-workflow-step__answer');
            if (answerEl) {
                answerEl.classList.remove('synapse-workflow-step__answer--thinking');
                answerEl.innerHTML = escapeHtml(answerPreview);
            }
            if (tokens > 0) {
                const tokensEl = document.createElement('div');
                tokensEl.className = 'synapse-workflow-step__tokens';
                tokensEl.textContent = `${tokens} tokens`;
                existingStep.appendChild(tokensEl);
            }
            if (fullAnswer) {
                existingStep.addEventListener('click', () => {
                    this._showDetailPopup(`${payload.stepName} (${payload.agentName})`, fullAnswer);
                });
            }
        } else {
            const stepNum = payload.stepIndex + 1;
            const total = payload.totalSteps;
            const stepEl = document.createElement('div');
            stepEl.className = `synapse-workflow-step synapse-workflow-step--appear synapse-workflow-step--done${fullAnswer ? ' synapse-tp-clickable' : ''}`;
            stepEl.setAttribute('data-step-index', payload.stepIndex);
            stepEl.innerHTML = `
                <div class="synapse-workflow-step__header">
                    <span class="synapse-workflow-step__badge">${stepNum}/${total}</span>
                    <span class="synapse-workflow-step__name">${escapeHtml(payload.stepName)}</span>
                    <span class="synapse-workflow-step__agent">${escapeHtml(payload.agentName)}</span>
                </div>
                <div class="synapse-workflow-step__answer">${escapeHtml(answerPreview)}</div>
                ${tokens > 0 ? `<div class="synapse-workflow-step__tokens">${tokens} tokens</div>` : ''}
            `;
            container.appendChild(stepEl);
            requestAnimationFrame(() => stepEl.classList.add('synapse-workflow-step--visible'));
            if (fullAnswer) {
                stepEl.addEventListener('click', () => {
                    this._showDetailPopup(`${payload.stepName} (${payload.agentName})`, fullAnswer);
                });
            }
        }

        this.asideTarget.scrollTop = this.asideTarget.scrollHeight;
    }

}

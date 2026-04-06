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

        // Passage du mode Accueil (Welcome) au mode Chat Actif
        this.element.classList.remove('synapse-chat-mode-welcome');
        this.element.classList.add('synapse-chat-mode-active');
        if (this.hasGreetingTarget) this.greetingTarget.classList.add('synapse-hidden');

        // Ajouter message utilisateur (avec preview pièces jointes éventuelles)
        const filesToSend = [...this.pendingFiles];
        this.addMessage(message, 'user', { attachments: filesToSend });

        // Reset l'input et les pièces jointes
        this.inputTarget.value = '';
        this.inputTarget.style.height = 'auto';
        this.clearPendingFiles();
        this.setLoading(true);
        this.pendingMemoryProposal = null;
        this.clearWorkflowSteps();

        const tone = this.hasToneInputTarget ? this.toneInputTarget.value : null;
        const agent = this.hasAgentInputTarget ? this.agentInputTarget.value : null;
        const csrfToken = await this.ensureCsrfToken();
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

        try {
            const payload = {
                message: message,
                conversation_id: this.currentConversationIdValue,
                options: { tone: tone, ...(agent ? { agent: agent } : {}) },
                debug: this.isDebugMode
            };
            if (filesToSend.length > 0) {
                payload.attachments = filesToSend.map(f => ({ mime_type: f.mime_type, data: f.data, name: f.name }));
            }

            const response = await fetch(this.chatUrlValue || '/synapse/api/chat', {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                let msg = `Erreur serveur (${response.status}).`;
                if (response.status === 401) msg = 'Session expirée. Rechargez la page.';
                throw new Error(msg);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let currentResponseText = '';
            let currentMessageBubble = null;
            let streamErrorMessage = null;
            let receivedResult = false;

            // Timeout sécurité adaptatif
            let timeoutId = null;
            const resetTimeout = () => {
                if (timeoutId) clearTimeout(timeoutId);
                timeoutId = setTimeout(() => {
                    if (!receivedResult) {
                        reader.cancel();
                        this.setLoading(false);
                        this.addMessage('⏱️ Le serveur ne répond plus (Timeout).', 'assistant');
                    }
                }, 30000); // 30s de silence avant timeout
            };

            resetTimeout();

            try {
                streamLoop: while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    resetTimeout(); // On a reçu de la donnée, on repousse le timeout

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // Garder ligne incomplète

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (!trimmedLine.startsWith('{')) continue; // Ignorer le non-JSON

                        try {
                            const evt = JSON.parse(trimmedLine);
                            if (!evt || typeof evt !== 'object' || !evt.type) continue;

                            if (evt.type === 'delta') {
                                if (!currentMessageBubble) {
                                    this.setLoading(false);
                                    this.addMessage('', 'assistant'); // Crée le conteneur vide
                                    const messages = this.messagesTarget.querySelectorAll('.synapse-chat-message--assistant');
                                    currentMessageBubble = messages[messages.length - 1].querySelector('.synapse-chat-bubble');
                                }
                                if (evt.payload && evt.payload.text) {
                                    currentResponseText += evt.payload.text;
                                    currentMessageBubble.innerHTML = this.parseMarkdown(currentResponseText);
                                    this.scrollToBottom();
                                }
                            } else if (evt.type === 'result') {
                                receivedResult = true;
                                if (timeoutId) clearTimeout(timeoutId);
                                this.setLoading(false);

                                if (evt.payload?.conversation_id) {
                                    this.updateUrlConversation(evt.payload.conversation_id);
                                }

                                if (currentMessageBubble && evt.payload?.answer) {
                                    currentMessageBubble.innerHTML = this.parseMarkdown(evt.payload.answer);
                                    if (this.debugValue && evt.payload?.debug_id) {
                                        this.addDebugButtonToMessage(currentMessageBubble.closest('.synapse-chat-message'), evt.payload.debug_id);
                                    }
                                } else if (!currentMessageBubble && (evt.payload?.answer || evt.payload?.generated_attachments?.length > 0)) {
                                    // Pas de streaming (image-only ou réponse directe) : créer le bubble
                                    const displayText = evt.payload?.answer && evt.payload.answer !== '[image]' ? evt.payload.answer : '';
                                    this.addMessage(displayText, 'assistant', { debug_id: evt.payload.debug_id });
                                    const messages = this.messagesTarget.querySelectorAll('.synapse-chat-message--assistant');
                                    currentMessageBubble = messages[messages.length - 1].querySelector('.synapse-chat-bubble');
                                }

                                // Afficher les images générées par le LLM
                                if (currentMessageBubble && evt.payload?.generated_attachments?.length > 0) {
                                    const imagesHtml = '<div class="synapse-chat-message-attachments">' +
                                        evt.payload.generated_attachments.map(att => {
                                            const url = this.attachmentUrlTemplateValue.replace('ATTACHMENT_ID', att.uuid);
                                            return this._renderAttachmentBadge(att.mime_type || 'image/png', url, att.display_name);
                                        }).join('') +
                                        '</div>';
                                    currentMessageBubble.insertAdjacentHTML('afterbegin', imagesHtml);
                                }

                            } else if (evt.type === 'status' && evt.payload?.message) {
                                this.updateLoadingText(evt.payload.message);
                            } else if (evt.type === 'title') {
                                // Titre auto-généré reçu
                                if (evt.payload?.title) {
                                    this.updateSidebarConversationTitle(this.currentConversationIdValue, evt.payload.title);
                                    if (this.hasConversationTitleTarget) {
                                        this.conversationTitleTarget.textContent = evt.payload.title;
                                    }
                                }
                            } else if (evt.type === 'error') {
                                streamErrorMessage = typeof evt.payload === 'string' ? evt.payload : (evt.payload?.message || "Erreur interne.");
                                receivedResult = true;
                                if (timeoutId) clearTimeout(timeoutId);
                                break streamLoop;
                            } else if (evt.type === 'workflow_step_started') {
                                this.renderWorkflowStepStarted(evt.payload);
                            } else if (evt.type === 'workflow_step') {
                                this.renderWorkflowStepCompleted(evt.payload);
                            } else if (evt.type === 'tool_executed') {
                                if (evt.payload?.tool === 'propose_to_remember' && evt.payload?.proposal) {
                                    this.pendingMemoryProposal = {
                                        proposal: evt.payload.proposal,
                                        conversationId: evt.payload.conversation_id || this.currentConversationIdValue
                                    };
                                }
                            }
                        } catch (e) { /* Ligne partielle, on ignore silencieusement */ }
                    }
                } // End Stream loop

                if (streamErrorMessage) {
                    this.setLoading(false);
                    this.addMessage('❌ ' + streamErrorMessage, 'assistant');
                } else if (!receivedResult && currentResponseText === '') {
                    this.setLoading(false);
                    this.addMessage('⚠️ Réponse vide du serveur.', 'assistant');
                }

                // Afficher l'encart de mémorisation à la fin du message principal pour plus de cohérence
                if (this.pendingMemoryProposal) {
                    this.showMemoryProposal(this.pendingMemoryProposal.proposal, this.pendingMemoryProposal.conversationId);
                    this.pendingMemoryProposal = null;
                }
            } finally {
                clearTimeout(timeoutId);
            }

        } catch (error) {
            this.setLoading(false);
            this.addMessage('❌ ' + error.message, 'assistant');
            console.error('Erreur API Chat:', error);
        } finally {
            this.setLoading(false);
            this.inputTarget.focus();
        }
    }

    /* ── Gestion des pièces jointes (images, PDF, etc.) ─────────────────── */

    attachFile() {
        if (this.hasFileInputTarget) {
            this.fileInputTarget.click();
        }
    }

    /** @deprecated Utiliser attachFile() */
    attachImage() {
        this.attachFile();
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

    /** @deprecated Utiliser removeFile() */
    removeImage(event) {
        this.removeFile(event);
    }

    clearPendingFiles() {
        this.pendingFiles = [];
        this.renderFilePreview();
    }

    /** @deprecated Utiliser clearPendingFiles() */
    clearPendingImages() {
        this.clearPendingFiles();
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

        this.messagesTarget.insertAdjacentHTML('beforeend', html);
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

    toggleToneMenu(event) {
        if (event) event.stopPropagation();
        if (this.hasToneMenuTarget) {
            this.toneMenuTarget.classList.toggle('synapse-hidden');
            this.toneTriggerTarget.classList.toggle('is-open');
        }
    }

    selectTone(event) {
        const { toneKey, toneName, toneEmoji } = event.currentTarget.dataset;

        // Mise à jour de l'UI du trigger
        if (this.hasCurrentToneEmojiTarget) this.currentToneEmojiTarget.textContent = toneEmoji;
        if (this.hasCurrentToneNameTarget) this.currentToneNameTarget.textContent = toneName;
        if (this.hasToneInputTarget) this.toneInputTarget.value = toneKey;

        // Mise à jour de l'état "active" dans le menu
        if (this.hasToneMenuTarget) {
            this.toneMenuTarget.querySelectorAll('.synapse-chat-tone-option').forEach(opt => {
                opt.classList.toggle('active', opt.dataset.toneKey === toneKey);
            });
        }

        // Sauvegarde persistante
        this.savePersistentTone(toneKey, toneName, toneEmoji);

        // Fermer le menu
        this.toggleToneMenu();
    }

    closeToneMenuOutside(event) {
        if (!this.hasTonePickerTarget) return;
        if (!this.tonePickerTarget.contains(event.target)) {
            if (this.hasToneMenuTarget && !this.toneMenuTarget.classList.contains('synapse-hidden')) {
                this.toggleToneMenu();
            }
        }
    }

    savePersistentTone(key, name, emoji) {
        localStorage.setItem('synapse_chat_tone', JSON.stringify({ key, name, emoji }));
    }

    loadPersistentTone() {
        const saved = localStorage.getItem('synapse_chat_tone');
        if (saved) {
            try {
                const { key, name, emoji } = JSON.parse(saved);
                if (this.hasCurrentToneEmojiTarget) this.currentToneEmojiTarget.textContent = emoji;
                if (this.hasCurrentToneNameTarget) this.currentToneNameTarget.textContent = name;
                if (this.hasToneInputTarget) this.toneInputTarget.value = key;

                if (this.hasToneMenuTarget) {
                    this.toneMenuTarget.querySelectorAll('.synapse-chat-tone-option').forEach(opt => {
                        opt.classList.toggle('active', opt.dataset.toneKey === key);
                    });
                }
            } catch (e) {
                console.error('Erreur lors du chargement du ton persistant', e);
            }
        }
    }

    /* ── 4.6. SÉLECTEUR D'AGENTS ────────────────────────────────────────────── */

    toggleAgentMenu(event) {
        if (event) event.stopPropagation();
        if (this.hasAgentMenuTarget) {
            this.agentMenuTarget.classList.toggle('synapse-hidden');
            this.agentTriggerTarget.classList.toggle('is-open');
        }
    }

    selectAgent(event) {
        const { agentKey, agentName, agentEmoji } = event.currentTarget.dataset;

        if (this.hasCurrentAgentEmojiTarget) this.currentAgentEmojiTarget.textContent = agentEmoji;
        if (this.hasCurrentAgentNameTarget) this.currentAgentNameTarget.textContent = agentName;
        if (this.hasAgentInputTarget) this.agentInputTarget.value = agentKey;

        if (this.hasAgentMenuTarget) {
            this.agentMenuTarget.querySelectorAll('.synapse-chat-tone-option').forEach(opt => {
                opt.classList.toggle('active', opt.dataset.agentKey === agentKey);
            });
        }

        // Sauvegarde persistante
        this.savePersistentAgent(agentKey, agentName, agentEmoji);

        this.toggleAgentMenu();
    }

    closeAgentMenuOutside(event) {
        if (!this.hasAgentPickerTarget) return;
        if (!this.agentPickerTarget.contains(event.target)) {
            if (this.hasAgentMenuTarget && !this.agentMenuTarget.classList.contains('synapse-hidden')) {
                this.toggleAgentMenu();
            }
        }
    }

    savePersistentAgent(key, name, emoji) {
        localStorage.setItem('synapse_chat_agent', JSON.stringify({ key, name, emoji }));
    }

    loadPersistentAgent() {
        const saved = localStorage.getItem('synapse_chat_agent');
        if (saved) {
            try {
                const { key, name, emoji } = JSON.parse(saved);
                if (this.hasCurrentAgentEmojiTarget) this.currentAgentEmojiTarget.textContent = emoji;
                if (this.hasCurrentAgentNameTarget) this.currentAgentNameTarget.textContent = name;
                if (this.hasAgentInputTarget) this.agentInputTarget.value = key;

                if (this.hasAgentMenuTarget) {
                    this.agentMenuTarget.querySelectorAll('.synapse-chat-tone-option').forEach(opt => {
                        opt.classList.toggle('active', opt.dataset.agentKey === key);
                    });
                }
            } catch (e) {
                console.error('Erreur lors du chargement de l\'agent persistant', e);
            }
        }
    }

    /* ── 5. UTILITAIRES & MARKDOWN ─────────────────────────────────────────── */

    scrollToBottom() {
        const scrollContainer = this.element.querySelector('.synapse-chat-main');
        if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
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

    // ── Workflow Sidebar ("Réflexion interne") ──────────────────────────────

    /**
     * Ouvre la sidebar workflow si nécessaire et retourne le container des steps.
     */
    _ensureWorkflowAside() {
        if (!this.hasAsideTarget) return null;

        const aside = this.asideTarget;

        if (!aside.classList.contains('synapse-chat-aside--open')) {
            aside.classList.add('synapse-chat-aside--open');
            aside.innerHTML = `
                <div class="synapse-workflow-header">
                    <div class="synapse-workflow-header__icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/><path d="M12 6v6l4 2"/></svg>
                    </div>
                    <span class="synapse-workflow-header__title">Réflexion interne</span>
                    <button type="button" class="synapse-workflow-header__close" aria-label="Fermer">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                    </button>
                </div>
                <div class="synapse-workflow-steps"></div>
            `;
            aside.querySelector('.synapse-workflow-header__close')?.addEventListener('click', () => {
                this.clearWorkflowSteps();
            });
        }

        return aside.querySelector('.synapse-workflow-steps');
    }

    /**
     * Affiche un step en état "réflexion en cours" dès que le backend commence à l'exécuter.
     */
    renderWorkflowStepStarted(payload) {
        const container = this._ensureWorkflowAside();
        if (!container) return;

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

    /**
     * Met à jour un step existant avec la réponse finale (remplace le spinner).
     */
    renderWorkflowStepCompleted(payload) {
        const container = this._ensureWorkflowAside();
        if (!container) return;

        const tokens = payload.usage?.total_tokens ?? 0;

        let answerPreview = payload.answer || '';
        if (answerPreview.length > 200) {
            answerPreview = answerPreview.substring(0, 200) + '…';
        }

        // Retrouver le step "thinking" existant par son index
        const existingStep = container.querySelector(`[data-step-index="${payload.stepIndex}"]`);
        if (existingStep) {
            existingStep.classList.remove('synapse-workflow-step--thinking');
            existingStep.classList.add('synapse-workflow-step--done');
            const answerEl = existingStep.querySelector('.synapse-workflow-step__answer');
            if (answerEl) {
                answerEl.classList.remove('synapse-workflow-step__answer--thinking');
                answerEl.innerHTML = escapeHtml(answerPreview);
            }
            // Ajouter les tokens
            if (tokens > 0) {
                const tokensEl = document.createElement('div');
                tokensEl.className = 'synapse-workflow-step__tokens';
                tokensEl.textContent = `${tokens} tokens`;
                existingStep.appendChild(tokensEl);
            }
        } else {
            // Fallback : si le step_started n'a pas été reçu, créer le bloc complet
            const stepNum = payload.stepIndex + 1;
            const total = payload.totalSteps;
            const stepEl = document.createElement('div');
            stepEl.className = 'synapse-workflow-step synapse-workflow-step--appear synapse-workflow-step--done';
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
        }

        this.asideTarget.scrollTop = this.asideTarget.scrollHeight;
    }

    clearWorkflowSteps() {
        if (!this.hasAsideTarget) return;
        this.asideTarget.classList.remove('synapse-chat-aside--open');
        this.asideTarget.innerHTML = '';
    }

}

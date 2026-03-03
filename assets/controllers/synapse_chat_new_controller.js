import { Controller } from '@hotwired/stimulus';

/**
 * Synapse Chat Controller V2 (Minimalist Organic)
 *
 * Gère l'UI du chat (streaming NDJSON) ET la liste des conversations (historique).
 * Remplace l'ancienne séparation `synapse_chat_controller` / `synapse_sidebar_controller`.
 */
export default class extends Controller {
    static targets = [
        // Zone Chat Principal
        'messages', 'input', 'submitBtn', 'toneSelect', 'greeting',
        // Zone Sidebar
        'sidebar', 'sidebarOverlay', 'conversationsList', 'conversationsEmpty'
    ];

    static values = {
        chatUrl: String,
        resetUrl: String,
        csrfUrl: String,
        memoryConfirmUrl: String,
        memoryRejectUrl: String,
        conversationsUrl: String,
        debugUrlTemplate: String,
        currentConversationId: String,
        debug: { type: Boolean, default: false }
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

        const urlParams = new URLSearchParams(window.location.search);
        this.isDebugMode = urlParams.has('debug') || this.debugValue;

        // Charger Markdown (Asynchrone)
        this.loadMarked();

        // Charger la liste des conversations (Sidebar)
        this.loadConversations();
    }

    disconnect() {
        if (this.hasInputTarget) {
            this.inputTarget.removeEventListener('keydown', this.onKeydown);
            this.inputTarget.removeEventListener('input', this.onInput);
        }
    }

    /* ── 1. GESTION DE LA SIDEBAR (MOBILE & LAYOUTS CONTRAINTS) ────── */

    toggleSidebar() {
        if (!this.hasSidebarTarget) return;
        this.sidebarTarget.classList.toggle('is-open');
        if (this.hasSidebarOverlayTarget) {
            this.sidebarOverlayTarget.classList.toggle('is-visible');
        }
    }

    closeSidebar() {
        if (!this.hasSidebarTarget) return;
        this.sidebarTarget.classList.remove('is-open');
        if (this.hasSidebarOverlayTarget) {
            this.sidebarOverlayTarget.classList.remove('is-visible');
        }
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
                    <div class="synapse-chat-conv-item__title" data-title-target="true">${this.escapeHtml(conv.title || 'Nouvelle conversation')}</div>
                    <div class="synapse-chat-conv-item__meta">
                        <span>${this.formatDate(conv.updated_at)}</span>
                    </div>
                    
                    <div class="synapse-chat-conv-actions">
                        <button type="button" class="synapse-chat-conv-btn" data-action="click->${this.identifier}#startRename:stop" aria-label="Renommer">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        </button>
                        <button type="button" class="synapse-chat-conv-btn is-danger" data-action="click->${this.identifier}#deleteConversation:stop" aria-label="Supprimer">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        if (this.hasConversationsListTarget) {
            this.conversationsListTarget.innerHTML = html;
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
        if (!message) return;

        // Passage du mode Accueil (Welcome) au mode Chat Actif
        this.element.classList.remove('synapse-chat-mode-welcome');
        this.element.classList.add('synapse-chat-mode-active');
        if (this.hasGreetingTarget) this.greetingTarget.classList.add('synapse-hidden');

        // Ajouter message utilisateur
        this.addMessage(message, 'user');

        // Reset l'input
        this.inputTarget.value = '';
        this.inputTarget.style.height = 'auto';
        this.setLoading(true);

        const tone = this.hasToneSelectTarget ? this.toneSelectTarget.value : null;
        const csrfToken = await this.ensureCsrfToken();
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

        try {
            const payload = {
                message: message,
                conversation_id: this.currentConversationIdValue,
                options: { tone: tone },
                debug: this.isDebugMode
            };

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

            // Timeout sécurité (30s)
            const streamTimeout = setTimeout(() => {
                reader.cancel();
                this.setLoading(false);
                this.addMessage('⏱️ Le serveur met trop de temps à répondre.', 'assistant');
            }, 30000);

            try {
                streamLoop: while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

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
                                this.setLoading(false);

                                if (evt.payload?.conversation_id) {
                                    this.updateUrlConversation(evt.payload.conversation_id);
                                }

                                if (currentMessageBubble && evt.payload?.answer) {
                                    currentMessageBubble.innerHTML = this.parseMarkdown(evt.payload.answer);
                                } else if (evt.payload?.answer && !currentResponseText) {
                                    this.addMessage(evt.payload.answer, 'assistant');
                                }

                            } else if (evt.type === 'status' && evt.payload?.message) {
                                // Update loading text if needed
                            } else if (evt.type === 'title') {
                                // Titre auto-généré reçu
                                if (evt.payload?.title) {
                                    this.updateSidebarConversationTitle(this.currentConversationIdValue, evt.payload.title);
                                }
                            } else if (evt.type === 'error') {
                                streamErrorMessage = typeof evt.payload === 'string' ? evt.payload : (evt.payload?.message || "Erreur interne.");
                                receivedResult = true;
                                break streamLoop;
                            } else if (evt.type === 'tool_executed') {
                                if (evt.payload?.tool === 'propose_to_remember' && evt.payload?.proposal) {
                                    this.showMemoryProposal(evt.payload.proposal, evt.payload.conversation_id || this.currentConversationIdValue);
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
            } finally {
                clearTimeout(streamTimeout);
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

    addMessage(text, role) {
        const formattedText = this.parseMarkdown(text);

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

        const html = `
            <div class="synapse-chat-message synapse-chat-message--${role}">
                ${avatarContent}
                <div class="synapse-chat-message__content">
                    <div class="synapse-chat-bubble">${formattedText}</div>
                </div>
            </div>
        `;

        this.messagesTarget.insertAdjacentHTML('beforeend', html);
        this.scrollToBottom();
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
                        <span class="synapse-chat-memory-encart__fact">${this.escapeHtml(fact)}</span>
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
            try { await fetch(this.memoryRejectUrlValue || '/synapse/api/memory/reject', { method: 'POST', headers: { 'X-CSRF-Token': await this.ensureCsrfToken() } }); } catch (e) { }
        });

        const confirmFunc = async (scope) => {
            try {
                await fetch(this.memoryConfirmUrlValue || '/synapse/api/memory/confirm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await this.ensureCsrfToken() },
                    body: JSON.stringify({ fact: fact, category: proposal.category || 'other', scope, conversation_id: conversationId })
                });
                encart.classList.add('synapse-chat-memory-encart--success');
                encart.innerHTML = `✅ Sauvegardé dans la mémoire (${scope === 'user' ? 'Générale' : 'Discussion courante'}).`;
                setTimeout(() => { lastMsg.remove(); }, 3000);
            } catch (e) { console.error('Erreur mémoire', e); }
        };

        encart.querySelector('[data-action-type="confirm-conv"]').addEventListener('click', () => confirmFunc('conversation'));
        encart.querySelector('[data-action-type="confirm-user"]').addEventListener('click', () => confirmFunc('user'));
    }

    /* ── 5. UTILITAIRES & MARKDOWN ─────────────────────────────────────────── */

    scrollToBottom() {
        if (this.hasMessagesTarget) {
            this.messagesTarget.scrollTop = this.messagesTarget.scrollHeight;
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

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatDate(dateString) {
        const date = new Date(dateString);
        const diff = Date.now() - date;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        if (days === 0) return 'Aujourd\'hui';
        if (days === 1) return 'Hier';
        if (days < 7) return `Il y a ${days} j`;
        return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
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
}

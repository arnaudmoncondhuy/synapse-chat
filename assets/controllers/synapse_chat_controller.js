import { Controller } from '@hotwired/stimulus';

/**
 * Synapse Chat Controller (v2 - Refactored)
 *
 * Handles the chat UI: sending messages, receiving streaming responses,
 * rendering markdown, and displaying thinking/debug blocks.
 *
 * Agnostic: No hardcoded texts (uses data-defaults or attributes).
 */
export default class extends Controller {
    static targets = ['messages', 'input', 'submitBtn', 'personaSelect', 'container', 'greeting'];
    static values = {
        history: Array,
        debug: { type: Boolean, default: false },
        welcomeMessage: { type: String, default: '' } // Allow overriding "New Conversation" toast
    };

    connect() {
        this.scrollToBottom();
        this.historyLoaded = false;
        this.inputTarget.focus();

        // Bind methods for manual event listeners
        this.onKeydown = this.handleKeydown.bind(this);
        this.onInput = this.autoResize.bind(this);

        // Manual event listeners to avoid Stimulus debug logs on every keystroke
        if (this.hasInputTarget) {
            this.inputTarget.addEventListener('keydown', this.onKeydown);
            this.inputTarget.addEventListener('input', this.onInput);
        }

        // Check for debug mode in URL
        const urlParams = new URLSearchParams(window.location.search);
        this.isDebugMode = urlParams.has('debug') || this.debugValue;

        if (this.isDebugMode) {
            this.element.classList.add('synapse-chat--debug-mode');
        }

        // Load marked async (for streaming)
        this.loadMarked();
    }

    disconnect() {
        if (this.hasInputTarget) {
            this.inputTarget.removeEventListener('keydown', this.onKeydown);
            this.inputTarget.removeEventListener('input', this.onInput);
        }
    }

    /**
     * Token CSRF : d'abord DOM (meta ou data-csrf-token), sinon cache après fetch.
     */
    getCsrfToken() {
        const fromMeta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
        if (fromMeta) return fromMeta;
        const fromData = this.element?.dataset?.csrfToken ?? '';
        if (fromData) return fromData;
        return this._csrfToken ?? '';
    }

    /**
     * Garantit d'avoir un token CSRF : lit le DOM, sinon fetch GET /synapse/api/csrf-token.
     * À appeler avant toute requête POST vers l'API.
     */
    async ensureCsrfToken() {
        if (this.getCsrfToken()) return this.getCsrfToken();
        try {
            const r = await fetch('/synapse/api/csrf-token', { credentials: 'same-origin' });
            if (!r.ok) return '';
            const data = await r.json();
            const token = data?.token ?? '';
            if (token) this._csrfToken = token;
            return token;
        } catch {
            return '';
        }
    }

    // History is now rendered server-side via Twig
    loadHistory(history) {
        this.scrollToBottom();
    }

    handleKeydown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.send(event);
        }
    }

    async send(event) {
        event.preventDefault();

        const message = this.inputTarget.value.trim();
        if (!message) return;

        // Switch UI to chat mode immediately
        if (this.hasContainerTarget) {
            this.containerTarget.classList.remove('mode-welcome');
            this.containerTarget.classList.add('mode-chat');
        }
        if (this.hasGreetingTarget) {
            this.greetingTarget.classList.add('hidden');
        }

        this.addMessage(message, 'user');
        this.inputTarget.value = '';
        this.inputTarget.style.height = 'auto';
        this.setLoading(true);

        // Get Persona
        let persona = null;
        if (this.hasPersonaSelectTarget) {
            persona = this.personaSelectTarget.value;
        }

        // Get current conversation ID from URL
        const urlParams = new URLSearchParams(window.location.search);
        const conversationId = urlParams.get('conversation');

        const csrfToken = await this.ensureCsrfToken();
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

        try {
            const response = await fetch('/synapse/api/chat', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    message: message,
                    conversation_id: conversationId,
                    options: { persona: persona },
                    debug: this.isDebugMode
                })
            });

            if (!response.ok) {
                const status = response.status;
                let msg = `Erreur serveur (${status}). Réessayez.`;
                if (status === 401 || status === 403) {
                    msg = 'Session expirée ou accès refusé. Rechargez la page et réessayez.';
                } else if (status === 405) {
                    msg = 'Requête incorrecte (méthode non autorisée). Rechargez la page.';
                } else {
                    try {
                        const body = await response.text();
                        const parsed = body.length < 2000 && body.startsWith('{') ? JSON.parse(body) : null;
                        if (parsed?.error || parsed?.message) msg += ' ' + (parsed.error || parsed.message);
                        else if (body.includes('Exception') && body.length < 500) msg += ' ' + body.substring(0, 200);
                    } catch (_) { /* ignore */ }
                }
                throw new Error(msg);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let currentResponseText = '';
            let currentMessageBubble = null;
            let receivedResultOrError = false;
            let streamErrorMessage = null;

            // Safety timeout (30 seconds)
            const streamTimeout = setTimeout(() => {
                reader.cancel();
                this.setLoading(false);
                this.addMessage('⏱️ Timeout: Le serveur ne répond plus. Veuillez réessayer.', 'assistant');
                console.error('🔴 [Stream] Timeout after 30 seconds');
            }, 30000);

            try {

                streamLoop: while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (!line.trim()) continue;

                        const trimmedLine = line.trim();
                        // Ne parser que les lignes NDJSON attendues (objet avec type/payload). Ignorer le CSS/HTML injecté (ex. [data-filters] { ... })
                        if (!trimmedLine.startsWith('{')) {
                            continue;
                        }

                        try {
                            const evt = JSON.parse(trimmedLine);

                            // Validate event structure
                            if (!evt || typeof evt !== 'object' || !evt.type) {
                                console.warn('⚠️ [Stream] Invalid event structure:', evt);
                                continue;
                            }

                            if (evt.type === 'status') {
                                if (evt.payload && evt.payload.message) {
                                    this.updateLoadingStatus(evt.payload.message);
                                }
                            } else if (evt.type === 'delta') {
                                // First token received: stop loading animation
                                if (!currentMessageBubble) {
                                    this.setLoading(false);
                                    // Create the message bubble container manually to hold the stream
                                    this.addMessage('', 'assistant');
                                    const messages = this.messagesTarget.querySelectorAll('.synapse-chat__message--assistant');
                                    const lastMsg = messages[messages.length - 1];
                                    currentMessageBubble = lastMsg.querySelector('.synapse-chat__bubble');
                                }

                                if (evt.payload && evt.payload.text) {
                                    currentResponseText += evt.payload.text;
                                    currentMessageBubble.innerHTML = this.parseMarkdown(currentResponseText);
                                    this.scrollToBottom();
                                }

                            } else if (evt.type === 'tool_executed') {
                                // Événement immédiat quand un outil est exécuté
                                if (evt.payload?.tool === 'propose_to_remember' && evt.payload?.proposal) {
                                    this.showMemoryProposal(evt.payload.proposal, evt.payload.conversation_id ?? null, true);
                                }

                            } else if (evt.type === 'result') {
                                receivedResultOrError = true;
                                this.setLoading(false);

                                if (evt.payload?.conversation_id) {
                                    this.updateUrlWithConversationId(evt.payload.conversation_id);
                                }

                                // If we streamed text, ensure final consistency (sometimes helpful for incomplete markdown)
                                if (currentMessageBubble && evt.payload && evt.payload.answer) {
                                    currentMessageBubble.innerHTML = this.parseMarkdown(evt.payload.answer);
                                    // Add debug footer if needed
                                    if (evt.payload.conversation_id) {
                                        this.updateUrlWithConversationId(evt.payload.conversation_id);
                                    }

                                    // Re-inject debug button if in debug mode
                                    if (this.isDebugMode && evt.payload.debug_id) {
                                        const debugUrl = `/synapse/_debug/${evt.payload.debug_id}`;
                                        const debugHtml = `
                                        <button type="button" class="synapse-chat__debug-trigger"
                                                onclick="window.open('${debugUrl}', '_blank')"
                                                title="Debug">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                                        </button>
                                    `;
                                        // wrapper footer
                                        const footer = document.createElement('div');
                                        footer.className = 'synapse-chat__footer';
                                        footer.innerHTML = debugHtml;

                                        // Find parent .synapse-chat__content and append footer
                                        currentMessageBubble.closest('.synapse-chat__content').appendChild(footer);
                                    }
                                } else if (evt.payload && evt.payload.answer) {
                                    // Fallback if no delta was received (e.g. empty response or error handled as result)
                                    this.addMessage(evt.payload.answer, 'assistant', evt.payload);
                                }

                            } else if (evt.type === 'title') {
                                // Auto-generated title received
                                const conversationId = new URLSearchParams(window.location.search).get('conversation');
                                if (conversationId && evt.payload && evt.payload.title) {
                                    document.dispatchEvent(new CustomEvent('assistant:title-updated', {
                                        detail: { conversationId, title: evt.payload.title }
                                    }));
                                }
                            } else if (evt.type === 'error') {
                                receivedResultOrError = true;
                                const payload = evt.payload;
                                streamErrorMessage = typeof payload === 'string' ? payload : (payload?.message || evt.message || (payload && JSON.stringify(payload)) || 'Erreur inconnue');
                                break streamLoop;
                            } else if (evt.type === 'tool_executed') {
                                if (evt.payload?.tool === 'propose_to_remember' && evt.payload?.proposal) {
                                    this.showMemoryProposal(evt.payload.proposal, evt.payload.conversation_id ?? null, true);
                                }
                            } else {
                                console.warn('⚠️ [Stream] Unknown event type:', evt.type);
                            }
                        } catch (e) {
                            if (e instanceof SyntaxError) {
                                // Lignes non-JSON (injection toolbar/CSS, etc.) : ignorer sans polluer la console
                                const preview = trimmedLine.substring(0, 80);
                                const looksLikeInjection = /^\s*[.#\w\[\]-]+\s*\{|<\w|position:\s|cursor:\s|display:\s|content:\s|^\s*\[[\w-]+\]\s*\{/i.test(preview);
                                if (!looksLikeInjection) {
                                    console.warn('⚠️ [Stream] Invalid JSON:', trimmedLine.substring(0, 100));
                                }
                            } else {
                                console.error('🔴 [Stream] Processing error:', e);
                                // Don't throw - continue processing other events
                            }
                        }
                    }
                }

                // Dernière ligne éventuelle (sans \n final) — même logique que le flux principal pour result
                if (buffer.trim() && buffer.trim().startsWith('{')) {
                    try {
                        const evt = JSON.parse(buffer.trim());
                        if (evt?.type === 'error') {
                            receivedResultOrError = true;
                            const payload = evt.payload;
                            streamErrorMessage = typeof payload === 'string' ? payload : (payload?.message || JSON.stringify(payload) || 'Erreur inconnue');
                        }
                        if (evt?.type === 'result') {
                            receivedResultOrError = true;
                            this.setLoading(false);
                            const payload = evt.payload ?? {};
                            if (payload.conversation_id) this.updateUrlWithConversationId(payload.conversation_id);
                            if (payload.answer) {
                                if (currentMessageBubble) {
                                    currentMessageBubble.innerHTML = this.parseMarkdown(payload.answer);
                                } else {
                                    this.addMessage(payload.answer, 'assistant', payload);
                                }
                            }
                        }
                    } catch (_) { /* ignore parse error */ }
                }

                if (streamErrorMessage) {
                    this.setLoading(false);
                    this.addMessage('❌ ' + streamErrorMessage, 'assistant');
                    this.scrollToBottom();
                } else if (!receivedResultOrError) {
                    this.setLoading(false);
                    this.addMessage('Aucune réponse reçue. Vérifiez la configuration IA (modèle, clé API) et les logs serveur.', 'assistant');
                    this.scrollToBottom();
                }
            } finally {
                clearTimeout(streamTimeout);
            }

        } catch (error) {
            this.setLoading(false);
            let errMsg = error?.message ?? 'Erreur inconnue';
            if (/network|fetch|HTTP2|protocol|Failed to fetch/i.test(errMsg)) {
                errMsg = 'Connexion interrompue (réseau ou proxy). Réessayez sans ?debug=1 ou vérifiez le serveur.';
            } else {
                errMsg += ' (synapse_chat_controller.js)';
            }
            this.addMessage('❌ Erreur: ' + errMsg, 'assistant');
            console.error('🔴 [Stream] Fatal error (synapse_chat_controller.js):', error);
        } finally {
            this.setLoading(false);
            this.inputTarget.focus();
        }
    }

    updateLoadingStatus(message) {
        const loadingContent = this.messagesTarget.querySelector('#synapse-loading .synapse-chat__content');
        if (loadingContent) {
            loadingContent.innerHTML = `<span class="synapse-chat__typing-dots">${message}</span>`;
            this.scrollToBottom();
        }
    }

    autoResize(event) {
        const textarea = event ? event.target : this.inputTarget;
        textarea.style.height = 'auto';

        const maxHeight = 120;
        const newHeight = Math.min(textarea.scrollHeight, maxHeight);
        textarea.style.height = newHeight + 'px';
        textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }

    async newConversation() {
        const csrfToken = await this.ensureCsrfToken();
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

        try {
            const response = await fetch('/synapse/api/reset', {
                method: 'POST',
                headers
            });

            const data = await response.json();

            if (data.success) {
                // Clear all messages
                this.messagesTarget.querySelectorAll('.synapse-chat__message').forEach(m => m.remove());

                // Restore greeting
                if (this.hasGreetingTarget) {
                    this.greetingTarget.classList.remove('hidden');
                }

                // Restore welcome mode
                if (this.hasContainerTarget) {
                    this.containerTarget.classList.remove('mode-chat');
                    this.containerTarget.classList.add('mode-welcome');
                }

                // Optional: Toast or message if no greeting target
                if (!this.hasGreetingTarget) {
                    const aiIcon = `<div class="synapse-chat__avatar"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 32 32"><use href="#gemini-icon" fill="url(#gemini-gradient)"></use></svg></div>`;
                    const msg = this.welcomeMessageValue || "Nouvelle conversation démarrée !";
                    this.messagesTarget.innerHTML = `
                        <div class="synapse-chat__message synapse-chat__message--assistant">
                             ${aiIcon}
                            <div class="synapse-chat__content">
                                <div class="synapse-chat__bubble"><p>${msg}</p></div>
                            </div>
                        </div>
                     `;
                }

                this.inputTarget.focus();
            } else {
                throw new Error(data.error || 'Reset failed');
            }
        } catch (error) {
            alert('Error: ' + error.message);
        }
    }

    addMessage(text, role, debugData = null) {
        let formattedText = text;

        // Simple markdown parsing
        formattedText = this.parseMarkdown(formattedText);

        // Debug info
        let debugHtml = '';
        if (this.isDebugMode && debugData && debugData.debug_id) {
            const debugUrl = `/synapse/_debug/${debugData.debug_id}`;
            debugHtml = `
                <button type="button" class="synapse-chat__debug-trigger"
                        onclick="window.open('${debugUrl}', '_blank')"
                        title="Debug">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                </button>
            `;
        }

        // Build avatar
        // Using generic classes so CSS/Theme handles the icon (SVG Symbol expected in DOM)
        const aiIcon = `<div class="synapse-chat__avatar"><div class="avatar-ai"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 32 32"><use href="#gemini-icon" fill="url(#gemini-gradient)"></use></svg></div></div>`;
        const userAvatar = `<div class="synapse-chat__avatar">👤</div>`;

        const avatarContent = role === 'user' ? userAvatar : aiIcon;

        let footerHtml = '';
        if (debugHtml) {
            footerHtml = `<div class="synapse-chat__footer">${debugHtml}</div>`;
        }

        const html = `
            <div class="synapse-chat__message synapse-chat__message--${role}">
                ${avatarContent}
                <div class="synapse-chat__content">
                    <div class="synapse-chat__bubble">${formattedText}</div>
                    ${footerHtml}
                </div>
            </div>
        `;

        this.messagesTarget.insertAdjacentHTML('beforeend', html);
        this.scrollToBottom();
    }

    async loadMarked() {
        try {
            const markedModule = await import('marked');

            if (typeof markedModule.parse === 'function') {
                this.markedParse = markedModule.parse;
            } else if (markedModule.default && typeof markedModule.default.parse === 'function') {
                this.markedParse = markedModule.default.parse;
            } else if (markedModule.marked && typeof markedModule.marked.parse === 'function') {
                this.markedParse = markedModule.marked.parse;
            } else {
                console.warn('⚠️ [Synapse] marked module loaded but parse function not found in exports:', markedModule);
            }

        } catch (e) {
            console.error('🔴 [Synapse] Failed to load marked:', e);
            console.warn('Synapse: "marked" library not found. Install it for better Markdown rendering (php bin/console importmap:require marked). Using fallback parser.');
        }
    }

    parseMarkdown(text) {
        if (this.markedParse) {
            try {
                return this.markedParse(text);
            } catch (e) {
                // Fallback to regex if marked fails
            }
        }

        // FALLBACK: Robust Regex Parser
        let html = text;

        // 1. PRIORITY: Convert Markdown links to styled buttons
        const linksBefore = (html.match(/\[([^\]]+)\]\(([^)]+)\)/g) || []).length;
        html = html.replace(
            /\[([^\]]+)\]\(([^)]+)\)/g,
            '<a href="$2" class="synapse-btn-action" target="_blank" rel="noopener noreferrer">$1</a>'
        );

        // 2. Text formatting
        html = html
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>');

        // 3. Code blocks
        html = html
            .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>');

        // 4. Line breaks (LAST to avoid breaking HTML tags)
        html = html.replace(/\n/g, '<br>');

        // 5. Group consecutive action buttons into a flex container
        // Match 2+ consecutive buttons (with optional <br> between them)
        html = html.replace(
            /(<a class="synapse-btn-action"[^>]*>.*?<\/a>(?:<br>)?){2,}/g,
            (match) => {
                // Remove <br> tags between buttons and wrap in action group
                const cleanedButtons = match.replace(/<br>/g, '');
                return `<div class="synapse-action-group">${cleanedButtons}</div>`;
            }
        );

        return html;
    }

    setLoading(isLoading) {
        this.submitBtnTarget.disabled = isLoading;

        if (isLoading) {
            const aiIcon = `<div class="synapse-chat__avatar synapse-chat__avatar--loading"><div class="synapse-chat__spinner"></div><div class="avatar-ai"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 32 32"><use href="#gemini-icon" fill="url(#gemini-gradient)"></use></svg></div></div>`;

            this.messagesTarget.insertAdjacentHTML('beforeend', `
                <div class="synapse-chat__message synapse-chat__message--assistant synapse-chat__loading" id="synapse-loading">
                    ${aiIcon}
                    <div class="synapse-chat__content">
                        <span class="synapse-chat__typing-dots">Réflexion</span>
                    </div>
                </div>
            `);
            this.scrollToBottom();
        } else {
            const loading = this.element.querySelector('#synapse-loading');
            if (loading) loading.remove();
        }
    }

    scrollToBottom() {
        this.messagesTarget.scrollTop = this.messagesTarget.scrollHeight;
    }

    /**
     * Affiche un encart de proposition de mémorisation dans le fil du chat.
     * 3 boutons : Non / Oui, dans la conversation / Oui, toujours. Actions directes (API), sans repasser par le LLM.
     * @param {Object} proposal - { fact, category?, __synapse_action? }
     * @param {string|null} conversationId
     * @param {boolean} insertBeforeLastAssistant - si true, insère l'encart juste avant la dernière bulle assistant (plus visible)
     */
    showMemoryProposal(proposal, conversationId = null, insertBeforeLastAssistant = false) {
        const fact = proposal?.fact ?? proposal?.data?.fact;
        if (!proposal || (typeof fact !== 'string' && typeof fact !== 'number')) {
            console.warn('[Synapse Memory] Proposition invalide (fact manquant):', proposal);
            return;
        }
        const existing = this.messagesTarget.querySelector('.synapse-memory-encart');
        if (existing) existing.closest('.synapse-chat__message--memory')?.remove();

        const factText = String(fact).trim() || '—';
        const encartWrapper = document.createElement('div');
        encartWrapper.className = 'synapse-chat__message synapse-chat__message--memory';
        encartWrapper.innerHTML = `
            <div class="synapse-chat__avatar synapse-chat__avatar--empty" aria-hidden="true"></div>
            <div class="synapse-chat__content">
                <div class="synapse-memory-encart">
                    <span class="synapse-memory-encart__icon">🧠</span>
                    <div class="synapse-memory-encart__body">
                        <span class="synapse-memory-encart__label">Retenir :</span>
                        <span class="synapse-memory-encart__fact">${this.escapeHtml(factText)}</span>
                    </div>
                    <div class="synapse-memory-encart__actions">
                        <button type="button" class="synapse-memory-encart__btn synapse-memory-encart__btn--reject">Non</button>
                        <button type="button" class="synapse-memory-encart__btn synapse-memory-encart__btn--conversation">Oui, dans la conversation</button>
                        <button type="button" class="synapse-memory-encart__btn synapse-memory-encart__btn--user">Oui, toujours</button>
                    </div>
                </div>
            </div>
        `;

        if (insertBeforeLastAssistant) {
            const lastAssistant = this.messagesTarget.querySelector('.synapse-chat__message--assistant:last-of-type');
            if (lastAssistant) {
                lastAssistant.insertAdjacentElement('beforebegin', encartWrapper);
            } else {
                this.messagesTarget.appendChild(encartWrapper);
            }
        } else {
            this.messagesTarget.appendChild(encartWrapper);
        }
        this.scrollToBottom();
        requestAnimationFrame(() => this.scrollToBottom());

        const removeEncart = () => {
            encartWrapper.remove();
            this.scrollToBottom();
        };

        const showFeedback = (text) => {
            encartWrapper.querySelector('.synapse-memory-encart').outerHTML = `
                <div class="synapse-memory-encart synapse-memory-encart--feedback">${text}</div>
            `;
            setTimeout(removeEncart, 2500);
        };

        const doConfirm = async (scope) => {
            const csrfToken = await this.ensureCsrfToken();
            const headers = { 'Content-Type': 'application/json' };
            if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
            try {
                await fetch('/synapse/api/memory/confirm', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        fact: proposal.fact,
                        category: proposal.category ?? 'other',
                        scope,
                        conversation_id: conversationId ?? null
                    })
                });
                showFeedback(scope === 'user' ? '✅ Mémorisé.' : '✅ Mémorisé pour cette conversation.');
            } catch (e) {
                console.error('[Synapse Memory] Erreur lors de la confirmation:', e);
            }
        };

        const doReject = async () => {
            const csrfToken = await this.ensureCsrfToken();
            const headers = { 'Content-Type': 'application/json' };
            if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
            try {
                await fetch('/synapse/api/memory/reject', { method: 'POST', headers });
            } catch (e) { /* Silencieux */ }
            removeEncart();
        };

        encartWrapper.querySelector('.synapse-memory-encart__btn--reject').addEventListener('click', doReject);
        encartWrapper.querySelector('.synapse-memory-encart__btn--conversation').addEventListener('click', () => doConfirm('conversation'));
        encartWrapper.querySelector('.synapse-memory-encart__btn--user').addEventListener('click', () => doConfirm('user'));

        setTimeout(() => {
            if (encartWrapper.isConnected) removeEncart();
        }, 30000);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(text));
        return div.innerHTML;
    }

    updateUrlWithConversationId(conversationId) {
        const url = new URL(window.location.href);
        const currentConversationId = url.searchParams.get('conversation');

        // Only dispatch event if this is a NEW conversation (not already in URL)
        const isNewConversation = currentConversationId !== conversationId;

        url.searchParams.set('conversation', conversationId);

        // Update URL without reloading page
        window.history.pushState({}, '', url.toString());

        // Dispatch event for sidebar to refresh ONLY for new conversations
        if (isNewConversation) {
            document.dispatchEvent(new CustomEvent('assistant:conversation-created', {
                detail: { conversationId, title: 'Nouvelle conversation' }
            }));
        }
    }
}

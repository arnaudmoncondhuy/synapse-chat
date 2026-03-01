import { Controller } from '@hotwired/stimulus';

/**
 * Stimulus controller pour la sidebar de conversations
 *
 * Fonctionnalités :
 * - Affichage/masquage drawer
 * - Chargement conversations via API
 * - Suppression optimiste avec rollback
 * - Renommage inline (double-clic)
 * - Écoute events (conversation-created, title-updated)
 */
export default class extends Controller {
    static targets = ['list', 'toggle', 'drawer', 'empty'];
    static values = {
        apiUrl: String,
        currentConversationId: String
    };

    connect() {

        // Initialiser l'ID de conversation depuis l'URL si non défini
        if (!this.currentConversationIdValue) {
            const urlParams = new URLSearchParams(window.location.search);
            const conversationId = urlParams.get('conversation');
            if (conversationId) {
                this.currentConversationIdValue = conversationId;
            }
        }

        this.loadConversations();
        this.setupEventListeners();
    }

    /**
     * Charge les conversations depuis l'API
     */
    async loadConversations() {
        try {
            const response = await fetch(this.apiUrlValue || '/synapse/api/conversations');

            if (response.status === 401) {
                this.showEmpty();
                return;
            }

            if (!response.ok) throw new Error('Failed to load conversations');

            const conversations = await response.json();
            this.renderConversations(conversations);
        } catch (error) {
            console.error('Error loading conversations:', error);
            this.showError('Impossible de charger les conversations');
        }
    }

    /**
     * Affiche la liste des conversations
     */
    renderConversations(conversations) {
        if (conversations.length === 0) {
            this.showEmpty();
            return;
        }

        this.hideEmpty();

        this.listTarget.innerHTML = conversations.map(conv => `
            <div
                class="conversation-item ${String(conv.id) === String(this.currentConversationIdValue) ? 'active' : ''}"
                data-conversation-id="${conv.id}"
                data-action="click->synapse-sidebar#selectConversation"
            >
                <div class="conversation-header">
                    <span class="conversation-title" data-synapse-sidebar-target="title">${this.escapeHtml(conv.title || 'Nouvelle conversation')}</span>
                    <!-- Risk badge removed - should only be visible in admin interface -->
                </div>
                <div class="conversation-meta">
                    <span class="conversation-date">${this.formatDate(conv.updated_at)}</span>
                    <span class="conversation-count">${conv.message_count} msg</span>
                </div>
                <div class="conversation-actions">
                    <button
                        class="conversation-edit"
                        data-action="click->synapse-sidebar#startRename:stop"
                        title="Renommer"
                    >
                        ✎
                    </button>
                    <button
                        class="conversation-delete"
                        data-action="click->synapse-sidebar#deleteConversation:stop"
                        title="Supprimer"
                    >
                        ×
                    </button>
                </div>
            </div>
        `).join('');
    }

    /**
     * Affiche le message vide
     */
    showEmpty() {
        if (this.hasEmptyTarget) {
            this.emptyTarget.classList.remove('hidden');
        }
        if (this.hasListTarget) {
            this.listTarget.innerHTML = '';
        }
    }

    /**
     * Cache le message vide
     */
    hideEmpty() {
        if (this.hasEmptyTarget) {
            this.emptyTarget.classList.add('hidden');
        }
    }

    /**
     * Toggle drawer (afficher/masquer)
     */
    toggle() {
        if (this.hasDrawerTarget) {
            this.drawerTarget.classList.toggle('open');
        }
    }

    /**
     * Ouvre le drawer
     */
    open() {
        if (this.hasDrawerTarget) {
            this.drawerTarget.classList.add('open');
        }
    }

    /**
     * Ferme le drawer
     */
    close() {
        if (this.hasDrawerTarget) {
            this.drawerTarget.classList.remove('open');
        }
    }

    /**
     * Sélectionne une conversation
     */
    selectConversation(event) {
        const conversationId = event.currentTarget.dataset.conversationId;

        // Désélectionner toutes
        this.listTarget.querySelectorAll('.conversation-item').forEach(item => {
            item.classList.remove('active');
        });

        // Sélectionner la courante
        event.currentTarget.classList.add('active');
        this.currentConversationIdValue = conversationId;

        // Dispatch event pour le chat
        this.dispatch('conversation-selected', { detail: { conversationId } });

        // Fermer drawer sur mobile
        if (window.innerWidth < 768) {
            this.close();
        }

        // REDIRECTION FORCEE pour charger l'historique (Server Side Rendering)
        const url = new URL(window.location.href);
        url.searchParams.set('conversation', conversationId);
        window.location.href = url.toString();
    }

    /**
     * Supprime une conversation (optimistic UI)
     */
    async deleteConversation(event) {
        const item = event.currentTarget.closest('.conversation-item');
        const conversationId = item.dataset.conversationId;

        if (!confirm('Supprimer cette conversation ?')) {
            return;
        }

        // Optimistic UI : masquer immédiatement
        const itemHtml = item.outerHTML;
        item.style.opacity = '0.5';
        item.style.pointerEvents = 'none';

        try {
            const response = await fetch(`${this.apiUrlValue || '/synapse/api/conversations'}/${conversationId}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) throw new Error('Delete failed');

            // Supprimer l'élément
            item.remove();

            // Vérifier si la liste est vide
            if (this.listTarget.children.length === 0) {
                this.showEmpty();
            }

            // Dispatch event
            this.dispatch('conversation-deleted', { detail: { conversationId } });

            // Si c'était la conversation active, rediriger vers nouvelle conversation
            if (String(conversationId) === String(this.currentConversationIdValue)) {
                this.currentConversationIdValue = '';
                this.dispatch('conversation-reset');

                // Rediriger vers la page sans paramètre de conversation
                const url = new URL(window.location.href);
                url.searchParams.delete('conversation');
                window.location.href = url.toString();
            }
        } catch (error) {
            console.error('Error deleting conversation:', error);

            // Rollback : restaurer l'élément
            item.style.opacity = '1';
            item.style.pointerEvents = 'auto';

            this.showError('Impossible de supprimer la conversation');
        }
    }

    /**
     * Démarre le renommage inline (clic sur bouton edit)
     */
    startRename(event) {
        const item = event.currentTarget.closest('.conversation-item');
        const titleSpan = item.querySelector('.conversation-title');
        const currentTitle = titleSpan.textContent;

        // Créer input
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentTitle;
        input.className = 'conversation-title-input';

        // Remplacer le span par l'input
        titleSpan.replaceWith(input);
        input.focus();
        input.select();

        // Sauvegarder au blur ou Enter
        const save = async () => {
            const newTitle = input.value.trim();

            if (newTitle && newTitle !== currentTitle) {
                await this.renameConversation(item.dataset.conversationId, newTitle);
            }

            // Restaurer le span
            const span = document.createElement('span');
            span.className = 'conversation-title';
            span.textContent = newTitle || currentTitle;
            span.dataset.synapseSidebarTarget = 'title';
            input.replaceWith(span);
        };

        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                input.value = currentTitle;
                input.blur();
            }
        });
    }

    /**
     * Renomme une conversation via l'API
     */
    async renameConversation(conversationId, newTitle) {
        try {
            const response = await fetch(`${this.apiUrlValue || '/synapse/api/conversations'}/${conversationId}/rename`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ title: newTitle })
            });

            if (!response.ok) throw new Error('Rename failed');

            // Dispatch event
            this.dispatch('conversation-renamed', {
                detail: { conversationId, title: newTitle }
            });
        } catch (error) {
            console.error('Error renaming conversation:', error);
            this.showError('Impossible de renommer la conversation');
        }
    }

    /**
     * Configure les event listeners
     */
    setupEventListeners() {
        // Écouter les events du chat
        document.addEventListener('assistant:conversation-created', (event) => {
            this.handleConversationCreated(event.detail);
        });

        document.addEventListener('assistant:title-updated', (event) => {
            this.handleTitleUpdated(event.detail);
        });

        // Responsive : fermer drawer au clic sur overlay
        if (this.hasDrawerTarget) {
            const overlay = this.drawerTarget.querySelector('.drawer-overlay');
            if (overlay) {
                overlay.addEventListener('click', () => this.close());
            }
        }
    }

    /**
     * Gère la création d'une nouvelle conversation
     */
    handleConversationCreated({ conversationId, title }) {
        this.currentConversationIdValue = conversationId;

        // Ajouter la conversation en tête de liste (optimistic UI)
        this.prependConversation({
            id: conversationId,
            title: title || 'Nouvelle conversation',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: 'ACTIVE',
            risk_level: 'NONE',
            message_count: 1
        });

        // Ne pas ouvrir automatiquement la sidebar - l'utilisateur peut le faire manuellement
    }

    /**
     * Ajoute une conversation en tête de liste
     */
    prependConversation(conversation) {
        this.hideEmpty();

        // Désélectionner les autres conversations
        this.listTarget.querySelectorAll('.conversation-item').forEach(item => {
            item.classList.remove('active');
        });

        const html = `
            <div
                class="conversation-item active"
                data-conversation-id="${conversation.id}"
                data-action="click->synapse-sidebar#selectConversation"
            >
                <div class="conversation-header">
                    <span class="conversation-title" data-synapse-sidebar-target="title">${this.escapeHtml(conversation.title)}</span>
                    <!-- Risk badge removed - should only be visible in admin interface -->
                </div>
                <div class="conversation-meta">
                    <span class="conversation-date">${this.formatDate(conversation.updated_at)}</span>
                    <span class="conversation-count">${conversation.message_count} msg</span>
                </div>
                <div class="conversation-actions">
                    <button
                        class="conversation-edit"
                        data-action="click->synapse-sidebar#startRename:stop"
                        title="Renommer"
                    >
                        ✎
                    </button>
                    <button
                        class="conversation-delete"
                        data-action="click->synapse-sidebar#deleteConversation:stop"
                        title="Supprimer"
                    >
                        ×
                    </button>
                </div>
            </div>
        `;

        this.listTarget.insertAdjacentHTML('afterbegin', html);
    }

    /**
     * Gère la mise à jour d'un titre
     */
    handleTitleUpdated({ conversationId, title }) {
        const item = this.listTarget.querySelector(`[data-conversation-id="${conversationId}"]`);
        if (item) {
            const titleSpan = item.querySelector('.conversation-title');
            if (titleSpan) {
                titleSpan.textContent = title;
            }
        }
    }

    /**
     * Affiche une erreur (toast)
     */
    showError(message) {
        // TODO: Intégrer avec votre système de notifications
        console.error(message);
        alert(message);
    }

    /**
     * Formate une date
     */
    formatDate(dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diff = now - date;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));

        if (days === 0) {
            return 'Aujourd\'hui';
        } else if (days === 1) {
            return 'Hier';
        } else if (days < 7) {
            return `Il y a ${days}j`;
        } else {
            return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
        }
    }

    /**
     * Retourne l'emoji d'un niveau de risque
     */
    getRiskEmoji(level) {
        const emojis = {
            'WARNING': '⚠️',
            'CRITICAL': '🚨'
        };
        return emojis[level] || '';
    }

    /**
     * Échappe le HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Crée une nouvelle conversation (recharge la page sans conversation ID)
     */
    newConversation(event) {
        event.preventDefault();

        // Supprimer le paramètre conversation de l'URL
        const url = new URL(window.location.href);
        url.searchParams.delete('conversation');
        window.location.href = url.toString();
    }
}

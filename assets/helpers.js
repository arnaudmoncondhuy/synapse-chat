/**
 * Shared utility functions for Synapse chat Stimulus controllers.
 */

export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function formatDate(dateString) {
    const date = new Date(dateString);
    const diff = Date.now() - date;
    const days = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
    if (days === 0) return 'Aujourd\'hui';
    if (days === 1) return 'Hier';
    if (days < 7) return `Il y a ${days}j`;
    return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

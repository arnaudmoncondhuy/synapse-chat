# Utilisation du bundle Chat

Le bundle **Synapse Chat** (`arnaudmoncondhuy/synapse-chat`) fournit l’API HTTP et les assets pour intégrer une interface de chat dans votre application. Il s’appuie sur **Synapse Core** pour la logique métier.

## Installation

```bash
composer require arnaudmoncondhuy/synapse-core arnaudmoncondhuy/synapse-chat
```

## Endpoints API

### Chat

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/synapse/api/chat` | Envoi d’un message, réponse en streaming NDJSON. |
| POST | `/synapse/api/estimate-cost` | Estimation du coût en tokens avant envoi. |
| POST | `/synapse/api/conversation/reset` | Réinitialisation de la conversation courante. |
| GET | `/synapse/api/csrf-token` | Récupérer le jeton CSRF (SPA, page surchargée). |

**Auto-titling** : Le bundle génère automatiquement un titre après le premier échange (événement `title` envoyé en NDJSON).

### Gestion des conversations

Ces endpoints permettent de gérer l’historique des conversations de l’utilisateur authentifié.

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/synapse/api/conversations` | Liste les conversations de l’utilisateur (`?limit=50`, max 500). |
| DELETE | `/synapse/api/conversations/{id}` | Supprime (soft-delete) une conversation. |
| PATCH | `/synapse/api/conversations/{id}/rename` | Renomme une conversation. Body : `{"title": "Nouveau nom"}`. |
| GET | `/synapse/api/conversations/{id}/messages` | Récupère tous les messages d’une conversation. |

Toutes ces routes nécessitent que l’utilisateur implémente `ConversationOwnerInterface`.

### Mémoire Sémantique

Le bundle propose des endpoints pour gérer la mémoire vectorielle de l’utilisateur (souvenirs, faits importants, etc.).

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/synapse/api/memory/confirm` | Confirmer une proposition de mémoire (lancée par le LLM via `ProposeMemoryTool`) |
| POST | `/synapse/api/memory/reject` | Rejeter une proposition de mémoire |
| GET | `/synapse/api/memory` | Lister les mémoires de l’utilisateur actif (`?limit=50`, max 500) |
| POST | `/synapse/api/memory/manual` | Créer une mémoire manuellement (sans proposition du LLM) |
| PATCH | `/synapse/api/memory/{id}` | Modifier le contenu d’une mémoire existante |
| DELETE | `/synapse/api/memory/{id}` | Supprimer une mémoire |

**Mémoire "Human-in-the-loop"** : Le LLM peut proposer des souvenirs via l’outil `ProposeMemoryTool`, mais seule l’utilisateur (ou le frontend) peut les confirmer ou les rejeter.

## Protection CSRF

Le bundle applique une protection CSRF sur les requêtes POST/PUT/DELETE. Le jeton est exposé via :

- Une meta HTML : `csrf-token` (si vous utilisez les templates fournis).
- **GET `/synapse/api/csrf-token`** : pour récupérer le jeton côté front (ex. SPA ou page surchargée).

Envoyez le header `X-CSRF-Token` (ou le champ `_csrf_token` dans le body) sur chaque requête modifiant des données.

## Intégration front

Les vues et contrôleurs Stimulus du bundle permettent d’afficher un chat avec streaming. Référez-vous à la configuration des routes et des templates dans votre projet pour intégrer le composant (sidebar ou page dédiée).

## Personnalisation & Internationalisation

Le bundle Chat est entièrement internationalisé. Tous les textes (boutons, placeholders, tooltips) utilisent le domaine de traduction `synapse_chat`. Vous pouvez personnaliser ces textes en surchargeant les fichiers YAML dans votre dossier `translations/`.

Exemple de clés : `synapse.chat.input_area.placeholder`, `synapse.chat.sidebar.tab.conversations`.

---

## Dépendance

Synapse Chat dépend de **Synapse Core** : la configuration des modèles, presets, outils et de la persistance se fait via Core (et éventuellement **Synapse Admin** pour l’interface d’administration).

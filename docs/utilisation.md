# Utilisation du bundle Chat

Le bundle **Synapse Chat** (`arnaudmoncondhuy/synapse-chat`) fournit l’API HTTP et les assets pour intégrer une interface de chat dans votre application. Il s’appuie sur **Synapse Core** pour la logique métier.

## Installation

```bash
composer require arnaudmoncondhuy/synapse-core arnaudmoncondhuy/synapse-chat
```

## Routes exposées

- **POST `/synapse/api/chat`** : envoi d’un message et réception de la réponse (streaming NDJSON ou JSON).
- **POST `/synapse/api/conversation/reset`** : réinitialisation de la conversation courante.
- **API Mémoire** : endpoints pour la mémoire vectorielle / sémantique (selon la configuration Core).

## Protection CSRF

Le bundle applique une protection CSRF sur les requêtes POST/PUT/DELETE. Le jeton est exposé via :

- Une meta HTML : `csrf-token` (si vous utilisez les templates fournis).
- **GET `/synapse/api/csrf-token`** : pour récupérer le jeton côté front (ex. SPA ou page surchargée).

Envoyez le header `X-CSRF-Token` (ou le champ `_csrf_token` dans le body) sur chaque requête modifiant des données.

## Intégration front

Les vues et contrôleurs Stimulus du bundle permettent d’afficher un chat avec streaming. Référez-vous à la configuration des routes et des templates dans votre projet pour intégrer le composant (sidebar ou page dédiée).

## Dépendance

Synapse Chat dépend de **Synapse Core** : la configuration des modèles, presets, outils et de la persistance se fait via Core (et éventuellement **Synapse Admin** pour l’interface d’administration).

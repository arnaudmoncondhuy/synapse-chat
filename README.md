# Synapse Chat

> Chat UI component for Synapse — Stimulus streaming controller, NDJSON API endpoints, and embeddable Twig templates.

Widget de chat embeddable pour Synapse Core. Composant Stimulus + Twig pour afficher une interface conversationnelle en streaming temps réel.

**Dépend de** : `arnaudmoncondhuy/synapse-core`

## Installation

```bash
composer require arnaudmoncondhuy/synapse-chat:^0.1
```

## Caractéristiques

### 💬 Chat UI moderne
- Interface conversationnelle en Twig
- Streaming en temps réel via NDJSON/SSE
- **Auto-titling** : Génération automatique du titre de conversation après le premier échange
- **Estimation de Coût** : Affichage prédictif du coût avant l'envoi
- Support des tool calls affichés en live
- Historique conversationnel persistant

### ⚡ Stimulus Controller
- `synapse_chat_controller` - Gestion du chat interactif
  - Envoi de messages
  - Streaming de réponses
  - Display des tool calls
  - Gestion d'erreurs gracieuse

### 🔗 API Endpoints NDJSON
- `POST /api/chat` - Envoi de message et streaming (NDJSON)
- `POST /api/estimate-cost` - Estimation du coût d'un message
- `POST /api/reset` - Réinitialiser la conversation
- `POST /api/csrf` - Obtenir token CSRF

### 🎨 Templates Twig
- `@Synapse/chat/page.html.twig` - Page chat complète
- `@Synapse/chat/component.html.twig` - Composant embeddable
- `@Synapse/chat/sidebar.html.twig` - Historique conversations

## Configuration minimale

**config/bundles.php** :
```php
ArnaudMoncondhuy\SynapseChat\SynapseChatBundle::class => ['all' => true],
```

**config/routes.yaml** :
```yaml
synapse_chat:
    resource: '@SynapseChatBundle/config/routes.yaml'
    prefix: /api
```

**config/packages/security.yaml** :
```yaml
access_control:
    - { path: ^/api/chat, roles: ROLE_USER }  # Chat restreint
    - { path: ^/api/csrf, roles: PUBLIC_ACCESS }
```

**CSRF (Optionel mais recommandé)** :
Le bundle vérifie le header `X-CSRF-Token` par défaut.
```yaml
synapse_chat:
    api_csrf_enabled: true
```

## Utilisation basique

### Page chat complète

```php
// Dans un contrôleur
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;

class ChatController extends AbstractController {
    public function chat() {
        return $this->render('@Synapse/chat/page.html.twig');
    }
}
```

```yaml
# config/routes.yaml
chat_page:
    path: /chat
    controller: App\Controller\ChatController::chat
```

### Composant embeddable

```twig
{# Dans votre template #}
<div class="my-layout">
    <header>Mon application</header>

    {% include '@Synapse/chat/component.html.twig' with {
        title: 'Assistant IA',
        placeholder: 'Posez une question...'
    } %}
</div>
```

### JavaScript Stimulus

Le controller Stimulus gère :
- Écoute du formulaire de chat
- Envoi AJAX vers `/api/chat`
- Streaming SSE de la réponse
- Affichage des chunks en temps réel
- Gestion des erreurs

```javascript
// Déclaration automatique via AssetMapper
// <div data-controller="synapse--chat">
```

## Format NDJSON

Chaque ligne est un objet JSON distinct :

```json
{"text":"Bonjour,","chunk_id":0,"type":"text"}
{"text":" comment","chunk_id":1,"type":"text"}
{"tool_use":{"id":"call_123","name":"calculator","input":{"a":2,"b":3}},"chunk_id":2,"type":"tool_call"}
{"text":"ça donne 5.","chunk_id":3,"type":"text"}
{"usage":{"input_tokens":15,"output_tokens":24},"chunk_id":4,"type":"usage"}
{"final":true,"chunk_id":5}
```

## Événements frontend

```javascript
// Dans votre composant Stimulus
messageReceived(event) {
    // Déclenché à chaque chunk reçu
    console.log(event.detail.chunk);
}

responseComplete(event) {
    // Déclenché à la fin du streaming
    console.log(event.detail.fullResponse);
}
```

## Intégration avec Synapse Core

Le bundle expose :
- Les routes API du core (ChatApiController)
- Les contrôleurs de conversation
- Gestion des presets depuis la DB

Configuration du preset actif :
```yaml
synapse_chat:
    default_preset_name: "default"  # Depuis DB
```

## Assets

CSS et JS inclusos automatiquement via AssetMapper :
```
packages/chat/assets/
├── controllers/
│   └── synapse_chat_controller.js
└── styles/
    └── synapse.css
```

À importer dans votre layout Twig :
```twig
{% include '@Synapse/chat/assets.html.twig' %}
```

## Structure des dépendances

```
synapse-chat
  ├── arnaudmoncondhuy/synapse-core
  ├── symfony/twig-bundle
  ├── symfony/asset-mapper
  ├── symfony/stimulus-bundle
  └── symfony/asset
```

## Internationalisation

L'interface de chat et les messages d'erreur API sont traduisibles.
- **Domaine de traduction** : `synapse_chat`
- **Composants traduits** : Interface Twig, contrôleurs API, prompts internes.

---

## Licence

## Support

- 📖 [Documentation Chat](https://arnaudmoncondhuy.github.io/synapse-bundle/chat/)
- 🐛 [Issues](https://github.com/arnaudmoncondhuy/synapse-bundle/issues)

## Auteur

[Arnaud Moncondhuy](https://github.com/arnaudmoncondhuy)
